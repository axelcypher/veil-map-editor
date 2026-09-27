// Vector layers above the cell colours: the smoothed sea that hides the blocky cell edges, rivers, area borders, zones and coastlines.
import type { TerrainAnalysis } from './analysis'
import type { View } from './cell-renderer'
import type { CoastShape } from './coastline'
import type { Border } from './regions'

/** what a layer looks like: the sea of the surface is rock underground and open sky above */
export interface LayerStyle {
  sea: string
  lake: string
  coast: string
  river: string
}

export const LAYER_STYLES: Record<'surface' | 'underground' | 'sky', LayerStyle> = {
  surface: { sea: '#4b7fa8', lake: '#79aed2', coast: '#2f4f63', river: '#5d97c4' },
  underground: { sea: '#3a322c', lake: '#3f6c8a', coast: '#14100d', river: '#5d97c4' },
  sky: { sea: '#7db6e0', lake: '#d3e8f5', coast: '#5a86a6', river: '#5d97c4' },
}

export interface AreaBorders {
  color: string
  borders: Border[]
}

export interface ZoneShape {
  color: string
  pattern: 'solid' | 'hatch' | 'cross' | 'dots'
  opacity: number
  shapes: Border[]
}

export interface OverlayOptions {
  mapWidth: number
  mapHeight: number
  /** paint the sea and lakes over the cells so that only the smooth land shapes show them */
  cover: boolean
  coastLine: boolean
  style: LayerStyle
  /** draw the rivers; riverUnit is the base cell size in map units, which the widths follow */
  rivers: boolean
  riverUnit: number
  areaBorders: AreaBorders[]
  zones: ZoneShape[]
  /** feature id drawn with a heavy outline: the island or lake being edited */
  highlight?: number
  /** the surface as a shadow under the sea of another layer */
  shadow?: { coast: CoastShape[]; landFill: string; lineColor: string; deep: Border[]; deepFill: string }
}

const RIVER_CLASSES = 6
const riverGeometry = new WeakMap<TerrainAnalysis, Path2D[]>()

/** one path per width class so that a whole network is a handful of strokes */
function riversOf(analysis: TerrainAnalysis): Path2D[] {
  let paths = riverGeometry.get(analysis)
  if (paths) return paths
  paths = Array.from({ length: RIVER_CLASSES }, () => new Path2D())
  for (const river of analysis.rivers) {
    for (let index = 0; index < river.points.length - 1; index += 1) {
      const width = Math.min(RIVER_CLASSES - 1, Math.max(0, Math.floor(Math.log2(Math.max(1, river.flux[index] / analysis.minFlux)))))
      paths[width].moveTo(...river.points[index])
      paths[width].lineTo(...river.points[index + 1])
    }
  }
  riverGeometry.set(analysis, paths)
  return paths
}

const patternCache = new Map<string, HTMLCanvasElement>()

function tile(pattern: ZoneShape['pattern'], color: string): HTMLCanvasElement {
  const key = `${pattern}|${color}`
  let canvas = patternCache.get(key)
  if (canvas) return canvas
  canvas = document.createElement('canvas')
  canvas.width = canvas.height = 12
  const context = canvas.getContext('2d')!
  context.strokeStyle = color
  context.fillStyle = color
  context.lineWidth = 1.5
  if (pattern === 'hatch' || pattern === 'cross') {
    context.beginPath()
    context.moveTo(-2, 14)
    context.lineTo(14, -2)
    context.moveTo(-2, 2)
    context.lineTo(2, -2)
    context.moveTo(10, 14)
    context.lineTo(14, 10)
    if (pattern === 'cross') {
      context.moveTo(-2, -2)
      context.lineTo(14, 14)
    }
    context.stroke()
  } else if (pattern === 'dots') {
    context.beginPath()
    context.arc(6, 6, 1.6, 0, Math.PI * 2)
    context.fill()
  }
  patternCache.set(key, canvas)
  return canvas
}

const polyline = (path: Path2D, border: Border) => {
  border.points.forEach(([x, y], index) => index ? path.lineTo(x, y) : path.moveTo(x, y))
  if (border.closed) path.closePath()
}

/** the surface as a shadow: its land faint, its lakes and deep sea as they are, and its coast as a thin line */
function drawShadow(ctx: CanvasRenderingContext2D, options: OverlayOptions, pixel: number, covered: boolean) {
  const { shadow } = options
  if (!shadow) return
  for (const shape of shadow.coast) {
    if (shape.type !== 'island' && !covered) continue
    ctx.fillStyle = shape.type === 'island' ? shadow.landFill : options.style.sea
    ctx.fill(shape.path)
  }
  if (shadow.deep.length) {
    const path = new Path2D()
    for (const border of shadow.deep) polyline(path, border)
    ctx.fillStyle = shadow.deepFill
    ctx.fill(path, 'evenodd')
  }
  ctx.strokeStyle = shadow.lineColor
  ctx.lineWidth = 1.2 * pixel
  for (const shape of shadow.coast) ctx.stroke(shape.path)
}

export function drawCoastOverlay(ctx: CanvasRenderingContext2D, analysis: TerrainAnalysis | null, view: View, options: OverlayOptions) {
  const { canvas } = ctx
  const pixel = 1 / (view.scale / (window.devicePixelRatio || 1))
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalCompositeOperation = 'source-over'
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.setTransform(view.scale, 0, 0, view.scale, view.x, view.y)
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'

  if (analysis && options.cover) {
    // features in id order nest correctly: an island cuts a hole into the sea, a lake fills it again, an island in the lake cuts it again
    ctx.fillStyle = options.style.sea
    ctx.fillRect(0, 0, options.mapWidth, options.mapHeight)
    drawShadow(ctx, options, pixel, true)
    for (const shape of analysis.coast) {
      if (shape.type === 'island') {
        ctx.globalCompositeOperation = 'destination-out'
        ctx.fillStyle = '#000'
      } else {
        ctx.globalCompositeOperation = 'source-over'
        ctx.fillStyle = options.style.lake
      }
      ctx.fill(shape.path)
    }
    ctx.globalCompositeOperation = 'source-over'
  }

  // the plain views show the shadow over the cells
  if (!(analysis && options.cover)) drawShadow(ctx, options, pixel, false)

  for (const zone of options.zones) {
    const path = new Path2D()
    for (const shape of zone.shapes) polyline(path, shape)
    ctx.globalAlpha = zone.opacity
    if (zone.pattern === 'solid') ctx.fillStyle = zone.color
    else {
      const fill = ctx.createPattern(tile(zone.pattern, zone.color), 'repeat')!
      fill.setTransform(new DOMMatrix().scale(pixel))
      ctx.fillStyle = fill
    }
    ctx.fill(path, 'evenodd')
    ctx.globalAlpha = Math.min(1, zone.opacity + 0.35)
    ctx.strokeStyle = zone.color
    ctx.lineWidth = 1.4 * pixel
    ctx.stroke(path)
    ctx.globalAlpha = 1
  }

  if (analysis && options.rivers) {
    ctx.strokeStyle = options.style.river
    riversOf(analysis).forEach((path, index) => {
      ctx.lineWidth = Math.max(0.9 * pixel, options.riverUnit * 0.035 * (1 + index * 0.75))
      ctx.stroke(path)
    })
  }

  for (const area of options.areaBorders) {
    const path = new Path2D()
    for (const border of area.borders) polyline(path, border)
    ctx.strokeStyle = 'rgb(20 28 33 / 55%)'
    ctx.lineWidth = 4 * pixel
    ctx.stroke(path)
    ctx.strokeStyle = area.color
    ctx.lineWidth = 2.2 * pixel
    ctx.setLineDash([10 * pixel, 6 * pixel])
    ctx.stroke(path)
    ctx.setLineDash([])
  }

  if (analysis && options.coastLine) {
    ctx.lineWidth = 1.2 * pixel
    ctx.strokeStyle = options.style.coast
    for (const shape of analysis.coast) ctx.stroke(shape.path)
    if (options.highlight !== undefined) {
      const shape = analysis.coast.find(item => item.featureId === options.highlight)
      if (shape) {
        ctx.lineWidth = 3 * pixel
        ctx.strokeStyle = '#f2cb78'
        ctx.stroke(shape.path)
      }
    }
  }
}
