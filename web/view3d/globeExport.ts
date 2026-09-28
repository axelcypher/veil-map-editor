// Pictures and animations of the globe, rendered off-screen at the size asked for. An animation is
// one full turn, so it loops without a jump; clouds that drift make whole extra turns in that time.
import { applyPalette, GIFEncoder, quantize } from 'gifenc'
import type { GlobeOptions } from '../model/types'
import { GlobeRenderer, type GlobeFrame } from './globe'

export interface GlobeScene {
  world: TexImageSource | null
  slope: { data: Uint8Array; width: number; height: number } | null
  options: GlobeOptions
  frame: GlobeFrame
}

/** renders frames into a 2D canvas, where the pixels come out with straight alpha */
function offscreen(scene: GlobeScene, width: number, height: number) {
  const glCanvas = document.createElement('canvas')
  glCanvas.width = width
  glCanvas.height = height
  const gl = glCanvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false, alpha: true, premultipliedAlpha: true })
  if (!gl) throw new Error('WebGL 2 wird nicht unterstützt.')
  const max = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number
  if (width > max || height > max) throw new Error(`Höchstens ${max} px je Seite.`)
  const renderer = new GlobeRenderer(gl)
  renderer.setMap(scene.world)
  renderer.setSlope(scene.slope)
  const out = document.createElement('canvas')
  out.width = width
  out.height = height
  const ctx = out.getContext('2d', { willReadFrequently: true })!
  return {
    canvas: out,
    draw(frame: GlobeFrame) {
      renderer.render(scene.options, frame, width, height)
      ctx.clearRect(0, 0, width, height)
      ctx.drawImage(glCanvas, 0, 0)
      return ctx
    },
    dispose() {
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    },
  }
}

/** frame i of n: the globe turned by i/n of a full turn in its direction of rotation */
function frameAt(scene: GlobeScene, i: number, n: number): GlobeFrame {
  const direction = Math.sign(scene.options.speed) || 1
  const turn = (2 * Math.PI * i) / n
  return {
    ...scene.frame,
    spin: scene.frame.spin - direction * turn,
    cloudAngle: scene.frame.cloudAngle + direction * turn * scene.options.clouds.turns,
  }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

export async function globePng(scene: GlobeScene, width: number, height: number): Promise<Uint8Array> {
  const view = offscreen(scene, width, height)
  try {
    view.draw(scene.frame)
    const blob = await new Promise<Blob | null>(resolve => view.canvas.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error('PNG konnte nicht erzeugt werden.')
    return new Uint8Array(await blob.arrayBuffer())
  } finally {
    view.dispose()
  }
}

export async function globeGif(scene: GlobeScene, onProgress: (fraction: number) => void): Promise<Uint8Array> {
  const { width, height, frames, fps } = scene.options.export
  const transparent = scene.options.background.kind === 'transparent'
  const format = transparent ? 'rgba4444' : 'rgb565'
  const view = offscreen(scene, width, height)
  const gif = GIFEncoder()
  try {
    for (let i = 0; i < frames; i++) {
      const pixels = view.draw(frameAt(scene, i, frames)).getImageData(0, 0, width, height).data
      const palette = quantize(pixels, 256, { format, oneBitAlpha: transparent })
      const index = applyPalette(pixels, palette, format)
      const transparentIndex = transparent ? palette.findIndex(color => color[3] === 0) : -1
      gif.writeFrame(index, width, height, {
        palette,
        delay: Math.round(1000 / fps),
        repeat: 0,
        transparent: transparentIndex >= 0,
        transparentIndex: Math.max(0, transparentIndex),
        // a transparent picture has to be cleared before the next frame, or the frames pile up
        dispose: transparent ? 2 : -1,
      })
      onProgress((i + 1) / frames)
      await tick()
    }
    gif.finish()
    return gif.bytes()
  } finally {
    view.dispose()
  }
}

export function webmSupported() {
  return typeof MediaRecorder !== 'undefined' && ['video/webm;codecs=vp9', 'video/webm'].some(type => MediaRecorder.isTypeSupported(type))
}

/** a WebM video of one turn; recorded in real time, so it takes as long as it plays */
export async function globeWebm(scene: GlobeScene, onProgress: (fraction: number) => void): Promise<Uint8Array> {
  const { width, height, frames, fps } = scene.options.export
  const view = offscreen(scene, width, height)
  const mimeType = ['video/webm;codecs=vp9', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type))
  if (!mimeType) throw new Error('Dieses System kann kein WebM aufnehmen.')
  const stream = view.canvas.captureStream(0)
  const track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void }
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: Math.round(width * height * fps * 0.25) })
  const chunks: Blob[] = []
  recorder.ondataavailable = event => {
    if (event.data.size) chunks.push(event.data)
  }
  const stopped = new Promise<void>(resolve => (recorder.onstop = () => resolve()))
  try {
    recorder.start()
    const start = performance.now()
    for (let i = 0; i < frames; i++) {
      view.draw(frameAt(scene, i, frames))
      track.requestFrame?.()
      onProgress((i + 1) / frames)
      // pace the frames at the playback rate
      const wait = start + ((i + 1) * 1000) / fps - performance.now()
      await new Promise(resolve => setTimeout(resolve, Math.max(0, wait)))
    }
    recorder.stop()
    await stopped
    return new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer())
  } finally {
    stream.getTracks().forEach(t => t.stop())
    view.dispose()
  }
}
