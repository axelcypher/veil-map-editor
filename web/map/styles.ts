// How each kind of element is drawn. Styles are cached per element object: the project is
// immutable, so a changed element is a new object and gets a new style.
import type { FeatureLike } from 'ol/Feature'
import type Geometry from 'ol/geom/Geometry'
import type LineString from 'ol/geom/LineString'
import LineStringGeom from 'ol/geom/LineString'
import MultiPoint from 'ol/geom/MultiPoint'
import MultiPolygon from 'ol/geom/MultiPolygon'
import Point from 'ol/geom/Point'
import Polygon from 'ol/geom/Polygon'
import { Circle, Fill, Icon, RegularShape, Stroke, Style, Text } from 'ol/style'
import { fullPath } from '../model/routing'
import type { City, Entity, EntityKind, Label, LayerStyle, Marker, Project, Regiment, River, Route, Zone, ZonePattern } from '../model/types'

export const SELECT_COLOR = '#f2b134'

export function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '')
  const full = clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean.padEnd(6, '0')
  const value = parseInt(full.slice(0, 6), 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}
export const rgba = (hex: string, alpha: number) => `rgba(${hexToRgb(hex).join(',')},${alpha})`
export function darken(hex: string, amount = 0.35) {
  const [r, g, b] = hexToRgb(hex).map(c => Math.round(c * (1 - amount)))
  return `rgb(${r},${g},${b})`
}
const dashOf = (dash: string) => {
  const parts = dash.trim().split(/[\s,]+/).map(Number).filter(n => n > 0)
  return parts.length ? parts : undefined
}

const patterns = new Map<string, CanvasPattern | string>()
function zonePattern(color: string, pattern: ZonePattern, opacity: number): CanvasPattern | string {
  const key = `${color}|${pattern}|${opacity}`
  const cached = patterns.get(key)
  if (cached) return cached
  if (pattern === 'fill') {
    patterns.set(key, rgba(color, opacity))
    return patterns.get(key)!
  }
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 12
  const ctx = canvas.getContext('2d')!
  ctx.strokeStyle = rgba(color, Math.min(1, opacity * 2.4))
  ctx.fillStyle = rgba(color, Math.min(1, opacity * 2.4))
  ctx.lineWidth = 1.4
  if (pattern === 'dots') {
    ctx.beginPath()
    ctx.arc(3, 3, 1.6, 0, Math.PI * 2)
    ctx.arc(9, 9, 1.6, 0, Math.PI * 2)
    ctx.fill()
  } else {
    ctx.beginPath()
    ctx.moveTo(0, 12)
    ctx.lineTo(12, 0)
    ctx.moveTo(-6, 6)
    ctx.lineTo(6, -6)
    ctx.moveTo(6, 18)
    ctx.lineTo(18, 6)
    if (pattern === 'cross') {
      ctx.moveTo(0, 0)
      ctx.lineTo(12, 12)
      ctx.moveTo(-6, 6)
      ctx.lineTo(6, 18)
      ctx.moveTo(6, -6)
      ctx.lineTo(18, 6)
    }
    ctx.stroke()
  }
  const created = ctx.createPattern(canvas, 'repeat')!
  patterns.set(key, created)
  return created
}

/** the label spot of an area: the interior point of its largest part */
const labelPoints = new WeakMap<Geometry, Point>()
export function areaLabelPoint(feature: FeatureLike): Point | undefined {
  const geometry = feature.getGeometry() as Geometry | undefined
  if (!geometry) return undefined
  const cached = labelPoints.get(geometry)
  if (cached) return cached
  let best: Polygon | null = null
  let bestArea = 0
  if (geometry instanceof MultiPolygon) {
    for (const polygon of geometry.getPolygons()) {
      const area = polygon.getArea()
      if (area > bestArea) {
        bestArea = area
        best = polygon
      }
    }
  } else if (geometry instanceof Polygon) best = geometry
  if (!best) return undefined
  const point = new Point(best.getInteriorPoint().getCoordinates().slice(0, 2))
  labelPoints.set(geometry, point)
  return point
}

export interface StyleContext {
  project: Project
  selectedId: string | null
  /** state id → fill colour when the map shows diplomacy */
  diplomacyColors: Map<string, string> | null
}

const font = (s: LayerStyle, size = s.labelSize, weight = '') => `${weight}${size}px ${s.labelFont}`
const textStyle = (s: LayerStyle, text: string, extra: Partial<ConstructorParameters<typeof Text>[0]> = {}) =>
  new Text({
    text,
    font: font(s),
    fill: new Fill({ color: s.labelColor }),
    stroke: s.haloWidth > 0 ? new Stroke({ color: s.halo, width: s.haloWidth }) : undefined,
    overflow: true,
    ...extra,
  })

function areaStyles(kind: EntityKind, entity: Entity & { color: string }, s: LayerStyle, ctx: StyleContext, selected: boolean): Style[] {
  const fillColor = (kind === 'state' && ctx.diplomacyColors?.get(entity.id)) || s.fill || entity.color
  const zone = kind === 'zone' ? (entity as Zone) : null
  const fill = zone ? zonePattern(zone.color, zone.pattern, zone.opacity * (s.fillOpacity / 0.35)) : rgba(fillColor, s.fillOpacity)
  const styles = [
    new Style({
      fill: s.fillOpacity > 0 || zone ? new Fill({ color: fill }) : undefined,
      stroke: new Stroke({ color: s.stroke || darken(entity.color), width: s.strokeWidth, lineDash: dashOf(s.dash) }),
    }),
  ]
  if (selected) styles.push(new Style({ stroke: new Stroke({ color: SELECT_COLOR, width: s.strokeWidth + 2.5 }) }))
  if (s.showLabels && entity.name)
    styles.push(new Style({ geometry: areaLabelPoint, text: textStyle(s, kind === 'state' ? entity.name.toUpperCase() : entity.name, { font: font(s, s.labelSize, kind === 'state' ? 'bold ' : '') }) }))
  return styles
}

function citySymbol(city: City, ctx: StyleContext, s: LayerStyle, selected: boolean) {
  const type = ctx.project.catalog.cityTypes.find(t => t.id === city.type)
  const radius = (type?.size ?? 5) * s.symbolScale
  const fill = new Fill({ color: s.fill || '#ffffff' })
  const stroke = new Stroke({ color: selected ? SELECT_COLOR : s.stroke || '#1b2329', width: selected ? 3 : 1.5 })
  if (city.features.capital) return new RegularShape({ points: 5, radius: radius * 1.35, radius2: radius * 0.6, fill: new Fill({ color: s.stroke || '#1b2329' }), stroke: new Stroke({ color: selected ? SELECT_COLOR : s.fill || '#ffffff', width: selected ? 3 : 1.2 }) })
  if (type?.shape === 'square') return new RegularShape({ points: 4, radius: radius * 1.2, angle: Math.PI / 4, fill, stroke })
  if (type?.shape === 'diamond') return new RegularShape({ points: 4, radius: radius * 1.2, fill, stroke })
  return new Circle({ radius, fill, stroke })
}

const markerIcons = new Map<string, string>()
function markerIcon(icon: string, color: string, size: number) {
  const key = `${icon}|${color}|${size}`
  let url = markerIcons.get(key)
  if (!url) {
    const px = Math.round(28 * size)
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = px + 4
    const c = canvas.getContext('2d')!
    c.beginPath()
    c.arc(px / 2 + 2, px / 2 + 2, px / 2, 0, Math.PI * 2)
    c.fillStyle = '#fbf7ee'
    c.fill()
    c.lineWidth = 2
    c.strokeStyle = color
    c.stroke()
    c.font = `${Math.round(px * 0.58)}px "Segoe UI Emoji", "Apple Color Emoji", sans-serif`
    c.textAlign = 'center'
    c.textBaseline = 'middle'
    c.fillText(icon, px / 2 + 2, px / 2 + 3)
    url = canvas.toDataURL()
    markerIcons.set(key, url)
  }
  return url
}

export const regimentTotal = (r: Regiment) => Object.values(r.units).reduce((a, b) => a + (b || 0), 0)
const compact = (n: number) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1).replace('.', ',')}k` : String(n))

export function labelText(label: Label, ctx: StyleContext) {
  const category = ctx.project.catalog.labelCategories.find(c => c.id === label.category)
  const uppercase = label.uppercase ?? category?.uppercase ?? false
  const spacing = label.spacing ?? category?.spacing ?? 0
  let text = uppercase ? label.name.toUpperCase() : label.name
  if (spacing > 0) text = [...text].join(' '.repeat(Math.max(1, Math.round(spacing / 1.5))))
  return text
}

function labelStyle(label: Label, ctx: StyleContext, s: LayerStyle, selected: boolean): Style[] {
  const category = ctx.project.catalog.labelCategories.find(c => c.id === label.category)
  const size = (label.size ?? category?.size ?? 13) * s.symbolScale
  const italic = label.italic ?? category?.italic ?? false
  const color = label.color ?? category?.color ?? s.labelColor
  const text = new Text({
    text: labelText(label, ctx),
    font: `${italic ? 'italic ' : ''}${size}px ${category?.font ?? s.labelFont}`,
    fill: new Fill({ color }),
    stroke: s.haloWidth > 0 ? new Stroke({ color: selected ? SELECT_COLOR : s.halo, width: selected ? s.haloWidth + 2 : s.haloWidth }) : undefined,
    placement: label.geometry.type === 'LineString' ? 'line' : 'point',
    rotation: label.geometry.type === 'Point' ? (label.rotation * Math.PI) / 180 : 0,
    overflow: true,
    maxAngle: Math.PI / 5,
  })
  const styles = [new Style({ text })]
  if (selected && label.geometry.type === 'LineString') styles.push(new Style({ stroke: new Stroke({ color: SELECT_COLOR, width: 1, lineDash: [4, 4] }) }))
  return styles
}

function riverWidth(river: River, s: LayerStyle) {
  return s.strokeWidth * (0.6 + Math.min(2.8, Math.log10(1 + river.upstreamKm / 60)))
}

const cache = new WeakMap<object, { key: string; styles: Style[] }>()

/** the style function for one element layer */
export function entityStyle(kind: EntityKind, getContext: () => StyleContext, styleVersion: () => number) {
  return (feature: FeatureLike, resolution: number): Style[] | undefined => {
    const entity = feature.get('entity') as Entity | undefined
    if (!entity) return undefined
    const ctx = getContext()
    const selected = ctx.selectedId === entity.id
    const layerId = kind === 'state' ? 'states' : kind === 'province' ? 'provinces' : kind === 'culture' ? 'cultures' : kind === 'religion' ? 'religions' : kind === 'zone' ? 'zones' : kind === 'city' ? 'cities' : kind === 'route' ? 'routes' : kind === 'river' ? 'rivers' : kind === 'label' ? 'labels' : kind === 'marker' ? 'markers' : 'regiments'
    const s = ctx.project.style[layerId]
    // world view hides small places and their names
    const bucket = resolution > 0.25 ? 0 : resolution > 0.06 ? 1 : 2
    const key = `${selected}|${bucket}|${styleVersion()}|${ctx.diplomacyColors?.get(entity.id) ?? ''}`
    const hit = cache.get(entity)
    // the selected route shows the routes it is docked onto, which change without it
    if (hit && hit.key === key && !(selected && kind === 'route')) return hit.styles
    let styles: Style[] = []
    switch (kind) {
      case 'state':
      case 'province':
      case 'culture':
      case 'religion':
      case 'zone':
        styles = areaStyles(kind, entity as Entity & { color: string }, s, ctx, selected)
        break
      case 'city': {
        const city = entity as City
        const type = ctx.project.catalog.cityTypes.find(t => t.id === city.type)
        const size = type?.size ?? 5
        if (!selected && !city.features.capital && ((bucket === 0 && size < 6) || (bucket === 1 && size < 4))) break
        const showName = s.showLabels && (selected || city.features.capital || bucket === 2 || (bucket === 1 && size >= 4) || size >= 6.5)
        styles = [
          new Style({
            image: citySymbol(city, ctx, s, selected),
            text: showName ? textStyle(s, city.name, { textAlign: 'left', offsetX: size * s.symbolScale + 5, font: font(s, s.labelSize + (size >= 6.5 || city.features.capital ? 2 : 0), size >= 6.5 || city.features.capital ? 'bold ' : '') }) : undefined,
            zIndex: size + (city.features.capital ? 10 : 0),
          }),
        ]
        break
      }
      case 'marker': {
        const marker = entity as Marker
        const type = ctx.project.catalog.markerTypes.find(t => t.id === marker.type)
        if (ctx.project.display.hiddenMarkerTypes?.includes(marker.type) && !selected) break
        const scale = marker.size * s.symbolScale
        styles = [
          new Style({
            image: new Icon({ src: markerIcon(type?.icon ?? '📍', selected ? SELECT_COLOR : (type?.color ?? '#b0302c'), 1), scale: scale * (bucket === 0 ? 0.7 : 1) }),
            text: s.showLabels && bucket > 0 ? textStyle(s, marker.name, { offsetY: 20 * scale }) : undefined,
          }),
        ]
        break
      }
      case 'route': {
        const route = entity as Route
        const type = ctx.project.catalog.routeTypes.find(t => t.id === route.type)
        styles = [new Style({ stroke: new Stroke({ color: type?.color ?? '#8b5a2b', width: (type?.width ?? 1.5) * s.symbolScale, lineDash: dashOf(type?.dash ?? ''), lineCap: 'round' }) })]
        if (selected) {
          styles.unshift(new Style({ stroke: new Stroke({ color: SELECT_COLOR, width: (type?.width ?? 1.5) + 5 }) }))
          // the shared stretches on other routes (branch, join): the whole way, faint
          const whole = fullPath(ctx.project.routes, route.id)
          if (whole.before.length || whole.after.length) {
            styles.unshift(new Style({ geometry: new LineStringGeom(whole.path), stroke: new Stroke({ color: rgba(SELECT_COLOR, 0.45), width: (type?.width ?? 1.5) + 5, lineDash: [8, 6] }) }))
          }
          // the points that can be dragged; a dense freehand line only shows its ends
          const dense = route.geometry.coordinates.length > 150
          styles.push(
            new Style({
              image: new Circle({ radius: 3.5, fill: new Fill({ color: '#ffffff' }), stroke: new Stroke({ color: '#7a5200', width: 1.5 }) }),
              geometry: f => {
                const coords = (f.getGeometry() as LineString).getCoordinates()
                return new MultiPoint(dense ? [coords[0], coords[coords.length - 1]] : coords)
              },
            }),
          )
        }
        if (s.showLabels && route.name) styles.push(new Style({ text: textStyle(s, route.name, { placement: 'line' }) }))
        break
      }
      case 'river': {
        const river = entity as River
        const width = riverWidth(river, s)
        if (bucket === 0 && width < s.strokeWidth * 1.1 && !selected) break
        styles = [new Style({ stroke: new Stroke({ color: s.stroke || '#3f7fbf', width, lineCap: 'round', lineJoin: 'round' }) })]
        if (selected) styles.unshift(new Style({ stroke: new Stroke({ color: SELECT_COLOR, width: width + 4 }) }))
        if (s.showLabels && river.name && bucket > 0) styles.push(new Style({ text: textStyle(s, river.name, { placement: 'line', font: `italic ${s.labelSize}px ${s.labelFont}` }) }))
        break
      }
      case 'label':
        styles = labelStyle(entity as Label, ctx, s, selected)
        break
      case 'regiment': {
        const regiment = entity as Regiment
        const state = ctx.project.states.find(st => st.id === regiment.stateId)
        const color = state?.color ?? '#777777'
        const scale = s.symbolScale
        styles = [
          new Style({
            image: new RegularShape({
              points: 4,
              radius: 15 * scale,
              angle: regiment.naval ? 0 : Math.PI / 4,
              scale: regiment.naval ? [1, 1] : [1.5, 0.75],
              fill: new Fill({ color }),
              stroke: new Stroke({ color: selected ? SELECT_COLOR : '#1b2329', width: selected ? 3 : 1.4 }),
            }),
            text: new Text({ text: compact(regimentTotal(regiment)), font: `bold ${10 * scale}px "Segoe UI", sans-serif`, fill: new Fill({ color: '#ffffff' }), stroke: new Stroke({ color: '#1b2329', width: 2 }) }),
          }),
        ]
        if (s.showLabels && bucket === 2) styles.push(new Style({ text: textStyle(s, regiment.name, { offsetY: 20 * scale }) }))
        break
      }
    }
    cache.set(entity, { key, styles })
    return styles
  }
}

