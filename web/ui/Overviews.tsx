// Lists of everything on the map, plus charts and conflicts. Provinces, military and diplomacy
// belong to a state and open from its inspector (StateDialogs).
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { conflicts, findConflicts } from '../model/actions'
import { cityMembership, cultureStats, militaryTotals, provinceStats, religionStats, stateStats } from '../model/derive'
import { formatInt, lineLengthM } from '../model/geo'
import { KIND_NAMES } from '../model/project'
import { fullPath } from '../model/routing'
import { list, patchProject, project, selection, tool } from '../model/store'
import { AREA_KINDS, type AreaKind, type EntityKind, type Project } from '../model/types'
import { mapView } from './mapRef'
import { Section, Swatch, Table, Tabs, type Column } from './components'

export type OverviewId = 'states' | 'cultures' | 'religions' | 'zones' | 'cities' | 'routes' | 'rivers' | 'markers' | 'labels' | 'charts' | 'conflicts'

const pick = (kind: EntityKind, id: string) => {
  selection.value = { kind, id }
  mapView.current?.focus(kind, id)
}

const nameIn = (items: { id: string; name: string }[], id: string | undefined) => items.find(x => x.id === id)?.name ?? ''

function AddArea({ kind }: { kind: AreaKind }) {
  return (
    <button class="primary" onClick={() => (tool.value = { id: 'area-new', kind })} title="Umriss auf der Karte zeichnen (Umschalt = freihand)">
      ＋ {KIND_NAMES[kind][0]} zeichnen
    </button>
  )
}

function AreaList({ kind }: { kind: AreaKind }) {
  const p = project.value
  const stats = kind === 'state' ? stateStats.value : kind === 'province' ? provinceStats.value : kind === 'culture' ? cultureStats.value : kind === 'religion' ? religionStats.value : null
  const rows = list(kind) as unknown as ({ id: string; name: string; color: string } & Record<string, unknown>)[]
  const columns: Column<(typeof rows)[number]>[] = [
    { id: 'name', name: 'Name', value: r => r.name, render: r => <><Swatch color={r.color} /> {r.name}</> },
  ]
  if (kind === 'province') columns.push({ id: 'state', name: 'Staat', value: r => nameIn(p.states, r.stateId as string) })
  if (kind === 'state') columns.push({ id: 'form', name: 'Form', value: r => nameIn(p.catalog.stateForms, r.form as string) })
  if (kind === 'culture') columns.push({ id: 'type', name: 'Typ', value: r => nameIn(p.catalog.cultureTypes, r.type as string) })
  if (kind === 'religion') columns.push({ id: 'type', name: 'Typ', value: r => nameIn(p.catalog.religionTypes, r.type as string) })
  if (kind === 'zone') columns.push({ id: 'type', name: 'Typ', value: r => nameIn(p.catalog.zoneTypes, r.type as string) })
  if (stats) {
    columns.push(
      { id: 'area', name: 'km²', numeric: true, value: r => Math.round(stats.get(r.id)?.areaKm2 ?? 0), render: r => formatInt(stats.get(r.id)?.areaKm2 ?? 0) },
      { id: 'cities', name: 'Städte', numeric: true, value: r => stats.get(r.id)?.cities.length ?? 0 },
      { id: 'pop', name: 'Einwohner', numeric: true, value: r => Math.round((stats.get(r.id)?.urban ?? 0) + (stats.get(r.id)?.rural ?? 0)), render: r => formatInt((stats.get(r.id)?.urban ?? 0) + (stats.get(r.id)?.rural ?? 0)) },
    )
  }
  return (
    <>
      <div class="list-actions">
        <AddArea kind={kind} />
      </div>
      <Table rows={rows} columns={columns} selectedId={selection.value?.id} onRow={r => pick(kind, r.id)} groupBy={kind === 'province' ? [columns[1]] : undefined} />
      {kind === 'state' && (
        <p class="hint">
          Bevölkerung = Städte + Landfläche × Landbevölkerung je km². Fläche nach dem Zuschnitt an der Küste.
        </p>
      )}
    </>
  )
}

function CityList() {
  const p = project.value
  const m = cityMembership.value
  const columns: Column<Project['cities'][number]>[] = [
    { id: 'name', name: 'Name', value: c => c.name, render: c => <>{c.features.capital ? '★ ' : ''}{c.name}</> },
    { id: 'type', name: 'Typ', value: c => nameIn(p.catalog.cityTypes, c.type) },
    { id: 'pop', name: 'Einwohner', numeric: true, value: c => c.population, render: c => formatInt(c.population) },
    { id: 'state', name: 'Staat', value: c => nameIn(p.states, m.get(c.id)?.state) },
    { id: 'province', name: 'Provinz', value: c => nameIn(p.provinces, m.get(c.id)?.province) },
    { id: 'culture', name: 'Kultur', value: c => nameIn(p.cultures, m.get(c.id)?.culture) },
    { id: 'group', name: 'Gruppe', value: c => c.group },
    { id: 'features', name: 'Merkmale', value: c => [c.features.port && 'Hafen', c.features.citadel && 'Zitadelle', c.features.walls && 'Mauer', c.features.temple && 'Tempel'].filter(Boolean).join(', ') },
  ]
  const total = p.cities.reduce((s, c) => s + c.population, 0)
  return (
    <>
      <div class="list-actions">
        <button class="primary" onClick={() => (tool.value = { id: 'place', kind: 'city' })}>
          ＋ Stadt setzen
        </button>
        <span class="muted">{formatInt(total)} Einwohner in Städten</span>
      </div>
      <Table rows={p.cities} columns={columns} selectedId={selection.value?.id} onRow={c => pick('city', c.id)} groupBy={[columns[1], columns[3], columns[4], columns[5], columns[6]]} initialSort={{ id: 'pop', desc: true }} />
    </>
  )
}

function RouteList() {
  const p = project.value
  const columns: Column<Project['routes'][number]>[] = [
    { id: 'name', name: 'Name', value: r => r.name },
    { id: 'type', name: 'Typ', value: r => nameIn(p.catalog.routeTypes, r.type) },
    // the whole way: a branch counts the shared stretch on its main route
    { id: 'len', name: 'Länge km', numeric: true, value: r => Math.round(lineLengthM(fullPath(p.routes, r.id).path, p.planetRadius) / 1000), render: r => formatInt(lineLengthM(fullPath(p.routes, r.id).path, p.planetRadius) / 1000) },
    { id: 'junction', name: 'Abzweig von', value: r => nameIn(p.routes, r.junctions?.start) },
  ]
  return (
    <>
      <div class="list-actions">
        <button class="primary" onClick={() => (tool.value = { id: 'draw-line', kind: 'route' })}>
          ＋ Route zeichnen
        </button>
      </div>
      <Table rows={p.routes} columns={columns} selectedId={selection.value?.id} onRow={r => pick('route', r.id)} groupBy={[columns[1]]} />
    </>
  )
}

function RiverList() {
  const p = project.value
  const columns: Column<Project['rivers'][number]>[] = [
    { id: 'name', name: 'Name', value: r => r.name || '—' },
    { id: 'type', name: 'Art', value: r => r.type },
    { id: 'len', name: 'Länge km', numeric: true, value: r => r.lengthKm, render: r => formatInt(r.lengthKm) },
    { id: 'up', name: 'Netz km', numeric: true, value: r => r.upstreamKm, render: r => formatInt(r.upstreamKm) },
    { id: 'parent', name: 'Mündet in', value: r => (r.parentId ? p.rivers.find(x => x.id === r.parentId)?.name || '(Fluss)' : 'Meer') },
  ]
  return (
    <>
      <p class="hint">Flüsse kommen aus der Gaea-Flussmaske (Projekt → Import). Hier werden sie benannt und beschrieben.</p>
      <Table rows={p.rivers} columns={columns} selectedId={selection.value?.id} onRow={r => pick('river', r.id)} groupBy={[columns[1], columns[4]]} initialSort={{ id: 'up', desc: true }} />
    </>
  )
}

function MarkerList() {
  const p = project.value
  const hidden = p.display.hiddenMarkerTypes
  const toggle = (id: string) => patchProject({ display: { ...p.display, hiddenMarkerTypes: hidden.includes(id) ? hidden.filter(h => h !== id) : [...hidden, id] } })
  const counts = new Map<string, number>()
  for (const m of p.markers) counts.set(m.type, (counts.get(m.type) ?? 0) + 1)
  const columns: Column<Project['markers'][number]>[] = [
    { id: 'name', name: 'Name', value: m => m.name, render: m => <>{p.catalog.markerTypes.find(t => t.id === m.type)?.icon} {m.name}</> },
    { id: 'type', name: 'Typ', value: m => nameIn(p.catalog.markerTypes, m.type) },
  ]
  return (
    <>
      <div class="list-actions">
        <button class="primary" onClick={() => (tool.value = { id: 'place', kind: 'marker' })}>
          ＋ Marker setzen
        </button>
      </div>
      <Section title="Typen und Sichtbarkeit">
        <div class="type-grid">
          {p.catalog.markerTypes.map(t => (
            <label key={t.id} class={`type-toggle${hidden.includes(t.id) ? ' off' : ''}`}>
              <input type="checkbox" checked={!hidden.includes(t.id)} onChange={() => toggle(t.id)} />
              <span>{t.icon}</span> {t.name} <span class="muted">{counts.get(t.id) ?? 0}</span>
            </label>
          ))}
        </div>
      </Section>
      <Table rows={p.markers} columns={columns} selectedId={selection.value?.id} onRow={m => pick('marker', m.id)} groupBy={[columns[1]]} />
    </>
  )
}

function LabelList() {
  const p = project.value
  const columns: Column<Project['labels'][number]>[] = [
    { id: 'name', name: 'Text', value: l => l.name },
    { id: 'cat', name: 'Kategorie', value: l => nameIn(p.catalog.labelCategories, l.category) },
    { id: 'form', name: 'Form', value: l => (l.geometry.type === 'LineString' ? 'entlang Linie' : 'Punkt') },
  ]
  return (
    <>
      <div class="list-actions">
        <button class="primary" onClick={() => (tool.value = { id: 'place', kind: 'label' })}>
          ＋ Beschriftung
        </button>
        <button onClick={() => (tool.value = { id: 'draw-line', kind: 'label' })}>＋ entlang einer Linie</button>
      </div>
      <Table rows={p.labels} columns={columns} selectedId={selection.value?.id} onRow={l => pick('label', l.id)} groupBy={[columns[1]]} />
    </>
  )
}

// ---------------------------------------------------------------------------------------------
// charts: one measure per chart, bars sorted, each bar in the element's map colour

type Metric = 'pop' | 'area' | 'cities' | 'urban' | 'military' | 'density'
const METRICS: { id: Metric; name: string; unit: string }[] = [
  { id: 'pop', name: 'Einwohner', unit: '' },
  { id: 'area', name: 'Landfläche', unit: ' km²' },
  { id: 'cities', name: 'Städte', unit: '' },
  { id: 'urban', name: 'Stadtbevölkerung', unit: '' },
  { id: 'density', name: 'Einwohner je km²', unit: '' },
  { id: 'military', name: 'Truppenstärke', unit: '' },
]

function BarChart({ rows, unit, title }: { rows: { id: string; name: string; color: string; value: number; kind: EntityKind }[]; unit: string; title: string }) {
  const [hover, setHover] = useState<string | null>(null)
  // drawn at the real panel width, so text stays at its intended size
  const box = useRef<HTMLElement>(null)
  const [measured, setMeasured] = useState(420)
  useEffect(() => {
    if (!box.current) return
    const observer = new ResizeObserver(([entry]) => setMeasured(Math.max(280, Math.round(entry.contentRect.width))))
    observer.observe(box.current)
    return () => observer.disconnect()
  }, [])
  const sorted = [...rows].sort((a, b) => b.value - a.value).slice(0, 24)
  const max = Math.max(1, ...sorted.map(r => r.value))
  const total = rows.reduce((s, r) => s + r.value, 0)
  const bar = 18
  const gap = 6
  const width = measured
  const labelWidth = Math.min(150, Math.round(width * 0.3))
  const plot = width - labelWidth - 110
  const height = sorted.length * (bar + gap) + 8
  if (!sorted.length) return <p class="empty" ref={box as never}>Keine Daten.</p>
  const fmt = (v: number) => (Number.isInteger(v) || v > 100 ? formatInt(v) : v.toFixed(1).replace('.', ','))
  return (
    <figure class="chart" ref={box}>
      <figcaption>
        {title} <span class="muted">· Summe {fmt(total)}{unit}</span>
      </figcaption>
      <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label={title}>
        {sorted.map((r, i) => {
          const y = i * (bar + gap) + 4
          const w = Math.max(r.value > 0 ? 3 : 0, (r.value / max) * plot)
          const share = total ? (r.value / total) * 100 : 0
          return (
            <g key={r.id} class={`bar${hover === r.id ? ' hover' : ''}`} onMouseEnter={() => setHover(r.id)} onMouseLeave={() => setHover(null)} onClick={() => pick(r.kind, r.id)}>
              <rect class="hit" x={0} y={y - gap / 2} width={width} height={bar + gap} />
              <text class="bar-label" x={labelWidth - 8} y={y + bar / 2} text-anchor="end" dominant-baseline="middle">
                {r.name.length > 18 ? `${r.name.slice(0, 17)}…` : r.name}
              </text>
              <path d={`M${labelWidth},${y} h${Math.max(0, w - 4)} a4,4 0 0 1 4,4 v${bar - 8} a4,4 0 0 1 -4,4 h${-Math.max(0, w - 4)} z`} fill={r.color} />
              <text class="bar-value" x={labelWidth + w + 6} y={y + bar / 2} dominant-baseline="middle">
                {fmt(r.value)}
                {unit}
                {hover === r.id && ` · ${share.toFixed(1).replace('.', ',')} %`}
              </text>
            </g>
          )
        })}
      </svg>
    </figure>
  )
}

function Charts() {
  const p = project.value
  const [group, setGroup] = useState<'state' | 'culture' | 'religion' | 'province'>('state')
  const [metric, setMetric] = useState<Metric>('pop')
  const military = militaryTotals.value
  const rows = useMemo(() => {
    const stats = group === 'state' ? stateStats.value : group === 'province' ? provinceStats.value : group === 'culture' ? cultureStats.value : religionStats.value
    const items = list(group) as unknown as { id: string; name: string; color: string }[]
    return items.map(item => {
      const s = stats.get(item.id)
      const pop = s ? s.urban + s.rural : 0
      const value =
        metric === 'pop' ? pop
        : metric === 'area' ? (s?.areaKm2 ?? 0)
        : metric === 'cities' ? (s?.cities.length ?? 0)
        : metric === 'urban' ? (s?.urban ?? 0)
        : metric === 'density' ? (s && s.areaKm2 > 0 ? pop / s.areaKm2 : 0)
        : Object.values(military.get(item.id) ?? {}).reduce((a, b) => a + b, 0)
      return { id: item.id, name: item.name, color: item.color, value: Math.round(value * 10) / 10, kind: group as EntityKind }
    })
  }, [p, group, metric, military])
  const m = METRICS.find(x => x.id === metric)!
  return (
    <>
      <div class="list-actions">
        <select value={group} onChange={e => setGroup((e.target as HTMLSelectElement).value as typeof group)}>
          <option value="state">Staaten</option>
          <option value="province">Provinzen</option>
          <option value="culture">Kulturen</option>
          <option value="religion">Religionen</option>
        </select>
        <select value={metric} onChange={e => setMetric((e.target as HTMLSelectElement).value as Metric)}>
          {METRICS.filter(x => x.id !== 'military' || group === 'state').map(x => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
      </div>
      <BarChart rows={rows} unit={m.unit} title={`${m.name} je ${KIND_NAMES[group][0]}`} />
      <p class="hint">Die Tabellen der jeweiligen Übersicht zeigen dieselben Werte. Klick auf einen Balken wählt das Element.</p>
    </>
  )
}

function Conflicts() {
  const items = conflicts.value
  return (
    <>
      <div class="list-actions">
        <button onClick={() => findConflicts()}>Neu prüfen</button>
      </div>
      {!items.length ? (
        <p class="empty">Keine Konflikte mit dem aktuellen Gelände.</p>
      ) : (
        <ul class="conflicts">
          {items.map((c, i) => (
            <li key={i} onClick={() => pick(c.kind, c.id)}>
              <span class="warn-icon">⚠</span> {c.text}
            </li>
          ))}
        </ul>
      )}
      <p class="hint">Geprüft wird nach jedem Neuimport: Städte, Marker und Heere an Land, Flotten auf See, Straßen über Land, Flussnamen ohne Linie.</p>
    </>
  )
}

export function Overviews({ active, onChange }: { active: OverviewId; onChange: (id: OverviewId) => void }) {
  const p = project.value
  const tabs: { id: OverviewId; name: string; badge?: number }[] = [
    { id: 'states', name: 'Staaten', badge: p.states.length },
    { id: 'cultures', name: 'Kulturen', badge: p.cultures.length },
    { id: 'religions', name: 'Religionen', badge: p.religions.length },
    { id: 'zones', name: 'Zonen', badge: p.zones.length },
    { id: 'cities', name: 'Städte', badge: p.cities.length },
    { id: 'routes', name: 'Routen', badge: p.routes.length },
    { id: 'rivers', name: 'Flüsse', badge: p.rivers.length },
    { id: 'markers', name: 'Marker', badge: p.markers.length },
    { id: 'labels', name: 'Beschriftungen', badge: p.labels.length },
    { id: 'charts', name: 'Diagramme' },
    { id: 'conflicts', name: 'Konflikte', badge: conflicts.value.length },
  ]
  const areaOf: Partial<Record<OverviewId, AreaKind>> = { states: 'state', cultures: 'culture', religions: 'religion', zones: 'zone' }
  const area = areaOf[active]
  return (
    <div class="overviews">
      <Tabs tabs={tabs} active={active} onChange={onChange} />
      <div class="overview-body">
        {area && (AREA_KINDS as readonly string[]).includes(area) && <AreaList kind={area} />}
        {active === 'cities' && <CityList />}
        {active === 'routes' && <RouteList />}
        {active === 'rivers' && <RiverList />}
        {active === 'markers' && <MarkerList />}
        {active === 'labels' && <LabelList />}
        {active === 'charts' && <Charts />}
        {active === 'conflicts' && <Conflicts />}
      </div>
    </div>
  )
}

