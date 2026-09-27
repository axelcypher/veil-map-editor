// Water on land: depressions fill up to lakes, rain runs downhill into rivers. Derived from the heights, never stored,
// so the painted terrain is not touched. The flood fill follows Barnes' priority-flood, the river rules follow the
// idea of Azgaar's Fantasy Map Generator (MIT): flux collects downstream and rivers start where it is large enough.
import type { GridGraph } from './graph'

export interface HydrologySettings {
  /** fill closed basins to lakes */
  lakes: boolean
  /** a basin needs at least this depth in metres to become a lake */
  minLakeDepthM: number
  /** upstream rain a river needs to form, in base blocks: smaller makes more rivers */
  riverThreshold: number
}

export const DEFAULT_HYDROLOGY: Readonly<HydrologySettings> = { lakes: true, minLakeDepthM: 60, riverThreshold: 14 }

export interface RiverPath {
  /** x, y and flux per point */
  points: [number, number][]
  flux: number[]
}

export interface Hydrology {
  /** 1 where the cell is dry land: not below the sea and not inside a lake */
  land: Uint8Array
  /** metres of water standing on the cell, 0 outside lakes */
  lakeDepth: Float32Array
  rivers: RiverPath[]
  minFlux: number
}

/** binary min-heap on a level, holding cells */
class CellHeap {
  private levels: number[] = []
  private cells: number[] = []
  get size() { return this.cells.length }
  push(level: number, cell: number) {
    let index = this.cells.length
    this.levels.push(level)
    this.cells.push(cell)
    while (index > 0) {
      const parent = (index - 1) >> 1
      if (this.levels[parent] <= level) break
      this.levels[index] = this.levels[parent]
      this.cells[index] = this.cells[parent]
      index = parent
    }
    this.levels[index] = level
    this.cells[index] = cell
  }
  pop(): [number, number] {
    const topLevel = this.levels[0]
    const topCell = this.cells[0]
    const level = this.levels.pop()!
    const cell = this.cells.pop()!
    const length = this.cells.length
    if (length) {
      let index = 0
      for (;;) {
        let child = index * 2 + 1
        if (child >= length) break
        if (child + 1 < length && this.levels[child + 1] < this.levels[child]) child += 1
        if (this.levels[child] >= level) break
        this.levels[index] = this.levels[child]
        this.cells[index] = this.cells[child]
        index = child
      }
      this.levels[index] = level
      this.cells[index] = cell
    }
    return [topLevel, topCell]
  }
}

const FLAT_STEP = 1e-6

/** smooth a polyline by corner cutting, the widths follow */
function smooth(points: [number, number][], flux: number[], rounds: number): RiverPath {
  let pts = points
  let flx = flux
  for (let round = 0; round < rounds && pts.length > 2; round += 1) {
    const nextPoints: [number, number][] = [pts[0]]
    const nextFlux: number[] = [flx[0]]
    for (let index = 0; index < pts.length - 1; index += 1) {
      const [a, b] = [pts[index], pts[index + 1]]
      nextPoints.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75])
      nextFlux.push(flx[index] * 0.75 + flx[index + 1] * 0.25, flx[index] * 0.25 + flx[index + 1] * 0.75)
    }
    nextPoints.push(pts[pts.length - 1])
    nextFlux.push(flx[flx.length - 1])
    pts = nextPoints
    flx = nextFlux
  }
  return { points: pts, flux: flx }
}

export function computeHydrology(graph: GridGraph, elevations: ArrayLike<number>, seaM: number, precipitation: Uint8Array, settings: HydrologySettings, withRivers: boolean): Hydrology {
  const { cellCount, neighbors, border } = graph
  const level = new Float64Array(cellCount)
  const parent = new Int32Array(cellCount).fill(-1)
  const seen = new Uint8Array(cellCount)
  const order: number[] = []
  const heap = new CellHeap()

  // water is where everything drains to; land next to it, and along the map edge, starts the flood
  for (let cell = 0; cell < cellCount; cell += 1) {
    if (elevations[cell] < seaM) seen[cell] = 1
  }
  for (let cell = 0; cell < cellCount; cell += 1) {
    if (seen[cell]) continue
    const wet = neighbors[cell].find(neighbor => seen[neighbor] && elevations[neighbor] < seaM)
    if (wet !== undefined || border[cell]) {
      seen[cell] = 2
      level[cell] = elevations[cell]
      parent[cell] = wet ?? -1
      heap.push(level[cell], cell)
    }
  }
  while (heap.size) {
    const [current, cell] = heap.pop()
    order.push(cell)
    for (const neighbor of neighbors[cell]) {
      if (seen[neighbor]) continue
      seen[neighbor] = 2
      level[neighbor] = Math.max(elevations[neighbor], current + FLAT_STEP)
      parent[neighbor] = cell
      heap.push(level[neighbor], neighbor)
    }
  }

  const lakeDepth = new Float32Array(cellCount)
  if (settings.lakes) {
    for (let cell = 0; cell < cellCount; cell += 1) {
      const depth = level[cell] - elevations[cell]
      if (seen[cell] === 2 && depth >= settings.minLakeDepthM) lakeDepth[cell] = depth
    }
    // a lake of one or two cells is a pothole, not a lake
    const group = new Int32Array(cellCount).fill(-1)
    for (let start = 0; start < cellCount; start += 1) {
      if (!lakeDepth[start] || group[start] >= 0) continue
      const members = [start]
      group[start] = start
      for (let cursor = 0; cursor < members.length; cursor += 1) {
        for (const neighbor of neighbors[members[cursor]]) {
          if (lakeDepth[neighbor] && group[neighbor] < 0) {
            group[neighbor] = start
            members.push(neighbor)
          }
        }
      }
      if (members.length < 4) for (const member of members) lakeDepth[member] = 0
    }
  }

  const land = new Uint8Array(cellCount)
  for (let cell = 0; cell < cellCount; cell += 1) land[cell] = elevations[cell] >= seaM && !lakeDepth[cell] ? 1 : 0

  const rivers: RiverPath[] = []
  let minFlux = Infinity
  if (withRivers) {
    // rain per cell weighs by its area, then runs to the sea through the parents: the reverse of the flood order
    const areaOf = (cell: number) => 0.25 ** graph.level[cell]
    const flux = new Float64Array(cellCount)
    let rain = 0
    let rainCells = 0
    for (let cell = 0; cell < cellCount; cell += 1) {
      if (elevations[cell] < seaM) continue
      flux[cell] = precipitation[cell] * areaOf(cell)
      rain += flux[cell]
      rainCells += areaOf(cell)
    }
    for (let index = order.length - 1; index >= 0; index -= 1) {
      const cell = order[index]
      if (parent[cell] >= 0 && elevations[parent[cell]] >= seaM) flux[parent[cell]] += flux[cell]
    }
    minFlux = (rain / Math.max(1e-9, rainCells)) * settings.riverThreshold
    const isRiver = (cell: number) => seen[cell] === 2 && flux[cell] >= minFlux

    const children = new Uint8Array(cellCount)
    for (const cell of order) if (isRiver(cell) && parent[cell] >= 0 && isRiver(parent[cell])) children[parent[cell]] += 1
    const walked = new Uint8Array(cellCount)
    const heads = order.filter(cell => isRiver(cell) && !children[cell]).sort((a, b) => flux[b] - flux[a])
    for (const head of heads) {
      const points: [number, number][] = []
      const fluxes: number[] = []
      for (let cell = head; ;) {
        points.push([graph.x[cell], graph.y[cell]])
        fluxes.push(flux[cell])
        if (walked[cell]) break
        walked[cell] = 1
        const next = parent[cell]
        if (next < 0 || !isRiver(next)) {
          // the mouth: continue to the water cell so the river reaches the shore
          if (next >= 0) {
            points.push([(graph.x[cell] + graph.x[next]) / 2, (graph.y[cell] + graph.y[next]) / 2])
            fluxes.push(flux[cell])
          }
          break
        }
        cell = next
      }
      if (points.length >= 2) rivers.push(smooth(points, fluxes, 2))
    }
  }
  return { land, lakeDepth, rivers, minFlux }
}
