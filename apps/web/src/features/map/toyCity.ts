/** Abstract 3D "toy city": a MapLibre custom WebGL2 layer drawing the GTA as hexagonal toy
 * blocks in a manga style (geometry: toyCityMesh.ts, data: public/city-hexes.json).
 *
 * The mesh is built ONCE when the data loads (~6,000 blocks) and never rebuilt while the
 * map moves; panning and zooming only change one matrix uniform.
 *
 * Style, all in one shader:
 *  - toon shading: three hard bands from a fixed sun;
 *  - screentone: printed dots on the mid and shadow bands (screen space);
 *  - ink line art: top edges, hex corners and the ground line, screen-constant width;
 *  - towers: glass with thin ink floor lines and two diagonal anime glare streaks;
 *  - blocks sink away when zoomed in to street level (squashFor), so job pins and street
 *    names stay readable; the flat manga map takes over there. */
import { type CustomLayerInterface, type CustomRenderMethodInput, type Map as MlMap, MercatorCoordinate } from "maplibre-gl";

import { buildToyCity, FLOATS_PER_VERTEX, type HexData, toyBlocks } from "./toyCityMesh";

export const TOY_CITY_DATA_URL = "/city-hexes.json";

/** Podiums: cream (city), sakura (dense core), mint (suburbs); spare: sky, sun, lilac.
 * Towers: glass blues. */
const PALETTE = [
  [1.0, 0.96, 0.88], [1.0, 0.78, 0.86], [0.78, 0.9, 1.0],
  [0.78, 0.94, 0.8], [1.0, 0.93, 0.66], [0.89, 0.84, 1.0],
  [0.66, 0.84, 1.0], [0.56, 0.78, 1.0], [0.72, 0.92, 0.98],
];

const VERT = `#version 300 es
precision highp float;
uniform mat4 u_matrix;
uniform float u_squash;
in vec3 a_pos;
in vec2 a_normal;
in vec3 a_meta; // v (height), top, info
out vec2 v_normal;
out float v_h;
out float v_top;
flat out float v_kind;
flat out float v_colour;
void main() {
  float info = a_meta.z;
  v_kind = floor(info / 100.0 + 0.001);
  v_colour = info - 100.0 * v_kind;
  v_normal = a_normal;
  v_h = a_meta.x;
  v_top = a_meta.y;
  gl_Position = u_matrix * vec4(a_pos.xy, a_pos.z * u_squash, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
uniform vec3 u_palette[9];
uniform float u_dpr;
uniform vec2 u_sun;
uniform vec3 u_ink;
in vec2 v_normal;
in float v_h;
in float v_top;
flat in float v_kind;
flat in float v_colour;
out vec4 fragColor;

float tone(float radius, float cellPx) {
  vec2 p = mat2(0.7071, -0.7071, 0.7071, 0.7071) * (gl_FragCoord.xy / u_dpr);
  vec2 cell = fract(p / cellPx) - 0.5;
  return 1.0 - smoothstep(radius - 0.05, radius + 0.05, length(cell));
}

void main() {
  vec3 base = u_palette[int(v_colour + 0.5)];
  vec3 col;
  if (v_kind > 0.5 && v_kind < 1.5) {
    // top face: brightest, flat
    col = base;
  } else {
    float d = dot(normalize(v_normal), normalize(u_sun));
    bool lit = d > 0.3;
    if (lit) col = base;
    else if (d > -0.3) col = base * 0.9;
    else col = mix(base * 0.8, u_ink, 0.5 * tone(0.26, 4.6));
    if (v_kind > 1.5) {
      // tower: thin ink floor lines (every 40 toy-metres, faded when too dense) + glare
      float pxPerM = 1.0 / max(fwidth(v_h), 1e-4) / u_dpr;
      float floorPx = abs(fract(v_h / 40.0 + 0.5) - 0.5) * 40.0 * pxPerM;
      float show = smoothstep(0.08, 0.16, pxPerM);
      col = mix(col, mix(col, u_ink, 0.45), show * (1.0 - smoothstep(0.3, 0.9, floorPx)));
      if (lit) {
        // two diagonal glare streaks, using height and screen x for the slant
        float t = fract((v_h * 0.004) + gl_FragCoord.x / u_dpr * 0.006);
        float glare = step(0.08, t) * step(t, 0.17) + step(0.21, t) * step(t, 0.24);
        col = mix(col, vec3(1.0), 0.8 * glare);
      }
    }
    // ink: top edge and ground line (screen-constant width)
    float w = 1.4 * u_dpr;
    float edge = min((v_top - v_h) / fwidth(v_h), v_h / fwidth(v_h) + (v_kind > 1.5 ? 1e4 : 0.0));
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

/** The toy city is a city-scale view. Blocks sink into the ground between z12.6 and z13.6
 * and are gone at street scale, where job pins and street names need the room. */
export const TOY_CITY_MAX_ZOOM = 13.6;
export function squashFor(zoom: number): number {
  return Math.min(Math.max((TOY_CITY_MAX_ZOOM - zoom) / 1.0, 0), 1);
}

export class ToyCityLayer implements CustomLayerInterface {
  readonly id = "toy-city";
  readonly type = "custom" as const;
  readonly renderingMode = "3d" as const;
  private map!: MlMap;
  private gl!: WebGL2RenderingContext;
  private program!: WebGLProgram;
  private vao!: WebGLVertexArrayObject;
  private buffer!: WebGLBuffer;
  private vertexCount = 0;
  private model: number[] = [];
  private u: Record<string, WebGLUniformLocation | null> = {};

  constructor(private readonly url = TOY_CITY_DATA_URL) {}

  onAdd(map: MlMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    this.map = map;
    const g = (this.gl = gl as WebGL2RenderingContext);
    const p = g.createProgram()!;
    g.attachShader(p, compile(g, g.VERTEX_SHADER, VERT));
    g.attachShader(p, compile(g, g.FRAGMENT_SHADER, FRAG));
    g.linkProgram(p);
    if (!g.getProgramParameter(p, g.LINK_STATUS)) throw new Error(g.getProgramInfoLog(p) ?? "link");
    this.program = p;
    for (const name of ["u_matrix", "u_squash", "u_palette", "u_dpr", "u_sun", "u_ink"]) {
      this.u[name] = g.getUniformLocation(p, name);
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
    attr("a_meta", 3, 5);
    g.bindVertexArray(null);
    g.bindBuffer(g.ARRAY_BUFFER, null);
    void this.load();
  }

  private async load() {
    let data: HexData;
    try {
      const res = await fetch(this.url);
      if (!res.ok) return;
      data = (await res.json()) as HexData;
    } catch {
      return; // no toy city: the flat manga map remains
    }
    // One fixed origin for the whole city; positions in local metres around it.
    const origin = MercatorCoordinate.fromLngLat(data.origin, 0);
    const s = origin.meterInMercatorCoordinateUnits();
    const toLocal = (lon: number, lat: number): [number, number] => {
      const m = MercatorCoordinate.fromLngLat([lon, lat], 0);
      return [(m.x - origin.x) / s, -(m.y - origin.y) / s];
    };
    const mesh = buildToyCity(toyBlocks(data), data.size, toLocal);
    const g = this.gl;
    g.bindBuffer(g.ARRAY_BUFFER, this.buffer);
    g.bufferData(g.ARRAY_BUFFER, mesh.data, g.STATIC_DRAW);
    g.bindBuffer(g.ARRAY_BUFFER, null);
    this.model = [s, 0, 0, 0, 0, -s, 0, 0, 0, 0, s, 0, origin.x, origin.y, 0, 1];
    this.vertexCount = mesh.vertexCount;
    this.map.triggerRepaint();
  }

  onRemove(): void {
    this.gl.deleteBuffer(this.buffer);
    this.gl.deleteVertexArray(this.vao);
    this.gl.deleteProgram(this.program);
  }

  render(gl: WebGLRenderingContext | WebGL2RenderingContext, args: CustomRenderMethodInput): void {
    const squash = squashFor(this.map.getZoom());
    if (this.vertexCount === 0 || squash <= 0) return;
    const g = gl as WebGL2RenderingContext;
    const matrix = mul(args.defaultProjectionData.mainMatrix as unknown as ArrayLike<number>, this.model);
    g.useProgram(this.program);
    g.uniformMatrix4fv(this.u.u_matrix!, false, matrix);
    g.uniform1f(this.u.u_squash!, squash);
    g.uniform3fv(this.u.u_palette!, PALETTE.flat());
    g.uniform1f(this.u.u_dpr!, window.devicePixelRatio || 1);
    g.uniform2f(this.u.u_sun!, -0.6, -0.8); // light from the south-west
    g.uniform3f(this.u.u_ink!, 0.09, 0.082, 0.12);
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
