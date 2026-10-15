/** The Canada atlas scene ("Clear Cel", docs/design/atlas-cel). Orbitable orthographic camera
 * over a pale extruded land board with ink coast and province lines. Cities with the highest
 * counts are drawn as round-topped bodies (one revolved profile, shaped per instance in the
 * vertex shader so the cap never stretches) with painted cel shading and a thin ink outline;
 * secondary cities use a sparse, zoom-dependent set of screen-space dots. The render loop only runs while something changes
 * (camera, tween, resize), so an idle map costs nothing. */
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";

import { project } from "../projection";
import { heightFor } from "../scale";
import { CEL } from "./palette";
import { landClearance, separatedRadius } from "./footprints";


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
export interface Anchor {
  id: string;
  /** body tip (or base for dots), base point and on-screen body radius, CSS px */
  x: number;
  y: number;
  bx: number;
  by: number;
  r: number;
  height: number;
  count: number | null;
  body: boolean;
  displaced: boolean;
}
interface Body {
  id: string;
  x: number;
  z: number;
  from: number;
  to: number;
  shown: number;
  count: number | null;
  clearance: number;
  radius: number;
  chartX: number;
  chartZ: number;
}

const MAX_BODIES = CEL.detail.bodyLimit + 2; // plus selected and hovered
const SEGMENTS = 32;
const BODY_RINGS = 4;
const CAP_RINGS = 10;
// Cel light from the upper left of the view, above and a little toward the viewer: the shade is
// a crescent on the right that follows the curved surface and the round top stays lit. Its
// height is fixed; it turns with the camera around the vertical so every angle reads the same.
const LIGHT = new THREE.Vector3(-0.68, 0.65, 0.34).normalize();
const ease = (t: number) => 1 - Math.pow(1 - t, 3);

/** Unit revolved profile: aProf = (profile parameter, angle). Parameter -1 is the bottom
 * centre, -0.5 the bottom rim, 0..1 the side, 1..2 the shoulder arc, 3 the top centre. */
function domeGeometry(segments = SEGMENTS, capRings = CAP_RINGS): THREE.InstancedBufferGeometry {
  const prof: number[] = [];
  const index: number[] = [];
  const ring = (p: number) => {
    const start = prof.length / 2;
    for (let i = 0; i < segments; i++) prof.push(p, (i / segments) * Math.PI * 2);
    return start;
  };
  const params = [
    ...Array.from({ length: BODY_RINGS + 1 }, (_, i) => (i / BODY_RINGS) ** 1.5), // denser at the foot
    ...Array.from({ length: capRings }, (_, i) => 1 + (i + 1) / capRings),
    3,
  ];
  const starts = params.map(ring);
  for (let r = 0; r < starts.length - 1; r++)
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments;
      const a = starts[r]! + i, b = starts[r]! + j, c = starts[r + 1]! + i, d = starts[r + 1]! + j;
      index.push(a, c, b, b, c, d);
    }
  // flat bottom: rim with a downward normal plus the centre
  const rim = ring(-0.5);
  const centre = prof.length / 2;
  prof.push(-1, 0);
  for (let i = 0; i < segments; i++) index.push(centre, rim + i, rim + ((i + 1) % segments));
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute("aProf", new THREE.Float32BufferAttribute(prof, 2));
  // three.js needs a position attribute to size draws; the shader ignores it
  g.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(prof.length * 1.5), 3));
  g.setIndex(index);
  g.setAttribute("iPos", new THREE.InstancedBufferAttribute(new Float32Array(MAX_BODIES * 3), 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute("iH", new THREE.InstancedBufferAttribute(new Float32Array(MAX_BODIES), 1).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute("iR", new THREE.InstancedBufferAttribute(new Float32Array(MAX_BODIES), 1).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute("iLine", new THREE.InstancedBufferAttribute(new Float32Array(MAX_BODIES), 1).setUsage(THREE.DynamicDrawUsage));
  g.instanceCount = 0;
  return g;
}

const DOME_VERTEX = /* glsl */ `
uniform float uR;
uniform float uPx;
attribute vec2 aProf;
attribute vec3 iPos;
attribute float iH;
attribute float iLine;
attribute float iR;
varying vec3 vN;
varying vec3 vV;
varying float vBodyT;
// Profile for a body of height H and base radius uR: a straight side leaning slightly inward
// (more for taller bodies, so the base is a little wider) and a wide round top: an arc tangent
// to the side and to the top whose radius is set by the width, never stretched by H.
void main() {
  float H = max(iH, 1.0);
  float R = min(min(uR, iR), H * 0.62);
  // Same monotone silhouette at every height: broad grounded foot, rounded
  // shoulder, hemispherical cap. Both first derivatives meet at the shoulder.
  float shoulder = R * 0.90;
  float cap = min(shoulder, H * 0.48);
  float stem = H - cap;
  float p = aProf.x;
  float r; float y; vec2 n;
  if (p < 0.0) {
    r = p < -0.75 ? 0.0 : R; y = 0.0; n = vec2(0.0, -1.0);
  } else if (p <= 1.0) {
    float t = p;
    y = t * stem;
    r = mix(R, shoulder, t * (2.0 - t));
    float slope = (shoulder - R) * 2.0 * (1.0 - t) / stem;
    n = normalize(vec2(1.0, -slope));
  } else if (p <= 2.0) {
    float a = (p - 1.0) * 1.5707963;
    r = shoulder * cos(a); y = stem + cap * sin(a);
    n = normalize(vec2(cap * cos(a), shoulder * sin(a)));
  } else {
    r = 0.0; y = H; n = vec2(0.0, 1.0);
  }
  vec3 N = vec3(n.x * cos(aProf.y), n.y, n.x * sin(aProf.y));
  vec3 P = iPos + vec3(r * cos(aProf.y), y, r * sin(aProf.y));
#ifdef OUTLINE
  P += N * iLine * uPx;
#endif
  vBodyT = y / H;
  vN = N;
  vV = normalize(cameraPosition - P);
  gl_Position = projectionMatrix * viewMatrix * vec4(P, 1.0);
}`;

const DOME_FRAGMENT = /* glsl */ `
uniform vec3 uLight;
uniform vec3 uLit;
uniform vec3 uShade;
uniform vec3 uTop;
uniform vec3 uGlow;
uniform vec3 uInk;
varying vec3 vN;
varying vec3 vV;
varying float vBodyT;
void main() {
#ifdef OUTLINE
  gl_FragColor = vec4(uShade, 1.0);
#else
  vec3 n = normalize(vN);
  // A1 painted volume: broad mint face, short softened cel transitions and a
  // light patch following the dome normal, not a horizontal cap or specular stripe.
  vec2 sideNormal = normalize(n.xz + vec2(0.00001));
  // Painted bands continue over the round shoulder instead of a separate lit lid.
  float d = dot(sideNormal, normalize(uLight.xz)) * 0.65 + 0.10
    + 0.20 * sin(vBodyT * 3.14159) - 0.25 * vBodyT + 0.42 * n.y;
  float shadeBand = smoothstep(-0.12, 0.04, d);
  float faceBand = smoothstep(0.22, 0.40, d);
  float glowBand = smoothstep(0.40, 0.82, d);
  vec3 mid = mix(uShade, uLit, 0.51);
  vec3 paint = mix(uShade, mid, shadeBand);
  paint = mix(paint, uLit, faceBand);
  paint = mix(paint, uGlow, glowBand * 0.78);
  // The highlight wraps the upper-left shoulder. Its curved boundary comes from
  // surface normals; it never forms a flat lid or a full-length white stripe.
  vec3 view = normalize(vV);
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), view));
  vec3 up = normalize(cross(view, right));
  vec2 q = vec2(dot(n, right), dot(n, up)) - vec2(-0.38, 0.53);
  vec2 petal = vec2(dot(q, vec2(0.707, -0.707)), dot(q, vec2(0.707, 0.707))) / vec2(0.40, 0.55);
  float crown = (1.0 - smoothstep(0.92, 1.08, length(petal))) * smoothstep(0.03, 0.15, n.y);
  paint *= 0.96 + 0.04 * vBodyT;
  paint = mix(paint, uTop, crown);
  // A fine ink foot and silhouette remain continuous at contact, where the
  // inverted shell would otherwise fall below the land's depth surface.
  float facing = abs(dot(n, normalize(vV)));
  float edge = 1.0 - smoothstep(0.0, max(fwidth(facing) * 1.6, 0.035), facing);
  float foot = 1.0 - smoothstep(fwidth(vBodyT) * 0.4, fwidth(vBodyT) * 1.7, vBodyT);
  paint = mix(paint, uInk, max(edge, foot));
  gl_FragColor = vec4(paint, 1.0);
#endif
  #include <colorspace_fragment>
}`;

/** Broad, quiet ice-cyan variation and directional cut-edge paint. No texture
 * downloads or per-frame geometry: these two batched materials share world space. */
function landPaint(light: THREE.Vector3, side = false): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uBase: { value: new THREE.Color(side ? CEL.landSide : CEL.landLight) }, uLight: { value: light } },
    vertexShader: `varying vec3 vP; varying vec3 vNormal;
      void main() { vP = position; vNormal = normal;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform vec3 uBase; uniform vec3 uLight; varying vec3 vP; varying vec3 vNormal;
      void main() {
        float wave = sin(vP.x * 0.0015 + vP.z * 0.0008) * 0.5
                   + sin(vP.z * 0.0021 - vP.x * 0.0006) * 0.3;
        vec3 paint = uBase;
        ${side ? `float facing = dot(normalize(vNormal), normalize(vec3(uLight.x, 0.0, uLight.z)));
        paint *= 0.91 + 0.16 * facing;
        paint = mix(paint, vec3(0.75,0.89,0.96), 0.17 * clamp(vP.y / 45.0, 0.0, 1.0));
        paint = mix(paint, vec3(0.88,0.98,1.0), smoothstep(41.5, 45.0, vP.y) * 0.40);`
          : `paint += vec3(-0.045, 0.012, 0.020) * wave;`}
        gl_FragColor = vec4(paint, 1.0);
        #include <colorspace_fragment>
      }`,
  });
}

const CONTACT_VERTEX = /* glsl */ `
attribute vec3 iPos; attribute float iH; attribute float iR;
uniform float uR; varying vec2 vUv;
void main() {
  vUv = position.xy;
  float R = min(min(uR, iR), max(iH, 1.0) * 0.62);
  vec3 P = iPos + vec3(position.x * R * 1.16 + R * 0.04, 1.0, position.y * R * 1.16 + R * 0.04);
  gl_Position = projectionMatrix * viewMatrix * vec4(P, 1.0);
}`;
const CONTACT_FRAGMENT = /* glsl */ `
varying vec2 vUv; uniform vec3 uColor;
void main() {
  float r = length(vUv);
  float alpha = (1.0 - smoothstep(0.90, 1.0, r)) * 0.65;
  if (alpha < 0.002) discard;
  gl_FragColor = vec4(uColor, alpha);
  #include <colorspace_fragment>
}`;

/** Screen-space city dots: kind 1 = positive, 2 = zero, 3 = unknown ring. */
const DOT_VERTEX = /* glsl */ `
uniform float uDpr;
uniform float uLift;
attribute float aKind;
attribute float aSize;
varying float vKind;
varying float vR;
void main() {
  vKind = aKind;
  vR = aSize / (aSize + 1.0);
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
  // a sprite has one depth: lift it so the ground just in front does not cut the dot in half
  gl_Position.z -= uLift * gl_Position.w;
  gl_PointSize = aKind < 0.5 ? 0.0 : (aSize * 2.0 + 2.0) * uDpr;
}`;
const DOT_FRAGMENT = /* glsl */ `
uniform vec3 uInk;
uniform vec3 uZero;
uniform vec3 uUnknown;
varying float vKind;
varying float vR;
void main() {
  if (vKind < 0.5) discard; // WebGL may clamp a zero point size to one pixel.
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float d = length(c);
  float edge = fwidth(d);
  float a;
  vec3 col;
  if (vKind > 2.5) {
    a = 1.0 - smoothstep(0.14 - edge, 0.14 + edge, abs(d - vR * 0.8));
    col = uUnknown;
  } else {
    a = 1.0 - smoothstep(vR - edge, vR + edge, d);
    col = vKind > 1.5 ? uZero : uInk;
    // positive cities not drawn as bodies are low-contrast ink dots
    if (vKind < 1.5 && vKind > 0.5) a *= 0.4;
  }
  if (a < 0.01) discard;
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}`;

export class AtlasScene {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.OrthographicCamera;
  private target = new THREE.Vector3();
  private elevation: number = CEL.elevation;
  private azimuth: number = CEL.azimuth;
  private landTop: number = CEL.landDepth;
  /** camera half height at the home fit; zoom is relative to it (1 = home) */
  private homeHalfH = 1000;
  private homeTarget = new THREE.Vector3();
  private zoom = 1;
  private interacted = false;
  private landPoints: THREE.Vector3[] = [];
  private lines: LineMaterial[] = [];
  private bodies: Body[] = [];
  private byId = new Map<string, number>();
  private scaleMax = 1;
  private priority: { id: string; max: number }[] = [];
  private expanded = new Set<string>();
  private visibleDots = new Set<string>();
  private regional = false;
  private frozen = false;
  private settleTimer = 0;
  private selected: string | null = null;
  private hovered: string | null = null;
  private tweenStart = 0;
  private cameraTween: { start: number; fromT: THREE.Vector3; toT: THREE.Vector3; fromZ: number; toZ: number } | null = null;
  /** Bodies and dots need rebuilding when data, selection, hover or zoom change, or while a
   * tween runs; panning and turning only re-render. */
  private layoutDirty = true;
  private raf = 0;
  private disposed = false;
  private listeners = new Set<() => void>();
  private settleListeners = new Set<() => void>();
  private resizeObserver: ResizeObserver;
  private domeGeo = domeGeometry();
  private placementKey = "";
  private clearanceAt: (x: number, y: number) => number = () => 0;
  private contactGeo = new THREE.InstancedBufferGeometry();
  private domeMat: THREE.ShaderMaterial;
  private outlineMat: THREE.ShaderMaterial;
  private dots!: THREE.Points;
  private leaders = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: CEL.inkMuted, transparent: true, opacity: 0.65 }));

  constructor(
    private host: HTMLElement,
    private opts: { reducedMotion: boolean },
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.style.display = "block";
    host.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(CEL.paper);
    this.scene.add(this.leaders);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -20000, 20000);

    const uniforms = {
      uR: { value: CEL.bodyDiameter / 2 },
      uPx: { value: 1 },
      uLight: { value: LIGHT.clone() },
      uLit: { value: new THREE.Color(CEL.dataLight) },
      uTop: { value: new THREE.Color(CEL.dataTop) },
      uGlow: { value: new THREE.Color(CEL.dataGlow) },
      uInk: { value: new THREE.Color(CEL.dataInk) },
      uShade: { value: new THREE.Color(CEL.dataShadow) },
    };
    this.domeMat = new THREE.ShaderMaterial({ uniforms, vertexShader: DOME_VERTEX, fragmentShader: DOME_FRAGMENT });
    this.outlineMat = new THREE.ShaderMaterial({
      uniforms: { ...uniforms, uShade: { value: new THREE.Color(CEL.dataInk) } },
      vertexShader: DOME_VERTEX,
      fragmentShader: DOME_FRAGMENT,
      defines: { OUTLINE: 1 },
      side: THREE.BackSide,
      // The shell must occlude later background surfaces at overlapping silhouettes.
      // Without depth writes the batched fill pass erases foreground ink boundaries.
      depthWrite: true,
      depthTest: true,
    });
    for (const mat of [this.outlineMat, this.domeMat]) {
      const mesh = new THREE.Mesh(this.domeGeo, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = mat === this.outlineMat ? 1.5 : 2;
      this.scene.add(mesh);
    }
    // Ground clearance already reserves >1.4 radii and neighbouring feet have
    // an 18-unit gap; 1.16-radius shadows therefore stay on land and independent.
    const plane = new THREE.PlaneGeometry(2, 2);
    this.contactGeo.index = plane.index;
    this.contactGeo.setAttribute("position", plane.getAttribute("position"));
    for (const name of ["iPos", "iH", "iR"]) this.contactGeo.setAttribute(name, this.domeGeo.getAttribute(name));
    const contact = new THREE.Mesh(this.contactGeo, new THREE.ShaderMaterial({
      uniforms: { uR: uniforms.uR, uColor: { value: new THREE.Color("#4385c1") } },
      vertexShader: CONTACT_VERTEX, fragmentShader: CONTACT_FRAGMENT,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    }));
    contact.frustumCulled = false;
    contact.renderOrder = 1;
    this.scene.add(contact);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
  }

  // ------------------------------------------------------------ geography

  setGeo(geo: GeoData): void {
    const started = performance.now();
    const top = this.landTop;
    const slab = (polys: Polygon[], depth: number, materials: THREE.Material | THREE.Material[]) => {
      const geometries: THREE.BufferGeometry[] = [];
      for (const poly of polys) {
        const shape = new THREE.Shape(poly[0]!.map(([x, y]) => new THREE.Vector2(x, y)));
        for (const hole of poly.slice(1)) shape.holes.push(new THREE.Path(hole.map(([x, y]) => new THREE.Vector2(x, y))));
        const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 1 });
        g.rotateX(-Math.PI / 2);
        geometries.push(g);
      }
      // Batch islands/provinces into one draw per material instead of hundreds of meshes.
      const merged = mergeGeometries(geometries, false);
      if (!merged) return new THREE.Group();
      if (Array.isArray(materials)) {
        const index: number[] = [];
        for (let material = 0; material < materials.length; material++) {
          const start = index.length;
          let offset = 0;
          for (const g of geometries) {
            for (const group of g.groups) if (group.materialIndex === material)
              for (let i = group.start; i < group.start + group.count; i++) index.push(offset + i);
            offset += g.getAttribute("position").count;
          }
          merged.addGroup(start, index.length - start, material);
        }
        merged.setIndex(index);
      }
      for (const g of geometries) g.dispose();
      return new THREE.Mesh(merged, materials);
    };
    const ink = (segments: number[], color: string, width: number) => {
      const g = new LineSegmentsGeometry();
      g.setPositions(segments);
      const m = new LineMaterial({ color, linewidth: width, worldUnits: false });
      m.resolution.set(this.host.clientWidth || 1, this.host.clientHeight || 1);
      this.lines.push(m);
      const line = new LineSegments2(g, m);
      line.renderOrder = 1;
      return line;
    };

    const polys = geo.provinces.flatMap((pr) => pr.polygons);
    this.clearanceAt = landClearance(polys, geo.lakes);
    this.scene.add(slab(polys, top, [landPaint(this.domeMat.uniforms.uLight!.value), landPaint(this.domeMat.uniforms.uLight!.value, true)]));

    // Edges shared by two provinces are borders (drawn once, thin); the rest is coast.
    // Small islands get a lighter coast so the Arctic archipelago never turns into ink blots.
    const key = (a: number[], b: number[]) => (a[0]! < b[0]! || (a[0] === b[0] && a[1]! < b[1]!) ? `${a}|${b}` : `${b}|${a}`);
    const uses = new Map<string, number>();
    for (const poly of polys)
      for (const ring of poly) for (let i = 0; i < ring.length - 1; i++) uses.set(key(ring[i]!, ring[i + 1]!), (uses.get(key(ring[i]!, ring[i + 1]!)) ?? 0) + 1);
    const area = (r: Ring) => Math.abs(r.reduce((s, [x, y], i) => s + x * r[(i + 1) % r.length]![1] - r[(i + 1) % r.length]![0] * y, 0)) / 2;
    const coast: number[] = [], island: number[] = [], border: number[] = [], base: number[] = [];
    for (const poly of polys) {
      const small = area(poly[0]!) < 50_000;
      for (const ring of poly)
        for (let i = 0; i < ring.length - 1; i++) {
          const [a, b] = [ring[i]!, ring[i + 1]!];
          const seg = [a[0], top + 0.6, -a[1], b[0], top + 0.6, -b[1]];
          if (uses.get(key(a, b))! > 1) border.push(...seg);
          else {
            (small ? island : coast).push(...seg);
            base.push(a[0], 0.3, -a[1], b[0], 0.3, -b[1]);
          }
          this.landPoints.push(new THREE.Vector3(a[0], top, -a[1]), new THREE.Vector3(a[0], 0, -a[1]));
        }
    }
    this.scene.add(ink(border, CEL.provinceLine, CEL.line.province));
    this.scene.add(ink(coast, "#5687be", CEL.line.coast));
    this.scene.add(ink(island, "#739dc6", CEL.line.island));
    this.scene.add(ink(base, CEL.inkMuted, CEL.line.province));

    // lakes keep their real shores, a little darker than the land
    const lakes = slab(geo.lakes, 1, new THREE.MeshBasicMaterial({ color: CEL.lake }));
    lakes.position.y = top + 0.1;
    this.scene.add(lakes);
    const shores: number[] = [];
    for (const poly of geo.lakes)
      for (const ring of poly)
        for (let i = 0; i < ring.length - 1; i++) shores.push(ring[i]![0], top + 1.3, -ring[i]![1], ring[i + 1]![0], top + 1.3, -ring[i + 1]![1]);
    this.scene.add(ink(shores, CEL.inkMuted, CEL.line.province));

    this.fitHome(true);
    performance.measure("atlas:geography", { start: started });
  }

  // ------------------------------------------------------------ cities

  setCities(cities: SceneCity[]): void {
    const started = performance.now();
    this.bodies = cities.map((c) => {
      const [x, y] = project(c.lon, c.lat);
      return { id: c.id, x, z: -y, from: 0, to: 0, shown: 0, count: null, clearance: this.clearanceAt(x, y), radius: 0, chartX: x, chartZ: -y };
    });
    this.byId = new Map(this.bodies.map((b, i) => [b.id, i]));
    if (this.dots) {
      this.scene.remove(this.dots);
      this.dots.geometry.dispose();
      (this.dots.material as THREE.Material).dispose();
    }
    const n = this.bodies.length;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.bodies.flatMap((b) => [b.x, this.landTop + 1, b.z]), 3));
    g.setAttribute("aKind", new THREE.Float32BufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("aSize", new THREE.Float32BufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage));
    this.dots = new THREE.Points(
      g,
      new THREE.ShaderMaterial({
        uniforms: {
          uDpr: { value: this.renderer.getPixelRatio() },
          uLift: { value: 0 },
          uInk: { value: new THREE.Color(CEL.ink) },
          uZero: { value: new THREE.Color(CEL.zero) },
          uUnknown: { value: new THREE.Color(CEL.unknown) },
        },
        vertexShader: DOT_VERTEX,
        fragmentShader: DOT_FRAGMENT,
        transparent: true,
      }),
    );
    this.dots.frustumCulled = false;
    this.dots.renderOrder = 3;
    this.scene.add(this.dots);
    performance.measure("atlas:cities", { start: started });
    this.expanded.clear();
    this.layoutDirty = true;
    this.invalidate();
  }

  /** New counts; heights tween from what is shown now (only real changes move). */
  setCounts(counts: Map<string, number | null>, scaleMax: number, priority?: { id: string; max: number }[]): void {
    if (priority) this.priority = priority;
    const firstData = !this.bodies.some(b => b.count != null);
    const rescaled = scaleMax !== this.scaleMax;
    this.scaleMax = scaleMax;
    for (const b of this.bodies) {
      const c = counts.has(b.id) ? counts.get(b.id)! : null;
      b.count = c;
      b.from = b.shown;
      b.to = heightFor(c, scaleMax);
      if (firstData) b.shown = b.from = b.to;
    }
    this.tweenStart = performance.now();
    this.layoutDirty = true;
    if (rescaled) this.fitHome(!this.interacted);
    if (!this.frozen) this.updateDetail();
    this.invalidate();
  }

  /** Stable drawing order for the level of detail: highest known count in the loaded data
   * first (ties by city id). Frozen by the caller during playback. */
  setPriority(list: { id: string; max: number }[]): void {
    this.priority = list;
    this.fitHome(!this.interacted);
    this.updateDetail();
  }

  /** While playing, the expanded set does not follow each frame's counts. */
  setFrozen(frozen: boolean): void {
    this.frozen = frozen;
    if (!frozen) this.updateDetail();
  }

  setSelected(id: string | null): void {
    this.selected = id;
    this.updateFootprints();
    this.layoutDirty = true;
    this.invalidate();
  }

  setHovered(id: string | null): void {
    if (id === this.hovered) return;
    this.hovered = id;
    this.updateFootprints();
    this.layoutDirty = true;
    this.invalidate();
  }

  /** Hundreds of positive cities stay present through rotation and zoom. Only labels and zero/unknown
   * markers use screen-space detail; overlap is resolved by the depth buffer, not deletion. */
  private updateDetail(): void {
    const d = CEL.detail;
    if (this.zoom >= d.enterRegional) this.regional = true;
    else if (this.zoom < d.exitRegional) this.regional = false;
    const w = this.host.clientWidth, h = this.host.clientHeight;
    // A stable, data-ranked set of hundreds, independent of camera/overlap. No view-angle
    // deletion or zoom gate. Selection can still expose any other city from the full dataset.
    const rankedBodies = this.priority.length
      ? this.priority.map(p => this.bodies[this.byId.get(p.id) ?? -1]).filter((b): b is Body => !!b && b.to > 0)
      : this.bodies.filter(b => b.to > 0).sort((a, b) => b.to - a.to);
    const placementKey = rankedBodies.map(b => `${b.id}:${Math.round(b.to)}`).join("|");
    if (placementKey !== this.placementKey) {
    const placementStarted = performance.now();
    this.placementKey = placementKey;
    const spaced: Body[] = [];
    for (const b of this.bodies) { b.chartX = b.x; b.chartZ = b.z; b.radius = 0; }
    for (const [rank, b] of rankedBodies.entries()) {
      if (spaced.length >= CEL.detail.bodyLimit) break;
      // A few major centres need a legible round body rather than a coast-clipped needle.
      // Their geographic anchor stays fixed; a short ground leader explicitly discloses
      // any chart displacement. All placements are geographic and frozen across rotation.
      const nominal = 42;
      const candidates: [number, number][] = [[b.x, b.z]];
      for (let distance = 24; distance <= (rank < 24 ? 144 : 48); distance += 24)
        for (let angle = 0; angle < 16; angle++) candidates.push([b.x + distance * Math.cos(angle * Math.PI / 8), b.z + distance * Math.sin(angle * Math.PI / 8)]);
      const sizes = [nominal, 32, 24, 16];
      let placed = false;
      for (const size of sizes) {
        for (const [x, z] of candidates) {
          const radius = size;
          if (spaced.some(other => Math.hypot(x - other.chartX, z - other.chartZ) < radius + other.radius + 18)) continue;
          if (this.clearanceAt(x, -z) < radius / 0.7) continue;
          b.chartX = x; b.chartZ = z; b.radius = radius;
          spaced.push(b); placed = true; break;
        }
        if (placed) break;
      }
    }
    const next = new Set(spaced.map(b => b.id));
    this.expanded = next;
    this.updateFootprints();
    performance.measure("atlas:placement", { start: placementStarted });
    }
    const next = this.expanded;
    // Stable priority plus screen-space spacing prevents thousands of city points becoming
    // a second heatmap. Hidden cities remain in the searchable dataset, not moved/aggregated.
    const dotGap = this.regional ? 16 : 30;
    const dotLimit = this.regional ? 180 : 64;
    const cells = new Map<string, [number, number][]>();
    const occupy = (x: number, y: number) => {
      const key = `${Math.floor(x / dotGap)},${Math.floor(y / dotGap)}`;
      const cell = cells.get(key) ?? [];
      cell.push([x, y]);
      cells.set(key, cell);
    };
    const crowded = (x: number, y: number) => {
      const gx = Math.floor(x / dotGap), gy = Math.floor(y / dotGap);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++)
        if (cells.get(`${gx + dx},${gy + dy}`)?.some(([ox, oy]) => (ox - x) ** 2 + (oy - y) ** 2 < dotGap ** 2)) return true;
      return false;
    };
    for (const b of this.bodies) if (next.has(b.id)) occupy(...this.toScreen(b.x, this.landTop, b.z));
    this.visibleDots.clear();
    const ranked = [...new Set([...this.priority.map(p => p.id), ...this.bodies.map(b => b.id)])];
    for (const id of ranked) {
      if (this.visibleDots.size >= dotLimit) break;
      if (next.has(id)) continue;
      const b = this.bodies[this.byId.get(id) ?? -1];
      if (!b || b.clearance <= 0) continue;
      const [x, y] = this.toScreen(b.x, this.landTop, b.z);
      if (x < 8 || y < 8 || x > w - 8 || y > h - 8) continue;
      if (crowded(x, y)) continue;
      occupy(x, y);
      this.visibleDots.add(id);
    }
    this.layoutDirty = true;
    this.invalidate();
    for (const cb of this.settleListeners) cb();
  }

  private updateFootprints(): void {
    const segments: number[] = [];
    for (const b of this.bodies) {
      if (!this.expanded.has(b.id)) {
        b.chartX = b.x; b.chartZ = b.z; b.radius = 0;
        if ((b.id === this.selected || b.id === this.hovered) && b.to > 0) {
          let nearest = Infinity;
          for (const other of this.bodies) if (this.expanded.has(other.id)) nearest = Math.min(nearest, Math.hypot(b.x - other.chartX, b.z - other.chartZ) - other.radius);
          b.radius = separatedRadius(b.clearance, nearest, 22);
        }
      }
      if (b.radius > 0 && Math.hypot(b.x - b.chartX, b.z - b.chartZ) > 1)
        segments.push(b.x, this.landTop + 2, b.z, b.chartX, this.landTop + 2, b.chartZ);
    }
    this.leaders.geometry.dispose();
    this.leaders.geometry = new THREE.BufferGeometry();
    this.leaders.geometry.setAttribute("position", new THREE.Float32BufferAttribute(segments, 3));
  }

  private isBody(b: Body): boolean {
    return b.shown > 0 && b.radius > 0 && (this.expanded.has(b.id) || b.id === this.selected || b.id === this.hovered);
  }

  private layout(now: number): boolean {
    if (!this.dots) return false;
    const R = this.bodyRadius();
    const px = this.worldPerPx();
    this.domeMat.uniforms.uR!.value = R;
    this.domeMat.uniforms.uPx!.value = px;
    // about 6 px of ground in depth units (the camera's depth range is 40 000)
    (this.dots.material as THREE.ShaderMaterial).uniforms.uLift!.value = (6 * px) / 20000;
    const pos = this.domeGeo.getAttribute("iPos") as THREE.InstancedBufferAttribute;
    const radii = this.domeGeo.getAttribute("iR") as THREE.InstancedBufferAttribute;
    const hAttr = this.domeGeo.getAttribute("iH") as THREE.InstancedBufferAttribute;
    const lineAttr = this.domeGeo.getAttribute("iLine") as THREE.InstancedBufferAttribute;
    const kind = this.dots.geometry.getAttribute("aKind") as THREE.BufferAttribute;
    const size = this.dots.geometry.getAttribute("aSize") as THREE.BufferAttribute;
    let moving = false;
    let n = 0;
    this.bodies.forEach((b, i) => {
      const t = this.opts.reducedMotion ? 1 : Math.min(1, Math.max(0, (now - this.tweenStart) / CEL.motion.height));
      if (t < 1) moving = true;
      b.shown = b.from + (b.to - b.from) * ease(t);
      const marked = b.id === this.selected || b.id === this.hovered;
      if (this.isBody(b) && n < MAX_BODIES) {
        pos.setXYZ(n, b.chartX, this.landTop, b.chartZ);
        hAttr.setX(n, b.shown);
        const radius = Math.min(R, b.radius);
        radii.setX(n, b.radius);
        lineAttr.setX(n, Math.min(marked ? CEL.line.selected : CEL.line.data, radius / px * 0.22));
        n++;
        const displaced = Math.hypot(b.chartX - b.x, b.chartZ - b.z) > 1;
        kind.setX(i, displaced ? 1 : 0);
        size.setX(i, displaced ? 2.5 : 0);
        return;
      }
      if (!marked && !this.visibleDots.has(b.id)) {
        kind.setX(i, 0);
        return;
      }
      if (b.count == null) {
        kind.setX(i, 3);
        size.setX(i, marked ? 4 : 2.5);
      } else if (b.count === 0) {
        kind.setX(i, 2);
        size.setX(i, marked ? 3 : 1.5);
      } else {
        kind.setX(i, 1);
        size.setX(i, marked ? 3.5 : 2);
      }
    });
    this.domeGeo.instanceCount = n;
    this.contactGeo.instanceCount = n;
    pos.needsUpdate = radii.needsUpdate = hAttr.needsUpdate = lineAttr.needsUpdate = true;
    kind.needsUpdate = size.needsUpdate = true;
    return moving;
  }

  // ------------------------------------------------------------ camera

  private worldPerPx(): number {
    return (this.camera.top - this.camera.bottom) / (this.host.clientHeight || 1);
  }

  /** Narrow common footprint keeps hundreds of bodies readable; height still encodes count. */
  private bodyRadius(): number {
    return CEL.bodyDiameter / 2;
  }

  private resize(): void {
    const w = this.host.clientWidth || 1;
    const h = this.host.clientHeight || 1;
    // Preserve native resolution on Retina displays and when moving between displays.
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.setSize(w, h, false);
    if (this.dots) (this.dots.material as THREE.ShaderMaterial).uniforms.uDpr!.value = this.renderer.getPixelRatio();
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    for (const m of this.lines) m.resolution.set(w, h);
    this.fitHome(!this.interacted);
    this.layoutDirty = true;
    this.scheduleSettle();
    this.invalidate();
  }

  private basis(el: number, az: number) {
    const e = (el * Math.PI) / 180, a = (az * Math.PI) / 180;
    const dir = new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e));
    const right = new THREE.Vector3(Math.cos(a), 0, -Math.sin(a));
    const up = new THREE.Vector3().crossVectors(dir, right);
    return { dir, right, up };
  }

  /** Home view: the real land points and the tips of the top bodies fit the safe rectangle at
   * the default angle. Moves the camera only when `apply` (before the user takes over). */
  private fitHome(apply: boolean): void {
    if (!this.landPoints.length) return;
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
    const mobile = w < 760;
    const [sx, sy, sw, sh] = mobile ? CEL.safeMobile : CEL.safeDesktop;
    const [cx, cy] = mobile ? [sx + sw / 2, sy + sh / 2] : CEL.centreDesktop;
    const homeAzimuth = CEL.azimuth;
    const homeElevation = CEL.elevation;
    const { dir, right, up } = this.basis(homeElevation, homeAzimuth);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    const add = (p: THREE.Vector3) => {
      const u = p.dot(right), v = p.dot(up);
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    };
    this.landPoints.forEach(add);
    for (const p of this.priority) {
      const b = this.bodies[this.byId.get(p.id) ?? -1];
      if (b) add(new THREE.Vector3(b.x, this.landTop + heightFor(p.max, this.scaleMax), b.z));
    }
    const k = Math.max((u1 - u0) / (sw * w), (v1 - v0) / (sh * h)); // world units per px
    this.homeHalfH = (k * h) / 2;
    // place the bounds' centre at the target centre, but keep them inside the safe rectangle
    const halfW = (u1 - u0) / k / 2, halfV = (v1 - v0) / k / 2;
    const px = THREE.MathUtils.clamp(cx * w, sx * w + halfW, (sx + sw) * w - halfW);
    const py = THREE.MathUtils.clamp(cy * h, sy * h + halfV, (sy + sh) * h - halfV);
    const uc = (u0 + u1) / 2 - (px - w / 2) * k;
    const vc = (v0 + v1) / 2 + (py - h / 2) * k;
    const q = right.clone().multiplyScalar(uc).addScaledVector(up, vc);
    this.homeTarget.copy(q.addScaledVector(dir, (this.landTop - q.y) / dir.y));
    if (apply) {
      this.target.copy(this.homeTarget);
      this.zoom = 1;
      this.elevation = homeElevation;
      this.azimuth = homeAzimuth;
    }
    this.updateCamera();
  }

  /** light and contact-shadow direction for the current camera turn */
  private turn = 0;

  private updateCamera(): void {
    this.turn = ((this.azimuth - CEL.azimuth) * Math.PI) / 180;
    (this.domeMat.uniforms.uLight!.value as THREE.Vector3).copy(LIGHT).applyAxisAngle(THREE.Object3D.DEFAULT_UP, this.turn);
    const aspect = (this.host.clientWidth || 1) / (this.host.clientHeight || 1);
    const halfH = this.homeHalfH / this.zoom;
    this.camera.left = -halfH * aspect;
    this.camera.right = halfH * aspect;
    this.camera.top = halfH;
    this.camera.bottom = -halfH;
    const { dir } = this.basis(this.elevation, this.azimuth);
    this.camera.position.copy(this.target).addScaledVector(dir, 8000);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.target);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    this.domeMat.uniforms.uPx!.value = this.worldPerPx();
    this.domeMat.uniforms.uR!.value = this.bodyRadius();
  }

  /** A user camera move: stop auto-fitting, keep the body set until the camera settles. */
  private moved(): void {
    this.interacted = true;
    this.cameraTween = null;
    this.updateCamera();
    this.scheduleSettle();
    this.invalidate();
  }

  private scheduleSettle(): void {
    clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(() => !this.disposed && this.updateDetail(), CEL.detail.settleMs);
  }

  /** Orbit around the map target, keeping the land readable. */
  rotate(dx: number, dy = 0): void {
    this.azimuth = (this.azimuth - dx * 0.28) % 360;
    this.elevation = THREE.MathUtils.clamp(this.elevation + dy * 0.2, 24, 75);
    this.moved();
  }

  /** Pan by a screen delta (pixels). */
  pan(dx: number, dy: number): void {
    const perPx = this.worldPerPx();
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    const groundUp = new THREE.Vector3(up.x, 0, up.z).normalize();
    const el = (this.elevation * Math.PI) / 180;
    this.target.addScaledVector(right, -dx * perPx).addScaledVector(groundUp, (dy * perPx) / Math.sin(el));
    this.moved();
  }

  /** Zoom by a factor around a screen point (keeps the point under the cursor). */
  zoomAt(factor: number, clientX?: number, clientY?: number): void {
    const before = clientX === undefined ? null : this.groundAt(clientX, clientY!);
    this.zoom = Math.min(24, Math.max(0.8, this.zoom * factor));
    this.layoutDirty = true;
    this.updateCamera();
    if (before) {
      const after = this.groundAt(clientX!, clientY!);
      if (after) this.target.add(before.sub(after));
    }
    this.moved();
  }

  resetView(): void {
    this.interacted = false;
    this.cameraTween = null;
    this.fitHome(true);
    this.scheduleSettle();
    this.invalidate();
  }

  /** Bring a city into view, with its whole body and label (320 ms ease, none when reduced). */
  focusCity(id: string, zoom = 3): void {
    const i = this.byId.get(id);
    if (i === undefined) return;
    const b = this.bodies[i]!;
    const h = Math.max(b.to, b.shown);
    let toZ = Math.max(this.zoom, zoom);
    // the projected body must fit in about half the screen height
    const projected = h * Math.cos((this.elevation * Math.PI) / 180);
    if (projected > (this.homeHalfH / toZ) * 1.0) toZ = Math.max(1, this.homeHalfH / projected);
    const toT = new THREE.Vector3(b.x, this.landTop + h / 2, b.z);
    this.interacted = true;
    if (this.opts.reducedMotion) {
      this.target.copy(toT);
      this.zoom = toZ;
      this.updateCamera();
      this.scheduleSettle();
    } else {
      this.cameraTween = { start: performance.now(), fromT: this.target.clone(), toT, fromZ: this.zoom, toZ };
    }
    this.invalidate();
  }

  private stepCamera(now: number): boolean {
    const tw = this.cameraTween;
    if (!tw) return false;
    const t = Math.min(1, (now - tw.start) / CEL.motion.focus);
    const e = ease(t);
    this.target.lerpVectors(tw.fromT, tw.toT, e);
    this.zoom = tw.fromZ + (tw.toZ - tw.fromZ) * e;
    this.updateCamera();
    if (t < 1) return true;
    this.cameraTween = null;
    this.scheduleSettle();
    return false;
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

  private toScreen(x: number, y: number, z: number): [number, number] {
    const p = new THREE.Vector3(x, y, z).project(this.camera);
    return [((p.x + 1) / 2) * this.host.clientWidth, ((1 - p.y) / 2) * this.host.clientHeight];
  }

  /** Nearest body (base-to-top) or city dot within a few pixels of a screen point. */
  pick(clientX: number, clientY: number): string | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const rPx = this.bodyRadius() / this.worldPerPx();
    let best: string | null = null;
    let bestD = 8;
    for (const b of this.bodies) {
      if (!this.isBody(b) && !this.visibleDots.has(b.id) && b.id !== this.selected && b.id !== this.hovered) continue;
      const [bx, by] = this.toScreen(this.isBody(b) ? b.chartX : b.x, this.landTop, this.isBody(b) ? b.chartZ : b.z);
      if (this.isBody(b) && Math.hypot(b.x - b.chartX, b.z - b.chartZ) > 1) {
        const [ax, ay] = this.toScreen(b.x, this.landTop, b.z);
        const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2 || 1)));
        const leaderDistance = Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay));
        if (leaderDistance < bestD) { bestD = leaderDistance; best = b.id; }
      }
      if (Math.abs(x - bx) > 60 || y > by + 20) continue;
      let d: number;
      if (this.isBody(b)) {
        const [tx, ty] = this.toScreen(b.chartX, this.landTop + b.shown, b.chartZ);
        const t = Math.max(0, Math.min(1, ((x - bx) * (tx - bx) + (y - by) * (ty - by)) / ((tx - bx) ** 2 + (ty - by) ** 2 || 1)));
        d = Math.max(0, Math.hypot(x - (bx + t * (tx - bx)), y - (by + t * (ty - by))) - Math.min(rPx, b.radius / this.worldPerPx()) * 0.85);
      } else {
        if (!this.visibleDots.has(b.id) && b.id !== this.selected && b.id !== this.hovered) continue;
        d = Math.hypot(x - bx, y - by);
      }
      if (d < bestD) {
        bestD = d;
        best = b.id;
      }
    }
    return best;
  }

  /** Screen positions of every city on screen (for HTML labels and tests). */
  anchors(ids?: ReadonlySet<string>): Anchor[] {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    const r = this.bodyRadius() / this.worldPerPx();
    const out: Anchor[] = [];
    for (const b of this.bodies) {
      if (ids && !ids.has(b.id)) continue;
      const [bx, by] = this.toScreen(b.x, this.landTop, b.z);
      if (bx < -50 || by < -50 || bx > w + 50 || by > h + 50) continue;
      const body = this.isBody(b);
      // labels are placed when bodies settle, possibly before they have grown: use the target
      const tall = (this.expanded.has(b.id) || body) && b.to > 0 ? Math.max(b.shown, b.to) : 0;
      const [x, y] = tall ? this.toScreen(b.chartX, this.landTop + tall, b.chartZ) : [bx, by];
      out.push({ id: b.id, x, y, bx, by, r: body ? Math.min(r, b.radius / this.worldPerPx()) : r, height: b.shown, count: b.count, body, displaced: Math.hypot(b.chartX - b.x, b.chartZ - b.z) > 1 });
    }
    return out;
  }

  /** Cities drawn as bodies in priority order, and whether the regional level is on. */
  detail(): { expanded: string[]; dots: string[]; regional: boolean } {
    return { expanded: this.priority.map((p) => p.id).filter((id) => this.expanded.has(id)), dots: [...this.visibleDots], regional: this.regional };
  }

  /** Data priority is independent of whether a coastal city fits a physical body. */
  labelCandidates(): string[] { return this.priority.map(p => p.id); }

  /** World-space footprint audit, also useful to verify rendered boundary/spacing invariants. */
  footprints(): { id: string; x: number; z: number; radius: number; clearance: number }[] {
    return this.bodies.filter(b => this.isBody(b)).map(b => ({ id: b.id, x: b.chartX, z: b.chartZ, radius: Math.min(this.bodyRadius(), b.radius), clearance: this.clearanceAt(b.chartX, -b.chartZ) }));
  }

  onFrame(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Called when the body set is rebuilt (camera settled, new data or priority). */
  onSettle(cb: () => void): () => void {
    this.settleListeners.add(cb);
    return () => this.settleListeners.delete(cb);
  }

  // ------------------------------------------------------------ loop

  invalidate(): void {
    if (this.raf || this.disposed) return;
    this.raf = requestAnimationFrame(() => this.frame());
  }

  private frame(): void {
    this.raf = 0;
    if (this.disposed) return;
    const now = performance.now();
    const panning = this.stepCamera(now);
    const moving = this.layoutDirty ? this.layout(now) : false;
    this.layoutDirty = moving;
    this.renderer.render(this.scene, this.camera);
    for (const cb of this.listeners) cb();
    if (moving || panning) this.invalidate();
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.settleTimer);
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
    this.domeGeo.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.listeners.clear();
    this.settleListeners.clear();
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
