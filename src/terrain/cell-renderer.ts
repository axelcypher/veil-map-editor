// Draws the whole cell mesh in one WebGL call. Every cell polygon is triangulated once, the colours live in a texture,
// so an edit only re-uploads that texture and pan and zoom cost a single draw.
import type { GridGraph } from './graph'

export interface View {
  /** device pixels per map unit */
  scale: number
  /** device pixel position of the map origin */
  x: number
  y: number
}

const TEXTURE_WIDTH = 1024

const VERTEX_SHADER = `#version 300 es
in vec2 a_position;
in float a_cell;
uniform vec2 u_size;
uniform vec3 u_view;
uniform highp sampler2D u_colors;
flat out vec4 v_color;
void main() {
  vec2 pixel = a_position * u_view.x + u_view.yz;
  gl_Position = vec4(pixel.x / u_size.x * 2.0 - 1.0, 1.0 - pixel.y / u_size.y * 2.0, 0.0, 1.0);
  int cell = int(a_cell);
  v_color = texelFetch(u_colors, ivec2(cell % ${TEXTURE_WIDTH}, cell / ${TEXTURE_WIDTH}), 0);
}`

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
flat in vec4 v_color;
out vec4 outColor;
void main() {
  outColor = vec4(v_color.rgb * v_color.a, v_color.a);
}`

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'Shader konnte nicht kompiliert werden')
  return shader
}

/** cell polygons as triangle fans, x y and the cell id per vertex, clamped to the map so edge cells stay inside */
function buildMesh(graph: GridGraph): Float32Array {
  let vertexTotal = 0
  for (const ring of graph.cellVertices) vertexTotal += Math.max(0, ring.length - 2) * 3

  const mesh = new Float32Array(vertexTotal * 3)
  let offset = 0
  const put = (vertex: number, cell: number) => {
    mesh[offset] = Math.min(graph.width, Math.max(0, graph.vertexX[vertex]))
    mesh[offset + 1] = Math.min(graph.height, Math.max(0, graph.vertexY[vertex]))
    mesh[offset + 2] = cell
    offset += 3
  }
  for (let cell = 0; cell < graph.cellCount; cell += 1) {
    const ring = graph.cellVertices[cell]
    for (let index = 1; index < ring.length - 1; index += 1) {
      put(ring[0], cell)
      put(ring[index], cell)
      put(ring[index + 1], cell)
    }
  }
  return mesh
}

export class CellRenderer {
  readonly canvas: HTMLCanvasElement
  private readonly gl: WebGL2RenderingContext
  private readonly program: WebGLProgram
  private readonly vertexArray: WebGLVertexArrayObject
  private readonly buffer: WebGLBuffer
  private readonly texture: WebGLTexture
  private readonly uniforms: Record<'size' | 'view' | 'colors', WebGLUniformLocation | null>
  private vertexCount = 0
  private textureHeight = 1

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: true, premultipliedAlpha: true })
    if (!gl) throw new Error('WebGL 2 wird von dieser Umgebung nicht unterstützt.')
    this.gl = gl

    this.program = gl.createProgram()!
    gl.attachShader(this.program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER))
    gl.attachShader(this.program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER))
    gl.linkProgram(this.program)
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(this.program) ?? 'Shader konnte nicht gelinkt werden')
    this.uniforms = {
      size: gl.getUniformLocation(this.program, 'u_size'),
      view: gl.getUniformLocation(this.program, 'u_view'),
      colors: gl.getUniformLocation(this.program, 'u_colors'),
    }

    this.vertexArray = gl.createVertexArray()!
    gl.bindVertexArray(this.vertexArray)
    this.buffer = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    const position = gl.getAttribLocation(this.program, 'a_position')
    const cell = gl.getAttribLocation(this.program, 'a_cell')
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 12, 0)
    gl.enableVertexAttribArray(cell)
    gl.vertexAttribPointer(cell, 1, gl.FLOAT, false, 12, 8)

    this.texture = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  }

  /** replace the mesh, the colours are undefined until setColors is called */
  setGraph(graph: GridGraph) {
    const { gl } = this
    const mesh = buildMesh(graph)
    this.vertexCount = mesh.length / 3
    gl.bindVertexArray(this.vertexArray)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    gl.bufferData(gl.ARRAY_BUFFER, mesh, gl.STATIC_DRAW)

    this.textureHeight = Math.ceil(graph.cellCount / TEXTURE_WIDTH)
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, TEXTURE_WIDTH, this.textureHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
  }

  /** one RGBA byte quadruple per cell */
  setColors(colors: Uint8Array) {
    const { gl } = this
    const padded = new Uint8Array(TEXTURE_WIDTH * this.textureHeight * 4)
    padded.set(colors)
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TEXTURE_WIDTH, this.textureHeight, gl.RGBA, gl.UNSIGNED_BYTE, padded)
  }

  resize(width: number, height: number) {
    if (this.canvas.width !== width) this.canvas.width = width
    if (this.canvas.height !== height) this.canvas.height = height
  }

  draw(view: View) {
    const { gl, canvas } = this
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.useProgram(this.program)
    gl.bindVertexArray(this.vertexArray)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.uniform1i(this.uniforms.colors, 0)
    gl.uniform2f(this.uniforms.size, canvas.width, canvas.height)
    gl.uniform3f(this.uniforms.view, view.scale, view.x, view.y)
    gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount)
  }

  dispose() {
    const { gl } = this
    gl.deleteTexture(this.texture)
    gl.deleteBuffer(this.buffer)
    gl.deleteVertexArray(this.vertexArray)
    gl.deleteProgram(this.program)
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
}
