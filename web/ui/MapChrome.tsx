// Things drawn over the map: compass rose, scale bar, the options of the active tool.
import { signal } from '@preact/signals'
import { formatKm } from '../model/geo'
import { KIND_NAMES } from '../model/project'
import { deleteVertices, freehand, freehandSmoothing, placeType, project, tool, type MeasureMode } from '../model/store'
import { mapView } from './mapRef'

export const viewInfo = signal<{ resolution: number; centerLat: number; rotation: number }>({ resolution: 1, centerLat: 0, rotation: 0 })
export const measurement = signal<{ mode: MeasureMode; text: string; value: number } | null>(null)

export function Compass() {
  const d = project.value.display.compass
  if (!d.show) return null
  const s = d.size
  const points = (r1: number, r2: number, n: number, offset = 0) =>
    Array.from({ length: n * 2 }, (_, i) => {
      const angle = (i * Math.PI) / n + offset - Math.PI / 2
      const r = i % 2 ? r2 : r1
      return `${50 + Math.cos(angle) * r},${50 + Math.sin(angle) * r}`
    }).join(' ')
  return (
    <svg class={`compass pos-${d.position}`} width={s} height={s} viewBox="0 0 100 100" aria-label="Kompassrose">
      <circle cx="50" cy="50" r="44" fill="none" stroke="#3b2f2f" stroke-width="0.8" />
      <circle cx="50" cy="50" r="40" fill="none" stroke="#3b2f2f" stroke-width="0.4" />
      <polygon points={points(34, 7, 4, Math.PI / 4)} fill="#8a7a62" stroke="#3b2f2f" stroke-width="0.5" />
      <polygon points={points(42, 8, 4)} fill="#efe6cf" stroke="#3b2f2f" stroke-width="0.7" />
      <polygon points="50,8 54,50 46,50" fill="#3b2f2f" />
      <polygon points="50,92 54,50 46,50" fill="#3b2f2f" opacity="0.35" />
      <circle cx="50" cy="50" r="3" fill="#3b2f2f" />
      <text x="50" y="7" text-anchor="middle" font-size="9" font-family="Georgia, serif" font-weight="bold" fill="#3b2f2f">
        N
      </text>
    </svg>
  )
}

const NICE = [1, 2, 5]
export function ScaleBar() {
  const p = project.value
  if (!p.display.scaleBar.show) return null
  const { resolution, centerLat } = viewInfo.value
  // plate carrée: east-west scale shrinks with the cosine of the latitude
  const metresPerPixel = resolution * (Math.PI / 180) * p.planetRadius * Math.max(0.02, Math.cos((centerLat * Math.PI) / 180))
  const target = metresPerPixel * 140
  const magnitude = 10 ** Math.floor(Math.log10(target))
  const step = NICE.map(n => n * magnitude).filter(n => n <= target).pop() ?? magnitude
  const width = step / metresPerPixel
  return (
    <div class="scale-bar" title={`Maßstab bei ${Math.round(centerLat)}° Breite (Ost-West)`}>
      <div class="scale-ticks" style={{ width: `${width}px` }}>
        <span />
        <span />
      </div>
      <div class="scale-label">{formatKm(step)}</div>
    </div>
  )
}

const HINTS: Record<string, string> = {
  select: '',
  place: 'Auf die Karte klicken, um zu setzen.',
  'draw-line': 'Klicks setzen Punkte, Doppelklick beendet. Umschalt gedrückt halten: freihand.',
  'area-new': 'Umriss zeichnen: Klicks setzen Punkte, Doppelklick schließt. Umschalt: freihand. Über das Meer hinaus zeichnen ist in Ordnung – zugeschnitten wird an der Küste.',
  'area-add': 'Fläche zeichnen, die dazukommt. Umschalt: freihand.',
  'area-subtract': 'Fläche zeichnen, die wegfällt. Umschalt: freihand.',
  'area-island': 'Auf eine Insel klicken, um sie ganz hinzuzufügen.',
  vertices: 'Stützpunkte ziehen; auf die Linie ziehen fügt einen ein, Alt+Klick (oder „Löschen“ an) entfernt einen.',
  pick: 'Auf die Karte klicken, um den Punkt zu wählen.',
}
const MEASURE_HINTS: Record<MeasureMode, string> = {
  ruler: 'Lineal: Start- und Endpunkt klicken. Gemessen wird auf dem Großkreis.',
  path: 'Opisometer: Weg abklicken, Doppelklick beendet. Umschalt: freihand nachfahren.',
  area: 'Planimeter: Fläche umfahren, Doppelklick schließt.',
}

export function ToolOptions() {
  const t = tool.value
  const p = project.value
  if (t.id === 'select') return null
  const hint = t.id === 'measure' ? MEASURE_HINTS[t.mode] : HINTS[t.id]
  const typeSelect = (key: string, options: { id: string; name: string }[]) => (
    <select value={placeType.value[key]} onChange={e => (placeType.value = { ...placeType.value, [key]: (e.target as HTMLSelectElement).value })}>
      {options.map(o => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </select>
  )
  let title = ''
  if (t.id === 'place') title = `${KIND_NAMES[t.kind][0]} setzen`
  if (t.id === 'draw-line') title = t.kind === 'route' ? 'Route zeichnen' : 'Beschriftung entlang einer Linie'
  if (t.id === 'area-new') title = `${KIND_NAMES[t.kind][0]} zeichnen`
  if (t.id === 'area-add' || t.id === 'area-subtract' || t.id === 'area-island') title = `${KIND_NAMES[t.kind][0]} bearbeiten`
  if (t.id === 'measure') title = t.mode === 'ruler' ? 'Lineal' : t.mode === 'path' ? 'Opisometer' : 'Planimeter'
  if (t.id === 'vertices') title = 'Stützpunkte'
  if (t.id === 'pick') title = 'Punkt wählen'
  const m = measurement.value
  const drawing = t.id === 'draw-line' || t.id === 'area-new' || t.id === 'area-add' || t.id === 'area-subtract' || (t.id === 'measure' && t.mode !== 'ruler')
  const act = (action: 'finish' | 'undo' | 'abort') => mapView.current?.drawAction(action)
  return (
    <div class="tool-options">
      <strong>{title}</strong>
      {t.id === 'place' && t.kind === 'city' && typeSelect('city', p.catalog.cityTypes)}
      {t.id === 'place' && t.kind === 'marker' && typeSelect('marker', p.catalog.markerTypes.map(x => ({ id: x.id, name: `${x.icon} ${x.name}` })))}
      {t.id === 'draw-line' && t.kind === 'route' && typeSelect('route', p.catalog.routeTypes)}
      {t.id === 'measure' && m && m.mode === t.mode && <span class="measure-result">{m.text}</span>}
      {(t.id === 'draw-line' || t.id === 'area-new' || t.id === 'area-add' || t.id === 'area-subtract') && (
        <label class="smoothing" title="Glättet Freihandstriche (Umschalt gedrückt) nach dem Loslassen; geklickte Ecken bleiben scharf">
          Glättung
          <input type="range" min={0} max={10} step={0.5} value={freehandSmoothing.value} onInput={e => (freehandSmoothing.value = Number((e.target as HTMLInputElement).value))} />
          <output>{freehandSmoothing.value === 0 ? 'aus' : freehandSmoothing.value}</output>
        </label>
      )}
      {drawing && (
        <span class="touch-buttons">
          <button class={`small${freehand.value ? ' active' : ''}`} title="Freihand zeichnen, ohne Umschalt zu halten (Touch)" onClick={() => (freehand.value = !freehand.value)}>
            ✎ Freihand
          </button>
          <button class="small" title="Letzten Punkt zurücknehmen" onClick={() => act('undo')}>
            ↶ Punkt
          </button>
          <button class="small" title="Linie bzw. Fläche abschließen (statt Doppelklick)" onClick={() => act('finish')}>
            ✓ Übernehmen
          </button>
          <button class="small" title="Zeichnung verwerfen" onClick={() => act('abort')}>
            ✕
          </button>
        </span>
      )}
      {t.id === 'vertices' && (
        <button class={`small${deleteVertices.value ? ' active' : ''}`} title="Tippen auf einen Stützpunkt löscht ihn (statt Alt+Klick)" onClick={() => (deleteVertices.value = !deleteVertices.value)}>
          🗑 Löschen
        </button>
      )}
      <span class="hint">{hint}</span>
      <button class="small" onClick={() => (tool.value = { id: 'select' })}>
        Fertig (Esc)
      </button>
    </div>
  )
}
