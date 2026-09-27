// Carry heights over when the cell graph changes.
import { Delaunay } from 'd3-delaunay'
import { findCell, type GridGraph } from './graph'
import { nodeKey } from './quadtree'

/** every new cell takes the height of the old cell at the same spot */
export function resampleHeights(from: GridGraph, elevations: Float32Array, to: GridGraph): Float32Array {
  const resampled = new Float32Array(to.cellCount)
  for (let cell = 0; cell < to.cellCount; cell += 1) {
    resampled[cell] = elevations[findCell(from, to.x[cell] / to.width * from.width, to.y[cell] / to.height * from.height)]
  }
  return resampled
}

/** height at a position, blended from the nearest cell and its neighbours so that a finer mesh does not show the coarse steps */
export function interpolateHeight(graph: GridGraph, elevations: ArrayLike<number>, x: number, y: number): number {
  const nearest = findCell(graph, x, y)
  const size = graph.baseSpacing / 2 ** graph.level[nearest]
  const softening = size * size * 1e-3
  let sum = 0
  let weights = 0
  const add = (cell: number) => {
    const weight = 1 / ((graph.x[cell] - x) ** 2 + (graph.y[cell] - y) ** 2 + softening)
    sum += elevations[cell] * weight
    weights += weight
  }
  add(nearest)
  for (const neighbor of graph.neighbors[nearest]) add(neighbor)
  return sum / weights
}

/**
 * Heights for a graph that was refined from another one: leaves that exist in both keep their height exactly,
 * new leaves are interpolated from the old graph.
 */
export function remapHeights(from: GridGraph, elevations: Float32Array, to: GridGraph): Float32Array {
  const remapped = new Float32Array(to.cellCount)
  for (let cell = 0; cell < to.cellCount; cell += 1) {
    const level = to.level[cell]
    const previous = level === 0
      ? from.baseLeaf[to.iy[cell] * from.cellsX + to.ix[cell]]
      : from.leafByKey.get(nodeKey(level, to.ix[cell], to.iy[cell]))
    remapped[cell] = previous !== undefined && previous >= 0
      ? elevations[previous]
      : interpolateHeight(from, elevations, to.x[cell], to.y[cell])
  }
  return remapped
}

/** heights of the uniform base graph, spread over a graph that may be finer in places */
export function spreadBaseHeights(base: GridGraph, baseElevations: Float32Array, to: GridGraph): Float32Array {
  return Float32Array.from({ length: to.cellCount }, (_, cell) => to.level[cell] === 0
    ? baseElevations[to.iy[cell] * to.cellsX + to.ix[cell]]
    : interpolateHeight(base, baseElevations, to.x[cell], to.y[cell]))
}

/** format 2 projects stored their own jittered points, in 0-1 map coordinates */
export function resampleLegacyHeights(points: [number, number][], elevations: number[], to: GridGraph): Float32Array {
  const delaunay = Delaunay.from(points)
  const resampled = new Float32Array(to.cellCount)
  let nearest = 0
  for (let cell = 0; cell < to.cellCount; cell += 1) {
    nearest = delaunay.find(to.x[cell] / to.width, to.y[cell] / to.height, nearest)
    resampled[cell] = elevations[nearest]
  }
  return resampled
}

/** ids per cell for another mesh: leaves that exist in both keep theirs, new ones take the id of the old cell at their spot */
export function remapValues<T extends Uint8Array | Uint16Array>(from: GridGraph, values: T, to: GridGraph): T {
  const remapped = new (values.constructor as new (length: number) => T)(to.cellCount)
  for (let cell = 0; cell < to.cellCount; cell += 1) {
    const level = to.level[cell]
    const previous = level === 0
      ? from.baseLeaf[to.iy[cell] * from.cellsX + to.ix[cell]]
      : from.leafByKey.get(nodeKey(level, to.ix[cell], to.iy[cell]))
    remapped[cell] = values[previous !== undefined && previous >= 0 ? previous : findCell(from, to.x[cell], to.y[cell])]
  }
  return remapped
}

/** ids per cell after the graph was rebuilt from other parameters: the old cell at the same relative spot */
export function resampleValues<T extends Uint8Array | Uint16Array>(from: GridGraph, values: T, to: GridGraph): T {
  const resampled = new (values.constructor as new (length: number) => T)(to.cellCount)
  for (let cell = 0; cell < to.cellCount; cell += 1) {
    resampled[cell] = values[findCell(from, to.x[cell] / to.width * from.width, to.y[cell] / to.height * from.height)]
  }
  return resampled
}
