// A floating second view of the map: the terrain in 3D, or the planet as a globe carrying the map.
// The terrain is the imported height grid with the current map view draped over it.

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
  world(): Promise<HTMLCanvasElement>
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

const GLOBE_VERTEX = `#version 300 es
precision highp float;
in vec3 a_position;
uniform mat4 u_mvp;
uniform mat4 u_model;
out vec3 v_normal;
out vec3 v_local;
void main() {
  v_local = a_position;
  v_normal = mat3(u_model) * a_position;
  gl_Position = u_mvp * vec4(a_position, 1.0);
}`

const GLOBE_FRAGMENT = `#version 300 es
precision highp float;
in vec3 v_normal;
in vec3 v_local;
uniform sampler2D u_map;
uniform vec4 u_extent;
uniform float u_global;
uniform vec3 u_eye;
out vec4 outColor;
const float PI = 3.14159265;
void main() {
  vec3 n = normalize(v_local);
  float lon = atan(n.x, n.z);
  float lat = asin(clamp(n.y, -1.0, 1.0));
  vec2 uv;
  if (u_global > 0.5) uv = vec2(lon / (2.0 * PI) + 0.5, 0.5 - lat / PI);
  else uv = vec2((degrees(lon) - u_extent.x) / (u_extent.y - u_extent.x), (u_extent.z - degrees(lat)) / (u_extent.z - u_extent.w));
  vec3 base = vec3(0.16, 0.22, 0.29);
  vec3 color = (uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0) ? texture(u_map, uv).rgb : base;
  vec3 world = normalize(v_normal);
  float lit = 0.32 + 0.8 * max(dot(world, normalize(vec3(-0.4, 0.5, 0.75))), 0.0);
  float rim = pow(1.0 - max(dot(world, normalize(u_eye)), 0.0), 3.0);
  outColor = vec4(color * lit + vec3(0.25, 0.5, 0.9) * rim * 0.7, 1.0);
}`

export class Viewer {
  private readonly canvas: HTMLCanvasElement
  private readonly source: ViewerSource
  private readonly gl: WebGL2RenderingContext
  private readonly terrain: WebGLProgram
  private readonly globe: WebGLProgram
  private readonly heightTexture: WebGLTexture
  private readonly colorTexture: WebGLTexture
  private readonly mapTexture: WebGLTexture
  private readonly emptyArray: WebGLVertexArrayObject
  private readonly sphere: { array: WebGLVertexArrayObject; count: number }
  private grid = { width: 0, height: 0, worldWidth: 1, worldHeight: 1 }
  private globeExtent = { west: -180, east: 180, north: 90, south: -90, global: true }
  private frame = 0
  mode: 'terrain' | 'globe' = 'terrain'
  exaggeration = 12
  private yaw = 0.5
  private pitch = 0.75
  private distance = 1.3
  private target = [0, 0]
  private unitsPerMeter = 0
  private seaM = 0
  private worldSize = 1

  constructor(canvas: HTMLCanvasElement, source: ViewerSource) {
    this.canvas = canvas
    this.source = source
    const gl = canvas.getContext('webgl2', { antialias: true })
    if (!gl) throw new Error('WebGL 2 wird nicht unterstützt.')
    this.gl = gl
    this.terrain = program(gl, TERRAIN_VERTEX, TERRAIN_FRAGMENT)
    this.globe = program(gl, GLOBE_VERTEX, GLOBE_FRAGMENT)
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
    this.mapTexture = texture()
    gl.bindTexture(gl.TEXTURE_2D, this.mapTexture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    this.emptyArray = gl.createVertexArray()!

    // a sphere as latitude rings; longitude 0 faces +z
    const rings = 48
    const segments = 96
    const positions: number[] = []
    for (let ring = 0; ring < rings; ring += 1) {
      for (let segment = 0; segment < segments; segment += 1) {
        const corners: [number, number][] = [[ring, segment], [ring + 1, segment], [ring, segment + 1], [ring, segment + 1], [ring + 1, segment], [ring + 1, segment + 1]]
        for (const [r, s] of corners) {
          const lat = Math.PI / 2 - r / rings * Math.PI
          const lon = s / segments * 2 * Math.PI - Math.PI
          positions.push(Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon))
        }
      }
    }
    const array = gl.createVertexArray()!
    gl.bindVertexArray(array)
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW)
    const location = gl.getAttribLocation(this.globe, 'a_position')
    gl.enableVertexAttribArray(location)
    gl.vertexAttribPointer(location, 3, gl.FLOAT, false, 0, 0)
    this.sphere = { array, count: positions.length / 3 }

    let dragging: { x: number; y: number; pan: boolean } | null = null
    canvas.addEventListener('pointerdown', event => {
      dragging = { x: event.clientX, y: event.clientY, pan: event.button !== 0 }
      canvas.setPointerCapture(event.pointerId)
    })
    canvas.addEventListener('pointermove', event => {
      if (!dragging) return
      const dx = event.clientX - dragging.x
      const dy = event.clientY - dragging.y
      dragging = { ...dragging, x: event.clientX, y: event.clientY }
      if (dragging.pan && this.mode === 'terrain') {
        const scale = this.distance * this.worldSize * 0.0016
        this.target[0] -= (Math.cos(this.yaw) * dx + Math.sin(this.yaw) * dy) * scale
        this.target[1] -= (-Math.sin(this.yaw) * dx + Math.cos(this.yaw) * dy) * scale
      } else {
        this.yaw -= dx * 0.008
        this.pitch = Math.min(1.5, Math.max(this.mode === 'globe' ? -1.5 : 0.08, this.pitch + dy * 0.008))
      }
      this.draw()
    })
    const stop = () => { dragging = null }
    canvas.addEventListener('pointerup', stop)
    canvas.addEventListener('pointercancel', stop)
    canvas.addEventListener('wheel', event => {
      event.preventDefault()
      this.distance = Math.min(6, Math.max(this.mode === 'globe' ? 1.25 : 0.15, this.distance * Math.exp(event.deltaY * 0.0012)))
      this.draw()
    }, { passive: false })
    canvas.addEventListener('contextmenu', event => event.preventDefault())
  }

  setMode(mode: 'terrain' | 'globe') {
    this.mode = mode
    this.distance = mode === 'globe' ? 3 : 1.3
    this.pitch = mode === 'globe' ? 0.35 : 0.75
    this.update().catch(error => console.error(error))
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
      const image = await this.source.world()
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
      gl.bindTexture(gl.TEXTURE_2D, this.mapTexture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image)
      this.globeExtent = { west: -180, east: 180, north: 90, south: -90, global: true }
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

    const radius = this.distance
    const eye = [Math.sin(this.yaw) * Math.cos(this.pitch) * radius, Math.sin(this.pitch) * radius, Math.cos(this.yaw) * Math.cos(this.pitch) * radius]
    const model = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
    const mvp = multiply(perspective(0.7, aspect, 0.05, 20), lookAt(eye, [0, 0, 0], [0, 1, 0]))
    gl.useProgram(this.globe)
    gl.bindVertexArray(this.sphere.array)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.mapTexture)
    gl.uniform1i(gl.getUniformLocation(this.globe, 'u_map'), 0)
    gl.uniformMatrix4fv(gl.getUniformLocation(this.globe, 'u_mvp'), false, mvp)
    gl.uniformMatrix4fv(gl.getUniformLocation(this.globe, 'u_model'), false, model)
    gl.uniform4f(gl.getUniformLocation(this.globe, 'u_extent'), this.globeExtent.west, this.globeExtent.east, this.globeExtent.north, this.globeExtent.south)
    gl.uniform1f(gl.getUniformLocation(this.globe, 'u_global'), this.globeExtent.global ? 1 : 0)
    gl.uniform3f(gl.getUniformLocation(this.globe, 'u_eye'), eye[0], eye[1], eye[2])
    gl.drawArrays(gl.TRIANGLES, 0, this.sphere.count)
  }
}
