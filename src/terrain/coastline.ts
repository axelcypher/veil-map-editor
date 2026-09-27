// Fractal coastlines, ported from Azgaar's Fantasy Map Generator (MIT, Copyright 2017-2024 Max Haniyeu).
// The outline of every island and lake is displaced by position-keyed noise, so an edit only changes the coast nearby.
import type { FeatureMap } from './features'
import { findCell, type GridGraph } from './graph'
import { MAX_LEVEL } from './quadtree'
import { hashSeed } from './rng'

type Point = [number, number]

export interface CoastSettings {
  /** false keeps the smooth cell outlines */
  enabled: boolean
  /** deepest subdivision of an edge */
  maxDepth: number
  /** how far the coast bends in and out */
  baseAmplitude: number
  amplitudeDecay: number
  /** edges shorter than this stay as they are, in reference cell units */
  minEdge: number
  /** roughness below this leaves the shore calm */
  smoothThreshold: number
  roughnessContrast: number
  /** length of a calm or rough stretch, in reference cell units */
  roughnessScale: number
  /** lake shores are calmer by this factor */
  lakeSmoothThreshMult: number
  /** reshuffles the calm and rough stretches */
  variant: number
}

export const DEFAULT_COAST: Readonly<CoastSettings> = {
  enabled: true,
  maxDepth: 4,
  baseAmplitude: 1.5,
  amplitudeDecay: 0.9,
  minEdge: 1,
  smoothThreshold: 0.25,
  roughnessContrast: 1.5,
  roughnessScale: 60,
  lakeSmoothThreshMult: 2,
  variant: 0,
}

export interface CoastShape {
  featureId: number
  type: 'island' | 'lake'
  path: Path2D
}

/** cell spacing the original defaults were tuned for, everything length-like scales with spacing / this */
const REFERENCE_SPACING = 14
const SIMPLIFICATION_TOLERANCE = 0.3
/** noise is keyed to segment ends rounded to 1/64 of the finest cell that can exist, so refining elsewhere never reshuffles a coast */
const QUANTUM_PER_CELL = 64
const OCTAVE_WEIGHT = 0.35
const FIELD_STRETCH = 1.9

interface Shape {
  points: Point[]
  /** index in points where original vertex i lives */
  originalIndices: number[]
}

/** settings one island or lake has of its own, matched by a point inside it so they survive re-numbering of the features */
export interface CoastOverride {
  x: number
  y: number
  settings: Partial<CoastSettings>
}

/** what a feature's shore is displaced with: the map's settings, then its own; lake shores are calmer */
export function shoreSettings(type: 'island' | 'lake', settings: CoastSettings, own?: Partial<CoastSettings>): CoastSettings {
  const merged = { ...settings, ...own }
  return type === 'lake' && merged.lakeSmoothThreshMult !== 1
    ? { ...merged, smoothThreshold: Math.min(1, merged.smoothThreshold * merged.lakeSmoothThreshMult) }
    : merged
}

export function buildCoastlines(graph: GridGraph, featureMap: FeatureMap, settings: CoastSettings, seed: string, overrides: Map<number, Partial<CoastSettings>> = new Map()): CoastShape[] {
  const baseUnit = graph.baseSpacing / REFERENCE_SPACING
  const finestUnit = baseUnit / 2 ** graph.maxLevel
  const shapes: CoastShape[] = []

  for (const feature of featureMap.features) {
    if (!feature || feature.type === 'ocean' || feature.ring.length < 3) continue
    const outline = getOutline(graph, feature.ring, finestUnit)
    if (outline.length < 3) continue

    const shore = shoreSettings(feature.type, settings, overrides.get(feature.id))
    const noiseSeed = hashSeed(`${seed}:coast:${shore.variant}`) | 0
    const shape: Shape = shore.enabled
      ? fractalize(outline, noiseSeed, shore, graph, baseUnit)
      : { points: outline, originalIndices: outline.map((_, index) => index) }
    const path = buildPath(shape)
    if (path) shapes.push({ featureId: feature.id, type: feature.type, path: new Path2D(path) })
  }
  return shapes
}

/** the feature's vertices, simplified and clipped to the map */
function getOutline(graph: GridGraph, ring: number[], finestUnit: number): Point[] {
  const points = ring.map(vertex => [graph.vertexX[vertex], graph.vertexY[vertex]] as Point)
  return secureBorder(clipPolygon(simplify(points, SIMPLIFICATION_TOLERANCE * finestUnit), graph.width, graph.height), graph.width, graph.height)
}

/** repeat the points on the map edge so the smoothing spline runs through them instead of arcing away */
function secureBorder(points: Point[], width: number, height: number): Point[] {
  const secured: Point[] = []
  for (const point of points) {
    secured.push(point)
    if (point[0] === 0 || point[0] === width || point[1] === 0 || point[1] === height) secured.push(point, point)
  }
  return secured
}

interface Displacement {
  settings: CoastSettings
  seed: number
  baseUnit: number
  quantum: number
  out: Point[]
}

/** displaces the outline; the amplitude follows the local cell size, the noise lattice stays the same everywhere */
function fractalize(points: Point[], seed: number, settings: CoastSettings, graph: GridGraph, baseUnit: number): Shape {
  const context: Displacement = { settings, seed, baseUnit, quantum: QUANTUM_PER_CELL * 2 ** MAX_LEVEL / baseUnit, out: [] }
  const originalIndices: number[] = []
  const onBorder = ([x, y]: Point) => x === 0 || x === graph.width || y === 0 || y === graph.height

  for (let index = 0; index < points.length; index += 1) {
    originalIndices.push(context.out.length)
    context.out.push(points[index])
    const [a, b] = [points[index], points[(index + 1) % points.length]]
    if (onBorder(a) && onBorder(b)) continue
    const unit = graph.maxLevel === 0 ? baseUnit : baseUnit / 2 ** graph.level[findCell(graph, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2)]
    subdivideEdge(a, b, settings.maxDepth, settings.baseAmplitude, unit, context)
  }
  return { points: context.out, originalIndices }
}

function subdivideEdge(a: Point, b: Point, depth: number, amplitude: number, unit: number, context: Displacement) {
  const { settings, seed, baseUnit, quantum, out } = context
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]]
  const length = Math.sqrt(dx * dx + dy * dy)
  if (depth === 0 || length < settings.minEdge * unit || amplitude === 0) return

  const [mx, my] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
  const roughness = roughnessAt(seed, mx, my, settings, baseUnit)
  if (roughness < settings.smoothThreshold) return

  const displacement = (segmentNoise(seed, a, b, depth, quantum) - 0.5) * Math.sqrt(length * unit) * amplitude * roughness
  const middle: Point = [mx + (-dy / length) * displacement, my + (dx / length) * displacement]
  const nextAmplitude = amplitude * settings.amplitudeDecay
  subdivideEdge(a, middle, depth - 1, nextAmplitude, unit, context)
  out.push(middle)
  subdivideEdge(middle, b, depth - 1, nextAmplitude, unit, context)
}

function roughnessAt(seed: number, x: number, y: number, settings: CoastSettings, baseUnit: number): number {
  const scale = Math.max(settings.roughnessScale * baseUnit, 1)
  const base = fieldAt(seed, x, y, scale)
  const detail = fieldAt(seed ^ 0x9e3779b9, x, y, scale / 2)
  const combined = base * (1 - OCTAVE_WEIGHT) + detail * OCTAVE_WEIGHT
  const spread = Math.min(1, Math.max(0, (combined - 0.5) * FIELD_STRETCH + 0.5))
  return spread ** settings.roughnessContrast
}

function segmentNoise(seed: number, [x0, y0]: Point, [x1, y1]: Point, depth: number, quantum: number): number {
  const quantize = (value: number) => Math.round(value * quantum)
  return noise(seed, quantize(x0), quantize(y0), quantize(x1), quantize(y1), depth)
}

/** smoothstep-interpolated value noise on a lattice of `scale` map units */
function fieldAt(seed: number, x: number, y: number, scale: number): number {
  const [fx, fy] = [x / scale, y / scale]
  const [ix, iy] = [Math.floor(fx), Math.floor(fy)]
  const [tx, ty] = [fx - ix, fy - iy]
  const [sx, sy] = [tx * tx * (3 - 2 * tx), ty * ty * (3 - 2 * ty)]
  const corner = (cx: number, cy: number) => noise(seed, cx, cy)
  const top = corner(ix, iy) * (1 - sx) + corner(ix + 1, iy) * sx
  const bottom = corner(ix, iy + 1) * (1 - sx) + corner(ix + 1, iy + 1) * sx
  return top * (1 - sy) + bottom * sy
}

/** deterministic value in [0, 1) for a tuple of integers */
function noise(seed: number, ...values: number[]): number {
  let hash = seed | 0
  for (const value of values) {
    hash = Math.imul(hash ^ (value | 0), 0x5bd1e995)
    hash ^= hash >>> 13
  }
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b)
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35)
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967296
}

const round = (value: number) => Math.round(value * 100) / 100

/** closed SVG path: smooth spans as B-spline midpoints, jagged spans as Catmull-Rom curves through every sub-point */
function buildPath({ points, originalIndices }: Shape): string {
  const total = points.length
  const originals = originalIndices.length
  if (total < 3 || originals < 3) return ''

  const smooth: boolean[] = new Array(originals)
  for (let index = 0; index < originals; index += 1) {
    const a = originalIndices[index]
    const b = originalIndices[(index + 1) % originals]
    smooth[index] = (b > a ? b - a : b + total - a) === 1
  }

  const first = points[originalIndices[0]]
  const last = points[originalIndices[originals - 1]]
  let atMiddle = smooth[originals - 1]
  const startX = atMiddle ? (last[0] + first[0]) / 2 : first[0]
  const startY = atMiddle ? (last[1] + first[1]) / 2 : first[1]
  const d: string[] = [`M${round(startX)},${round(startY)}`]

  for (let index = 0; index < originals; index += 1) {
    const current = originalIndices[index]
    const next = originalIndices[(index + 1) % originals]
    const [cx, cy] = points[current]

    if (smooth[index]) {
      const [nx, ny] = points[next]
      const mx = (cx + nx) / 2
      const my = (cy + ny) / 2
      d.push(atMiddle ? `Q${round(cx)},${round(cy)} ${round(mx)},${round(my)}` : `L${round(mx)},${round(my)}`)
      atMiddle = true
      continue
    }

    if (atMiddle) d.push(`L${round(cx)},${round(cy)}`)
    const end = next > current ? next : next + total
    for (let j = current; j < end; j += 1) {
      const a = points[j % total]
      const b = points[(j + 1) % total]
      const before = points[(j - 1 + total) % total]
      const after = points[(j + 2) % total]
      d.push(`C${round(a[0] + (b[0] - before[0]) / 8)},${round(a[1] + (b[1] - before[1]) / 8)} ${round(b[0] - (after[0] - a[0]) / 8)},${round(b[1] - (after[1] - a[1]) / 8)} ${round(b[0])},${round(b[1])}`)
    }
    atMiddle = false
  }
  return `${d.join('')}Z`
}

// simplify-js (Vladimir Agafonkin, BSD-2): radial distance, then Douglas-Peucker

const squaredDistance = (a: Point, b: Point) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2

function squaredSegmentDistance(p: Point, a: Point, b: Point): number {
  let [x, y] = a
  let dx = b[0] - x
  let dy = b[1] - y
  if (dx !== 0 || dy !== 0) {
    const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy)
    if (t > 1) [x, y] = b
    else if (t > 0) {
      x += dx * t
      y += dy * t
    }
  }
  dx = p[0] - x
  dy = p[1] - y
  return dx * dx + dy * dy
}

function simplify(points: Point[], tolerance: number): Point[] {
  if (points.length <= 2) return points
  const squaredTolerance = tolerance * tolerance

  let previous = points[0]
  const radial: Point[] = [previous]
  for (let index = 1; index < points.length; index += 1) {
    if (squaredDistance(points[index], previous) > squaredTolerance) {
      radial.push(points[index])
      previous = points[index]
    }
  }
  if (previous !== points[points.length - 1]) radial.push(points[points.length - 1])

  const last = radial.length - 1
  const keep = new Uint8Array(radial.length)
  keep[0] = keep[last] = 1
  const stack: [number, number][] = [[0, last]]
  while (stack.length) {
    const [first, end] = stack.pop()!
    let maxDistance = squaredTolerance
    let split = -1
    for (let index = first + 1; index < end; index += 1) {
      const distance = squaredSegmentDistance(radial[index], radial[first], radial[end])
      if (distance > maxDistance) {
        split = index
        maxDistance = distance
      }
    }
    if (split < 0) continue
    keep[split] = 1
    stack.push([first, split], [split, end])
  }
  return radial.filter((_, index) => keep[index])
}

/** Sutherland-Hodgman clip of a polygon to the map rectangle */
function clipPolygon(polygon: Point[], width: number, height: number): Point[] {
  const edges: { inside: (p: Point) => boolean; cross: (a: Point, b: Point) => Point }[] = [
    { inside: p => p[0] >= 0, cross: (a, b) => [0, a[1] + (b[1] - a[1]) * (0 - a[0]) / (b[0] - a[0])] },
    { inside: p => p[0] <= width, cross: (a, b) => [width, a[1] + (b[1] - a[1]) * (width - a[0]) / (b[0] - a[0])] },
    { inside: p => p[1] >= 0, cross: (a, b) => [a[0] + (b[0] - a[0]) * (0 - a[1]) / (b[1] - a[1]), 0] },
    { inside: p => p[1] <= height, cross: (a, b) => [a[0] + (b[0] - a[0]) * (height - a[1]) / (b[1] - a[1]), height] },
  ]
  let output = polygon
  for (const edge of edges) {
    const input = output
    output = []
    for (let index = 0; index < input.length; index += 1) {
      const current = input[index]
      const previous = input[(index + input.length - 1) % input.length]
      if (edge.inside(current)) {
        if (!edge.inside(previous)) output.push(edge.cross(previous, current))
        output.push(current)
      } else if (edge.inside(previous)) output.push(edge.cross(previous, current))
    }
    if (!output.length) break
  }
  return output
}
