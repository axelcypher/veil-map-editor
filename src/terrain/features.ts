// Oceans, lakes and islands of a heightmap, after the feature markup of Azgaar's Fantasy Map Generator (MIT).
import type { GridGraph } from './graph'

export type FeatureType = 'ocean' | 'lake' | 'island'

export interface Feature {
  id: number
  type: FeatureType
  land: boolean
  /** touches the map edge: water that does is ocean, the rest are lakes */
  border: boolean
  cells: number
  firstCell: number
  /** the outer outline of an island or lake as vertex ids, empty for oceans */
  ring: number[]
}

export interface FeatureMap {
  /** feature id of every cell, ids start at 1 */
  ids: Uint32Array
  /** indexed by feature id, slot 0 is unused */
  features: Feature[]
}

/** land is 1 for dry land; everything else is water, lakes included */
export function markupFeatures(graph: GridGraph, landMask: Uint8Array): FeatureMap {
  const { neighbors, border, cellCount } = graph
  const ids = new Uint32Array(cellCount)
  const features: Feature[] = [undefined as unknown as Feature]

  for (let first = 0, id = 1; first < cellCount; first += 1, id = features.length) {
    if (ids[first]) continue
    const land = landMask[first] === 1
    let touchesBorder = false
    let cells = 0
    ids[first] = id
    const stack = [first]
    while (stack.length) {
      const cell = stack.pop()!
      cells += 1
      if (border[cell]) touchesBorder = true
      for (const neighbor of neighbors[cell]) {
        if (ids[neighbor] || (landMask[neighbor] === 1) !== land) continue
        ids[neighbor] = id
        stack.push(neighbor)
      }
    }
    const type: FeatureType = land ? 'island' : touchesBorder ? 'ocean' : 'lake'
    features.push({ id, type, land, border: touchesBorder, cells, firstCell: first, ring: [] })
  }

  for (const feature of features) {
    if (feature && feature.type !== 'ocean') feature.ring = traceOutline(graph, ids, feature)
  }
  return { ids, features }
}

/** walk the vertices along the outer boundary between a feature and everything around it */
function traceOutline(graph: GridGraph, ids: Uint32Array, feature: Feature): number[] {
  const { cellVertices, vertexCells, vertexNeighbors } = graph
  const sameFeature = (cell: number) => ids[cell] === feature.id
  const start = cellVertices[feature.firstCell].find(vertex => vertexCells[vertex].some(cell => !sameFeature(cell)))
  if (start === undefined) return []

  const ring: number[] = []
  let next = start
  for (let step = 0; step === 0 || next !== start; step += 1) {
    const previous = ring.at(-1)
    const current = next
    ring.push(current)

    const [c1, c2, c3] = vertexCells[current].map(sameFeature)
    const [v1, v2, v3] = vertexNeighbors[current]
    if (v1 !== previous && c1 !== c2) next = v1
    else if (v2 !== previous && c2 !== c3) next = v2
    else if (v3 !== previous && c1 !== c3) next = v3

    // a vertex on the hull has no opposite triangle, its neighbour is -1
    if (next < 0 || next >= vertexCells.length || next === current || step > vertexCells.length) return []
  }
  return ring
}
