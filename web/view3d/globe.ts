// The planet as a globe, drawn in one full-screen pass: every pixel casts a ray against the unit
// sphere. That gives exact, smooth edges at any export size and lets the background, the glow of
// the atmosphere, clouds and the day–night line share one shader. Works on any WebGL 2 context, so
// the window and the off-screen exports use the same code.
import type { GlobeOptions } from '../model/types'

export interface GlobeFrame {
  /** longitude facing the viewer, radians */
  spin: number
  /** latitude facing the viewer, radians */
  pitch: number
  /** 1 = the whole globe with its atmosphere fills the picture */
  zoom: number
  /** extra turn of the cloud layer about the axis, radians */
  cloudAngle: number
}

const VERTEX = `#version 300 es
out vec2 v_ndc;
void main() {
  // one triangle that covers the screen
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  v_ndc = p;
  gl_Position = vec4(p, 0.0, 1.0);
}`

const FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_ndc;
out vec4 outColor;
uniform sampler2D u_map;
uniform sampler2D u_slope;
uniform mat3 u_model;
uniform mat3 u_cloud;
uniform float u_distance;
uniform float u_tanHalf;
uniform float u_aspect;
uniform float u_pixel;
uniform float u_hasMap;
uniform float u_relief;
uniform float u_hasSlope;
uniform vec3 u_sun;
uniform vec3 u_sunParams; // on, night brightness, softness
uniform vec4 u_atmo;      // rgb, strength
uniform vec2 u_atmoParams; // on, thickness
uniform vec4 u_grat;      // rgb, opacity
uniform vec2 u_gratParams; // on, step in degrees
uniform vec4 u_clouds;    // cover, opacity, scale, seed
uniform float u_cloudsOn;
uniform vec4 u_bg;        // rgb, kind: 0 transparent, 1 colour, 2 stars
const float PI = 3.14159265358979;

float hash(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.x + p.y) * p.z);
}

float noise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}

float fbm(vec3 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 6; i++) {
    sum += amp * noise(p);
    p = p * 2.03 + vec3(17.1, 3.7, 9.2);
    amp *= 0.5;
  }
  return sum / 0.984;
}

float stars(vec3 dir, float cells) {
  vec3 q = dir * cells;
  vec3 cell = floor(q);
  float h = hash(cell);
  if (h < 0.965) return 0.0;
  vec3 center = cell + 0.5 + (vec3(hash(cell + 7.1), hash(cell + 3.3), hash(cell + 5.9)) - 0.5) * 0.6;
  float d = length(q - center);
  return smoothstep(0.32, 0.0, d) * (0.35 + 0.65 * hash(cell + 1.7));
}

/** premultiplied background */
vec4 background(vec3 dir) {
  if (u_bg.w < 0.5) return vec4(0.0);
  if (u_bg.w < 1.5) return vec4(u_bg.rgb, 1.0);
  float s = stars(dir, 1.0 / (u_pixel * 5.0)) + 0.6 * stars(dir.yzx, 1.0 / (u_pixel * 3.0));
  return vec4(u_bg.rgb + vec3(s) * vec3(0.9, 0.95, 1.0), 1.0);
}

/** how much of the sun a direction sees: 0 on the night side, soft across the terminator */
float daylight(vec3 n) {
  if (u_sunParams.x < 0.5) return 1.0;
  return smoothstep(-u_sunParams.z, u_sunParams.z, dot(n, u_sun));
}

void main() {
  vec3 origin = vec3(0.0, 0.0, u_distance);
  vec3 dir = normalize(vec3(v_ndc.x * u_tanHalf * u_aspect, v_ndc.y * u_tanHalf, -1.0));
  float b = dot(origin, dir);
  float c = dot(origin, origin) - 1.0;
  // distance of the ray from the planet's centre, in radii
  float m = sqrt(max(dot(origin, origin) - b * b, 0.0));
  // one pixel at the limb, in the same unit
  float px = u_pixel * sqrt(max(c, 1e-4));
  float coverage = 1.0 - smoothstep(1.0 - px, 1.0 + px, m);

  vec4 color = background(dir);

  // glow of the atmosphere around the disc
  if (u_atmoParams.x > 0.5 && b < 0.0 && m > 1.0 - px) {
    vec3 closest = normalize(origin - b * dir);
    float glow = u_atmo.w * exp(-(m - 1.0) / max(u_atmoParams.y, 1e-3)) * 0.85;
    glow *= mix(0.12, 1.0, smoothstep(-0.35, 0.45, u_sunParams.x > 0.5 ? dot(closest, u_sun) : 1.0));
    glow = clamp(glow, 0.0, 1.0);
    color = vec4(color.rgb * (1.0 - glow) + u_atmo.rgb * glow, color.a + (1.0 - color.a) * glow);
  }

  if (coverage > 0.0) {
    float h = max(b * b - c, 0.0);
    vec3 p = normalize(origin + (-b - sqrt(h)) * dir);
    vec3 local = transpose(u_model) * p;
    float lon = atan(local.x, local.z);
    float lat = asin(clamp(local.y, -1.0, 1.0));

    // texture coordinates without a seam at ±180°: the gradient comes from whichever of two
    // parametrisations is continuous here
    vec2 uv = vec2(lon / (2.0 * PI) + 0.5, 0.5 - lat / PI);
    float shifted = fract(uv.x + 0.5);
    vec2 dx = dFdx(uv);
    vec2 dy = dFdy(uv);
    float dxs = dFdx(shifted);
    float dys = dFdy(shifted);
    if (abs(dxs) + abs(dys) < abs(dx.x) + abs(dy.x)) {
      dx.x = dxs;
      dy.x = dys;
    }
    vec3 surface = u_hasMap > 0.5 ? textureGrad(u_map, uv, dx, dy).rgb : vec3(0.16, 0.22, 0.29);

    // relief: tilt the normal by the slope of the terrain
    vec3 east = vec3(cos(lon), 0.0, -sin(lon));
    vec3 north = vec3(-sin(lat) * sin(lon), cos(lat), -sin(lat) * cos(lon));
    vec3 n = local;
    if (u_hasSlope > 0.5 && u_relief > 0.0) {
      vec2 slope = textureGrad(u_slope, uv, dx, dy).rg * 2.0 - 1.0;
      n = normalize(local - u_relief * 1.6 * (slope.x * east + slope.y * north));
    }
    vec3 nv = u_model * n;

    float light;
    if (u_sunParams.x > 0.5) {
      float day = daylight(p);
      float direct = 0.22 + 0.95 * max(dot(nv, u_sun), 0.0);
      light = mix(u_sunParams.y, direct, day);
    } else {
      // even light to check the map; the ball is shaded gently, the relief shows fully
      vec3 l = normalize(vec3(-0.45, 0.55, 0.7));
      light = 0.8 + 0.25 * dot(p, l) + 1.1 * (dot(nv, l) - dot(p, l));
    }
    surface *= light;

    // graticule
    if (u_gratParams.x > 0.5) {
      float latDeg = degrees(lat) / u_gratParams.y;
      float lonDeg = degrees(lon) / u_gratParams.y;
      float lonWrapped = mod(degrees(lon) + 360.0, 360.0) / u_gratParams.y;
      float wLat = max(fwidth(latDeg), 1e-5);
      float wLon = max(min(fwidth(lonDeg), fwidth(lonWrapped)), 1e-5);
      float dLat = abs(fract(latDeg + 0.5) - 0.5) / wLat;
      float dLon = abs(fract(lonDeg + 0.5) - 0.5) / wLon;
      float line = max(1.0 - smoothstep(0.4, 1.3, dLat), (1.0 - smoothstep(0.4, 1.3, dLon)) * smoothstep(88.0, 80.0, abs(degrees(lat))));
      surface = mix(surface, u_grat.rgb * mix(u_sunParams.y + 0.3, 1.0, daylight(p)), line * u_grat.a);
    }

    // clouds
    if (u_cloudsOn > 0.5) {
      vec3 q = u_cloud * local;
      float f = fbm(q * u_clouds.z + u_clouds.w * 13.7);
      float threshold = 1.0 - u_clouds.x;
      float cloud = smoothstep(threshold - 0.06, threshold + 0.14, f) * u_clouds.y;
      float cloudLight = u_sunParams.x > 0.5 ? mix(u_sunParams.y * 0.8, 1.0, daylight(p)) : 0.95;
      surface = mix(surface, vec3(cloudLight), cloud);
    }

    // the atmosphere seen against the surface near the rim
    if (u_atmoParams.x > 0.5) {
      float rim = pow(1.0 - max(dot(p, -dir), 0.0), 3.0) * u_atmo.w * 0.9;
      surface += u_atmo.rgb * rim * mix(0.1, 1.0, daylight(p));
    }
    color = mix(color, vec4(surface, 1.0), coverage);
  }
  outColor = color;
}`

function compile(gl: WebGL2RenderingContext) {
  const build = (type: number, source: string) => {
    const shader = gl.createShader(type)!
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'Shader')
    return shader
  }
  const program = gl.createProgram()!
  gl.attachShader(program, build(gl.VERTEX_SHADER, VERTEX))
  gl.attachShader(program, build(gl.FRAGMENT_SHADER, FRAGMENT))
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'Programm')
  return program
}

const rgb = (hex: string): [number, number, number] => {
  const v = parseInt(hex.replace('#', ''), 16) || 0
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]
}

/** column-major 3 × 3 rotations */
function rotX(a: number) {
  const c = Math.cos(a), s = Math.sin(a)
  return [1, 0, 0, 0, c, s, 0, -s, c]
}
function rotY(a: number) {
  const c = Math.cos(a), s = Math.sin(a)
  return [c, 0, -s, 0, 1, 0, s, 0, c]
}
function rotZ(a: number) {
  const c = Math.cos(a), s = Math.sin(a)
  return [c, s, 0, -s, c, 0, 0, 0, 1]
}
function mul(a: number[], b: number[]) {
  const out = new Array<number>(9).fill(0)
  for (let col = 0; col < 3; col++) for (let row = 0; row < 3; row++) for (let k = 0; k < 3; k++) out[col * 3 + row] += a[k * 3 + row] * b[col * 3 + k]
  return out
}

/** camera distance for a zoom; 1 shows the globe and its glow with a small margin */
export function cameraDistance(fovDegrees: number, zoom: number) {
  const fit = 1.16 / Math.sin(((fovDegrees * Math.PI) / 180) / 2)
  return Math.max(1.02, fit / zoom)
}

/**
 * The slope of the terrain as a small RGBA texture (east and north slope in R and G), from the
 * height grid in metres. The sea counts as flat.
 */
export function slopeTexture(grid: Int16Array, width: number, height: number, radiusM: number) {
  const w = Math.min(width, 2048)
  const h = w / 2
  const step = width / w
  const at = (x: number, y: number) => {
    const gx = Math.floor((((x % w) + w) % w) * step)
    const gy = Math.min(height - 1, Math.max(0, Math.floor(y * step)))
    return Math.max(0, grid[gy * width + gx])
  }
  const data = new Uint8Array(w * h * 4)
  const dy = (Math.PI * radiusM) / h
  // slopes up to 1:8 fill the byte range
  const scale = 8 * 127
  for (let y = 0; y < h; y++) {
    const lat = 90 - ((y + 0.5) / h) * 180
    const dx = (2 * Math.PI * radiusM * Math.max(0.02, Math.cos((lat * Math.PI) / 180))) / w
    for (let x = 0; x < w; x++) {
      const east = (at(x + 1, y) - at(x - 1, y)) / (2 * dx)
      const north = (at(x, y - 1) - at(x, y + 1)) / (2 * dy)
      const i = (y * w + x) * 4
      data[i] = Math.max(0, Math.min(255, 128 + east * scale))
      data[i + 1] = Math.max(0, Math.min(255, 128 + north * scale))
      data[i + 3] = 255
      data[i + 2] = 0
    }
  }
  return { data, width: w, height: h }
}

export class GlobeRenderer {
  private readonly gl: WebGL2RenderingContext
  private readonly program: WebGLProgram
  private readonly vao: WebGLVertexArrayObject
  private readonly map: WebGLTexture
  private readonly slope: WebGLTexture
  private hasMap = false
  private hasSlope = false
  private readonly uniforms = new Map<string, WebGLUniformLocation | null>()

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl
    this.program = compile(gl)
    this.vao = gl.createVertexArray()!
    const texture = () => {
      const created = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, created)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      return created
    }
    this.map = texture()
    this.slope = texture()
  }

  private u(name: string) {
    if (!this.uniforms.has(name)) this.uniforms.set(name, this.gl.getUniformLocation(this.program, name))
    return this.uniforms.get(name)!
  }

  /** the equirectangular picture the globe wears */
  setMap(image: TexImageSource | null) {
    const { gl } = this
    this.hasMap = !!image
    if (!image) return
    gl.bindTexture(gl.TEXTURE_2D, this.map)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image)
    gl.generateMipmap(gl.TEXTURE_2D)
  }

  setSlope(slope: { data: Uint8Array; width: number; height: number } | null) {
    const { gl } = this
    this.hasSlope = !!slope
    if (!slope) return
    gl.bindTexture(gl.TEXTURE_2D, this.slope)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, slope.width, slope.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, slope.data)
    gl.generateMipmap(gl.TEXTURE_2D)
  }

  render(options: GlobeOptions, frame: GlobeFrame, width: number, height: number) {
    const { gl } = this
    gl.viewport(0, 0, width, height)
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.BLEND)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.useProgram(this.program)
    gl.bindVertexArray(this.vao)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.map)
    gl.uniform1i(this.u('u_map'), 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.slope)
    gl.uniform1i(this.u('u_slope'), 1)

    const rad = Math.PI / 180
    const model = mul(rotZ(-options.tilt * rad), mul(rotX(frame.pitch), rotY(-frame.spin)))
    gl.uniformMatrix3fv(this.u('u_model'), false, model)
    gl.uniformMatrix3fv(this.u('u_cloud'), false, rotY(frame.cloudAngle))
    const tanHalf = Math.tan((options.fov * rad) / 2)
    gl.uniform1f(this.u('u_distance'), cameraDistance(options.fov, frame.zoom))
    gl.uniform1f(this.u('u_tanHalf'), tanHalf)
    gl.uniform1f(this.u('u_aspect'), width / Math.max(1, height))
    gl.uniform1f(this.u('u_pixel'), (2 * tanHalf) / Math.max(1, height))
    gl.uniform1f(this.u('u_hasMap'), this.hasMap ? 1 : 0)
    gl.uniform1f(this.u('u_hasSlope'), this.hasSlope ? 1 : 0)
    gl.uniform1f(this.u('u_relief'), options.relief)

    const { sun, atmosphere, graticule, clouds, background } = options
    const az = sun.azimuth * rad
    const el = sun.elevation * rad
    gl.uniform3f(this.u('u_sun'), Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el))
    gl.uniform3f(this.u('u_sunParams'), sun.on ? 1 : 0, sun.night, Math.max(0.01, sun.softness))
    gl.uniform4f(this.u('u_atmo'), ...rgb(atmosphere.color), atmosphere.strength)
    gl.uniform2f(this.u('u_atmoParams'), atmosphere.on ? 1 : 0, atmosphere.thickness)
    gl.uniform4f(this.u('u_grat'), ...rgb(graticule.color), graticule.opacity)
    gl.uniform2f(this.u('u_gratParams'), graticule.on ? 1 : 0, Math.max(1, graticule.step))
    gl.uniform4f(this.u('u_clouds'), clouds.cover, clouds.opacity, clouds.scale, clouds.seed)
    gl.uniform1f(this.u('u_cloudsOn'), clouds.on ? 1 : 0)
    const kind = background.kind === 'transparent' ? 0 : background.kind === 'color' ? 1 : 2
    gl.uniform4f(this.u('u_bg'), ...rgb(background.color), kind)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }
}
