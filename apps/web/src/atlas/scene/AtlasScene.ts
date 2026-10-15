/** The Canada diorama (spec §7). Orbitable orthographic camera; provinces extruded as a
 * land board with ink outlines and three-step toon light; one six-sided crystal per city,
 * with a straight shaft and short faceted crown, batched with instancing. The render loop only runs while
 * something changes (camera, tween, resize), so an idle map costs nothing. */
import * as THREE from "three";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";

import { project } from "../projection";
import { heightFor, colorFor } from "../scale";
import type { ScenePalette } from "./palette";
import { contactShadow, hatch, seaPattern, toonGradient } from "./textures";

type Ring = [number, number][];
type Polygon = Ring[];
export interface GeoData {
  bbox: [number, number, number, number];
  provinces: { code: string; name: string; polygons: Polygon[] }[];
  neighbours: Polygon[];
  lakes: Polygon[];
}
export interface SceneCity {
  id: string;
  name: string;
  lon: number;
  lat: number;
}
interface Crystal {
  id: string;
  x: number;
  z: number;
  from: number;
  to: number;
  shown: number;
  delay: number;
  known: boolean;
  count: number | null;
  color: string;
}

const CRYSTAL_W = 24;
const CRYSTAL_BASE = 3;
const TWEEN_MS = 750;
const MOUNTAINS: [number, number, number][] = [
  [-116.3, 50.4, 1], [-117.5, 51.3, 1.25], [-118.4, 52.6, 1.1], [-119.7, 53.4, 1.3],
  [-120.9, 54.1, 0.95], [-121.8, 55.0, 1.05], [-123.5, 56.6, 1], [-125.2, 58.2, 1.15],
  [-127.5, 59.5, 0.9], [-129.0, 60.6, 1], [-136.0, 61.3, 1.4], [-138.5, 60.4, 1.2],
  [-122.5, 50.8, 0.9], [-124.5, 52.0, 1], [-126.2, 54.0, 0.85], [-63.5, 58.6, 0.8],
];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
const ease = (t: number) => 1 - Math.pow(1 - t, 3);

export class AtlasScene {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.OrthographicCamera;
  private target = new THREE.Vector3();
  private baseHalfH = 1000;
  private zoom = 1;
  private elevation: number;
  private azimuth: number;
  private landTop: number;
  private lines: LineMaterial[] = [];
  private gradient = toonGradient();
  private crystals: Crystal[] = [];
  private byId = new Map<string, number>();
  private selected: string | null = null;
  private hovered: string | null = null;
  private tweenStart = 0;
  /** Instance matrices only need rebuilding when data, selection or hover change, or while a
   * tween runs; panning and zooming only re-render. */
  private layoutDirty = true;
  private raf = 0;
  private disposed = false;
  private listeners = new Set<() => void>();
  private resizeObserver: ResizeObserver;
  private meshes!: Record<"body" | "crown" | "outline" | "crownOutline" | "pads" | "rings" | "unknown" | "shadows", THREE.InstancedMesh>;

  constructor(
    private host: HTMLElement,
    private palette: ScenePalette,
    private opts: { reducedMotion: boolean },
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.style.display = "block";
    host.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(palette.background);
    this.landTop = palette.landDepth;
    this.elevation = palette.elevation;
    this.azimuth = palette.azimuth;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -20000, 20000);
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.5);
    sun.position.set(-0.55, 1, -0.35); // from the north-west: shadows fall south-east
    this.scene.add(sun);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
  }

  // ------------------------------------------------------------ geography

  setGeo(geo: GeoData): void {
    const p = this.palette;
    const toon = (color: string, extra: THREE.MeshToonMaterialParameters = {}) =>
      new THREE.MeshToonMaterial({ color, gradientMap: this.gradient, ...extra });
    // One mesh per polygon: ExtrudeGeometry's two groups (caps, sides) map onto the two
    // materials; merging with groups would number groups per input geometry instead.
    const slab = (polys: Polygon[], depth: number, materials: THREE.Material | THREE.Material[]) => {
      const group = new THREE.Group();
      for (const poly of polys) {
        const shape = new THREE.Shape(poly[0]!.map(([x, y]) => new THREE.Vector2(x, y)));
        for (const hole of poly.slice(1)) shape.holes.push(new THREE.Path(hole.map(([x, y]) => new THREE.Vector2(x, y))));
        const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 1 });
        g.rotateX(-Math.PI / 2);
        group.add(new THREE.Mesh(g, materials));
      }
      return group;
    };
    const ink = (polys: Polygon[], y: number, color: string, width: number) => {
      const pos: number[] = [];
      for (const poly of polys)
        for (const ring of poly)
          for (let i = 0; i < ring.length - 1; i++)
            pos.push(ring[i]![0], y, -ring[i]![1], ring[i + 1]![0], y, -ring[i + 1]![1]);
      const g = new LineSegmentsGeometry();
      g.setPositions(pos);
      const m = new LineMaterial({ color, linewidth: width, worldUnits: false });
      this.lines.push(m);
      return new LineSegments2(g, m);
    };

    // Warm screentone paper replaces the endless ocean.
    const seaTex = seaPattern(p.sea, p.seaInk, "screentone");
    seaTex.repeat.set(36, 36);
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(24000, 24000), new THREE.MeshBasicMaterial({ map: seaTex }));
    sea.rotateX(-Math.PI / 2);
    sea.position.y = -1;
    this.scene.add(sea);

    // neighbouring land (context only)
    const nDepth = p.landDepth * 0.55;
    this.scene.add(slab(geo.neighbours, nDepth, [toon(p.neighbourTop), toon(p.neighbourSide)]));
    this.scene.add(ink(geo.neighbours, nDepth + 0.5, p.provinceInk, p.provinceWidth));

    // Canada board: one merged mesh, caps and sides with their own materials
    const polys = geo.provinces.flatMap((pr) => pr.polygons);
    // the board's shadow on the sea (it floats like a model), then the board itself
    const shadow = slab(polys, 0.5, new THREE.MeshBasicMaterial({ color: p.seaInk, transparent: true, opacity: 0.55 }));
    shadow.position.set(46, -0.6, 46);
    this.scene.add(shadow);
    const sideTex = hatch(p.landSide, p.ink);
    sideTex.repeat.set(1 / 36, 1 / 36); // side UVs are in km
    this.scene.add(slab(polys, p.landDepth, [toon(p.landTop), toon("#ffffff", { map: sideTex })]));
    // provinces: thin ink on the top face; coast: thick ink on top and along the base
    this.scene.add(ink(polys, p.landDepth + 0.6, p.provinceInk, p.provinceWidth));
    const outer: Polygon[] = polys.map((poly) => [poly[0]!]);
    this.scene.add(ink(outer, p.landDepth + 0.8, p.ink, p.coastWidth));
    this.scene.add(ink(outer, 0.4, p.ink, p.coastWidth * 0.7));

    // lakes, slightly above the board
    const lakes = slab(geo.lakes, 1, toon(p.lake));
    lakes.position.y = p.landDepth + 0.1;
    this.scene.add(lakes);
    this.scene.add(ink(geo.lakes, p.landDepth + 1.3, p.ink, p.provinceWidth));

    this.addMountains();
    const [minX, minY, maxX, maxY] = geo.bbox;
    this.target.set((minX + maxX) / 2, this.landTop, -(minY + maxY) / 2 + 250);
    this.baseHalfH = (maxY - minY) * 0.5;
    this.fitWidth = maxX - minX;
    // Portrait screens: start closer, nudged south where the cities are.
    const portrait = (this.host.clientWidth || 1) / (this.host.clientHeight || 1) < 0.8;
    this.homeZoom = portrait ? 1.6 : 0.96;
    if (portrait) this.target.z += 160;
    this.zoom = this.homeZoom;
    this.homeTarget = this.target.clone();
    this.updateCamera();
    this.invalidate();
  }

  private fitWidth = 5000;
  private homeZoom = 1;

  private addMountains(): void {
    const p = this.palette;
    const toonM = (c: string) => new THREE.MeshToonMaterial({ color: c, gradientMap: this.gradient });
    const body = new THREE.ConeGeometry(60, 95, 5);
    const cap = new THREE.ConeGeometry(25, 38, 5);
    const outline = new THREE.MeshBasicMaterial({ color: p.ink, side: THREE.BackSide });
    for (const [lon, lat, s] of MOUNTAINS) {
      const [x, y] = project(lon, lat);
      const g = new THREE.Group();
      const m = new THREE.Mesh(body, toonM(p.mountain));
      m.position.y = 47.5;
      const o = new THREE.Mesh(body, outline);
      o.position.y = 47.5;
      o.scale.setScalar(1.08);
      const c = new THREE.Mesh(cap, toonM(p.snow));
      c.position.y = 95 - 19 + 2;
      g.add(o, m, c);
      g.position.set(x, this.landTop, -y);
      g.scale.setScalar(s);
      g.rotation.y = (hash(`${lon}`) % 100) / 30;
      this.scene.add(g);
    }
  }

  // ------------------------------------------------------------ crystals

  setCities(cities: SceneCity[]): void {
    this.crystals = cities.map((c) => {
      const [x, y] = project(c.lon, c.lat);
      return { id: c.id, x, z: -y, from: 0, to: 0, shown: 0, delay: 0,
               known: true, count: null, color: colorFor(0, 1) };
    });
    this.byId = new Map(this.crystals.map((b, i) => [b.id, i]));
    this.buildMeshes();
    this.layoutDirty = true;
    this.invalidate();
  }

  private buildMeshes(): void {
    if (this.meshes) {
      const geometries = new Set<THREE.BufferGeometry>();
      const materials = new Set<THREE.Material>();
      for (const mesh of Object.values(this.meshes)) {
        this.scene.remove(mesh);
        mesh.dispose();
        geometries.add(mesh.geometry);
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(material);
      }
      geometries.forEach((g) => g.dispose());
      materials.forEach((m) => {
        for (const value of Object.values(m)) if (value instanceof THREE.Texture && value !== this.gradient) value.dispose();
        m.dispose();
      });
    }
    const p = this.palette;
    const n = Math.max(1, this.crystals.length);
    const inst = (geo: THREE.BufferGeometry, mat: THREE.Material) => {
      const mesh = new THREE.InstancedMesh(geo, mat, n);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      return mesh;
    };
    // Flat normals and restrained face tints keep the six facets legible without glass or glow.
    const facet = (radiusTop: number) => {
      const source = new THREE.CylinderGeometry(radiusTop, 0.5, 1, 6, 1).rotateY(Math.PI / 6);
      const geo = source.toNonIndexed();
      source.dispose();
      geo.computeVertexNormals();
      const normals = geo.getAttribute("normal");
      const colors = [];
      for (let i = 0; i < normals.count; i++) {
        const shade = normals.getY(i) > 0.5 ? 1 : 0.78 + 0.22 * (normals.getX(i) * 0.6 - normals.getZ(i) * 0.8);
        colors.push(shade, shade, shade);
      }
      geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
      return geo;
    };
    const body = facet(0.5);
    const crown = facet(0.12);
    const crystalMat = new THREE.MeshToonMaterial({ color: 0xffffff, vertexColors: true, gradientMap: this.gradient });
    const outlineMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.BackSide });
    const ring = new THREE.TorusGeometry(0.5, 0.025, 4, 24).rotateX(-Math.PI / 2);
    this.meshes = {
      body: inst(body, crystalMat),
      crown: inst(crown, crystalMat),
      outline: inst(body, outlineMat),
      crownOutline: inst(crown, outlineMat),
      pads: inst(new THREE.CylinderGeometry(0.5, 0.5, 1, 16), new THREE.MeshBasicMaterial({ color: p.zeroPad })),
      rings: inst(ring, new THREE.MeshBasicMaterial({ color: 0xffffff })),
      unknown: inst(new THREE.TorusGeometry(0.5, 0.035, 4, 20, Math.PI * 1.6).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: p.provinceInk })),
      shadows: inst(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: contactShadow(p.shadow), transparent: true, depthWrite: false })),
    };
    this.meshes.shadows.renderOrder = 1;
  }

  /** New counts; heights tween from what is shown now (never random growth: only real changes
   * move). `stagger` raises crystals west to east on first load. */
  setCounts(counts: Map<string, number | null>, scaleMax: number, opts: { stagger?: boolean } = {}): void {
    const now = performance.now();
    const minX = Math.min(...this.crystals.map((b) => b.x));
    const spanX = Math.max(1, Math.max(...this.crystals.map((b) => b.x)) - minX);
    for (const b of this.crystals) {
      const c = counts.has(b.id) ? counts.get(b.id)! : null;
      b.count = c;
      b.color = colorFor(c, scaleMax);
      b.known = c !== null;
      b.from = b.shown;
      b.to = heightFor(c, scaleMax);
      b.delay = opts.stagger && !this.opts.reducedMotion ? ((b.x - minX) / spanX) * 650 : 0;
    }
    this.tweenStart = now;
    this.layoutDirty = true;
    this.invalidate();
  }

  setSelected(id: string | null): void {
    this.selected = id;
    this.layoutDirty = true;
    this.invalidate();
  }

  setHovered(id: string | null): void {
    if (id === this.hovered) return;
    this.hovered = id;
    this.layoutDirty = true;
    this.invalidate();
  }

  private layout(now: number): boolean {
    const m = this.meshes;
    if (!m) return false;
    const p = this.palette;
    const W = CRYSTAL_W;
    const top = this.landTop;
    const mat = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const color = new THREE.Color();
    const ink = new THREE.Color(p.ink);
    const selectedInk = new THREE.Color("#c32f65");
    const hoverInk = new THREE.Color("#198d98");
    let moving = false;
    let nc = 0, np = 0, nr = 0, nu = 0;
    const set = (mesh: THREE.InstancedMesh, i: number, x: number, y: number, z: number, sx: number, sy: number, sz: number) => {
      pos.set(x, y, z);
      scl.set(sx, sy, sz);
      mesh.setMatrixAt(i, mat.compose(pos, q, scl));
    };
    for (const b of this.crystals) {
      const t = this.opts.reducedMotion ? 1 : Math.min(1, Math.max(0, (now - this.tweenStart - b.delay) / TWEEN_MS));
      if (t < 1) moving = true;
      b.shown = b.from + (b.to - b.from) * ease(t);
      const selected = b.id === this.selected;
      const hovered = b.id === this.hovered;
      const outline = selected ? selectedInk : hovered ? hoverInk : ink;
      if (!b.known) {
        set(m.unknown, nu++, b.x, top + 2, b.z, W, 1, W);
        continue;
      }
      // A quiet dot for zero, an anchored locator ring for a counted crystal.
      if (b.count === 0) set(m.pads, np++, b.x, top + 1, b.z, W * 0.65, 2, W * 0.65);
      if (b.count !== 0 || selected || hovered) {
        const ringW = W * (selected || hovered ? 2.1 : 1.4);
        set(m.rings, nr, b.x, top + 2, b.z, ringW, 1, ringW);
        m.rings.setColorAt(nr++, selected || hovered ? outline : color.set(p.provinceInk));
      }
      const h = b.shown;
      if (h <= 0.5) continue;
      // The crown is part of the measured height, not an extra decorative data value.
      const crownH = Math.min(W * 0.7, h * 0.25);
      const bodyH = h - crownH;
      const y0 = top + CRYSTAL_BASE;
      const pad = selected || hovered ? 3.5 : 1.2;
      set(m.body, nc, b.x, y0 + bodyH / 2, b.z, W, bodyH, W);
      set(m.crown, nc, b.x, y0 + bodyH + crownH / 2, b.z, W, crownH, W);
      m.body.setColorAt(nc, color.set(b.color));
      m.crown.setColorAt(nc, color);
      set(m.outline, nc, b.x, y0 + bodyH / 2, b.z, W + pad, bodyH + 0.8, W + pad);
      set(m.crownOutline, nc, b.x, y0 + bodyH + crownH / 2, b.z, W + pad, crownH + 0.8, W + pad);
      m.outline.setColorAt(nc, outline);
      m.crownOutline.setColorAt(nc, outline);
      const shadowW = W * 2.2;
      set(m.shadows, nc, b.x + W * 0.25, top + 0.8, b.z + W * 0.2, shadowW, 1, shadowW);
      nc++;
    }
    m.body.count = m.crown.count = m.outline.count = m.crownOutline.count = m.shadows.count = nc;
    m.pads.count = np;
    m.rings.count = nr;
    m.unknown.count = nu;
    for (const mesh of Object.values(m)) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    return moving;
  }

  // ------------------------------------------------------------ camera

  private resize(): void {
    const w = this.host.clientWidth || 1;
    const h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    for (const m of this.lines) m.resolution.set(w, h);
    this.updateCamera();
    this.invalidate();
  }

  private updateCamera(): void {
    const w = this.host.clientWidth || 1;
    const h = this.host.clientHeight || 1;
    const aspect = w / h;
    const el = (this.elevation * Math.PI) / 180;
    const az = (this.azimuth * Math.PI) / 180;
    // fit the board: vertical extent foreshortened by the view angle
    const needH = Math.max(this.baseHalfH * Math.sin(el) * 1.05, (this.fitWidth / aspect) * 0.5 * 1.02);
    const halfH = needH / this.zoom;
    this.camera.left = -halfH * aspect;
    this.camera.right = halfH * aspect;
    this.camera.top = halfH;
    this.camera.bottom = -halfH;
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
    this.camera.position.copy(this.target).addScaledVector(dir, 8000);
    this.camera.lookAt(this.target);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
  }

  /** Orbit around the map target, keeping the land readable. */
  rotate(dx: number, dy = 0): void {
    this.azimuth = (this.azimuth - dx * 0.28) % 360;
    this.elevation = THREE.MathUtils.clamp(this.elevation + dy * 0.2, 24, 75);
    this.updateCamera();
    this.invalidate();
  }

  /** Pan by a screen delta (pixels). */
  pan(dx: number, dy: number): void {
    const w = this.host.clientWidth || 1;
    const perPx = (this.camera.right - this.camera.left) / w;
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    const groundUp = new THREE.Vector3(up.x, 0, up.z).normalize();
    const el = (this.elevation * Math.PI) / 180;
    this.target.addScaledVector(right, -dx * perPx).addScaledVector(groundUp, (dy * perPx) / Math.sin(el));
    this.updateCamera();
    this.invalidate();
  }

  /** Zoom by a factor around a screen point (keeps the point under the cursor). */
  zoomAt(factor: number, clientX?: number, clientY?: number): void {
    const before = clientX === undefined ? null : this.groundAt(clientX, clientY!);
    this.zoom = Math.min(16, Math.max(0.85, this.zoom * factor));
    this.updateCamera();
    if (before) {
      const after = this.groundAt(clientX!, clientY!);
      if (after) {
        this.target.add(before.sub(after));
        this.updateCamera();
      }
    }
    this.invalidate();
  }

  resetView(): void {
    this.zoom = this.homeZoom;
    this.elevation = this.palette.elevation;
    this.azimuth = this.palette.azimuth;
    this.setGeoTarget();
    this.updateCamera();
    this.invalidate();
  }

  private homeTarget: THREE.Vector3 | null = null;
  private setGeoTarget(): void {
    if (this.homeTarget) this.target.copy(this.homeTarget);
  }

  focusCity(id: string, zoom = 4.5): void {
    const i = this.byId.get(id);
    if (i === undefined) return;
    const b = this.crystals[i]!;
    // aim at the middle of the crystal, so a tall signal stays in the picture
    this.target.set(b.x, this.landTop + Math.max(b.to, b.shown) / 2, b.z);
    this.zoom = Math.max(this.zoom, zoom);
    this.updateCamera();
    // A focus view must contain the full crystal, including tall historical peaks.
    const projectedHeight = Math.max(b.to, b.shown) * Math.cos(this.elevation * Math.PI / 180);
    const availableHeight = (this.camera.top - this.camera.bottom) * 0.5;
    if (projectedHeight > availableHeight) {
      this.zoom *= availableHeight / projectedHeight;
      this.updateCamera();
    }
    this.invalidate();
  }

  private groundAt(clientX: number, clientY: number): THREE.Vector3 | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -this.landTop);
    const hit = new THREE.Vector3();
    return ray.ray.intersectPlane(plane, hit) ? hit : null;
  }

  // ------------------------------------------------------------ picking & labels

  private toScreen(v: THREE.Vector3): [number, number] {
    const p = v.clone().project(this.camera);
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    return [((p.x + 1) / 2) * w, ((1 - p.y) / 2) * h];
  }

  /** Nearest crystal (base-to-top segment) within a few pixels of a screen point. */
  pick(clientX: number, clientY: number): string | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    let best: string | null = null;
    let bestD = 18;
    for (const b of this.crystals) {
      if (!b.known && b.count === null) continue;
      const [bx, by] = this.toScreen(new THREE.Vector3(b.x, this.landTop, b.z));
      const [tx, ty] = this.toScreen(new THREE.Vector3(b.x, this.landTop + CRYSTAL_BASE + Math.max(b.shown, 8), b.z));
      const t = Math.max(0, Math.min(1, ((x - bx) * (tx - bx) + (y - by) * (ty - by)) / ((tx - bx) ** 2 + (ty - by) ** 2 || 1)));
      const d = Math.hypot(x - (bx + t * (tx - bx)), y - (by + t * (ty - by)));
      if (d < bestD) {
        bestD = d;
        best = b.id;
      }
    }
    return best;
  }

  /** Screen position of each crystal's tip (for HTML labels). */
  anchors(): { id: string; x: number; y: number; height: number; count: number | null }[] {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    const out = [];
    for (const b of this.crystals) {
      const [x, y] = this.toScreen(new THREE.Vector3(b.x, this.landTop + CRYSTAL_BASE + b.shown + 20, b.z));
      if (x < -50 || y < -50 || x > w + 50 || y > h + 50) continue;
      out.push({ id: b.id, x, y, height: b.shown, count: b.count });
    }
    return out;
  }

  onFrame(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  // ------------------------------------------------------------ loop

  invalidate(): void {
    if (this.raf || this.disposed) return;
    this.raf = requestAnimationFrame(() => this.frame());
  }

  private frame(): void {
    this.raf = 0;
    if (this.disposed) return;
    const moving = this.layoutDirty ? this.layout(performance.now()) : false;
    this.layoutDirty = moving;
    this.renderer.render(this.scene, this.camera);
    for (const cb of this.listeners) cb();
    if (moving) this.invalidate();
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose?.();
      const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      for (const m of mats) {
        for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.dispose();
        m.dispose();
      }
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.listeners.clear();
  }
}

export function webglAvailable(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}
