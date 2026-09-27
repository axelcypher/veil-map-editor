import type { GridGraph } from './graph'
import type { Metric } from './brush'
import { clamp, hashSeed } from './rng'

export interface LandscapeSettings {
  seed: string
  /** height above the sea of the highest ground where nothing was drawn */
  reliefM: number
  /** size of the largest features in km */
  featureKm: number
  /** 0 to 1: rolling hills up to sharp ridges */
  ruggedness: number
  /** distance from the coast until the ground has risen to its full height, in km */
  coastRampKm: number
  /** ground that stands at least this high above the sea is kept as it is */
  keepFromM: number
  /** 0 to 1: how much of the old heights goes into the ground that is not kept */
  keepMix: number
  /** 0 to 1: how much of the pits in the new ground is filled up, which leaves fewer lakes */
  drain: number
  minM: number
  maxM: number
}

export interface LandscapeResult {
  elevations: Float32Array
  kept: number
  generated: number
}

// value noise on a lattice, turned a little per octave so that the grid does not show
function lattice(seed: number, ix: number, iy: number) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 2147483647)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

function valueNoise(seed: number, x: number, y: number) {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = x - ix
  const fy = y - iy
  const sx = fx * fx * (3 - 2 * fx)
  const sy = fy * fy * (3 - 2 * fy)
  const top = lattice(seed, ix, iy) * (1 - sx) + lattice(seed, ix + 1, iy) * sx
  const bottom = lattice(seed, ix, iy + 1) * (1 - sx) + lattice(seed, ix + 1, iy + 1) * sx
  return top * (1 - sy) + bottom * sy
}

const COS = Math.cos(0.55)
const SIN = Math.sin(0.55)

/** fractal noise between 0 and 1 */
function fbm(seed: number, x: number, y: number, octaves: number) {
  let sum = 0
  let weight = 0
  let amplitude = 1
  for (let octave = 0; octave < octaves; octave += 1) {
    sum += valueNoise(seed + octave * 101, x, y) * amplitude
    weight += amplitude
    amplitude *= 0.5
    ;[x, y] = [(x * COS - y * SIN) * 2.03 + 17.3, (x * SIN + y * COS) * 2.03 - 5.1]
  }
  return sum / weight
}

/** binary min-heap of cells by a key, grown as needed */
class Heap {
  private keys = new Float64Array(1 << 16)
  private values = new Int32Array(1 << 16)
  size = 0
  key = 0
  value = 0
  push(key: number, value: number) {
    if (this.size === this.keys.length) {
      const grownKeys = new Float64Array(this.size * 2)
      const grownValues = new Int32Array(this.size * 2)
      grownKeys.set(this.keys)
      grownValues.set(this.values)
      this.keys = grownKeys
      this.values = grownValues
    }
    const { keys, values } = this
    let index = this.size++
    while (index > 0) {
      const parent = (index - 1) >> 1
      if (keys[parent] <= key) break
      keys[index] = keys[parent]
      values[index] = values[parent]
      index = parent
    }
    keys[index] = key
    values[index] = value
  }
  /** takes the smallest into key and value */
  pop() {
    const { keys, values } = this
    this.key = keys[0]
    this.value = values[0]
    this.size -= 1
    const size = this.size
    if (size > 0) {
      const lastKey = keys[size]
      const lastValue = values[size]
      let index = 0
      for (;;) {
        let child = index * 2 + 1
        if (child >= size) break
        if (child + 1 < size && keys[child + 1] < keys[child]) child += 1
        if (keys[child] >= lastKey) break
        keys[index] = keys[child]
        values[index] = values[child]
        index = child
      }
      keys[index] = lastKey
      values[index] = lastValue
    }
  }
}

/** the distance in km over the cells that may be crossed, from the nearest of the start cells, and which one that was */
function distanceField(graph: GridGraph, metric: Metric, starts: ArrayLike<number>, initial: (cell: number) => number, passable: Uint8Array) {
  const dist = new Float32Array(graph.cellCount).fill(Infinity)
  const owner = new Int32Array(graph.cellCount).fill(-1)
  const heap = new Heap()
  for (let index = 0; index < starts.length; index += 1) {
    const cell = starts[index]
    dist[cell] = initial(cell)
    owner[cell] = cell
    heap.push(dist[cell], cell)
  }
  while (heap.size > 0) {
    heap.pop()
    const { key, value: cell } = heap
    if (key > dist[cell]) continue
    for (const neighbor of graph.neighbors[cell]) {
      if (!passable[neighbor]) continue
      const next = key + metric.cellDistanceKm(cell, neighbor)
      if (next < dist[neighbor]) {
        dist[neighbor] = next
        owner[neighbor] = owner[cell]
        heap.push(next, neighbor)
      }
    }
  }
  return { dist, owner }
}

/** raises the ground in pits towards the level where the water would spill, by the given share */
function drainPits(graph: GridGraph, field: Float32Array, land: Uint8Array, movable: Uint8Array, share: number) {
  const { cellCount, neighbors, border } = graph
  const level = new Float64Array(cellCount)
  const seen = new Uint8Array(cellCount)
  const heap = new Heap()
  for (let cell = 0; cell < cellCount; cell += 1) {
    if (!land[cell]) continue
    if (border[cell] || neighbors[cell].some(neighbor => !land[neighbor])) {
      seen[cell] = 1
      level[cell] = field[cell]
      heap.push(level[cell], cell)
    }
  }
  while (heap.size > 0) {
    heap.pop()
    const { key, value: cell } = heap
    for (const neighbor of neighbors[cell]) {
      if (seen[neighbor] || !land[neighbor]) continue
      seen[neighbor] = 1
      level[neighbor] = Math.max(field[neighbor], key + 1e-4)
      heap.push(level[neighbor], neighbor)
    }
  }
  for (let cell = 0; cell < cellCount; cell += 1) {
    if (land[cell] && movable[cell]) field[cell] += (level[cell] - field[cell]) * share
  }
}

const smoothstep = (value: number) => {
  const t = clamp(value, 0, 1)
  return t * t * (3 - 2 * t)
}

/**
 * Natural ground inside the land that is already there. Water stays water and land stays land, so the coast does not
 * move; the ground rises from the coast with noise on top, and heights that were set by hand at or above a threshold
 * stay, with foothills growing around them.
 */
export function generateLandscape(graph: GridGraph, metric: Metric, elevations: Float32Array, seaM: number, settings: LandscapeSettings): LandscapeResult {
  const { cellCount, neighbors } = graph
  const land = new Uint8Array(cellCount)
  for (let cell = 0; cell < cellCount; cell += 1) land[cell] = elevations[cell] > seaM ? 1 : 0
  const result = elevations.slice()

  // the shore: land cells with water beside them
  const shore: number[] = []
  const anchors: number[] = []
  for (let cell = 0; cell < cellCount; cell += 1) {
    if (!land[cell]) continue
    if (neighbors[cell].some(neighbor => !land[neighbor])) shore.push(cell)
    if (elevations[cell] - seaM >= settings.keepFromM) anchors.push(cell)
  }
  if (!shore.length && !anchors.length) return { elevations: result, kept: 0, generated: 0 }

  const shoreField = distanceField(graph, metric, shore, cell => {
    const water = neighbors[cell].find(neighbor => !land[neighbor])
    return water === undefined ? 0 : metric.cellDistanceKm(cell, water) / 2
  }, land)
  const anchorField = anchors.length ? distanceField(graph, metric, anchors, () => 0, land) : null
  const isAnchor = new Uint8Array(cellCount)
  for (const cell of anchors) isAnchor[cell] = 1

  const seed = hashSeed(settings.seed)
  const unit = metric.unitKm
  const size = Math.max(1, settings.featureKm)
  const ramp = Math.max(1, settings.coastRampKm)
  const ridged = clamp(settings.ruggedness, 0, 1)
  const generated = new Float32Array(cellCount)

  for (let cell = 0; cell < cellCount; cell += 1) {
    if (!land[cell] || isAnchor[cell]) continue
    const px = graph.x[cell] * unit / size
    const py = graph.y[cell] * unit / size
    // fractal noise stays close to its middle, so it is stretched to use the whole range
    const hills = clamp((fbm(seed, px, py, 5) - 0.5) * 2.8 + 0.5, 0, 1)
    const ridge = (1 - Math.abs(2 * fbm(seed + 7, px * 1.3, py * 1.3, 5) - 1)) ** 4
    const detail = fbm(seed + 13, px * 6, py * 6, 3)
    const shape = hills * (1 - ridged) + (ridge * (0.3 + 0.7 * hills) * 1.15 + hills * 0.15) * ridged
    // the contours of the rise do not follow the coast exactly
    const inland = smoothstep(shoreField.dist[cell] * (0.55 + 0.9 * fbm(seed + 29, px * 0.7, py * 0.7, 3)) / ramp)
    let height = 3 + settings.reliefM * inland * (0.1 + 0.9 * shape ** 0.9) + settings.reliefM * 0.02 * inland * (detail - 0.5) * 2

    if (anchorField && anchorField.owner[cell] >= 0) {
      // foothills around the kept ground, wider around the higher one
      const above = Math.max(0, elevations[anchorField.owner[cell]] - seaM)
      const reach = size * (0.25 + 0.75 * Math.min(1, above / Math.max(1, settings.reliefM)))
      const foot = above * Math.exp(-((anchorField.dist[cell] / reach) ** 1.4)) * (0.8 + 0.4 * detail)
      height = Math.max(height, foot)
    }
    if (settings.keepMix > 0) height = height * (1 - settings.keepMix) + Math.max(1, elevations[cell] - seaM) * settings.keepMix
    generated[cell] = height
  }

  if (settings.drain > 0) {
    const field = new Float32Array(cellCount)
    const movable = new Uint8Array(cellCount)
    for (let cell = 0; cell < cellCount; cell += 1) {
      if (!land[cell]) continue
      field[cell] = isAnchor[cell] ? elevations[cell] - seaM : generated[cell]
      movable[cell] = isAnchor[cell] ? 0 : 1
    }
    drainPits(graph, field, land, movable, clamp(settings.drain, 0, 1))
    for (let cell = 0; cell < cellCount; cell += 1) if (movable[cell]) generated[cell] = field[cell]
  }

  // one round of smoothing across the land only, so that kept ground and new ground meet without a step
  for (let cell = 0; cell < cellCount; cell += 1) {
    if (!land[cell] || isAnchor[cell]) continue
    let sum = generated[cell] * 2
    let count = 2
    for (const neighbor of neighbors[cell]) {
      if (!land[neighbor]) continue
      sum += isAnchor[neighbor] ? elevations[neighbor] - seaM : generated[neighbor]
      count += 1
    }
    result[cell] = clamp(seaM + Math.max(1, sum / count), settings.minM, settings.maxM)
  }
  return { elevations: result, kept: anchors.length, generated: land.reduce((sum, value) => sum + value, 0) - anchors.length }
}
