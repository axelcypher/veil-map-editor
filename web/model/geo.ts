// Measurements on the planet sphere (radius from the project) and small geometry helpers.
import type { AreaGeometry, LonLat } from './types'

const rad = Math.PI / 180

export function distanceM(a: LonLat, b: LonLat, radius: number) {
  const dLat = (b[1] - a[1]) * rad
  const dLon = (b[0] - a[0]) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(h)))
}

export const lineLengthM = (line: LonLat[], radius: number) =>
  line.reduce((sum, point, i) => (i ? sum + distanceM(line[i - 1], point, radius) : 0), 0)

/** spherical excess of a ring, the same formula OpenLayers uses */
function ringArea(ring: LonLat[], radius: number) {
  let area = 0
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i]
    const [x2, y2] = ring[i + 1]
    area += (x2 - x1) * rad * (2 + Math.sin(y1 * rad) + Math.sin(y2 * rad))
  }
  return Math.abs((area * radius * radius) / 2)
}

export function polygonAreaM2(rings: LonLat[][], radius: number) {
  if (!rings.length) return 0
  return Math.max(0, ringArea(rings[0], radius) - rings.slice(1).reduce((s, r) => s + ringArea(r, radius), 0))
}

export const areaKm2 = (geometry: AreaGeometry | null, radius: number) =>
  geometry ? geometry.coordinates.reduce((s, poly) => s + polygonAreaM2(poly, radius), 0) / 1e6 : 0

/** points along the great circle from a to b */
export function greatCircle(a: LonLat, b: LonLat, steps = 64): LonLat[] {
  const toVec = ([lon, lat]: LonLat) => [Math.cos(lat * rad) * Math.cos(lon * rad), Math.cos(lat * rad) * Math.sin(lon * rad), Math.sin(lat * rad)]
  const va = toVec(a)
  const vb = toVec(b)
  const angle = Math.acos(Math.min(1, Math.max(-1, va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2])))
  if (angle < 1e-9) return [a, b]
  const out: LonLat[] = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const ka = Math.sin((1 - t) * angle) / Math.sin(angle)
    const kb = Math.sin(t * angle) / Math.sin(angle)
    const v = [ka * va[0] + kb * vb[0], ka * va[1] + kb * vb[1], ka * va[2] + kb * vb[2]]
    out.push([Math.atan2(v[1], v[0]) / rad, Math.atan2(v[2], Math.hypot(v[0], v[1])) / rad])
  }
  // keep the line continuous where it crosses ±180°
  for (let i = 1; i < out.length; i++) {
    while (out[i][0] - out[i - 1][0] > 180) out[i][0] -= 360
    while (out[i][0] - out[i - 1][0] < -180) out[i][0] += 360
  }
  return out
}

export type BBox = [number, number, number, number]

export function bboxOf(coords: LonLat[][][]): BBox {
  const box: BBox = [Infinity, Infinity, -Infinity, -Infinity]
  for (const poly of coords) for (const [x, y] of poly[0] ?? []) {
    if (x < box[0]) box[0] = x
    if (y < box[1]) box[1] = y
    if (x > box[2]) box[2] = x
    if (y > box[3]) box[3] = y
  }
  return box
}

export const bboxHit = (a: BBox, b: BBox) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]

function inRing(ring: LonLat[], [x, y]: LonLat) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

export const inPolygon = (poly: LonLat[][], point: LonLat) => inRing(poly[0], point) && !poly.slice(1).some(hole => inRing(hole, point))

export function inArea(geometry: AreaGeometry | null, point: LonLat) {
  if (!geometry) return false
  return geometry.coordinates.some(poly => inPolygon(poly, point))
}

export const formatKm = (m: number) => (m >= 100_000 ? `${Math.round(m / 1000).toLocaleString('de-DE')} km` : `${(m / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1 })} km`)
export const formatKm2 = (km2: number) => `${Math.round(km2).toLocaleString('de-DE')} km²`
export const formatInt = (n: number) => Math.round(n).toLocaleString('de-DE')
export const formatLonLat = ([lon, lat]: LonLat) =>
  `${Math.abs(lat).toFixed(3)}° ${lat >= 0 ? 'N' : 'S'} · ${Math.abs(lon).toFixed(3)}° ${lon >= 0 ? 'O' : 'W'}`

/**
 * Smooths a freehand stroke. `step` is the sampling distance in degrees (about two screen pixels);
 * `strength` 0…10 is the Gaussian width in samples. Clicked shapes (long segments) stay as they are.
 */
export function smoothStroke(coords: LonLat[], closed: boolean, strength: number, step: number): LonLat[] {
  if (strength <= 0 || coords.length <= 12) return coords
  // a freehand stroke has many short segments (one per mouse move); clicked shapes keep their corners
  const segments = coords.slice(1).map((p, i) => Math.hypot(p[0] - coords[i][0], p[1] - coords[i][1]))
  const sorted = [...segments].sort((a, b) => a - b)
  if (sorted[Math.floor(sorted.length / 2)] > step * 15) return coords
  const ring = closed ? coords.slice(0, -1) : coords
  // even spacing first, so the filter does not depend on how fast the mouse moved
  const path = closed ? [...ring, ring[0]] : ring
  const samples: LonLat[] = [path[0]]
  let carry = 0
  for (let i = 1; i < path.length; i++) {
    const [ax, ay] = path[i - 1]
    const [bx, by] = path[i]
    const length = Math.hypot(bx - ax, by - ay)
    let t = step - carry
    while (t <= length) {
      samples.push([ax + ((bx - ax) * t) / length, ay + ((by - ay) * t) / length])
      t += step
    }
    carry = length - (t - step)
  }
  if (!closed) samples.push(path[path.length - 1])
  const n = samples.length
  if (n < 5) return coords
  const sigma = strength
  const radius = Math.min(Math.ceil(sigma * 3), closed ? Math.floor(n / 2) - 1 : n)
  const kernel = Array.from({ length: radius * 2 + 1 }, (_, k) => Math.exp(-((k - radius) ** 2) / (2 * sigma * sigma)))
  const smoothed: LonLat[] = samples.map((_, i) => {
    if (!closed && (i === 0 || i === n - 1)) return samples[i]
    let x = 0
    let y = 0
    let weight = 0
    for (let k = -radius; k <= radius; k++) {
      let j = i + k
      if (closed) j = (j + n) % n
      else if (j < 0 || j >= n) continue
      const w = kernel[k + radius]
      x += samples[j][0] * w
      y += samples[j][1] * w
      weight += w
    }
    return [x / weight, y / weight]
  })
  const simplified = simplifyLine(closed ? [...smoothed, smoothed[0]] : smoothed, step * 0.25)
  return simplified.map(([x, y]) => [Math.round(x * 1e5) / 1e5, Math.round(y * 1e5) / 1e5])
}

/** Douglas–Peucker; the ends stay */
export function simplifyLine(points: LonLat[], tolerance: number): LonLat[] {
  if (points.length < 3) return points
  const keep = new Uint8Array(points.length)
  keep[0] = keep[points.length - 1] = 1
  const stack: [number, number][] = [[0, points.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()!
    const [ax, ay] = points[a]
    const [bx, by] = points[b]
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    let best = 0
    let index = -1
    for (let i = a + 1; i < b; i++) {
      const [px, py] = points[i]
      const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0
      const d = Math.hypot(px - ax - t * dx, py - ay - t * dy)
      if (d > best) {
        best = d
        index = i
      }
    }
    if (best > tolerance && index > 0) {
      keep[index] = 1
      stack.push([a, index], [index, b])
    }
  }
  return points.filter((_, i) => keep[i])
}
