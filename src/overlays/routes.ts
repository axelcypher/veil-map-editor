// Routes: lines for sea lanes, roads, trails and air routes, drawn by hand or found across the terrain.
import type { GridGraph } from '../terrain/graph'
import { findCell } from '../terrain/graph'
import type { Metric } from '../terrain/brush'
import type { Position, Route, RouteKind } from '../model'

export const ROUTE_KINDS: { id: RouteKind; label: string; color: string; width: number; dash: Route['dash'] }[] = [
  { id: 'sea', label: 'Seeweg', color: '#2b6cb0', width: 2.4, dash: 'dashed' },
  { id: 'road', label: 'Straße', color: '#7a4b22', width: 2.6, dash: 'solid' },
  { id: 'trail', label: 'Pfad', color: '#8a6a3d', width: 1.8, dash: 'dotted' },
  { id: 'air', label: 'Luftweg', color: '#7e6bc4', width: 2.2, dash: 'dashed' },
  { id: 'river', label: 'Fluss', color: '#5d97c4', width: 3, dash: 'solid' },
  { id: 'custom', label: 'Eigene', color: '#b23a48', width: 2.2, dash: 'solid' },
]

export const routeKindLabel = (kind: RouteKind) => ROUTE_KINDS.find(item => item.id === kind)?.label ?? kind

/** a smooth curve through the points, in map units */
export function routePath(points: Position[]): Path2D {
  const path = new Path2D()
  if (!points.length) return path
  path.moveTo(...points[0])
  if (points.length === 2) path.lineTo(...points[1])
  for (let index = 0; index < points.length - 1 && points.length > 2; index += 1) {
    const [before, a, b, after] = [points[Math.max(0, index - 1)], points[index], points[index + 1], points[Math.min(points.length - 1, index + 2)]]
    path.bezierCurveTo(a[0] + (b[0] - before[0]) / 6, a[1] + (b[1] - before[1]) / 6, b[0] - (after[0] - a[0]) / 6, b[1] - (after[1] - a[1]) / 6, b[0], b[1])
  }
  return path
}

export function routeLengthKm(points: Position[], metric: Metric): number {
  let total = 0
  for (let index = 0; index < points.length - 1; index += 1) {
    const [kmX, kmY] = metric.kmPerUnit((points[index][1] + points[index + 1][1]) / 2)
    total += Math.hypot((points[index + 1][0] - points[index][0]) * kmX, (points[index + 1][1] - points[index][1]) * kmY)
  }
  return total
}

/** distance in pixels from a screen position to the route, the way it is drawn */
export function distanceToRoute(route: Route, screen: Position, toScreen: (point: Position) => Position): number {
  let best = Infinity
  const points = route.points.map(toScreen)
  for (let index = 0; index < points.length - 1; index += 1) {
    const [a, b] = [points[index], points[index + 1]]
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]]
    const length = dx * dx + dy * dy
    const t = length ? Math.max(0, Math.min(1, ((screen[0] - a[0]) * dx + (screen[1] - a[1]) * dy) / length)) : 0
    best = Math.min(best, Math.hypot(screen[0] - (a[0] + dx * t), screen[1] - (a[1] + dy * t)))
  }
  return best
}

/** the cell path between two points that stays on water (sea routes) or on dry land (roads, trails), or a straight line */
export function findRouteBetween(graph: GridGraph, kind: RouteKind, from: Position, to: Position, metric: Metric, elevations: ArrayLike<number>, land: (cell: number) => boolean): Position[] {
  if (kind === 'air' || kind === 'custom') return [from, to]
  const wantLand = kind !== 'sea'
  const passable = (cell: number) => land(cell) === wantLand
  const start = findCell(graph, from[0], from[1])
  const goal = findCell(graph, to[0], to[1])
  if (start === goal || !passable(start) || !passable(goal)) return [from, to]

  // A* over the cells; a road pays for every metre it climbs, a sea lane for nothing but distance
  const cost = new Float64Array(graph.cellCount).fill(Infinity)
  const previous = new Int32Array(graph.cellCount).fill(-1)
  const heapCells: number[] = []
  const heapKeys: number[] = []
  const push = (key: number, cell: number) => {
    let index = heapCells.length
    heapCells.push(cell)
    heapKeys.push(key)
    while (index > 0) {
      const parent = (index - 1) >> 1
      if (heapKeys[parent] <= key) break
      ;[heapKeys[index], heapCells[index]] = [heapKeys[parent], heapCells[parent]]
      index = parent
    }
    heapKeys[index] = key
    heapCells[index] = cell
  }
  const pop = () => {
    const cell = heapCells[0]
    const lastKey = heapKeys.pop()!
    const lastCell = heapCells.pop()!
    if (heapCells.length) {
      let index = 0
      for (;;) {
        let child = index * 2 + 1
        if (child >= heapCells.length) break
        if (child + 1 < heapCells.length && heapKeys[child + 1] < heapKeys[child]) child += 1
        if (heapKeys[child] >= lastKey) break
        heapKeys[index] = heapKeys[child]
        heapCells[index] = heapCells[child]
        index = child
      }
      heapKeys[index] = lastKey
      heapCells[index] = lastCell
    }
    return cell
  }
  const estimate = (cell: number) => metric.cellDistanceKm(cell, goal)
  cost[start] = 0
  push(estimate(start), start)
  while (heapCells.length) {
    const cell = pop()
    if (cell === goal) break
    for (const neighbor of graph.neighbors[cell]) {
      if (!passable(neighbor)) continue
      const distance = metric.cellDistanceKm(cell, neighbor)
      const climb = wantLand ? Math.abs(elevations[neighbor] - elevations[cell]) / (distance * 1000 + 1) * 4 : 0
      const next = cost[cell] + distance * (1 + climb)
      if (next < cost[neighbor]) {
        cost[neighbor] = next
        previous[neighbor] = cell
        push(next + estimate(neighbor), neighbor)
      }
    }
  }
  if (previous[goal] < 0) return [from, to]

  const cells: number[] = []
  for (let cell = goal; cell >= 0; cell = previous[cell]) cells.push(cell)
  cells.reverse()
  return [from, ...cells.slice(1, -1).map(cell => [graph.x[cell], graph.y[cell]] as Position), to]
}
