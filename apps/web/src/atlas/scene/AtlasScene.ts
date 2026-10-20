/** The Canada atlas scene ("Clear Cel", docs/design/atlas-cel). Orbitable orthographic camera
 * over a pale extruded land board with ink coast and province lines. Every city with postings
 * is drawn as a round-topped body (one revolved profile, shaped per instance in the vertex
 * shader so the cap never stretches) with painted cel shading and a thin ink outline; cities
 * with zero or unknown counts are not drawn (search reaches them). The render loop only runs
 * while something changes (camera, tween, resize), so an idle map costs nothing. */
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";

import { project } from "../projection";
import { heightFor, MAX_HEIGHT } from "../scale";
import { CEL } from "./palette";
import { landClearance, landField, separatedRadius } from "./footprints";


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
  /** body tip (or base when not drawn), base point and on-screen body radius, CSS px */
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

const MAX_BODIES = (CEL.detail.bodyLimit + 2) * 2; // old and new placements, including selected and hovered
/** Camera limits. The deepest zoom is set by geography: at 6× the GTA cities (Toronto,
 * Mississauga, Brampton, Vaughan, Markham) stand clearly apart as separate bodies (measured;
 * they separate from 2.25×). */
const ZOOM_MAX = 6;

const ELEVATION_MIN = 30;
const ELEVATION_MAX = 60;
/** Rubber band beyond a limit during a gesture: the overshoot grows ever more slowly towards
 * these bounds (zoom factor, pan as a share of the view, degrees), then springs back over
 * SPRING_MS when released. */
const RUBBER_ZOOM = Math.log(1.15);
const RUBBER_PAN = 0.12;
const RUBBER_ANGLE = 6;
const SPRING_MS = 250;
/** iOS-style rubber band: follows 1:1 at first, never passes `limit` */
const rubber = (x: number, limit: number) => Math.sign(x) * limit * (1 - 1 / ((Math.abs(x) * 0.55) / limit + 1));

interface CameraState {
  target: THREE.Vector3;
  zoom: number;
  az: number;
  el: number;
}

/** Run `cb` in a short slice of main-thread time: when the browser is idle, or soon if `urgent`
 * (Safari has no requestIdleCallback). */
type Deadline = { timeRemaining(): number };
function slice(cb: (d: Deadline) => void, urgent = false): void {
  if (urgent || !window.requestIdleCallback)
    window.setTimeout(() => {
      const end = performance.now() + 8;
      cb({ timeRemaining: () => end - performance.now() });
    }, 0);
  else window.requestIdleCallback(cb, { timeout: 500 });
}

/** Detail level for a zoom: steps of 1.5× (1, 1.5, 2.25, …). */
const levelFor = (zoom: number) => Math.pow(1.5, Math.floor(Math.log(zoom + 1e-9) / Math.log(1.5)));

/** Zoom interpolates linearly in 1/zoom (the view's scale) alongside the target, so a point the
 * two states share on screen (the pointer of a zoom) stays put all the way. */
function lerpState(a: CameraState, b: CameraState, t: number): CameraState {
  return {
    target: a.target.clone().lerp(b.target, t),
    zoom: 1 / (1 / a.zoom + (1 / b.zoom - 1 / a.zoom) * t),
    az: a.az + (b.az - a.az) * t,
    el: a.el + (b.el - a.el) * t,
  };
}
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
export function domeGeometry(segments = SEGMENTS, capRings = CAP_RINGS): THREE.InstancedBufferGeometry {
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
  g.setAttribute("iBase", new THREE.InstancedBufferAttribute(new Float32Array(MAX_BODIES), 1).setUsage(THREE.DynamicDrawUsage));
  g.instanceCount = 0;
  return g;
}

export const DOME_VERTEX = /* glsl */ `
uniform float uR;
uniform float uPx;
uniform float uCompare;
attribute vec2 aProf;
attribute vec3 iPos;
attribute float iH;
attribute float iLine;
attribute float iR;
attribute float iBase;
varying float vBase;
varying float vHeight;
varying vec3 vN;
varying vec3 vV;
varying float vBodyT;
varying vec3 vLocal;
varying float vRadius;
varying float vFaceX;
// Profile for a body of height H and base radius uR: a straight side leaning slightly inward
// (more for taller bodies, so the base is a little wider) and a wide round top: an arc tangent
// to the side and to the top whose radius is set by the width, never stretched by H.
void main() {
  vBase = iBase; vHeight = iH;
  // A single shared shell reaches the larger value during comparison.
  float H = max(mix(iH, max(iH, iBase), uCompare), 1.0);
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
  vLocal = vec3(r * cos(aProf.y), y, r * sin(aProf.y));
  vRadius = R;
  vFaceX = dot(vLocal, vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]));
  vec3 P = iPos + vLocal;
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
uniform float uCompare;
varying float vBase;
varying float vHeight;
varying vec3 vN;
varying vec3 vV;
varying float vBodyT;
varying vec3 vLocal;
varying float vRadius;
varying float vFaceX;
void main() {
#ifdef OUTLINE
  vec3 paint = uShade;
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
#endif
  // The shorter period is painted into the front face of this one shell.
  // View-facing coordinates keep both outer rails readable through map rotation.
  float grayAmount = 0.0;
  if (vBase >= 0.0 && abs(vBase - vHeight) > 0.1 && uCompare > 0.0) {
    float shorter = min(vBase, vHeight);
    float inset = 0.0;
    float seam = 0.0;
#ifndef OUTLINE
    if (shorter > 0.0) {
      float x = vFaceX;
      float width = vRadius * 0.60;
      float cap = min(width, shorter * 0.48);
      // Rounded face patch; its bottom and top are the actual two data levels.
      vec2 q = vec2(abs(x) - width + cap, abs(vLocal.y - shorter * 0.5) - shorter * 0.5 + cap);
      float distance = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - cap;
      float pixel = max(fwidth(distance), 0.01);
      inset = 1.0 - smoothstep(-pixel * 0.5, pixel * 0.5, distance);
      seam = (1.0 - smoothstep(pixel * 0.2, pixel * 1.0, abs(distance))) * 0.55;
      // A soft shoulder glint belongs to the inset surface, not a second dome mesh.
      vec2 glint = vec2((x + width * 0.26) / (width * 0.44), (vLocal.y - shorter + cap * 0.55) / (cap * 0.28));
      float highlight = (1.0 - smoothstep(0.65, 1.05, length(glint))) * inset;
      paint = mix(paint, uTop, highlight * uCompare * 0.9);
    }
#endif
    grayAmount = (vBase > vHeight ? 1.0 - inset : inset) * uCompare;
#ifndef OUTLINE
    paint = mix(paint, uInk, seam * uCompare);
#endif
  }
  float gray = dot(paint, vec3(0.2126, 0.7152, 0.0722));
  paint = mix(paint, vec3(gray), grayAmount);
  gl_FragColor = vec4(paint, 1.0);
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
  private gesture = false;
  private releaseTimer = 0;
  /** a gesture's camera before the rubber band (null when no gesture is stretching it) */
  private raw: CameraState | null = null;
  /** the eased limits correction of the gesture in progress */
  private correction: THREE.Vector3 | null = null;
  /** the screen point of the last zoom, the anchor of a zoom spring-back */
  private zoomPoint: [number, number] | null = null;
  private wheelLock = 0;
  private anim: { start: number; ms: number; from: CameraState; to: CameraState } | null = null;
  private landPoints: THREE.Vector3[] = [];
  private extentCache: { el: number; az: number; count: number; bounds: [number, number, number, number] } | null = null;
  private land: ReturnType<typeof landField> | null = null;
  private landPolys: Polygon[] = [];
  private landDistance() {
    return (this.land ??= landField(this.landPolys));
  }
  private lines: LineMaterial[] = [];
  private bodies: Body[] = [];
  private byId = new Map<string, number>();
  private scaleMax = 1;
  private priority: { id: string; max: number }[] = [];
  private expanded = new Set<string>();
  private regional = false;
  private frozen = false;
  private interactionLocked = false;
  private comparison: { key: string; baseline: Map<string, number | null>; visible: boolean } | null = null;
  private compareStarted = 0;
  private compareMat: THREE.ShaderMaterial;
  setInteractionLocked(value: boolean): void {
    const wasLocked = this.interactionLocked;
    this.interactionLocked = value;
    if (value) { this.anim = null; this.raw = null; clearTimeout(this.releaseTimer); }
    if (wasLocked && !value && this.comparison) {
      // Numeric frames stay exact; settle the visual tween immediately on pause/end.
      for (const body of this.bodies) body.shown = body.from = body.to;
      this.layoutDirty = true;
      this.invalidate();
    }
  }
  setComparison(value: { key: string; baseline: Map<string, number | null>; visible: boolean } | null): void {
    if (value?.key === this.comparison?.key && value?.visible === this.comparison?.visible) return;
    this.comparison = value;
    this.compareStarted = performance.now();
    this.layoutDirty = true;
    this.invalidate();
  }
  replayReady(): boolean { return this.placements.has(this.level) && !this.layoutDirty && this.bodies.length > 0; }
  private settleTimer = 0;
  private selected: string | null = null;
  private hovered: string | null = null;
  private tweenStart = 0;
  /** Bodies need rebuilding when data, selection, hover or zoom change, or while a
   * tween runs; panning and turning only re-render. */
  private layoutDirty = true;
  /** Rendered footprints converge independently of the exact placement audit. */
  private visual = new Map<string, { x: number; z: number; radius: number }>();
  private layoutTime = 0;
  private raf = 0;
  private disposed = false;
  private listeners = new Set<() => void>();
  private settleListeners = new Set<() => void>();
  private resizeObserver: ResizeObserver;
  private domeGeo = domeGeometry();
  private placementKey = "";
  /** placements per detail level for the current data (placementData) */
  private placements = new Map<number, Map<string, [number, number, number]>>();
  private placementData = "";
  private precomputing = new Map<number, { steps: Generator<void, void>; done: (() => void)[] }>();
  /** detail level: footprints, spacing and search distances are divided by it, so zooming in
   * by 1.5× frees room for more cities while bodies keep a similar size on screen */
  private level = 1;
  private clearanceAt: (x: number, y: number) => number = () => 0;
  private contactGeo = new THREE.InstancedBufferGeometry();
  private domeMat: THREE.ShaderMaterial;
  private outlineMat: THREE.ShaderMaterial;
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
    this.leaders.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX_BODIES * 6), 3).setUsage(THREE.DynamicDrawUsage));
    this.leaders.geometry.setDrawRange(0, 0);
    this.leaders.frustumCulled = false;
    this.scene.add(this.leaders);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -20000, 20000);

    const uniforms = {
      uCompare: { value: 0 },
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
    // Comparison reuses the solid shell and its ink pass: no duplicate geometry.
    this.compareMat = this.domeMat;
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
    // The land's distance field only matters once zoomed in near a coast: build it when the
    // browser is idle (or on first need) instead of during the first paint.
    this.landPolys = polys;
    this.land = null;
    slice(() => !this.disposed && this.landDistance());
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
    this.visual.clear();
    this.bodies = cities.map((c) => {
      const [x, y] = project(c.lon, c.lat);
      return { id: c.id, x, z: -y, from: 0, to: 0, shown: 0, count: null, clearance: this.clearanceAt(x, y), radius: 0, chartX: x, chartZ: -y };
    });
    this.byId = new Map(this.bodies.map((b, i) => [b.id, i]));
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
      if (firstData || (this.comparison && !this.interactionLocked)) b.shown = b.from = b.to;
    }
    this.tweenStart = performance.now();
    this.layoutDirty = true;
    if (rescaled) this.fitHome(!this.interacted);
    if (!this.frozen || (this.comparison && this.placementKey !== `${this.level}|replay:${this.comparison.key}`)) this.updateDetail();
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

  /** Cities with postings become bodies in data-rank order wherever a footprint fits on land
   * without touching another; the rest appear as zooming in frees room (no dots, no overlap).
   * The set is independent of the view angle, so it holds through rotation. */
  private updateDetail(): void {
    const d = CEL.detail;
    if (this.zoom >= d.enterRegional) this.regional = true;
    else if (this.zoom < d.exitRegional) this.regional = false;
    const level = levelFor(this.zoom);
    const ranked = this.rankedBodies();
    const dataKey = this.comparison ? `replay:${this.comparison.key}` : ranked.map(b => `${b.id}:${Math.round(b.to)}`).join("|");
    if (dataKey !== this.placementData) {
      this.placementData = dataKey;
      this.placements.clear();
      this.precomputing.clear(); // jobs for the old data stop on their own
    }
    const placementKey = `${level}|${dataKey}`;
    if (placementKey !== this.placementKey) {
      // Not computed yet: compute in slices that leave the main thread free, keep the current
      // bodies meanwhile, and apply it when done.
      const placed = this.placements.get(level);
      if (!placed) return this.precompute(level, ranked, dataKey, () => this.updateDetail());
      this.placementKey = placementKey;
      this.level = level;
      for (const b of this.bodies) { b.chartX = b.x; b.chartZ = b.z; b.radius = 0; }
      for (const [id, [x, z, radius]] of placed) {
        const b = this.bodies[this.byId.get(id)!]!;
        b.chartX = x; b.chartZ = z; b.radius = radius;
      }
      this.expanded = new Set(placed.keys());
      this.updateFootprints();
      this.layoutDirty = true;
    }
    // Precompute the neighbouring levels in small idle slices, so the next zoom step across a
    // level does not stall on placement and no slice blocks input.
    for (const next of [level * 1.5, level / 1.5])
      if (next >= 1 && next <= ZOOM_MAX * 1.5) this.precompute(next, ranked, dataKey);
    this.invalidate();
    for (const cb of this.settleListeners) cb();
  }

  private rankedBodies(): Body[] {
    return this.priority.length
      ? this.priority.map(p => this.bodies[this.byId.get(p.id) ?? -1]).filter((b): b is Body => !!b && (b.to > 0 || !!this.comparison))
      : this.bodies.filter(b => b.to > 0).sort((a, b) => b.to - a.to);
  }

  private precompute(level: number, ranked: Body[], dataKey: string, done?: () => void): void {
    if (this.placements.has(level)) return void done?.();
    const running = this.precomputing.get(level);
    if (running) {
      if (done) running.done.push(done);
      return;
    }
    const job = { steps: this.placementSteps(level, ranked), done: done ? [done] : [] };
    this.precomputing.set(level, job);
    const forget = () => this.precomputing.get(level) === job && this.precomputing.delete(level);
    const run = (deadline: Deadline) => {
      if (this.disposed || this.placementData !== dataKey) return void forget();
      while (deadline.timeRemaining() > 2)
        if (job.steps.next().done) {
          forget();
          for (const cb of job.done) cb();
          return;
        }
      slice(run, job.done.length > 0); // someone is waiting for it: keep going promptly
    };
    slice(run, job.done.length > 0);
  }

  /** Feet for one detail level (cached), yielding every few cities so it can run in idle
   * slices: in rank order, each city takes the largest footprint that fits on land without
   * touching another, at its own point or a nearby spot (a ground leader shows the shift).
   * Sizes, gaps and search rings are divided by the level. */
  private *placementSteps(level: number, ranked: Body[]): Generator<void, void> {
    const started = performance.now();
    const CELL = 120 / level; // wider than the largest foot + gap + foot
    const grid = new Map<string, [number, number, number][]>();
    const blocked = (x: number, z: number, radius: number, gap: number) => {
      const gx = Math.floor(x / CELL), gz = Math.floor(z / CELL);
      for (let dx = -1; dx <= 1; dx++)
        for (let dz = -1; dz <= 1; dz++)
          for (const [ox, oz, or] of grid.get(`${gx + dx},${gz + dz}`) ?? [])
            if (Math.hypot(x - ox, z - oz) < radius + or + gap) return true;
      return false;
    };
    const out = new Map<string, [number, number, number]>();
    const sizes = [42, 32, 24, 16].map((size) => size / level);
    const gap = 18 / level;
    for (const [rank, b] of ranked.entries()) {
      if (out.size >= CEL.detail.bodyLimit) break;
      if (rank % 32 === 31) yield;
      // Near rings shrink with the level. A city whose point falls just off the simplified
      // coast also searches the original reach, so it can stand on the nearest land; major
      // centres look further for a legible round body.
      const reach = rank < 24 ? 144 : 48;
      const distances = new Set<number>();
      for (let d = 24; d <= reach; d += 24) {
        distances.add(d / level);
        if (b.clearance <= 0) distances.add(d);
      }
      const candidates: [number, number][] = [[b.x, b.z]];
      for (const distance of [...distances].sort((x, y) => x - y))
        for (let angle = 0; angle < 16; angle++) candidates.push([b.x + distance * Math.cos(angle * Math.PI / 8), b.z + distance * Math.sin(angle * Math.PI / 8)]);
      search: for (const radius of sizes)
        for (const [x, z] of candidates) {
          if (blocked(x, z, radius, gap) || this.clearanceAt(x, -z) < radius / 0.7) continue;
          out.set(b.id, [x, z, radius]);
          const key = `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
          const cell = grid.get(key);
          if (cell) cell.push([x, z, radius]);
          else grid.set(key, [[x, z, radius]]);
          break search;
        }
    }
    this.placements.set(level, out);
    performance.measure("atlas:placement", { start: started });
  }

  private updateFootprints(): void {
    this.layoutTime = performance.now();
    for (const b of this.bodies) {
      if (!this.expanded.has(b.id)) {
        b.chartX = b.x; b.chartZ = b.z; b.radius = 0;
        if ((b.id === this.selected || b.id === this.hovered) && b.to > 0) {
          let nearest = Infinity;
          for (const other of this.bodies) if (this.expanded.has(other.id)) nearest = Math.min(nearest, Math.hypot(b.x - other.chartX, b.z - other.chartZ) - other.radius);
          b.radius = separatedRadius(b.clearance, nearest, 22 / this.level);
        }
      }
    }
  }

  private isBody(b: Body): boolean {
    return b.shown > 0 && b.radius > 0 && (this.expanded.has(b.id) || b.id === this.selected || b.id === this.hovered);
  }

  private layout(now: number): boolean {
    if (!this.bodies.length) return false;
    const R = this.bodyRadius();
    const px = this.worldPerPx();
    this.domeMat.uniforms.uR!.value = R;
    this.domeMat.uniforms.uPx!.value = px;
    const pos = this.domeGeo.getAttribute("iPos") as THREE.InstancedBufferAttribute;
    const radii = this.domeGeo.getAttribute("iR") as THREE.InstancedBufferAttribute;
    const hAttr = this.domeGeo.getAttribute("iH") as THREE.InstancedBufferAttribute;
    const baseAttr = this.domeGeo.getAttribute("iBase") as THREE.InstancedBufferAttribute;
    const lineAttr = this.domeGeo.getAttribute("iLine") as THREE.InstancedBufferAttribute;
    let moving = false;
    let n = 0;
    let leaderCount = 0;
    const leaders = this.leaders.geometry.getAttribute("position") as THREE.BufferAttribute;
    const scale = this.heightScale();
    const dt = Math.max(0, now - this.layoutTime);
    this.layoutTime = now;
    const blend = this.opts.reducedMotion ? 1 : 1 - Math.exp(-dt / 65);
    this.bodies.forEach((b) => {
      const t = this.opts.reducedMotion ? 1 : Math.min(1, Math.max(0, (now - this.tweenStart) / (this.comparison ? 90 : CEL.motion.height)));
      if (t < 1) moving = true;
      b.shown = b.from + (b.to - b.from) * (this.comparison ? t : ease(t));
      const marked = b.id === this.selected || b.id === this.hovered;
      const baseline = this.comparison?.baseline.get(b.id);
      const comparable = baseline != null && b.count != null;
      const targetRadius = (this.isBody(b) || (this.comparison && this.expanded.has(b.id))) ? b.radius : 0;
      const v = this.visual.get(b.id) ?? { x: b.chartX, z: b.chartZ, radius: 0 };
      this.visual.set(b.id, v);
      // Departing bodies keep their last foot while narrowing; new bodies grow at their
      // final foot. Continuing bodies move smoothly between the cached placements.
      const x = targetRadius > 0 ? b.chartX : v.x;
      const z = targetRadius > 0 ? b.chartZ : v.z;
      const distance = Math.hypot(x - v.x, z - v.z);
      if (Math.abs(targetRadius - v.radius) > px * 0.02 || distance > px * 0.02) {
        v.x += (x - v.x) * blend;
        v.z += (z - v.z) * blend;
        v.radius += (targetRadius - v.radius) * blend;
        moving = !this.opts.reducedMotion || moving;
      } else {
        v.x = x; v.z = z; v.radius = targetRadius;
      }
      if (v.radius > 0 && (b.shown > 0 || (comparable && baseline > 0)) && n < MAX_BODIES) {
        pos.setXYZ(n, v.x, this.landTop, v.z);
        hAttr.setX(n, b.shown * scale);
        baseAttr.setX(n, comparable ? heightFor(baseline, this.scaleMax) * scale : -1);
        const radius = Math.min(R, v.radius);
        radii.setX(n, v.radius);
        lineAttr.setX(n, Math.min(marked ? CEL.line.selected : CEL.line.data, radius / px * 0.22));
        if (Math.hypot(b.x - v.x, b.z - v.z) > 1) {
          leaders.setXYZ(leaderCount++, b.x, this.landTop + 2, b.z);
          leaders.setXYZ(leaderCount++, v.x, this.landTop + 2, v.z);
        }
        n++;
      }
    });
    leaders.needsUpdate = true;
    this.leaders.geometry.setDrawRange(0, leaderCount);
    this.domeGeo.instanceCount = n;
    this.contactGeo.instanceCount = n;
    pos.needsUpdate = radii.needsUpdate = hAttr.needsUpdate = lineAttr.needsUpdate = baseAttr.needsUpdate = true;
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

  /** The safe rectangle in CSS px: [left, top, width, height], and where the home view centres. */
  private safeRect(): { x: number; y: number; w: number; h: number; cx: number; cy: number } {
    const W = this.host.clientWidth || 1, H = this.host.clientHeight || 1;
    const mobile = W < 760;
    const [sx, sy, sw, sh] = mobile ? CEL.safeMobile : CEL.safeDesktop;
    const [cx, cy] = mobile ? [sx + sw / 2, sy + sh / 2] : CEL.centreDesktop;
    return { x: sx * W, y: sy * H, w: sw * W, h: sh * H, cx: cx * W, cy: cy * H };
  }

  /** One global height factor for every body, from zoom and elevation only: the body for
   * count = scaleMax never projects taller than half the safe rectangle. Data meaning is kept
   * (same count = same height at any moment); only the camera changes it, continuously. */
  heightScale(zoom = this.zoom, elevation = this.elevation): number {
    const k = (2 * this.homeHalfH) / zoom / (this.host.clientHeight || 1);
    const projected = (MAX_HEIGHT * Math.cos((elevation * Math.PI) / 180)) / k;
    return Math.min(1, (this.safeRect().h * 0.5) / projected);
  }

  private resize(): void {
    const w = this.host.clientWidth || 1;
    const h = this.host.clientHeight || 1;
    // Preserve native resolution on Retina displays and when moving between displays.
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    for (const m of this.lines) m.resolution.set(w, h);
    this.fitHome(!this.interacted);
    if (this.interacted) this.commit(this.state(), false);
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

  /** The land's extent on the camera plane for given angles: [u0, u1, v0, v1]. */
  private landExtent(el: number, az: number): [number, number, number, number] {
    const cached = this.extentCache;
    if (cached && cached.el === el && cached.az === az && cached.count === this.landPoints.length) return cached.bounds;
    const { right, up } = this.basis(el, az);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const p of this.landPoints) {
      const u = p.dot(right), v = p.dot(up);
      if (u < u0) u0 = u;
      if (u > u1) u1 = u;
      if (v < v0) v0 = v;
      if (v > v1) v1 = v;
    }
    const bounds: [number, number, number, number] = [u0, u1, v0, v1];
    this.extentCache = { el, az, count: this.landPoints.length, bounds };
    return bounds;
  }

  /** Home view: the real land fits the safe rectangle at the default angle. Moves the camera
   * only when `apply` (before the user takes over). */
  private fitHome(apply: boolean): void {
    if (!this.landPoints.length) return;
    const H = this.host.clientHeight || 1;
    const safe = this.safeRect();
    const [u0, u1, v0, v1] = this.landExtent(CEL.elevation, CEL.azimuth);
    const k = Math.max((u1 - u0) / safe.w, (v1 - v0) / safe.h); // world units per px
    this.homeHalfH = (k * H) / 2;
    this.homeTarget.copy(this.constrain({ target: this.homeTarget, zoom: 1, az: CEL.azimuth, el: CEL.elevation }).target);
    if (apply) this.setState({ target: this.homeTarget, zoom: 1, az: CEL.azimuth, el: CEL.elevation });
    this.updateCamera();
  }

  /** light and contact-shadow direction for the current camera turn */
  private turn = 0;

  private updateCamera(updateBodies = true): void {
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
    // Translation and azimuth change only the view/uniforms, not instance geometry.
    if (updateBodies) this.layoutDirty = true;
  }

  private state(): CameraState {
    return { target: this.target.clone(), zoom: this.zoom, az: this.azimuth, el: this.elevation };
  }

  private setState(st: CameraState): void {
    const updateBodies = st.zoom !== this.zoom || st.el !== this.elevation;
    this.target.copy(st.target);
    this.zoom = st.zoom;
    this.azimuth = st.az;
    this.elevation = st.el;
    this.updateCamera(updateBodies);
  }

  /** The nearest allowed camera: zoom in [1, max], any azimuth, elevation
   * 30–60°, and on each screen axis the land either centred (when it fits the safe rectangle)
   * or covering the safe rectangle's full width (no blank margin inside it). */
  private constrain(st: CameraState): CameraState {
    const zoom = THREE.MathUtils.clamp(st.zoom, 1, ZOOM_MAX);
    const az = st.az; // turns freely all the way round
    const el = THREE.MathUtils.clamp(st.el, ELEVATION_MIN, ELEVATION_MAX);
    if (!this.landPoints.length) return { target: st.target.clone(), zoom, az, el };
    const W = this.host.clientWidth || 1, H = this.host.clientHeight || 1;
    const safe = this.safeRect();
    const k = (2 * this.homeHalfH) / zoom / H;
    const { dir, right, up } = this.basis(el, az);
    let [u0, u1, v0, v1] = this.landExtent(el, az);
    // A selected city's whole body counts as content, so turning the map never leaves it
    // standing past an edge the land pins to the screen.
    const picked = this.selected ? this.bodies[this.byId.get(this.selected) ?? -1] : undefined;
    if (picked && picked.radius > 0)
      for (const py of [this.landTop, this.landTop + picked.shown * this.heightScale(zoom, el)]) {
        const p = new THREE.Vector3(picked.chartX, py, picked.chartZ);
        u0 = Math.min(u0, p.dot(right)); u1 = Math.max(u1, p.dot(right));
        v0 = Math.min(v0, p.dot(up)); v1 = Math.max(v1, p.dot(up));
      }
    // camera-plane centre that puts screen position `px` on land coordinate `u`
    const fit = (lo: number, hi: number, safeLo: number, safeLen: number, centre: number, screen: number, sign: 1 | -1, cur: number) => {
      const len = (hi - lo) / k;
      if (len <= safeLen * (1 + 1e-6)) {
        // fits: centred like the home view (bounds centre at the target centre, kept inside)
        const half = len / 2;
        const p = THREE.MathUtils.clamp(centre, safeLo + half, safeLo + safeLen - half);
        return (lo + hi) / 2 - sign * (p - screen / 2) * k;
      }
      // larger: the land's edges may not come inside the safe rectangle
      const a = lo + sign * (screen / 2 - (sign > 0 ? safeLo : safeLo + safeLen)) * k;
      const b = hi - sign * ((sign > 0 ? safeLo + safeLen : safeLo) - screen / 2) * k;
      return THREE.MathUtils.clamp(cur, Math.min(a, b), Math.max(a, b));
    };
    // the view centre (the target, on the ground) at the same place on screen
    const ground = st.target.clone().addScaledVector(dir, (this.landTop - st.target.y) / dir.y);
    // The extent alone still allows views of mostly empty sea, or of the US, at Canada's
    // irregular edges: keep the view centre 15% of the view inside the coast or border,
    // climbing the land's distance field (smooth, so a drag along the limit never jumps). Only
    // deeper steps are taken, so on land thinner than that the centre rests on its spine
    // instead of rocking across it.
    const land = zoom > 1 + 1e-6 ? this.landDistance() : this.land;
    if (land) {
      const inset = 0.15 * Math.min(safe.w, safe.h) * k;
      // never push a selected city's body out of view: a coastal city may show more sea
      const sel = this.selected ? this.bodies[this.byId.get(this.selected) ?? -1] : undefined;
      const tip = sel ? this.landTop + sel.shown * this.heightScale(zoom, el) : 0;
      const keepsSelected = (cx: number, cy: number) => !sel || sel.radius <= 0 || [this.landTop, tip].every((py) => {
        const p = new THREE.Vector3(sel.chartX, py, sel.chartZ), g = new THREE.Vector3(cx, this.landTop, -cy);
        const X = W / 2 + (p.dot(right) - g.dot(right)) / k, Y = H / 2 - (p.dot(up) - g.dot(up)) / k;
        return X >= 0 && X <= W && Y >= 0 && Y <= H;
      });
      // far off land, one long first step; then small steps (≤ 4 km) up the field
      let x = ground.x, y = -ground.z, d = land.distance(x, y);
      const selectedShown = keepsSelected(x, y);
      for (let i = 0; i < 60 && d < inset; i++) {
        const [gx, gy] = land.gradient(x, y);
        const len = Math.hypot(gx, gy);
        if (len < 1e-3) break;
        const step = d < -8 ? -d : Math.min(inset - d, 4);
        const nx = x + (gx / len) * step, ny = y + (gy / len) * step;
        const nd = land.distance(nx, ny);
        if (nd <= d) break; // the spine of thin land: as deep as it goes
        if (selectedShown && !keepsSelected(nx, ny)) break;
        x = nx; y = ny; d = nd;
      }
      ground.x = x;
      ground.z = -y;
    }
    const uc = fit(u0, u1, safe.x, safe.w, safe.cx, W, 1, ground.dot(right));
    const vc = fit(v0, v1, safe.y, safe.h, safe.cy, H, -1, ground.dot(up));
    const t = ground.addScaledVector(right, uc - ground.dot(right)).addScaledVector(up, vc - ground.dot(up));
    t.addScaledVector(dir, (this.landTop - t.y) / dir.y); // same view, target back on the ground
    return { target: t, zoom, az, el };
  }

  /** What a gesture's raw camera shows: the nearest allowed camera plus the overshoot,
   * rubber-banded per component (continuous, bounded). */
  private display(raw: CameraState): CameraState {
    const W = this.host.clientWidth || 1, H = this.host.clientHeight || 1;
    // zoom first, around the zoom point, so that point stays under the pointer while stretched
    const limited = THREE.MathUtils.clamp(raw.zoom, 1, ZOOM_MAX);
    const zoom = limited * Math.exp(rubber(Math.log(raw.zoom / limited), RUBBER_ZOOM));
    let target = raw.target;
    if (zoom !== raw.zoom && this.zoomPoint) {
      const { dir, right, up } = this.basis(raw.el, raw.az);
      const dk = ((2 * this.homeHalfH) / H) * (1 / raw.zoom - 1 / zoom);
      target = raw.target.clone()
        .addScaledVector(right, (this.zoomPoint[0] - W / 2) * dk)
        .addScaledVector(up, -(this.zoomPoint[1] - H / 2) * dk);
      target.addScaledVector(dir, (this.landTop - target.y) / dir.y);
    }
    const c = this.constrain({ ...raw, target, zoom });
    const k = (2 * this.homeHalfH) / c.zoom / H;
    const { dir, right, up } = this.basis(c.el, c.az);
    // The limits' correction is eased in over a few events: where an irregular coast makes the
    // allowed position jump, the view glides instead. Inside the limits it is zero (no lag).
    const correction = target.clone().sub(c.target);
    this.correction = (this.correction ?? new THREE.Vector3()).lerp(correction, 0.3);
    const off = this.correction;
    const limit = RUBBER_PAN * Math.min(W, H);
    const t = target.clone().sub(off)
      .addScaledVector(right, rubber(off.dot(right) / k, limit) * k)
      .addScaledVector(up, rubber(off.dot(up) / k, limit) * k);
    t.addScaledVector(dir, (this.landTop - t.y) / dir.y);
    return {
      target: t,
      zoom,
      az: c.az + rubber(raw.az - c.az, RUBBER_ANGLE),
      el: c.el + rubber(raw.el - c.el, RUBBER_ANGLE),
    };
  }

  /** Apply a camera move. During a gesture (elastic) the input accumulates on a raw camera and
   * the view shows it rubber-banded past the limits; other moves, and reduced motion, are
   * clamped outright. */
  private commit(next: CameraState, elastic: boolean): void {
    if (this.interactionLocked) return;
    const to = elastic && !this.opts.reducedMotion ? this.display(next) : this.constrain(next);
    // Direct manipulation must reach the next rendered frame without chasing a tween.
    // Keep animation for focus and boundary spring-back, independent of body transitions.
    this.anim = null;
    this.setState(to);
    if (!elastic || this.opts.reducedMotion) {
      this.raw = null;
    } else {
      this.raw = next;
      // wheels and trackpads have no "release": spring back once input pauses
      clearTimeout(this.releaseTimer);
      if (!this.gesture) this.releaseTimer = window.setTimeout(() => this.release(true), 120);
    }
    this.interacted = true;
    this.scheduleSettle();
    this.invalidate();
  }

  /** The camera an elastic move starts from: the gesture's raw camera, or the view. */
  private base(): CameraState {
    const base = this.raw ?? this.state();
    return { ...base, target: base.target.clone() };
  }

  /** A pointer or trackpad gesture starts / ends: overshoot is allowed only while it lasts. */
  beginGesture(): void {
    this.gesture = true;
    this.raw = null;
    this.correction = null;
    this.anim = null;
    clearTimeout(this.releaseTimer);
  }

  endGesture(): void {
    this.gesture = false;
    this.release(false);
  }

  /** Spring back inside the limits; a zoom past its limit returns around the last zoom point. */
  private release(fromWheel: boolean): void {
    this.raw = null;
    this.correction = null;
    const cur = this.state();
    const destination = this.anim?.to ?? cur;
    let to = this.constrain(destination);
    if (to.zoom !== destination.zoom && this.zoomPoint) {
      const [x, y] = this.zoomPoint;
      this.setState(destination);
      const before = this.groundAt(x, y);
      this.setState({ ...destination, zoom: to.zoom });
      const after = this.groundAt(x, y);
      this.setState(cur);
      if (before && after) to = this.constrain({ ...cur, target: destination.target.clone().add(before.sub(after)), zoom: to.zoom });
    }
    const k = (2 * this.homeHalfH) / cur.zoom / (this.host.clientHeight || 1);
    if (destination.target.distanceTo(to.target) / k < 0.5 && Math.abs(Math.log(destination.zoom / to.zoom)) < 1e-4 && Math.abs(destination.az - to.az) + Math.abs(destination.el - to.el) < 0.01) return;
    // trackpad momentum keeps sending wheel events after the fingers lift: don't let them
    // stretch the view again while it springs back
    if (fromWheel) this.wheelLock = performance.now() + 350;
    if (this.opts.reducedMotion) this.setState(to);
    else this.anim = { start: performance.now(), ms: SPRING_MS, from: cur, to };
    this.invalidate();
  }

  /** True when the camera is not at the home view (shows "Back to Canada"). */
  isHome(): boolean {
    const k = (2 * this.homeHalfH) / this.zoom / (this.host.clientHeight || 1);
    const turned = Math.abs(((this.azimuth - CEL.azimuth) % 360 + 540) % 360 - 180);
    return Math.abs(this.zoom - 1) < 0.01 && turned < 0.5 && Math.abs(this.elevation - CEL.elevation) < 0.5
      && this.target.distanceTo(this.homeTarget) / k < 1;
  }

  private scheduleSettle(): void {
    clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(() => !this.disposed && this.updateDetail(), CEL.detail.settleMs);
  }

  /** Orbit around the map target (all the way round; elevation 30–60°). */
  rotate(dx: number, dy = 0, elastic = false): void {
    const b = this.base();
    this.commit({ ...b, az: b.az - dx * 0.28, el: b.el + dy * 0.2 }, elastic);
  }

  /** Pan by a screen delta (pixels). */
  pan(dx: number, dy: number): void {
    const perPx = this.worldPerPx();
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    const groundUp = new THREE.Vector3(up.x, 0, up.z).normalize();
    const el = (this.elevation * Math.PI) / 180;
    const base = this.base();
    const target = base.target.clone().addScaledVector(right, -dx * perPx).addScaledVector(groundUp, (dy * perPx) / Math.sin(el));
    this.commit({ ...base, target }, false);
  }

  /** Drag the map: the ground point under (fromX, fromY) follows the pointer to (toX, toY). */
  drag(fromX: number, fromY: number, toX: number, toY: number, elastic = false): void {
    const a = this.groundAt(fromX, fromY);
    const b = this.groundAt(toX, toY);
    if (!a || !b) return;
    const base = this.base();
    this.commit({ ...base, target: base.target.add(a.sub(b)) }, elastic);
  }

  /** Zoom by a factor around a screen point (keeps the point under the cursor). */
  zoomAt(factor: number, clientX?: number, clientY?: number, elastic = false): void {
    if (elastic && !this.gesture && performance.now() < this.wheelLock) {
      // momentum after a spring-back: ignore pushes past the limit it springs to
      const settling = this.anim?.to.zoom ?? this.zoom;
      if ((factor > 1 && settling >= ZOOM_MAX - 1e-6) || (factor < 1 && settling <= 1 + 1e-6)) {
        this.wheelLock = performance.now() + 150;
        return;
      }
    }
    const cur = this.state();
    const base = this.base();
    const next = { ...base, target: base.target.clone(), zoom: base.zoom * factor };
    if (clientX !== undefined) {
      // anchor in the camera being changed (a stretched gesture's raw camera)
      this.setState(base);
      const before = this.groundAt(clientX, clientY!);
      this.setState(next);
      const after = this.groundAt(clientX, clientY!);
      this.setState(cur);
      if (before && after) next.target.add(before.sub(after));
      this.zoomPoint = [clientX, clientY!];
    } else this.zoomPoint = null;
    this.commit(next, elastic);
  }

  resetView(): void {
    if (this.interactionLocked) return;
    this.anim = null;
    this.raw = null;
    this.fitHome(true);
    this.interacted = false;
    this.scheduleSettle();
    this.invalidate();
  }

  /** Bring a city into view, its whole body inside the viewport (320 ms ease, none when reduced). */
  focusCity(id: string, zoom = 3): void {
    if (this.interactionLocked) return;
    const i = this.byId.get(id);
    if (i === undefined) return;
    const b = this.bodies[i]!;
    const toZoom = THREE.MathUtils.clamp(Math.max(this.zoom, zoom), 1, ZOOM_MAX);
    const h = Math.max(b.to, b.shown) * this.heightScale(toZoom);
    const to = this.constrain({ target: new THREE.Vector3(b.chartX, this.landTop + h / 2, b.chartZ), zoom: toZoom, az: this.azimuth, el: this.elevation });
    this.interacted = true;
    this.raw = null;
    if (this.opts.reducedMotion) this.setState(to);
    else this.anim = { start: performance.now(), ms: CEL.motion.focus, from: this.state(), to };
    this.scheduleSettle();
    this.invalidate();
  }

  private stepCamera(now: number): boolean {
    const a = this.anim;
    if (!a) return false;
    const t = Math.min(1, (now - a.start) / a.ms);
    this.setState(lerpState(a.from, a.to, ease(t)));
    if (t < 1) return true;
    this.anim = null;
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

  /** Nearest body (base-to-top, or its ground leader) within a few pixels of a screen point. */
  pick(clientX: number, clientY: number): string | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const rPx = this.bodyRadius() / this.worldPerPx();
    let best: string | null = null;
    let bestD = 8;
    for (const b of this.bodies) {
      const baseline = this.comparison?.visible && b.count != null ? this.comparison.baseline.get(b.id) : null;
      const startHeight = baseline != null ? heightFor(baseline, this.scaleMax) : 0;
      const visibleHeight = b.shown + (Math.max(b.shown, startHeight) - b.shown) * this.compareMat.uniforms.uCompare!.value;
      if (!this.isBody(b) && !(visibleHeight > 0 && b.radius > 0 && this.expanded.has(b.id))) continue;
      const v = this.visual.get(b.id) ?? { x: b.chartX, z: b.chartZ, radius: b.radius };
      const [bx, by] = this.toScreen(v.x, this.landTop, v.z);
      if (Math.hypot(b.x - b.chartX, b.z - b.chartZ) > 1) {
        const [ax, ay] = this.toScreen(b.x, this.landTop, b.z);
        const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2 || 1)));
        const leaderDistance = Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay));
        if (leaderDistance < bestD) { bestD = leaderDistance; best = b.id; }
      }
      if (Math.abs(x - bx) > 60 || y > by + 20) continue;
      const [tx, ty] = this.toScreen(v.x, this.landTop + visibleHeight * this.heightScale(), v.z);
      const t = Math.max(0, Math.min(1, ((x - bx) * (tx - bx) + (y - by) * (ty - by)) / ((tx - bx) ** 2 + (ty - by) ** 2 || 1)));
      const d = Math.max(0, Math.hypot(x - (bx + t * (tx - bx)), y - (by + t * (ty - by))) - Math.min(rPx, b.radius / this.worldPerPx()) * 0.85);
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
    // Labels request a small reference set; do not scan the whole gazetteer per frame.
    const bodies = ids ? [...ids].map(id => this.bodies[this.byId.get(id) ?? -1]).filter((b): b is Body => !!b) : this.bodies;
    for (const b of bodies) {
      const [bx, by] = this.toScreen(b.x, this.landTop, b.z);
      if (bx < -50 || by < -50 || bx > w + 50 || by > h + 50) continue;
      const body = this.isBody(b);
      const v = this.visual.get(b.id) ?? { x: b.chartX, z: b.chartZ, radius: b.radius };
      // labels are placed when bodies settle, possibly before they have grown: use the target
      const tall = ((this.expanded.has(b.id) || body) && b.to > 0 ? Math.max(b.shown, b.to) : 0) * this.heightScale();
      const [x, y] = tall ? this.toScreen(v.x, this.landTop + tall, v.z) : [bx, by];
      out.push({ id: b.id, x, y, bx, by, r: body ? Math.min(r, b.radius / this.worldPerPx()) : r, height: b.shown, count: b.count, body, displaced: Math.hypot(b.chartX - b.x, b.chartZ - b.z) > 1 });
    }
    return out;
  }

  /** Cities drawn as bodies in priority order, and whether the regional level is on. */
  detail(): { expanded: string[]; regional: boolean } {
    return { expanded: this.priority.map((p) => p.id).filter((id) => this.expanded.has(id)), regional: this.regional };
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
    const reveal = this.comparison?.visible ? (this.opts.reducedMotion ? 1 : Math.min(1, (now - this.compareStarted) / 1000)) : 0;
    this.compareMat.uniforms.uCompare!.value = reveal;
    const revealing = !!this.comparison?.visible && reveal < 1;
    const panning = this.stepCamera(now);
    const moving = this.layoutDirty ? this.layout(now) : false;
    this.layoutDirty = moving;
    this.renderer.render(this.scene, this.camera);
    for (const cb of this.listeners) cb();
    if (moving || panning || revealing) this.invalidate();
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.settleTimer);
    clearTimeout(this.releaseTimer);
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
