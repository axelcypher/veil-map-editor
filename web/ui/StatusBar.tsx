// Coordinates, height and climate under the cursor; the point info panel lists everything there.
import { signal } from '@preact/signals'
import { useEffect, useState } from 'preact/hooks'
import { membershipAt } from '../model/derive'
import { formatLonLat } from '../model/geo'
import { busy, dirty, filePath, project } from '../model/store'
import { gridHeight, koppenAt } from '../model/terrain'
import type { LonLat } from '../model/types'
import { platform } from '../platform'

export const hover = signal<LonLat | null>(null)
export const pointInfoOpen = signal(false)

function useExactHeight(at: LonLat | null) {
  const [height, setHeight] = useState<number | null>(null)
  useEffect(() => {
    if (!at) return
    setHeight(gridHeight(at))
    const timer = setTimeout(() => {
      platform.heights([at]).then(([h]) => h != null && setHeight(h))
    }, 40)
    return () => clearTimeout(timer)
  }, [at?.[0], at?.[1]])
  return at ? height : null
}

export function PointInfo() {
  const at = hover.value
  const p = project.value
  const height = useExactHeight(at)
  if (!pointInfoOpen.value) return null
  if (!at) return <div class="point-info muted">Maus über die Karte bewegen.</div>
  const m = membershipAt(p, at)
  const code = koppenAt(at)
  const klass = p.koppenClasses.find(c => c.code === code)
  const name = (list: { id: string; name: string }[], id: string) => list.find(x => x.id === id)?.name ?? '—'
  let nearest: { name: string; km: number } | null = null
  for (const city of p.cities) {
    const [lon, lat] = city.geometry.coordinates
    const dLat = ((lat - at[1]) * Math.PI) / 180
    const dLon = ((lon - at[0]) * Math.PI) / 180
    const h = Math.sin(dLat / 2) ** 2 + Math.cos((at[1] * Math.PI) / 180) * Math.cos((lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2
    const km = (2 * p.planetRadius * Math.asin(Math.sqrt(h))) / 1000
    if (!nearest || km < nearest.km) nearest = { name: city.name, km }
  }
  return (
    <div class="point-info">
      <dl>
        <dt>Position</dt>
        <dd>{formatLonLat(at)}</dd>
        <dt>Höhe</dt>
        <dd>{height == null ? '—' : `${Math.round(height).toLocaleString('de-DE')} m${height <= 0 ? ' (Meer)' : ''}`}</dd>
        <dt>Klima</dt>
        <dd>{klass ? `${klass.code} · ${klass.name}` : '—'}</dd>
        <dt>Staat</dt>
        <dd>{name(p.states, m.state)}</dd>
        <dt>Provinz</dt>
        <dd>{name(p.provinces, m.province)}</dd>
        <dt>Kultur</dt>
        <dd>{name(p.cultures, m.culture)}</dd>
        <dt>Religion</dt>
        <dd>{name(p.religions, m.religion)}</dd>
        <dt>Zonen</dt>
        <dd>{m.zones.length ? m.zones.map(id => name(p.zones, id)).join(', ') : '—'}</dd>
        <dt>Nächste Stadt</dt>
        <dd>{nearest ? `${nearest.name} (${Math.round(nearest.km).toLocaleString('de-DE')} km)` : '—'}</dd>
      </dl>
    </div>
  )
}

export function StatusBar() {
  const at = hover.value
  const p = project.value
  const height = useExactHeight(at)
  const b = busy.value
  const code = at ? koppenAt(at) : null
  return (
    <footer class="status-bar">
      {b ? (
        <span class="busy">
          <span class="spinner" /> {b.stage} {b.fraction > 0 && b.fraction < 1 ? `${Math.round(b.fraction * 100)} %` : ''}
        </span>
      ) : (
        <span>
          {p.display.coordinates.show && at ? formatLonLat(at) : ''}
          {at && height != null ? ` · ${Math.round(height).toLocaleString('de-DE')} m` : ''}
          {code ? ` · ${code}` : ''}
        </span>
      )}
      <span class="spacer" />
      <button class={`small${pointInfoOpen.value ? ' active' : ''}`} onClick={() => (pointInfoOpen.value = !pointInfoOpen.value)} title="Punktinfo: alles unter dem Mauszeiger">
        ⓘ Punktinfo
      </button>
      <span class="file" title={filePath.value ?? ''}>
        {filePath.value ? filePath.value.split(/[\\/]/).pop() : 'nicht gespeichert'}
        {dirty.value ? ' •' : ''}
      </span>
      <span class="version" title={`Build ${__BUILD_TIME__}`}>
        v{__APP_VERSION__} · {new Date(__BUILD_TIME__).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}
      </span>
    </footer>
  )
}
