// Markers: cities and points of interest with a symbol, a size and a label.
import type { LabelSide, Marker, MarkerKind, Position } from '../model'

export const MARKER_KINDS: { id: MarkerKind; label: string; size: number }[] = [
  { id: 'capital', label: 'Hauptstadt', size: 5 },
  { id: 'city', label: 'Stadt', size: 4 },
  { id: 'town', label: 'Kleinstadt', size: 3 },
  { id: 'village', label: 'Dorf', size: 2 },
  { id: 'fort', label: 'Festung', size: 3 },
  { id: 'temple', label: 'Tempel', size: 3 },
  { id: 'port', label: 'Hafen', size: 3 },
  { id: 'mine', label: 'Mine', size: 2 },
  { id: 'ruin', label: 'Ruine', size: 2 },
  { id: 'dungeon', label: 'Dungeon', size: 3 },
  { id: 'landmark', label: 'Wahrzeichen', size: 3 },
  { id: 'poi', label: 'Ort', size: 2 },
]

export const kindLabel = (kind: MarkerKind) => MARKER_KINDS.find(item => item.id === kind)?.label ?? kind

/** symbol radius in screen pixels */
export const markerRadius = (marker: Marker) => 4 + marker.size * 2.2

function star(ctx: CanvasRenderingContext2D, x: number, y: number, outer: number) {
  ctx.beginPath()
  for (let point = 0; point < 10; point += 1) {
    const radius = point % 2 ? outer * 0.45 : outer
    const angle = -Math.PI / 2 + point * Math.PI / 5
    ctx.lineTo(x + Math.cos(angle) * radius, y + Math.sin(angle) * radius)
  }
  ctx.closePath()
}

/** the symbol at a screen position; the stroke is dark, the fill is the marker's colour */
export function drawMarkerSymbol(ctx: CanvasRenderingContext2D, marker: Marker, x: number, y: number, selected: boolean) {
  const r = markerRadius(marker)
  ctx.lineWidth = 1.6
  ctx.strokeStyle = '#1b2329'
  ctx.fillStyle = marker.color
  ctx.setLineDash([])
  if (selected) {
    ctx.save()
    ctx.strokeStyle = '#f2cb78'
    ctx.lineWidth = 2.5
    ctx.beginPath()
    ctx.arc(x, y, r + 5, 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
  }
  ctx.beginPath()
  switch (marker.kind) {
    case 'capital':
      star(ctx, x, y, r * 1.25)
      break
    case 'city':
      ctx.arc(x, y, r, 0, Math.PI * 2)
      break
    case 'town':
      ctx.arc(x, y, r * 0.85, 0, Math.PI * 2)
      break
    case 'village':
      ctx.arc(x, y, r * 0.65, 0, Math.PI * 2)
      break
    case 'fort':
      ctx.rect(x - r * 0.8, y - r * 0.8, r * 1.6, r * 1.6)
      break
    case 'temple':
      ctx.moveTo(x, y - r)
      ctx.lineTo(x + r, y + r * 0.8)
      ctx.lineTo(x - r, y + r * 0.8)
      ctx.closePath()
      break
    case 'port':
      ctx.moveTo(x, y - r)
      ctx.lineTo(x + r, y)
      ctx.lineTo(x, y + r)
      ctx.lineTo(x - r, y)
      ctx.closePath()
      break
    case 'mine':
      ctx.moveTo(x - r, y - r)
      ctx.lineTo(x + r, y + r)
      ctx.moveTo(x + r, y - r)
      ctx.lineTo(x - r, y + r)
      ctx.stroke()
      return
    case 'ruin':
      ctx.moveTo(x - r, y + r * 0.8)
      ctx.lineTo(x - r, y - r * 0.5)
      ctx.lineTo(x - r * 0.3, y - r * 0.9)
      ctx.lineTo(x + r * 0.3, y - r * 0.2)
      ctx.lineTo(x + r, y - r * 0.6)
      ctx.lineTo(x + r, y + r * 0.8)
      ctx.closePath()
      break
    case 'dungeon':
      ctx.arc(x, y, r, Math.PI, 0)
      ctx.lineTo(x + r, y + r)
      ctx.lineTo(x - r, y + r)
      ctx.closePath()
      break
    case 'landmark':
      ctx.moveTo(x - r * 1.1, y + r * 0.8)
      ctx.lineTo(x - r * 0.2, y - r)
      ctx.lineTo(x + r * 0.35, y - r * 0.1)
      ctx.lineTo(x + r * 0.7, y - r * 0.55)
      ctx.lineTo(x + r * 1.1, y + r * 0.8)
      ctx.closePath()
      break
    default:
      ctx.arc(x, y - r * 0.35, r * 0.7, Math.PI * 0.8, Math.PI * 0.2)
      ctx.lineTo(x, y + r)
      ctx.closePath()
  }
  ctx.fill()
  ctx.stroke()
  if (marker.kind === 'city' || marker.kind === 'capital') {
    ctx.beginPath()
    ctx.arc(x, y, r * 0.3, 0, Math.PI * 2)
    ctx.fillStyle = '#1b2329'
    ctx.fill()
  }
}

export const labelFont = (marker: Marker) => `${marker.size >= 4 ? 'bold ' : ''}${10 + marker.size * 1.6}px "Segoe UI", sans-serif`

/** the name beside the symbol, with a light halo so it reads on any colour */
export function drawMarkerLabel(ctx: CanvasRenderingContext2D, marker: Marker, x: number, y: number) {
  if (!marker.showLabel || !marker.name) return
  const r = markerRadius(marker)
  ctx.font = labelFont(marker)
  ctx.textBaseline = 'middle'
  const sides: Record<LabelSide, [number, number, CanvasTextAlign]> = {
    right: [x + r + 5, y, 'left'],
    left: [x - r - 5, y, 'right'],
    top: [x, y - r - 9, 'center'],
    bottom: [x, y + r + 10, 'center'],
  }
  const [tx, ty, align] = sides[marker.labelSide]
  ctx.textAlign = align
  ctx.lineJoin = 'round'
  ctx.lineWidth = 3.5
  ctx.strokeStyle = 'rgb(250 246 236 / 88%)'
  ctx.strokeText(marker.name, tx, ty)
  ctx.fillStyle = '#1b2329'
  ctx.fillText(marker.name, tx, ty)
}

/** the marker under a screen position, the nearest one within its symbol and a little slack */
export function hitMarker(markers: Marker[], screen: Position, toScreen: (marker: Marker) => Position): Marker | undefined {
  let found: Marker | undefined
  let best = Infinity
  for (const marker of markers) {
    const [x, y] = toScreen(marker)
    const distance = Math.hypot(x - screen[0], y - screen[1])
    if (distance <= markerRadius(marker) + 5 && distance < best) {
      found = marker
      best = distance
    }
  }
  return found
}
