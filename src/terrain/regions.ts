// Areas made of cells: their borders and their labels. Used by the territories and the zones.
import type { GridGraph } from './graph'

export type Point = [number, number]

export interface Border {
  points: Point[]
  closed: boolean
}

/** a value per cell as runs of value and length: what a project file stores */
export function encodeRuns(values: ArrayLike<number>): number[] {
  const runs: number[] = []
  for (let index = 0; index < values.length;) {
    let end = index + 1
    while (end < values.length && values[end] === values[index]) end += 1
    runs.push(values[index], end - index)
    index = end
  }
  return runs
}

export function decodeRuns<T extends Uint8Array | Uint16Array>(runs: number[], length: number, create: (length: number) => T): T {
  const values = create(length)
  let position = 0
  for (let index = 0; index + 1 < runs.length && position < length; index += 2) {
    values.fill(runs[index], position, Math.min(length, position + runs[index + 1]))
    position += runs[index + 1]
  }
  return values
}

/** round the corners off a polyline, the ends stay */
export function chaikin(points: Point[], closed: boolean, rounds: number): Point[] {
  let current = points
  for (let round = 0; round < rounds && current.length > 2; round += 1) {
    const next: Point[] = closed ? [] : [current[0]]
    for (let index = 0; index < current.length - 1; index += 1) {
      const [a, b] = [current[index], current[index + 1]]
      next.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75])
    }
    if (closed) next.push(next[0])
    else next.push(current[current.length - 1])
    current = next
  }
  return current
}

/**
 * The outline of every label's cells as chains of Voronoi edges. An edge is a border where the cell across it has
 * another label; the edges along the map edge are left out.
 */
export function traceBorders(graph: GridGraph, labelOf: (cell: number) => number, smoothing = 2, closeAtEdge = false): Map<number, Border[]> {
  const { cellVertices, vertexCells, cellCount } = graph
  const outgoing = new Map<number, Map<number, number[]>>()

  for (let cell = 0; cell < cellCount; cell += 1) {
    const label = labelOf(cell)
    if (!label) continue
    const ring = cellVertices[cell]
    for (let index = 0; index < ring.length; index += 1) {
      const from = ring[index]
      const to = ring[(index + 1) % ring.length]
      const across = vertexCells[from].find(other => other !== cell && vertexCells[to].includes(other))
      const outside = across === undefined || across >= cellCount
      if (outside ? !closeAtEdge : labelOf(across) === label) continue
      let edges = outgoing.get(label)
      if (!edges) outgoing.set(label, edges = new Map())
      const list = edges.get(from)
      if (list) list.push(to)
      else edges.set(from, [to])
    }
  }

  const borders = new Map<number, Border[]>()
  for (const [label, edges] of outgoing) {
    const chains: Border[] = []
    for (const [start, firsts] of edges) {
      while (firsts.length) {
        const chain = [start, firsts.pop()!]
        for (let current = chain[1]; current !== start;) {
          const options = edges.get(current)
          if (!options?.length) break
          current = options.pop()!
          chain.push(current)
        }
        const closed = chain[chain.length - 1] === start
        const points = chain.map(vertex => [graph.vertexX[vertex], graph.vertexY[vertex]] as Point)
        chains.push({ points: chaikin(points, closed, smoothing), closed })
      }
    }
    borders.set(label, chains)
  }
  return borders
}

export interface RegionLabel {
  x: number
  y: number
  /** text direction in radians, along the long axis of the area and never upside down */
  angle: number
  /** size of the largest text that still fits the area, in map units */
  fontSize: number
}

/**
 * Where a name goes: the deepest point of the area's largest piece, turned along its long axis. Returns nothing for
 * label ids without cells.
 */
export function computeLabels(graph: GridGraph, ids: Uint16Array, textLength: (id: number) => number): Map<number, RegionLabel> {
  const { neighbors, cellCount } = graph
  const areaOf = (cell: number) => graph.blockWidth * graph.blockHeight / 4 ** graph.level[cell]
  const visited = new Uint8Array(cellCount)
  const best = new Map<number, { cells: number[]; area: number }>()

  for (let start = 0; start < cellCount; start += 1) {
    const id = ids[start]
    if (!id || visited[start]) continue
    const cells = [start]
    visited[start] = 1
    let area = 0
    for (let cursor = 0; cursor < cells.length; cursor += 1) {
      area += areaOf(cells[cursor])
      for (const neighbor of neighbors[cells[cursor]]) {
        if (ids[neighbor] === id && !visited[neighbor]) {
          visited[neighbor] = 1
          cells.push(neighbor)
        }
      }
    }
    if (!best.has(id) || best.get(id)!.area < area) best.set(id, { cells, area })
  }

  const labels = new Map<number, RegionLabel>()
  for (const [id, { cells, area }] of best) {
    // hops from the edge of the piece: the largest is the pole of inaccessibility
    const inside = new Set(cells)
    const depth = new Map<number, number>()
    let frontier = cells.filter(cell => graph.border[cell] || neighbors[cell].some(neighbor => !inside.has(neighbor)))
    for (const cell of frontier) depth.set(cell, 0)
    let pole = frontier[0] ?? cells[0]
    while (frontier.length) {
      const next: number[] = []
      for (const cell of frontier) {
        for (const neighbor of neighbors[cell]) {
          if (inside.has(neighbor) && !depth.has(neighbor)) {
            depth.set(neighbor, depth.get(cell)! + 1)
            next.push(neighbor)
            pole = neighbor
          }
        }
      }
      frontier = next
    }

    // long axis from the second moments of the piece
    let sumX = 0
    let sumY = 0
    for (const cell of cells) {
      sumX += graph.x[cell]
      sumY += graph.y[cell]
    }
    const meanX = sumX / cells.length
    const meanY = sumY / cells.length
    let sxx = 0
    let syy = 0
    let sxy = 0
    for (const cell of cells) {
      const dx = graph.x[cell] - meanX
      const dy = graph.y[cell] - meanY
      sxx += dx * dx
      syy += dy * dy
      sxy += dx * dy
    }
    let angle = 0.5 * Math.atan2(2 * sxy, sxx - syy)
    if (angle > Math.PI / 2) angle -= Math.PI
    if (angle < -Math.PI / 2) angle += Math.PI
    // a nearly round area keeps its text level
    const spread = Math.hypot(sxx - syy, 2 * sxy) / Math.max(1e-9, sxx + syy)
    if (spread < 0.25) angle = 0

    const along = 4 * Math.sqrt(Math.max(sxx, syy) / cells.length)
    // the text fits along the long axis, stays modest for a huge area and never gets larger than a fraction of the map
    const fontSize = Math.min(Math.sqrt(area) * 0.1, along * 0.75 / (Math.max(2, textLength(id)) * 0.74), graph.height * 0.07)
    labels.set(id, { x: graph.x[pole], y: graph.y[pole], angle, fontSize })
  }
  return labels
}
