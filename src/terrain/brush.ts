// Brush selection and height edits on the cell graph. Radii are kilometres on the real planet or region.
import type { MapSettings, PlanetSettings } from '../model'
import { getLinePower } from './heightmap-generator'
import { metersPerFmgUnit, type HeightScale } from './height-scale'
import { findCell, type GridGraph } from './graph'
import { clamp, type Random } from './rng'

export type BrushTool = 'raise' | 'lower' | 'smooth' | 'set' | 'disrupt' | 'range' | 'trough'
export type CellFilter = 'all' | 'land' | 'water'

export interface Metric {
  /** distance from a cell to a position in map units */
  distanceKm(cell: number, x: number, y: number): number
  /** distance between two cells */
  cellDistanceKm(a: number, b: number): number
  /** average kilometres per map unit */
  unitKm: number
  /** kilometres per map unit at the position, horizontally and vertically */
  kmPerUnit(y: number): [number, number]
}

/** region maps are flat, global maps use the great-circle distance */
export function createMetric(graph: GridGraph, map: MapSettings, planet: PlanetSettings): Metric {
  if (map.mode === 'region') {
    const kx = map.widthKm / graph.width
    const ky = map.heightKm / graph.height
    return {
      distanceKm: (cell, x, y) => Math.hypot((graph.x[cell] - x) * kx, (graph.y[cell] - y) * ky),
      cellDistanceKm: (a, b) => Math.hypot((graph.x[a] - graph.x[b]) * kx, (graph.y[a] - graph.y[b]) * ky),
      unitKm: Math.sqrt(kx * ky),
      kmPerUnit: () => [kx, ky],
    }
  }

  const radius = planet.equatorialDiameterKm / 2
  const toLongitude = (x: number) => (x / graph.width * 360 - 180) * Math.PI / 180
  const toLatitude = (y: number) => (90 - y / graph.height * 180) * Math.PI / 180
  const longitudes = Float64Array.from(graph.x, toLongitude)
  const latitudes = Float64Array.from(graph.y, toLatitude)
  const greatCircle = (latitudeA: number, longitudeA: number, latitudeB: number, longitudeB: number) => {
    const haversine = Math.sin((latitudeB - latitudeA) / 2) ** 2
      + Math.cos(latitudeA) * Math.cos(latitudeB) * Math.sin((longitudeB - longitudeA) / 2) ** 2
    return 2 * radius * Math.asin(Math.min(1, Math.sqrt(haversine)))
  }
  const widthKm = Math.PI * planet.equatorialDiameterKm
  const heightKm = Math.PI * planet.polarDiameterKm / 2
  return {
    distanceKm: (cell, x, y) => greatCircle(latitudes[cell], longitudes[cell], toLatitude(y), toLongitude(x)),
    cellDistanceKm: (a, b) => greatCircle(latitudes[a], longitudes[a], latitudes[b], longitudes[b]),
    unitKm: Math.sqrt(widthKm * heightKm / (graph.width * graph.height)),
    kmPerUnit: y => [widthKm / graph.width * Math.max(0.01, Math.cos(toLatitude(y))), heightKm / graph.height],
  }
}

/** collects the cells within a radius without allocating per stamp */
export class CellSelector {
  private readonly graph: GridGraph
  private readonly marks: Uint32Array
  private generation = 0
  cells: number[] = []
  distances: number[] = []

  constructor(graph: GridGraph) {
    this.graph = graph
    this.marks = new Uint32Array(graph.cellCount)
  }

  select(x: number, y: number, radiusKm: number, metric: Metric) {
    const { graph, marks } = this
    this.generation += 1
    this.cells = []
    this.distances = []
    const start = findCell(graph, x, y)
    const baseSpacingKm = graph.baseSpacing * metric.unitKm
    const queue = [start]
    marks[start] = this.generation

    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const cell = queue[cursor]
      const distance = metric.distanceKm(cell, x, y)
      if (distance <= radiusKm || cell === start) {
        this.cells.push(cell)
        this.distances.push(distance)
      }
      // a cell can only reach into the brush by about its own size
      if (distance > radiusKm + baseSpacingKm * 2.4 / 2 ** graph.level[cell]) continue
      for (const neighbor of graph.neighbors[cell]) {
        if (marks[neighbor] === this.generation) continue
        marks[neighbor] = this.generation
        queue.push(neighbor)
      }
    }
  }
}

export interface BrushSettings {
  tool: BrushTool
  radiusKm: number
  strengthM: number
  targetM: number
  filter: CellFilter
}

/** one stamp of a brush on the cells the selector holds */
export function applyBrushStamp(elevations: Float32Array, graph: GridGraph, selector: CellSelector, settings: BrushSettings, scale: HeightScale, random: Random) {
  const { cells, distances } = selector
  const { tool, radiusKm, strengthM, targetM, filter } = settings
  const eligible = (cell: number) => filter === 'all' || (elevations[cell] >= scale.seaM) === (filter === 'land')
  const lowest = filter === 'land' ? scale.seaM : scale.minM
  const highest = filter === 'water' ? scale.seaM - 1 : scale.maxM
  const limit = (value: number) => clamp(value, lowest, highest)

  if (tool === 'smooth') {
    const strength = Math.min(0.9, strengthM / 2500)
    const replacements = cells.map(cell => {
      let sum = elevations[cell]
      let count = 1
      for (const neighbor of graph.neighbors[cell]) {
        if (filter !== 'all' && !eligible(neighbor)) continue
        sum += elevations[neighbor]
        count += 1
      }
      return elevations[cell] + (sum / count - elevations[cell]) * strength
    })
    cells.forEach((cell, index) => {
      if (eligible(cell)) elevations[cell] = limit(replacements[index])
    })
    return
  }

  const start = cells[0]
  cells.forEach((cell, index) => {
    if (!eligible(cell)) return
    const falloff = cell === start ? 1 : Math.max(0.08, (1 - distances[index] / radiusKm) ** 2)
    const current = elevations[cell]
    if (tool === 'raise') elevations[cell] = limit(current + strengthM * falloff)
    else if (tool === 'lower') elevations[cell] = limit(current - strengthM * falloff)
    else if (tool === 'set') elevations[cell] = limit(current + (targetM - current) * Math.max(0.15, falloff))
    else if (tool === 'disrupt') elevations[cell] = limit(current + (random() - 0.5) * strengthM * falloff)
  })
}

/** the cells a mountain range or trough follows: from the start towards the end, sometimes taking a shortcut for a wobble */
export function ridgePath(graph: GridGraph, random: Random, start: number, end: number, randomness: number): number[] {
  const used = new Uint8Array(graph.cellCount)
  const path = [start]
  used[start] = 1
  for (let current = start; current !== end;) {
    let min = Infinity
    let next = current
    for (const neighbor of graph.neighbors[current]) {
      if (used[neighbor]) continue
      let distance = (graph.x[end] - graph.x[neighbor]) ** 2 + (graph.y[end] - graph.y[neighbor]) ** 2
      if (random() > 1 - randomness) distance /= 2
      if (distance < min) {
        min = distance
        next = neighbor
      }
    }
    if (min === Infinity) break
    current = next
    path.push(current)
    used[current] = 1
  }
  return path
}

/** height of a ridge by rings away from its line, fading to nothing */
function ridgeProfile(power: number, linePower: number): number[] {
  const profile = [power]
  for (let height = power; profile.length < 60;) {
    height = height ** linePower - 1
    if (height < 2) break
    profile.push(height)
  }
  profile.push(0)
  return profile
}

/** a mountain range or trough along the path, as wide as the brush radius; only cells the filter allows change */
export function applyLine(elevations: Float32Array, graph: GridGraph, metric: Metric, settings: BrushSettings, scale: HeightScale, random: Random, path: number[]) {
  const unit = metersPerFmgUnit(scale)
  const profile = ridgeProfile(clamp(settings.strengthM / unit, 1, 100), getLinePower(graph.cellsX * graph.cellsY))
  const sign = settings.tool === 'range' ? 1 : -1
  const lowest = settings.filter === 'land' ? scale.seaM : scale.minM
  const highest = settings.filter === 'water' ? scale.seaM - 1 : scale.maxM
  const reach = settings.radiusKm

  // shortest distance from the path to every cell within reach
  const distance = new Float32Array(graph.cellCount).fill(Infinity)
  const heap: [number, number][] = []
  const push = (item: [number, number]) => {
    heap.push(item)
    for (let child = heap.length - 1; child > 0;) {
      const parent = (child - 1) >> 1
      if (heap[parent][0] <= heap[child][0]) break
      ;[heap[parent], heap[child]] = [heap[child], heap[parent]]
      child = parent
    }
  }
  const pop = (): [number, number] => {
    const top = heap[0]
    const last = heap.pop()!
    if (heap.length) {
      heap[0] = last
      for (let parent = 0;;) {
        const left = parent * 2 + 1
        const right = left + 1
        let smallest = parent
        if (left < heap.length && heap[left][0] < heap[smallest][0]) smallest = left
        if (right < heap.length && heap[right][0] < heap[smallest][0]) smallest = right
        if (smallest === parent) break
        ;[heap[parent], heap[smallest]] = [heap[smallest], heap[parent]]
        parent = smallest
      }
    }
    return top
  }
  for (const cell of path) {
    distance[cell] = 0
    push([0, cell])
  }
  while (heap.length) {
    const [known, cell] = pop()
    if (known > distance[cell] || known >= reach) continue
    for (const neighbor of graph.neighbors[cell]) {
      const next = known + metric.cellDistanceKm(cell, neighbor)
      if (next < distance[neighbor]) {
        distance[neighbor] = next
        push([next, neighbor])
      }
    }
  }

  for (let cell = 0; cell < graph.cellCount; cell += 1) {
    if (distance[cell] >= reach) continue
    if (settings.filter !== 'all' && (elevations[cell] >= scale.seaM) !== (settings.filter === 'land')) continue
    const position = distance[cell] / reach * (profile.length - 1)
    const ring = Math.floor(position)
    const height = profile[ring] + (profile[ring + 1] - profile[ring]) * (position - ring)
    elevations[cell] = clamp(elevations[cell] + sign * height * (random() * 0.3 + 0.85) * unit, lowest, highest)
  }
}
