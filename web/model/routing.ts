// Route geometry after drawing: reshaping a section, snapping the ends onto cities, and leading
// sea routes around the land. All planar in degrees, like the map.
import type { AreaGeometry, City, LonLat } from './types'

const round = ([x, y]: LonLat): LonLat => [Math.round(x * 1e5) / 1e5, Math.round(y * 1e5) / 1e5]
const same = (a: LonLat, b: LonLat) => Math.abs(a[0] - b[0]) < 5e-6 && Math.abs(a[1] - b[1]) < 5e-6

function dedupe(line: LonLat[]): LonLat[] {
  return line.filter((p, i) => i === 0 || !same(p, line[i - 1]))
}

// ---------------------------------------------------------------------------------------------
// reshaping

interface Hit {
  index: number
  t: number
  at: LonLat
  dist: number
  along: number
}

function nearestOnLine(line: LonLat[], [px, py]: LonLat): Hit {
  let best: Hit = { index: 0, t: 0, at: line[0], dist: Infinity, along: 0 }
  for (let i = 0; i < line.length - 1; i++) {
    const [ax, ay] = line[i]
    const [bx, by] = line[i + 1]
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0
    const at: LonLat = [ax + t * dx, ay + t * dy]
    const dist = Math.hypot(px - at[0], py - at[1])
    if (dist < best.dist) best = { index: i, t, at, dist, along: i + t }
  }
  return best
}

const head = (line: LonLat[], h: Hit): LonLat[] => [...line.slice(0, h.index + 1), h.at]
const tail = (line: LonLat[], h: Hit): LonLat[] => [h.at, ...line.slice(h.index + 1)]

/**
 * A stroke that starts and ends on the line replaces the section between; one that only starts
 * (or ends) on it replaces the nearer end of the line, or extends it when drawn from an end.
 * `tolerance` is how far from the line a stroke end still counts as on it. Null: neither end is.
 */
export function reshapeLine(line: LonLat[], stroke: LonLat[], tolerance: number): LonLat[] | null {
  if (stroke.length < 2 || line.length < 2) return null
  const a = nearestOnLine(line, stroke[0])
  const b = nearestOnLine(line, stroke[stroke.length - 1])
  const aOn = a.dist <= tolerance
  const bOn = b.dist <= tolerance
  if (aOn && bOn) {
    const forward = a.along <= b.along
    const s = forward ? stroke : [...stroke].reverse()
    const [from, to] = forward ? [a, b] : [b, a]
    return dedupe([...head(line, from), ...s.slice(1, -1), ...tail(line, to)])
  }
  if (!aOn && !bOn) return null
  // the stroke runs away from the line, starting at `hit`
  const s = aOn ? stroke : [...stroke].reverse()
  const hit = aOn ? a : b
  const rest = s.slice(1)
  if (hit.along >= (line.length - 1) / 2) return dedupe([...head(line, hit), ...rest])
  return dedupe([...rest.reverse(), ...tail(line, hit)])
}

// ---------------------------------------------------------------------------------------------
// cities

/** moves the first and last point onto a city within `tolerance` degrees */
export function snapEnds(line: LonLat[], cities: City[], tolerance: number): LonLat[] {
  const nearest = (p: LonLat) => {
    let best: LonLat | null = null
    let dist = tolerance
    for (const city of cities) {
      const c = city.geometry.coordinates
      const d = Math.hypot(c[0] - p[0], c[1] - p[1])
      if (d <= dist) {
        dist = d
        best = c
      }
    }
    return best
  }
  const out = [...line]
  const start = nearest(out[0])
  const end = nearest(out[out.length - 1])
  if (start) out[0] = start
  if (end) out[out.length - 1] = end
  return dedupe(out)
}

/** the city an end of the route sits on */
export function cityAt(cities: City[], p: LonLat): City | undefined {
  return cities.find(c => same(c.geometry.coordinates, p))
}

/** all routes with a point on `from` get it moved to `to` (a city was dragged) */
export function followPoint<R extends { geometry: { coordinates: LonLat[] } }>(routes: R[], from: LonLat, to: LonLat): R[] {
  return routes.map(r =>
    r.geometry.coordinates.some(p => same(p, from)) ? { ...r, geometry: { ...r.geometry, coordinates: r.geometry.coordinates.map(p => (same(p, from) ? to : p)) } } : r,
  )
}

// ---------------------------------------------------------------------------------------------
// sea routes around the land

const MAX_CELLS = 4_000_000
const MAX_SIDE = 4000
/** distance kept from the coast, in cells */
const CLEARANCE = 2

interface Mask {
  minX: number
  maxY: number
  cell: number
  w: number
  h: number
  blocked: Uint8Array
}

type Box = [number, number, number, number]
const outerBoxes = new WeakMap<AreaGeometry, Box[]>()
function boxesOf(land: AreaGeometry): Box[] {
  let boxes = outerBoxes.get(land)
  if (!boxes) {
    boxes = land.coordinates.map(poly => {
      const box: Box = [Infinity, Infinity, -Infinity, -Infinity]
      for (const [x, y] of poly[0]) {
        if (x < box[0]) box[0] = x
        if (y < box[1]) box[1] = y
        if (x > box[2]) box[2] = x
        if (y > box[3]) box[3] = y
      }
      return box
    })
    outerBoxes.set(land, boxes)
  }
  return boxes
}

/** land (outer rings only: lakes count as land) rasterised into the box and grown by the clearance */
function buildMask(land: AreaGeometry, [minX, minY, maxX, maxY]: Box, wanted: number): Mask {
  let cell = wanted
  const grow = Math.max(1, Math.sqrt(((maxX - minX) / cell) * ((maxY - minY) / cell) / MAX_CELLS), (maxX - minX) / cell / MAX_SIDE, (maxY - minY) / cell / MAX_SIDE)
  cell *= grow
  const w = Math.max(1, Math.ceil((maxX - minX) / cell))
  const h = Math.max(1, Math.ceil((maxY - minY) / cell))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.setTransform(1 / cell, 0, 0, -1 / cell, -minX / cell, maxY / cell)
  ctx.beginPath()
  const boxes = boxesOf(land)
  land.coordinates.forEach((poly, i) => {
    const b = boxes[i]
    if (b[2] < minX || b[0] > maxX || b[3] < minY || b[1] > maxY) return
    const ring = poly[0]
    ctx.moveTo(ring[0][0], ring[0][1])
    for (let k = 1; k < ring.length; k++) ctx.lineTo(ring[k][0], ring[k][1])
    ctx.closePath()
  })
  ctx.fillStyle = '#000'
  ctx.fill()
  const data = ctx.getImageData(0, 0, w, h).data
  const isLand = new Uint8Array(w * h)
  for (let i = 0; i < isLand.length; i++) isLand[i] = data[i * 4 + 3] > 100 ? 1 : 0
  // square dilation, rows then columns
  const rows = new Uint8Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = 0
      for (let k = Math.max(0, x - CLEARANCE); k <= Math.min(w - 1, x + CLEARANCE) && !v; k++) v = isLand[y * w + k]
      rows[y * w + x] = v
    }
  const blocked = new Uint8Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = 0
      for (let k = Math.max(0, y - CLEARANCE); k <= Math.min(h - 1, y + CLEARANCE) && !v; k++) v = rows[k * w + x]
      blocked[y * w + x] = v
    }
  return { minX, maxY, cell, w, h, blocked }
}

function cellOf(m: Mask, [lon, lat]: LonLat): number {
  const x = Math.floor((lon - m.minX) / m.cell)
  const y = Math.floor((m.maxY - lat) / m.cell)
  return x < 0 || y < 0 || x >= m.w || y >= m.h ? -1 : y * m.w + x
}
const isBlocked = (m: Mask, p: LonLat) => {
  const i = cellOf(m, p)
  return i >= 0 && m.blocked[i] === 1
}
const centerOf = (m: Mask, i: number): LonLat => [m.minX + ((i % m.w) + 0.5) * m.cell, m.maxY - (Math.floor(i / m.w) + 0.5) * m.cell]

function clear(m: Mask, a: LonLat, b: LonLat) {
  const steps = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (m.cell * 0.4))
  for (let k = 1; k < steps; k++) if (isBlocked(m, [a[0] + ((b[0] - a[0]) * k) / steps, a[1] + ((b[1] - a[1]) * k) / steps])) return false
  return true
}

/** A* over the free cells, 8 neighbours, no corner cutting */
function findPath(m: Mask, start: number, goal: number): number[] | null {
  const { w, h, blocked } = m
  const n = w * h
  const g = new Float32Array(n).fill(Infinity)
  const from = new Int32Array(n).fill(-1)
  const done = new Uint8Array(n)
  const gx = goal % w
  const gy = Math.floor(goal / w)
  const heuristic = (i: number) => {
    const dx = Math.abs((i % w) - gx)
    const dy = Math.abs(Math.floor(i / w) - gy)
    return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy)
  }
  // binary heap of cells by f
  const heap: number[] = []
  const f: number[] = []
  const push = (i: number, score: number) => {
    heap.push(i)
    f.push(score)
    let c = heap.length - 1
    while (c > 0) {
      const parent = (c - 1) >> 1
      if (f[parent] <= f[c]) break
      ;[heap[parent], heap[c]] = [heap[c], heap[parent]]
      ;[f[parent], f[c]] = [f[c], f[parent]]
      c = parent
    }
  }
  const pop = () => {
    const top = heap[0]
    const lastI = heap.pop()!
    const lastF = f.pop()!
    if (heap.length) {
      heap[0] = lastI
      f[0] = lastF
      let c = 0
      for (;;) {
        const l = c * 2 + 1
        const r = l + 1
        let s = c
        if (l < heap.length && f[l] < f[s]) s = l
        if (r < heap.length && f[r] < f[s]) s = r
        if (s === c) break
        ;[heap[s], heap[c]] = [heap[c], heap[s]]
        ;[f[s], f[c]] = [f[c], f[s]]
        c = s
      }
    }
    return top
  }
  g[start] = 0
  push(start, heuristic(start))
  while (heap.length) {
    const i = pop()
    if (done[i]) continue
    if (i === goal) {
      const path = [i]
      for (let c = from[i]; c >= 0; c = from[c]) path.push(c)
      return path.reverse()
    }
    done[i] = 1
    const x = i % w
    const y = Math.floor(i / w)
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        const j = ny * w + nx
        if (blocked[j] || done[j]) continue
        if (dx && dy && (blocked[y * w + nx] || blocked[ny * w + x])) continue
        const score = g[i] + (dx && dy ? Math.SQRT2 : 1)
        if (score < g[j]) {
          g[j] = score
          from[j] = i
          push(j, score + heuristic(j))
        }
      }
  }
  return null
}

/** straight lines between the corners that must be kept */
function pull(m: Mask, points: LonLat[]): LonLat[] {
  if (points.length <= 2) return points
  const out = [points[0]]
  let anchor = 0
  for (let i = 2; i < points.length; i++) {
    if (!clear(m, points[anchor], points[i])) {
      anchor = i - 1
      out.push(points[anchor])
    }
  }
  out.push(points[points.length - 1])
  return out
}

function reroute(line: LonLat[], m: Mask) {
  // samples closer than a cell, so no crossing slips between two of them
  const step = m.cell * 0.5
  const samples: { p: LonLat; orig: boolean }[] = []
  for (let i = 0; i < line.length - 1; i++) {
    const [ax, ay] = line[i]
    const [bx, by] = line[i + 1]
    samples.push({ p: line[i], orig: true })
    const steps = Math.floor(Math.hypot(bx - ax, by - ay) / step)
    for (let k = 1; k < steps; k++) samples.push({ p: [ax + ((bx - ax) * k) / steps, ay + ((by - ay) * k) / steps], orig: false })
  }
  samples.push({ p: line[line.length - 1], orig: true })
  const bad = samples.map(s => isBlocked(m, s.p))
  const first = bad.indexOf(false)
  const last = bad.lastIndexOf(false)
  if (first < 0) return { line, changed: false, failed: 0 }
  const out: LonLat[] = []
  let changed = false
  let failed = 0
  // the way out of a harbour and into the last one stays as drawn
  for (let i = 0; i < first; i++) if (samples[i].orig) out.push(samples[i].p)
  out.push(samples[first].p)
  let i = first
  while (i < last) {
    const j = i + 1
    if (!bad[j]) {
      if (samples[j].orig || j === last) out.push(samples[j].p)
      i = j
      continue
    }
    let k = j
    while (bad[k]) k++
    const path = findPath(m, cellOf(m, samples[i].p), cellOf(m, samples[k].p))
    if (path) {
      const pulled = pull(m, [samples[i].p, ...path.slice(1, -1).map(c => centerOf(m, c)), samples[k].p])
      out.push(...pulled.slice(1))
      changed = true
    } else {
      failed++
      for (let c = j; c <= k; c++) if (samples[c].orig || c === k) out.push(samples[c].p)
    }
    i = k
  }
  for (let c = last + 1; c < samples.length; c++) if (samples[c].orig) out.push(samples[c].p)
  return { line: changed ? dedupe(out.map(round)) : line, changed, failed }
}

/**
 * Leads the parts of a sea route that cross land around it, at a distance of a few `cell`s
 * (degrees, about two screen pixels each). The ends may lie on land (harbours) and stay as drawn.
 */
export function avoidLand(line: LonLat[], land: AreaGeometry, cell: number): { line: LonLat[]; changed: boolean; failed: number } {
  if (line.length < 2 || !land.coordinates.length) return { line, changed: false, failed: 0 }
  const box: Box = [Infinity, Infinity, -Infinity, -Infinity]
  for (const [x, y] of line) {
    box[0] = Math.min(box[0], x)
    box[1] = Math.min(box[1], y)
    box[2] = Math.max(box[2], x)
    box[3] = Math.max(box[3], y)
  }
  const span = Math.max(box[2] - box[0], box[3] - box[1])
  let result = { line, changed: false, failed: 0 }
  // a small search area first; a long peninsula needs a larger one
  for (const factor of [1, 4]) {
    const margin = Math.max(cell * 40, span * 0.5) * factor
    const mask = buildMask(land, [box[0] - margin, Math.max(-90, box[1] - margin), box[2] + margin, Math.min(90, box[3] + margin)], cell)
    result = reroute(line, mask)
    if (!result.failed) break
  }
  return result
}
