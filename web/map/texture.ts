// Seamless background textures, generated once. Each is a 256 px tile laid over the whole map.
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

/** value noise that wraps at the tile edge */
function tileNoise(size: number, cells: number, random: () => number) {
  const grid = Array.from({ length: cells * cells }, random)
  const at = (x: number, y: number) => grid[((y + cells) % cells) * cells + ((x + cells) % cells)]
  const out = new Float32Array(size * size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const gx = (x / size) * cells
      const gy = (y / size) * cells
      const x0 = Math.floor(gx)
      const y0 = Math.floor(gy)
      const fx = gx - x0
      const fy = gy - y0
      const sx = fx * fx * (3 - 2 * fx)
      const sy = fy * fy * (3 - 2 * fy)
      const top = at(x0, y0) * (1 - sx) + at(x0 + 1, y0) * sx
      const bottom = at(x0, y0 + 1) * (1 - sx) + at(x0 + 1, y0 + 1) * sx
      out[y * size + x] = top * (1 - sy) + bottom * sy
    }
  }
  return out
}

const cache = new Map<string, string>()

export function textureUrl(kind: 'paper' | 'linen' | 'grain'): string {
  const hit = cache.get(kind)
  if (hit) return hit
  const size = 256
  const random = rng(kind === 'paper' ? 7 : kind === 'linen' ? 11 : 13)
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const image = ctx.createImageData(size, size)
  const coarse = tileNoise(size, 4, random)
  const medium = tileNoise(size, 16, random)
  const fine = tileNoise(size, 64, random)
  for (let i = 0; i < size * size; i++) {
    const x = i % size
    const y = Math.floor(i / size)
    let v: number
    if (kind === 'paper') v = 0.86 + coarse[i] * 0.08 + medium[i] * 0.05 + fine[i] * 0.04 - (random() < 0.002 ? 0.12 : 0)
    else if (kind === 'linen') v = 0.88 + (Math.sin(x * 1.6) * 0.5 + 0.5) * 0.04 + (Math.sin(y * 1.6) * 0.5 + 0.5) * 0.04 + fine[i] * 0.05
    else v = 0.9 + (random() - 0.5) * 0.14 + medium[i] * 0.04
    const r = Math.round(255 * Math.min(1, v))
    const g = Math.round(255 * Math.min(1, v * 0.985))
    const b = Math.round(255 * Math.min(1, v * (kind === 'paper' ? 0.93 : 0.97)))
    image.data.set([r, g, b, 255], i * 4)
  }
  ctx.putImageData(image, 0, 0)
  if (kind === 'paper') {
    // a few fibres
    ctx.strokeStyle = 'rgba(120, 95, 60, 0.08)'
    for (let n = 0; n < 60; n++) {
      const x = random() * size
      const y = random() * size
      const angle = random() * Math.PI
      const length = 6 + random() * 18
      ctx.beginPath()
      ctx.moveTo(x, y)
      ctx.quadraticCurveTo(x + Math.cos(angle) * length * 0.5 + 3, y + Math.sin(angle) * length * 0.5, x + Math.cos(angle) * length, y + Math.sin(angle) * length)
      ctx.stroke()
    }
  }
  const url = canvas.toDataURL('image/png')
  cache.set(kind, url)
  return url
}
