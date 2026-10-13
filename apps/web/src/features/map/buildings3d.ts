/** Manga 3D buildings: a MapLibre custom WebGL2 layer that draws the real OSM buildings
 * (footprints and heights from the vector tiles) as an anime-background city.
 *
 * Style, all in one shader:
 *  - toon (cel) shading: three hard bands from a fixed sun, no smooth gradients;
 *  - screentone: the mid and shadow bands get printed dot tone in screen space;
 *  - ink line art: building corners, roof edges and the ground line are drawn as ~2 px ink
 *    lines (screen-constant, from derivatives);
 *  - windows: floor/bay grid on taller walls, glass with diagonal white anime glare,
 *    faded out when they would be too small to read;
 *  - buildings grow out of the ground when the 3D zoom level is reached.
 * Geometry comes from buildingMesh.ts. */
import { type CustomLayerInterface, type CustomRenderMethodInput, type Map as MlMap, MercatorCoordinate } from "maplibre-gl";

import { buildBuildingMesh, FLOATS_PER_VERTEX } from "./buildingMesh";

export const BUILDINGS_3D_MIN_ZOOM = 14;
/** Invisible fill layer in the style that makes the building footprints queryable. */
export const BUILDINGS_QUERY_LAYER = "art-building-query";
const MAX_FEATURES = 18000;

/** Low-rise: paper, sakura, sky, mint, sun, lilac. Towers: glassy white / sky / pale cyan. */
const PALETTE = [
  [0.992, 0.984, 0.961], [1.0, 0.86, 0.9], [0.84, 0.92, 1.0],
  [0.86, 0.96, 0.9], [1.0, 0.95, 0.75], [0.91, 0.88, 1.0],
  [0.95, 0.97, 1.0], [0.8, 0.9, 1.0], [0.84, 0.96, 0.98],
];

const VERT = `#version 300 es
precision highp float;
uniform mat4 u_matrix;
uniform float u_grow;
in vec3 a_pos;
in vec2 a_normal;
in vec2 a_uv;
in vec4 a_meta; // edgeLen, top, base, info
out vec2 v_uv;
out vec2 v_normal;
out vec3 v_meta; // edgeLen, top, base
out float v_kind;
out float v_colour;
void main() {
  float info = a_meta.w;
  v_kind = info >= 100.0 ? 1.0 : 0.0;
  v_colour = info - 100.0 * v_kind;
  v_uv = a_uv;
  v_normal = a_normal;
  v_meta = a_meta.xyz;
  gl_Position = u_matrix * vec4(a_pos.xy, a_pos.z * u_grow, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
uniform vec3 u_palette[9];
uniform float u_dpr;
uniform vec3 u_sun;     // direction towards the sun (x east, y north, z up)
uniform vec3 u_ink;
in vec2 v_uv;
in vec2 v_normal;
in vec3 v_meta;
in float v_kind;
in float v_colour;
out vec4 fragColor;

// Printed dot tone, 45 degrees, cell in CSS px.
float tone(float radius) {
  vec2 p = gl_FragCoord.xy / u_dpr;
  p = mat2(0.7071, -0.7071, 0.7071, 0.7071) * p;
  vec2 cell = fract(p / 4.2) - 0.5;
  return 1.0 - smoothstep(radius - 0.06, radius + 0.06, length(cell));
}

void main() {
  vec3 base = u_palette[int(v_colour + 0.5)];
  vec3 col;
  if (v_kind > 0.5) {
    // Roof: brightest face, a light tone so it reads as a surface.
    col = mix(base, u_ink, 0.18 * tone(0.16));
  } else {
    float d = dot(normalize(v_normal), normalize(u_sun.xy));
    // three hard bands
    if (d > 0.35) {
      col = base;
    } else if (d > -0.25) {
      col = mix(base * 0.96, u_ink, 0.35 * tone(0.17));
    } else {
      col = mix(base * 0.88, u_ink, 0.5 * tone(0.25));
    }

    float u = v_uv.x, v = v_uv.y;
    float len = v_meta.x, top = v_meta.y, bottom = v_meta.z;
    float pxPerM = 1.0 / max(fwidth(v), 1e-4) / u_dpr;   // CSS px per metre here
    bool lit = d > -0.25;
    if (top >= 50.0) {
      // Tower: glass curtain wall — thin ink mullions (bays 3.2 m, floors 3.6 m) once they
      // are at least ~5 px apart, and two big diagonal anime glare streaks on the sunny side.
      float showGrid = smoothstep(1.4, 2.2, pxPerM);
      float mu = abs(fract(u / 3.2 + 0.5) - 0.5) * 3.2 * pxPerM;   // px to nearest mullion
      float fl = abs(fract((v - bottom) / 3.6 + 0.5) - 0.5) * 3.6 * pxPerM;
      col = mix(col, mix(col, u_ink, 0.55), showGrid * (1.0 - smoothstep(0.4, 1.1, mu)));
      col = mix(col, mix(col, u_ink, 0.3), showGrid * (1.0 - smoothstep(0.3, 0.9, fl)));
      if (lit) {
        float t = fract((u + (v - bottom) * 0.85) / 34.0);
        float glare = step(0.06, t) * step(t, 0.13) + step(0.16, t) * step(t, 0.18);
        col = mix(col, vec3(1.0), 0.75 * glare);
      }
    } else if (top - bottom >= 8.0) {
      // Mid/low-rise: punched windows with ink frames, only when big enough to read.
      float showWin = smoothstep(2.4, 3.4, pxPerM);
      float row = fract((v - bottom) / 3.6);
      float bay = fract(u / 3.2);
      float inside = step(0.34, row) * step(row, 0.84) * step(0.22, bay) * step(bay, 0.78)
                   * step(bottom + 2.6, v) * step(v, top - 1.4) * step(1.0, u) * step(u, len - 1.0);
      if (inside > 0.5 && showWin > 0.0) {
        vec3 glass = lit ? vec3(0.62, 0.82, 1.0) : vec3(0.34, 0.5, 0.82);
        float frame = min(min(row - 0.34, 0.84 - row) * 3.6, min(bay - 0.22, 0.78 - bay) * 3.2) * pxPerM;
        float shine = step(fract((u + v) * 0.31), 0.18);
        vec3 win = mix(glass, vec3(1.0), shine * (lit ? 0.85 : 0.4));
        win = mix(u_ink, win, smoothstep(0.6, 1.3, frame));
        col = mix(col, win, showWin);
      }
    }

    // Ink line art (screen-constant width): roof edge and ground line always; vertical
    // corners only on real corners — not between the many short segments of a curved
    // facade, and not on walls too narrow on screen to carry two lines.
    float w = 1.3 * u_dpr;
    float wallPx = len / max(fwidth(u), 1e-4);
    float corners = step(4.0, len) * step(6.0 * w, wallPx);
    float edgeH = min((top - v) / fwidth(v), (v - bottom) / fwidth(v));
    float edgeV = min(u / fwidth(u), (len - u) / fwidth(u));
    float edge = corners > 0.5 ? min(edgeH, edgeV) : edgeH;
    col = mix(u_ink, col, smoothstep(w - 0.6, w + 0.6, edge));
  }
  fragColor = vec4(col, 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
  return s;
}

/** First [lon, lat] of any geometry (tile geometries can be empty or nested unexpectedly). */
function firstPosition(g: GeoJSON.Geometry): number[] | null {
  let c: unknown = "coordinates" in g ? g.coordinates : null;
  while (Array.isArray(c) && Array.isArray(c[0])) c = c[0];
  return Array.isArray(c) && typeof c[0] === "number" ? (c as number[]) : null;
}

/** out = a × b for column-major 4×4 matrices. */
function mul(a: ArrayLike<number>, b: ArrayLike<number>): Float32Array {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
      o[c * 4 + r] = s;
    }
  return o;
}

export class MangaBuildingsLayer implements CustomLayerInterface {
  readonly id = "manga-buildings";
  readonly type = "custom" as const;
  readonly renderingMode = "3d" as const;
  private map!: MlMap;
  private gl!: WebGL2RenderingContext;
  private program!: WebGLProgram;
  private vao!: WebGLVertexArrayObject;
  private buffer!: WebGLBuffer;
  private vertexCount = 0;
  private origin = new MercatorCoordinate(0, 0, 0);
  private scale = 1;
  private timer: number | undefined;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};

  private lastKey = "";

  constructor(private readonly sourceId = "protomaps") {}

  onAdd(map: MlMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    this.map = map;
    this.gl = gl as WebGL2RenderingContext;
    const g = this.gl;
    const p = g.createProgram()!;
    g.attachShader(p, compile(g, g.VERTEX_SHADER, VERT));
    g.attachShader(p, compile(g, g.FRAGMENT_SHADER, FRAG));
    g.linkProgram(p);
    if (!g.getProgramParameter(p, g.LINK_STATUS)) throw new Error(g.getProgramInfoLog(p) ?? "link");
    this.program = p;
    for (const u of ["u_matrix", "u_grow", "u_palette", "u_dpr", "u_sun", "u_ink"]) {
      this.uniforms[u] = g.getUniformLocation(p, u);
    }
    this.buffer = g.createBuffer()!;
    this.vao = g.createVertexArray()!;
    g.bindVertexArray(this.vao);
    g.bindBuffer(g.ARRAY_BUFFER, this.buffer);
    const stride = FLOATS_PER_VERTEX * 4;
    const attr = (name: string, size: number, offset: number) => {
      const loc = g.getAttribLocation(p, name);
      g.enableVertexAttribArray(loc);
      g.vertexAttribPointer(loc, size, g.FLOAT, false, stride, offset * 4);
    };
    attr("a_pos", 3, 0);
    attr("a_normal", 2, 3);
    attr("a_uv", 2, 5);
    attr("a_meta", 4, 7);
    g.bindVertexArray(null);
    g.bindBuffer(g.ARRAY_BUFFER, null);

    map.on("moveend", this.schedule);
    map.on("idle", this.schedule);
    map.on("sourcedata", this.onSourceData);
    this.schedule();
  }

  onRemove(map: MlMap): void {
    map.off("moveend", this.schedule);
    map.off("idle", this.schedule);
    map.off("sourcedata", this.onSourceData);
    window.clearTimeout(this.timer);
    this.gl.deleteBuffer(this.buffer);
    this.gl.deleteVertexArray(this.vao);
    this.gl.deleteProgram(this.program);
  }

  private onSourceData = (e: { sourceId?: string; isSourceLoaded?: boolean }) => {
    if (e.sourceId === this.sourceId && e.isSourceLoaded) this.schedule();
  };

  // queryRenderedFeatures needs the frame rendered: rebuild after tiles finish too.

  private schedule = () => {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(this.rebuild, 120);
  };

  /** Rebuild the mesh from the buildings in the loaded tiles, around the current centre. */
  private rebuild = () => {
    const map = this.map;
    if (map.getZoom() < BUILDINGS_3D_MIN_ZOOM - 0.3) {
      this.vertexCount = 0;
      return;
    }
    const c = map.getCenter();
    const key = `${c.lng.toFixed(5)},${c.lat.toFixed(5)},${map.getZoom().toFixed(2)},${map.getBearing().toFixed(1)},${map.getPitch().toFixed(1)},${map.areTilesLoaded()}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    // Only buildings in the current tiles inside the view (no cached parent-tile duplicates).
    let features = map.getLayer(BUILDINGS_QUERY_LAYER)
      ? map.queryRenderedFeatures({ layers: [BUILDINGS_QUERY_LAYER] })
      : [];
    if (features.length > MAX_FEATURES) {
      // A tilted view reaches far: keep the buildings nearest the centre of the view.
      const { lng, lat } = map.getCenter();
      const k = Math.cos((lat * Math.PI) / 180);
      const dist = (f: (typeof features)[number]) => {
        const pt = firstPosition(f.geometry) ?? [lng, lat];
        return ((pt[0]! - lng) * k) ** 2 + (pt[1]! - lat) ** 2;
      };
      features = features
        .map((f) => [dist(f), f] as const)
        .sort((a, b) => a[0] - b[0])
        .slice(0, MAX_FEATURES)
        .map(([, f]) => f);
    }
    const origin = MercatorCoordinate.fromLngLat(map.getCenter(), 0);
    const s = origin.meterInMercatorCoordinateUnits();
    const toLocal = (lon: number, lat: number): [number, number] => {
      const m = MercatorCoordinate.fromLngLat([lon, lat], 0);
      return [(m.x - origin.x) / s, -(m.y - origin.y) / s];
    };
    const { data, vertexCount } = buildBuildingMesh(features, toLocal);
    const g = this.gl;
    g.bindBuffer(g.ARRAY_BUFFER, this.buffer);
    g.bufferData(g.ARRAY_BUFFER, data, g.STATIC_DRAW);
    g.bindBuffer(g.ARRAY_BUFFER, null);
    this.origin = origin;
    this.scale = s;
    this.vertexCount = vertexCount;
    map.triggerRepaint();
  };

  render(gl: WebGLRenderingContext | WebGL2RenderingContext, args: CustomRenderMethodInput): void {
    const zoom = this.map.getZoom();
    if (this.vertexCount === 0 || zoom < BUILDINGS_3D_MIN_ZOOM - 0.3) return;
    const g = gl as WebGL2RenderingContext;
    // local metres -> mercator: translate to the origin, scale (y flipped: north is -y).
    const s = this.scale;
    const model = [s, 0, 0, 0, 0, -s, 0, 0, 0, 0, s, 0, this.origin.x, this.origin.y, 0, 1];
    // mainMatrix: mercator 0..1 -> clip space (z conformal in "3d" mode)
    const matrix = mul(args.defaultProjectionData.mainMatrix as unknown as ArrayLike<number>, model);
    g.useProgram(this.program);
    g.uniformMatrix4fv(this.uniforms.u_matrix!, false, matrix);
    g.uniform1f(this.uniforms.u_grow!, Math.min(Math.max((zoom - (BUILDINGS_3D_MIN_ZOOM - 0.3)) / 0.7, 0), 1));
    g.uniform3fv(this.uniforms.u_palette!, PALETTE.flat());
    g.uniform1f(this.uniforms.u_dpr!, window.devicePixelRatio || 1);
    g.uniform3f(this.uniforms.u_sun!, -0.55, -0.75, 0.6); // from the south-west, high
    g.uniform3f(this.uniforms.u_ink!, 0.09, 0.082, 0.12);
    g.enable(g.DEPTH_TEST);
    g.depthFunc(g.LEQUAL);
    g.depthMask(true);
    g.disable(g.CULL_FACE);
    g.disable(g.BLEND);
    g.bindVertexArray(this.vao);
    g.drawArrays(g.TRIANGLES, 0, this.vertexCount);
    g.bindVertexArray(null);
  }
}
