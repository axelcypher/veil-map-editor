// Voronoi graph over jittered points, after Azgaar's Fantasy Map Generator (MIT).
// One point per quadtree leaf, so resolution can differ across the map. The point of a leaf depends only on the seed
// and its own coordinates: refining one area never moves a point somewhere else.
import { Delaunay } from 'd3-delaunay'
import { blockSizeAt, createBaseGrid, enumerateLeaves, nodeKey, type BaseGrid, type Splits } from './quadtree'
import { createRandom, hashSeed } from './rng'

export interface GridGraph {
  seed: string
  width: number
  height: number
  /** the base grid: cell counts and block size of level 0 */
  cellsX: number
  cellsY: number
  blockWidth: number
  blockHeight: number
  /** average distance between neighbouring points at level 0 */
  baseSpacing: number
  maxLevel: number
  cellCount: number
  x: Float64Array
  y: Float64Array
  /** quadtree level of every cell, 0 is the base resolution */
  level: Uint8Array
  /** block coordinates of every cell at its own level */
  ix: Int32Array
  iy: Int32Array
  /** cell ids of the adjacent cells */
  neighbors: number[][]
  /** vertex ids around each cell, in ring order */
  cellVertices: number[][]
  /** 1 if the cell touches the map edge */
  border: Uint8Array
  vertexX: Float64Array
  vertexY: Float64Array
  /** the (up to) three vertices next to each vertex, -1 where the diagram ends */
  vertexNeighbors: number[][]
  /** the three cells around each vertex; ids >= cellCount belong to the pseudo-points outside the map */
  vertexCells: number[][]
  /** cell of every unsplit base block, -1 where the block is split */
  baseLeaf: Int32Array
  /** cell of every leaf below level 0 by node key */
  leafByKey: Map<number, number>
  splits: Splits
}

const JITTER = 0.9
/** mirror points sit slightly outside so that four neighbouring points are never exactly on one circle */
const MIRROR_OFFSET = 1.02

const mix = (value: number) => {
  let h = Math.imul(value ^ value >>> 16, 0x85ebca6b)
  h = Math.imul(h ^ h >>> 13, 0xc2b2ae35)
  return (h ^ h >>> 16) >>> 0
}

/** two stable numbers in [0, 1) for a leaf */
function leafRandom(seedHash: number, level: number, ix: number, iy: number): [number, number] {
  let h = mix(seedHash ^ Math.imul(level + 1, 0x9e3779b1))
  h = mix(h ^ Math.imul(ix + 0x7f4a7c15, 0x85ebca77))
  h = mix(h ^ Math.imul(iy + 0x165667b1, 0xc2b2ae3d))
  return [h / 4294967296, mix(h ^ 0x27d4eb2f) / 4294967296]
}

interface VoronoiParts {
  neighbors: number[][]
  cellVertices: number[][]
  border: Uint8Array
  vertexX: Float64Array
  vertexY: Float64Array
  vertexNeighbors: number[][]
  vertexCells: number[][]
}

/** Voronoi cells for the first cellCount points; the rest only clip the diagram */
function buildVoronoi(coordinates: Float64Array, cellCount: number): VoronoiParts {
  const { triangles, halfedges } = new Delaunay(coordinates)
  const nextHalfedge = (edge: number) => edge % 3 === 2 ? edge - 2 : edge + 1
  const triangleCount = triangles.length / 3
  const neighbors: number[][] = new Array(cellCount)
  const cellVertices: number[][] = new Array(cellCount)
  const border = new Uint8Array(cellCount)
  const vertexX = new Float64Array(triangleCount)
  const vertexY = new Float64Array(triangleCount)
  const vertexNeighbors: number[][] = new Array(triangleCount)
  const vertexCells: number[][] = new Array(triangleCount)

  for (let edge = 0; edge < triangles.length; edge += 1) {
    const point = triangles[nextHalfedge(edge)]
    if (point < cellCount && !neighbors[point]) {
      const around: number[] = []
      let incoming = edge
      do {
        around.push(incoming)
        incoming = halfedges[nextHalfedge(incoming)]
      } while (incoming !== -1 && incoming !== edge && around.length < 24)

      cellVertices[point] = around.map(item => Math.floor(item / 3))
      neighbors[point] = around.map(item => triangles[item]).filter(cell => cell < cellCount)
      border[point] = around.length > neighbors[point].length ? 1 : 0
    }

    const triangle = Math.floor(edge / 3)
    if (!vertexCells[triangle]) {
      const a = triangles[triangle * 3]
      const b = triangles[triangle * 3 + 1]
      const c = triangles[triangle * 3 + 2]
      const [ax, ay, bx, by, cx, cy] = [
        coordinates[a * 2], coordinates[a * 2 + 1], coordinates[b * 2], coordinates[b * 2 + 1], coordinates[c * 2], coordinates[c * 2 + 1],
      ]
      const ad = ax * ax + ay * ay
      const bd = bx * bx + by * by
      const cd = cx * cx + cy * cy
      const divisor = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
      vertexX[triangle] = (ad * (by - cy) + bd * (cy - ay) + cd * (ay - by)) / divisor
      vertexY[triangle] = (ad * (cx - bx) + bd * (ax - cx) + cd * (bx - ax)) / divisor
      vertexCells[triangle] = [a, b, c]
      vertexNeighbors[triangle] = [0, 1, 2].map(side => Math.floor(halfedges[triangle * 3 + side] / 3))
    }
  }
  return { neighbors, cellVertices, border, vertexX, vertexY, vertexNeighbors, vertexCells }
}

/** the graph for a base resolution and a set of split blocks */
export function createGraph(seed: string, width: number, height: number, baseCells: number, splits: Splits): GridGraph {
  const base: BaseGrid = createBaseGrid(width, height, baseCells)
  const leaves = enumerateLeaves(base, splits)
  const cellCount = leaves.level.length
  const seedHash = hashSeed(seed)

  const x = new Float64Array(cellCount)
  const y = new Float64Array(cellCount)
  const mirrors: number[] = []
  let maxLevel = 0
  const baseLeaf = new Int32Array(base.cellsX * base.cellsY).fill(-1)
  const leafByKey = new Map<number, number>()

  for (let cell = 0; cell < cellCount; cell += 1) {
    const level = leaves.level[cell]
    const ix = leaves.ix[cell]
    const iy = leaves.iy[cell]
    const [blockWidth, blockHeight] = blockSizeAt(base, level)
    const [u, v] = leafRandom(seedHash, level, ix, iy)
    x[cell] = (ix + 0.5 + (u - 0.5) * JITTER) * blockWidth
    y[cell] = (iy + 0.5 + (v - 0.5) * JITTER) * blockHeight
    maxLevel = Math.max(maxLevel, level)
    if (level === 0) baseLeaf[iy * base.cellsX + ix] = cell
    else leafByKey.set(nodeKey(level, ix, iy), cell)

    // a leaf on the map edge gets its mirror image outside, which puts the cell border exactly on the edge
    const left = ix === 0
    const right = ix === base.cellsX * 2 ** level - 1
    const top = iy === 0
    const bottom = iy === base.cellsY * 2 ** level - 1
    const mirrorX = (value: number, atRight: boolean) => atRight ? width + (width - value) * MIRROR_OFFSET : -value * MIRROR_OFFSET
    const mirrorY = (value: number, atBottom: boolean) => atBottom ? height + (height - value) * MIRROR_OFFSET : -value * MIRROR_OFFSET
    if (left || right) mirrors.push(mirrorX(x[cell], right), y[cell])
    if (top || bottom) mirrors.push(x[cell], mirrorY(y[cell], bottom))
    if ((left || right) && (top || bottom)) mirrors.push(mirrorX(x[cell], right), mirrorY(y[cell], bottom))
  }

  const coordinates = new Float64Array(cellCount * 2 + mirrors.length)
  for (let cell = 0; cell < cellCount; cell += 1) {
    coordinates[cell * 2] = x[cell]
    coordinates[cell * 2 + 1] = y[cell]
  }
  coordinates.set(mirrors, cellCount * 2)

  return {
    seed, width, height, cellsX: base.cellsX, cellsY: base.cellsY, blockWidth: base.blockWidth, blockHeight: base.blockHeight,
    baseSpacing: base.spacing, maxLevel, cellCount, x, y, level: leaves.level, ix: leaves.ix, iy: leaves.iy,
    ...buildVoronoi(coordinates, cellCount), baseLeaf, leafByKey, splits,
  }
}

/** the uniform graph of project format 3, only kept to carry old heights over to the current graph */
export function createLegacyGraph(seed: string, width: number, height: number, cellsDesired: number): GridGraph {
  const random = createRandom(`${seed}:grid`)
  const base = createBaseGrid(width, height, cellsDesired)
  const cellCount = base.cellsX * base.cellsY

  const boundary: [number, number][] = []
  const spacing = Math.sqrt(width * height / cellsDesired)
  const offset = -spacing
  const boundarySpacing = spacing * 2
  const w = width - offset * 2
  const h = height - offset * 2
  const countX = Math.ceil(w / boundarySpacing) - 1
  const countY = Math.ceil(h / boundarySpacing) - 1
  for (let i = 0.5; i < countX; i += 1) {
    const px = Math.ceil(w * i / countX + offset)
    boundary.push([px, offset], [px, h + offset])
  }
  for (let i = 0.5; i < countY; i += 1) {
    const py = Math.ceil(h * i / countY + offset)
    boundary.push([offset, py], [w + offset, py])
  }

  const x = new Float64Array(cellCount)
  const y = new Float64Array(cellCount)
  const level = new Uint8Array(cellCount)
  const ix = new Int32Array(cellCount)
  const iy = new Int32Array(cellCount)
  const coordinates = new Float64Array((cellCount + boundary.length) * 2)
  for (let row = 0; row < base.cellsY; row += 1) {
    for (let column = 0; column < base.cellsX; column += 1) {
      const cell = row * base.cellsX + column
      x[cell] = (column + 0.5 + (random() - 0.5) * JITTER) * base.blockWidth
      y[cell] = (row + 0.5 + (random() - 0.5) * JITTER) * base.blockHeight
      ix[cell] = column
      iy[cell] = row
      coordinates[cell * 2] = x[cell]
      coordinates[cell * 2 + 1] = y[cell]
    }
  }
  boundary.forEach(([bx, by], index) => {
    coordinates[(cellCount + index) * 2] = bx
    coordinates[(cellCount + index) * 2 + 1] = by
  })

  return {
    seed, width, height, cellsX: base.cellsX, cellsY: base.cellsY, blockWidth: base.blockWidth, blockHeight: base.blockHeight,
    baseSpacing: base.spacing, maxLevel: 0, cellCount, x, y, level, ix, iy,
    ...buildVoronoi(coordinates, cellCount), baseLeaf: Int32Array.from({ length: cellCount }, (_, cell) => cell), leafByKey: new Map(), splits: new Set(),
  }
}

/** the leaf that contains the position */
function leafAt(graph: GridGraph, x: number, y: number): number {
  const column = Math.min(graph.cellsX - 1, Math.max(0, Math.floor(x / graph.blockWidth)))
  const row = Math.min(graph.cellsY - 1, Math.max(0, Math.floor(y / graph.blockHeight)))
  const base = graph.baseLeaf[row * graph.cellsX + column]
  if (base >= 0) return base
  for (let level = 1; level <= graph.maxLevel; level += 1) {
    const width = graph.blockWidth / 2 ** level
    const height = graph.blockHeight / 2 ** level
    const ix = Math.min(graph.cellsX * 2 ** level - 1, Math.max(0, Math.floor(x / width)))
    const iy = Math.min(graph.cellsY * 2 ** level - 1, Math.max(0, Math.floor(y / height)))
    const found = graph.leafByKey.get(nodeKey(level, ix, iy))
    if (found !== undefined) return found
  }
  return 0
}

/** the cell whose point is closest to the position: the leaf gives a start, neighbours refine it */
export function findCell(graph: GridGraph, x: number, y: number): number {
  let best = leafAt(graph, x, y)
  let bestDistance = (graph.x[best] - x) ** 2 + (graph.y[best] - y) ** 2
  for (let improved = true; improved;) {
    improved = false
    for (const neighbor of graph.neighbors[best]) {
      const distance = (graph.x[neighbor] - x) ** 2 + (graph.y[neighbor] - y) ** 2
      if (distance < bestDistance) {
        best = neighbor
        bestDistance = distance
        improved = true
      }
    }
  }
  return best
}

/** cell index from a position by grid arithmetic alone, for the uniform base graph */
export function gridCell(graph: GridGraph, x: number, y: number): number {
  const column = Math.min(graph.cellsX - 1, Math.max(0, Math.floor(x / graph.width * graph.cellsX)))
  const row = Math.min(graph.cellsY - 1, Math.max(0, Math.floor(y / graph.height * graph.cellsY)))
  return row * graph.cellsX + column
}

/** size of a cell in map units, the average distance to its neighbours before jittering */
export const cellSize = (graph: GridGraph, cell: number) => graph.baseSpacing / 2 ** graph.level[cell]
