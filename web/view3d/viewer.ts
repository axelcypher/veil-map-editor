// A floating second view of the map: the terrain in 3D, or the planet as a globe carrying the map.
// The terrain is the imported height grid with the current map view draped over it.
import type { GlobeOptions } from '../model/types'
import { GlobeRenderer, type GlobeFrame } from './globe'

export interface TerrainPatch {
  width: number
  height: number
  /** metres, row by row from the north-west */
  heights: Float32Array
  /** RGBA per sample: what the map shows there */
  colors: Uint8Array
  /** size of the patch on the planet */
  widthKm: number
  heightKm: number
}

export interface ViewerSource {
  terrain(): TerrainPatch | null
  /** the whole map as an image for the globe */
  world(source: GlobeOptions['source']): Promise<HTMLCanvasElement>
  /** slopes of the terrain for relief on the globe */
  slope(): { data: Uint8Array; width: number; height: number } | null
}

type Matrix = Float32Array

function perspective(fovy: number, aspect: number, near: number, far: number): Matrix {
  const f = 1 / Math.tan(fovy / 2)
  const out = new Float32Array(16)
  out[0] = f / aspect
  out[5] = f
  out[10] = (far + near) / (near - far)
  out[11] = -1
  out[14] = 2 * far * near / (near - far)
  return out
}

function lookAt(eye: number[], target: number[], up: number[]): Matrix {
  const z = normalize([eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]])
  const x = normalize(cross(up, z))
  const y = cross(z, x)
  return Float32Array.from([
    x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
    -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]), -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]), -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]), 1,
  ])
}

const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const normalize = (v: number[]) => {
  const length = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / length, v[1] / length, v[2] / length]
}

function multiply(a: Matrix, b: Matrix): Matrix {
  const out = new Float32Array(16)
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0
      for (let k = 0; k < 4; k += 1) sum += a[k * 4 + row] * b[column * 4 + k]
      out[column * 4 + row] = sum
    }
  }
  return out
}

function program(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram {
  const build = (type: number, source: string) => {
    const shader = gl.createShader(type)!
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'Shader')
    return shader
  }
  const linked = gl.createProgram()!
  gl.attachShader(linked, build(gl.VERTEX_SHADER, vertex))
  gl.attachShader(linked, build(gl.FRAGMENT_SHADER, fragment))
  gl.linkProgram(linked)
  if (!gl.getProgramParameter(linked, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(linked) ?? 'Programm')
  return linked
}

const TERRAIN_VERTEX = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D u_height;
uniform highp sampler2D u_color;
uniform mat4 u_mvp;
uniform vec4 u_grid;
uniform vec2 u_scale;
out vec3 v_normal;
out vec3 v_color;
float zAt(ivec2 p) {
  ivec2 size = ivec2(u_grid.xy);
  return max(texelFetch(u_height, clamp(p, ivec2(0), size - 1), 0).r - u_scale.x, 0.0) * u_scale.y;
}
void main() {
  int quadsX = int(u_grid.x) - 1;
  int quad = gl_VertexID / 6;
  int corner = gl_VertexID % 6;
  ivec2 offset = corner == 0 ? ivec2(0, 0) : corner == 1 ? ivec2(1, 0) : corner == 2 ? ivec2(0, 1) : corner == 3 ? ivec2(1, 0) : corner == 4 ? ivec2(1, 1) : ivec2(0, 1);
  ivec2 p = ivec2(quad % quadsX, quad / quadsX) + offset;
  float z = zAt(p);
  vec2 step = vec2(u_grid.z, u_grid.w) / (u_grid.xy - 1.0);
  vec3 normal = normalize(vec3(-(zAt(p + ivec2(1, 0)) - zAt(p - ivec2(1, 0))) / (2.0 * step.x), 1.0, -(zAt(p + ivec2(0, 1)) - zAt(p - ivec2(0, 1))) / (2.0 * step.y)));
  v_normal = z <= 0.0 ? vec3(0.0, 1.0, 0.0) : normal;
  v_color = texelFetch(u_color, p, 0).rgb;
  gl_Position = u_mvp * vec4(float(p.x) * step.x - u_grid.z * 0.5, z, float(p.y) * step.y - u_grid.w * 0.5, 1.0);
}`

const TERRAIN_FRAGMENT = `#version 300 es
precision highp float;
in vec3 v_normal;
in vec3 v_color;
out vec4 outColor;
void main() {
  vec3 light = normalize(vec3(-0.55, 0.75, 0.45));
  float lit = 0.42 + 0.72 * max(dot(normalize(v_normal), light), 0.0);
  outColor = vec4(v_color * lit, 1.0);
}`

export class Viewer {
  private readonly canvas: HTMLCanvasElement
  private readonly source: ViewerSource
  private readonly gl: WebGL2RenderingContext
  private readonly terrain: WebGLProgram
  private readonly globe: GlobeRenderer
  private readonly heightTexture: WebGLTexture
  private readonly colorTexture: WebGLTexture
  private readonly emptyArray: WebGLVertexArrayObject
  private grid = { width: 0, height: 0, worldWidth: 1, worldHeight: 1 }
  private frame = 0
  private animation = 0
  private lastTime = 0
  mode: 'terrain' | 'globe' = 'terrain'
  globeOptions: GlobeOptions
  /** the picture on the globe, kept for the exports */
  world: HTMLCanvasElement | null = null
  slope: { data: Uint8Array; width: number; height: number } | null = null
  private zoom = 1
  private cloudAngle = 0
  exaggeration = 12
  private yaw = 0.5
  private pitch = 0.75
  private distance = 1.3
  private target = [0, 0]
  private unitsPerMeter = 0
  private seaM = 0
  private worldSize = 1

  constructor(canvas: HTMLCanvasElement, source: ViewerSource, globeOptions: GlobeOptions) {
    this.canvas = canvas
    this.source = source
    this.globeOptions = globeOptions
    const gl = canvas.getContext('webgl2', { antialias: true })
    if (!gl) throw new Error('WebGL 2 wird nicht unterstützt.')
    this.gl = gl
    this.terrain = program(gl, TERRAIN_VERTEX, TERRAIN_FRAGMENT)
    this.globe = new GlobeRenderer(gl)
    const texture = () => {
      const created = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, created)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      return created
    }
    this.heightTexture = texture()
    this.colorTexture = texture()
    this.emptyArray = gl.createVertexArray()!

    // one pointer turns (or pans with the right button), two fingers pan and pinch-zoom the terrain
    // and pinch-zoom the globe
    const pointers = new Map<number, { x: number; y: number }>()
    let pan = false
    const spread = () => {
      const [a, b] = [...pointers.values()]
      return Math.hypot(a.x - b.x, a.y - b.y)
    }
    let pinch = 0
    canvas.addEventListener('pointerdown', event => {
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
      pan = event.button !== 0
      if (pointers.size === 2) pinch = spread()
      canvas.setPointerCapture(event.pointerId)
    })
    canvas.addEventListener('pointermove', event => {
      const last = pointers.get(event.pointerId)
      if (!last) return
      const dx = event.clientX - last.x
      const dy = event.clientY - last.y
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (pointers.size === 2) {
        const now = spread()
        this.zoomBy(pinch / Math.max(1, now))
        pinch = now
        if (this.mode === 'terrain') this.panBy(dx / 2, dy / 2)
      } else if (pan && this.mode === 'terrain') {
        this.panBy(dx, dy)
      } else {
        const speed = this.mode === 'globe' ? 0.008 / this.zoom : 0.008
        this.yaw -= dx * speed
        this.pitch = Math.min(1.5, Math.max(this.mode === 'globe' ? -1.5 : 0.08, this.pitch + dy * speed))
      }
      this.draw()
    })
    const stop = (event: PointerEvent) => {
      pointers.delete(event.pointerId)
    }
    canvas.addEventListener('pointerup', stop)
    canvas.addEventListener('pointercancel', stop)
    canvas.addEventListener('wheel', event => {
      event.preventDefault()
      this.zoomBy(Math.exp(event.deltaY * 0.0012))
      this.draw()
    }, { passive: false })
    canvas.addEventListener('contextmenu', event => event.preventDefault())
  }

  /** factor > 1 moves away */
  private zoomBy(factor: number) {
    if (this.mode === 'globe') this.zoom = Math.min(12, Math.max(0.4, this.zoom / factor))
    else this.distance = Math.min(6, Math.max(0.15, this.distance * factor))
  }

  private panBy(dx: number, dy: number) {
    const scale = this.distance * this.worldSize * 0.0016
    this.target[0] -= (Math.cos(this.yaw) * dx + Math.sin(this.yaw) * dy) * scale
    this.target[1] -= (-Math.sin(this.yaw) * dx + Math.cos(this.yaw) * dy) * scale
  }

  setMode(mode: 'terrain' | 'globe') {
    this.mode = mode
    this.distance = 1.3
    this.zoom = 1
    this.pitch = mode === 'globe' ? 0.35 : 0.75
    this.update().catch(error => console.error(error))
    this.animate()
  }

  /** new globe settings; the picture is read again only when its source changed */
  setGlobeOptions(options: GlobeOptions) {
    const sourceChanged = options.source !== this.globeOptions.source
    this.globeOptions = options
    if (this.mode === 'globe' && sourceChanged) this.update().catch(error => console.error(error))
    this.animate()
    this.draw()
  }

  /** the view the globe is seen from, for the exports */
  globeFrame(): GlobeFrame {
    return { spin: this.yaw, pitch: this.pitch, zoom: this.zoom, cloudAngle: this.cloudAngle }
  }

  /** turns the globe while it is shown and rotation is on */
  private animate() {
    cancelAnimationFrame(this.animation)
    if (this.mode !== 'globe' || !this.globeOptions.rotate || !this.globeOptions.speed) return
    this.lastTime = performance.now()
    const tick = (time: number) => {
      const dt = Math.min(0.1, (time - this.lastTime) / 1000)
      this.lastTime = time
      const turn = (this.globeOptions.speed * Math.PI) / 180 * dt
      this.yaw -= turn
      this.cloudAngle += turn * this.globeOptions.clouds.turns
      this.render()
      this.animation = requestAnimationFrame(tick)
    }
    this.animation = requestAnimationFrame(tick)
  }

  dispose() {
    cancelAnimationFrame(this.animation)
    cancelAnimationFrame(this.frame)
  }

  /** turn the globe so the given point faces the viewer */
  centerGlobe(lon = 0, lat = 20) {
    this.yaw = (lon * Math.PI) / 180
    this.pitch = (lat * Math.PI) / 180
  }

  /** read the map again: heights and colours for the terrain, the picture for the globe */
  async update() {
    const { gl } = this
    if (this.mode === 'terrain') {
      const patch = this.source.terrain()
      if (!patch) return
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
      gl.bindTexture(gl.TEXTURE_2D, this.heightTexture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, patch.width, patch.height, 0, gl.RED, gl.FLOAT, patch.heights)
      gl.bindTexture(gl.TEXTURE_2D, this.colorTexture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, patch.width, patch.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, patch.colors)
      this.grid = { width: patch.width, height: patch.height, worldWidth: patch.widthKm, worldHeight: patch.heightKm }
      this.seaM = 0
      this.unitsPerMeter = 1 / 1000
      this.worldSize = Math.max(patch.widthKm, patch.heightKm)
    } else {
      this.world = await this.source.world(this.globeOptions.source)
      this.slope = this.source.slope()
      this.globe.setMap(this.world)
      this.globe.setSlope(this.slope)
    }
    this.draw()
  }

  resize() {
    const ratio = window.devicePixelRatio || 1
    const width = Math.max(1, Math.round(this.canvas.clientWidth * ratio))
    const height = Math.max(1, Math.round(this.canvas.clientHeight * ratio))
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width
      this.canvas.height = height
    }
    this.draw()
  }

  draw() {
    cancelAnimationFrame(this.frame)
    this.frame = requestAnimationFrame(() => this.render())
  }

  private render() {
    const { gl, canvas } = this
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.enable(gl.DEPTH_TEST)
    gl.clearColor(0.05, 0.08, 0.11, 1)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    const aspect = canvas.width / Math.max(1, canvas.height)
    if (this.mode === 'terrain') {
      if (!this.grid.width) return
      const radius = this.distance * this.worldSize
      const eye = [
        this.target[0] + Math.sin(this.yaw) * Math.cos(this.pitch) * radius,
        Math.sin(this.pitch) * radius,
        this.target[1] + Math.cos(this.yaw) * Math.cos(this.pitch) * radius,
      ]
      const mvp = multiply(perspective(0.9, aspect, radius * 0.01, radius * 8), lookAt(eye, [this.target[0], 0, this.target[1]], [0, 1, 0]))
      gl.useProgram(this.terrain)
      gl.bindVertexArray(this.emptyArray)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, this.heightTexture)
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, this.colorTexture)
      gl.uniform1i(gl.getUniformLocation(this.terrain, 'u_height'), 0)
      gl.uniform1i(gl.getUniformLocation(this.terrain, 'u_color'), 1)
      gl.uniformMatrix4fv(gl.getUniformLocation(this.terrain, 'u_mvp'), false, mvp)
      gl.uniform4f(gl.getUniformLocation(this.terrain, 'u_grid'), this.grid.width, this.grid.height, this.grid.worldWidth, this.grid.worldHeight)
      gl.uniform2f(gl.getUniformLocation(this.terrain, 'u_scale'), this.seaM, this.unitsPerMeter * this.exaggeration)
      gl.drawArrays(gl.TRIANGLES, 0, (this.grid.width - 1) * (this.grid.height - 1) * 6)
      return
    }

    this.globe.render(this.globeOptions, this.globeFrame(), canvas.width, canvas.height)
  }
}
