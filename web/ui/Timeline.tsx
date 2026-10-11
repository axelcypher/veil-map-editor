// The timeline in the interface: the bar under the map that picks the year shown, the life and
// history of the selected element, the chronicle of events, and the timeline settings.
import { signal } from '@preact/signals'
import { useEffect, useRef, useState } from 'preact/hooks'
import { confirmDialog } from '../model/actions'
import { KIND_NAMES, newEvent, newId, newTimeline } from '../model/project'
import { commitSource, patchSource, project, selection, setYear, source, storedEntity, updateStored, year } from '../model/store'
import { changeYears, editChange, entityYears, flattenAt, happeningsIn, moveChange, removeEventFromProject } from '../model/timeline'
import { COLLECTION, type Base, type Change, type EntityKind, type EntityRef, type Era, type Project, type Timeline, type WorldEvent } from '../model/types'
import { mapView } from './mapRef'
import { NoteLink } from './NoteLink'
import { Color, Field, Section, Select, Swatch, Text } from './components'

/** the event open in the chronicle */
export const selectedEvent = signal<string | null>(null)
/** asks the app to show the chronicle (a click on an event in the bar) */
export const chronicleRequest = signal(0)

export const formatYear = (y: number, t: Timeline | null = source.value.timeline) => `${y}${t?.unit ? ` ${t.unit}` : ''}`

/** the era a year falls in */
export function eraAt(t: Timeline, y: number): Era | null {
  let found: Era | null = null
  for (const era of [...t.eras].sort((a, b) => a.start - b.start)) if (era.start <= y) found = era
  return found
}

/** a year field that only takes the value when typing is done (Enter or leaving the field) */
function YearInput({ value, onChange, placeholder, title }: { value: number | null | undefined; onChange: (v: number | null) => void; placeholder?: string; title?: string }) {
  const [draft, setDraft] = useState(value == null ? '' : String(value))
  useEffect(() => setDraft(value == null ? '' : String(value)), [value])
  const done = () => {
    const text = draft.trim()
    if (text === '') {
      if (value != null) onChange(null)
      return
    }
    const n = Math.round(Number(text))
    if (Number.isFinite(n) && n !== value) onChange(n)
    else setDraft(value == null ? '' : String(value))
  }
  return (
    <input
      type="number"
      class="year-input"
      step={1}
      value={draft}
      placeholder={placeholder}
      title={title}
      onInput={e => setDraft((e.target as HTMLInputElement).value)}
      onBlur={done}
      onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  )
}

// ---------------------------------------------------------------------------------------------
// the bar

const percent = (t: Timeline, y: number) => `${((Math.min(t.end, Math.max(t.start, y)) - t.start) / Math.max(1, t.end - t.start)) * 100}%`

/** the next year (after or before the one shown) in which something changes */
function neighbour(years: number[], from: number, direction: 1 | -1) {
  return direction > 0 ? years.find(y => y > from) : [...years].reverse().find(y => y < from)
}

export function TimelineBar() {
  const raw = source.value
  const t = raw.timeline
  const y = year.value
  const [playing, setPlaying] = useState(false)
  const years = changeYears(raw)
  const s = selection.value
  const stored = s ? storedEntity(s.kind, s.id) : undefined
  const own = stored ? entityYears(stored) : []
  // playing walks through the years in which something changes
  useEffect(() => {
    if (!playing) return
    const timer = window.setInterval(() => {
      const p = source.peek()
      const next = neighbour(changeYears(p), year.peek() ?? 0, 1)
      if (next == null || !p.timeline || next > p.timeline.end) setPlaying(false)
      else setYear(next)
    }, 1200)
    return () => clearInterval(timer)
  }, [playing])
  if (!t || y == null) return null
  const era = eraAt(t, y)
  const eras = [...t.eras].sort((a, b) => a.start - b.start)
  const step = (direction: 1 | -1) => {
    const next = neighbour(years, y, direction)
    if (next != null) setYear(next)
  }
  const addEvent = () => {
    const event = newEvent(raw, y)
    patchSource({ events: [...raw.events, event] })
    selectedEvent.value = event.id
    chronicleRequest.value++
  }
  return (
    <div class="timeline-bar" aria-label="Zeitleiste">
      <div class="tl-controls">
        <button class="icon" title="Voriges Jahr mit Änderungen (Alt+←)" disabled={neighbour(years, y, -1) == null} onClick={() => step(-1)}>
          ⏮
        </button>
        <button class={`icon${playing ? ' active' : ''}`} title={playing ? 'Anhalten' : 'Abspielen: von Änderung zu Änderung'} onClick={() => setPlaying(!playing)}>
          {playing ? '⏸' : '▶'}
        </button>
        <button class="icon" title="Nächstes Jahr mit Änderungen (Alt+→)" disabled={neighbour(years, y, 1) == null} onClick={() => step(1)}>
          ⏭
        </button>
      </div>
      <div class="tl-year">
        <YearInput value={y} onChange={v => v != null && setYear(v)} title="Jahr eingeben" />
        {t.unit && <span class="tl-unit">{t.unit}</span>}
        {era && (
          <span class="tl-era" style={{ borderColor: era.color }}>
            {era.name}
          </span>
        )}
      </div>
      <div class="tl-track">
        <div class="tl-marks">
          <span class="tl-line" />
          <span class="tl-progress" style={{ width: percent(t, y) }} />
          {eras.map((e, i) => (
            <span
              key={e.id}
              class="tl-era-band"
              title={e.name}
              style={{ left: percent(t, e.start), width: `calc(${percent(t, eras[i + 1]?.start ?? t.end)} - ${percent(t, e.start)})`, background: e.color }}
            />
          ))}
          {years.map(x => (
            <span key={x} class={`tl-tick${own.includes(x) ? ' own' : ''}`} style={{ left: percent(t, x) }} />
          ))}
          {raw.events.map(e => {
            const color = raw.catalog.eventTypes.find(k => k.id === e.type)?.color ?? '#9e9e9e'
            return (
              <button
                key={e.id}
                class={`tl-event${selectedEvent.value === e.id ? ' on' : ''}`}
                title={`${formatYear(e.year, t)}${e.until != null ? `–${e.until}` : ''}: ${e.name}`}
                style={{ left: percent(t, e.year), width: e.until != null ? `calc(${percent(t, e.until)} - ${percent(t, e.year)} + 9px)` : undefined, background: color }}
                onClick={() => {
                  setYear(e.year)
                  selectedEvent.value = e.id
                  chronicleRequest.value++
                }}
              />
            )
          })}
        </div>
        <input type="range" min={t.start} max={t.end} step={1} value={y} onInput={e => setYear(Number((e.target as HTMLInputElement).value))} aria-label="Jahr" />
        <div class="tl-ends">
          <span>{t.start}</span>
          <span>{t.end}</span>
        </div>
      </div>
      <button class="small" onClick={addEvent} title="Neues Ereignis in diesem Jahr, in der Chronik bearbeiten">
        ＋ Ereignis
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// the selected element: its life span and its changes

const FIELD_NAMES: Record<string, string> = {
  name: 'Name',
  fullName: 'Voller Name',
  color: 'Farbe',
  geometry: 'Gebiet bzw. Lage',
  clip: 'Küstenschnitt',
  form: 'Form',
  capitalId: 'Hauptstadt',
  ruralDensity: 'Landbevölkerung',
  cultureId: 'Kultur',
  religionId: 'Religion',
  stateId: 'Staat',
  seatId: 'Sitz',
  type: 'Art',
  origins: 'Herkunft',
  deity: 'Gottheit',
  pattern: 'Muster',
  opacity: 'Deckkraft',
  population: 'Einwohner',
  features: 'Merkmale',
  group: 'Gruppe',
  plan: 'Stadtplan',
  junctions: 'Anschlüsse',
  category: 'Kategorie',
  size: 'Größe',
  rotation: 'Drehung',
  units: 'Truppen',
  commander: 'Befehlshaber',
  naval: 'Flotte',
  leader: 'Leitung',
  members: 'Mitglieder',
  description: 'Notiz',
  note: 'Obsidian-Note',
  parentId: 'Mündung',
}

function nameOfId(p: Project, id: string) {
  for (const key of Object.values(COLLECTION)) {
    const found = (p[key] as unknown as Base[]).find(e => e.id === id)
    if (found) return found.name || '(ohne Namen)'
  }
  return id
}

/** "Staat → Arvland, Einwohner → 12.000" */
export function describeChange(set: Record<string, unknown>, p: Project = source.value) {
  return Object.entries(set)
    .map(([key, value]) => {
      const label = FIELD_NAMES[key] ?? key
      if (key.endsWith('Id')) return `${label} → ${value ? nameOfId(p, String(value)) : '—'}`
      if (typeof value === 'number') return `${label} → ${value.toLocaleString('de-DE')}`
      if (typeof value === 'string' && key !== 'description' && value.length <= 40) return `${label} → ${value || '—'}`
      if (typeof value === 'boolean') return `${label} → ${value ? 'ja' : 'nein'}`
      if (value === null && key === 'geometry') return `${label} → keins`
      return label
    })
    .join(', ')
}

function EventSelect({ value, onChange }: { value: string | undefined; onChange: (id: string) => void }) {
  const events = [...source.value.events].sort((a, b) => a.year - b.year)
  if (!events.length) return null
  return <Select value={value ?? ''} onChange={onChange} options={events.map(e => ({ id: e.id, name: `${e.year} · ${e.name}` }))} empty="kein Ereignis" />
}

/** in the inspector's head: from which year an edit holds, when that is not the element's first */
export function EditYear({ kind, id }: { kind: EntityKind; id: string }) {
  const t = source.value.timeline
  const y = year.value
  const stored = storedEntity(kind, id)
  if (!t || y == null || !stored || y <= (stored.begin ?? t.start)) return null
  return (
    <span class="edit-year" title="Was du hier änderst, gilt ab diesem Jahr; frühere Jahre bleiben, wie sie waren">
      Änderung ab {formatYear(y, t)}
    </span>
  )
}

/** life span and dated changes of the selected element; only with a timeline */
export function TimeSection({ kind, id }: { kind: EntityKind; id: string }) {
  const t = source.value.timeline
  const y = year.value
  const stored = storedEntity(kind, id)
  if (!t || y == null || !stored) return null
  const since = stored.begin ?? t.start
  const edit = (change: (e: Base) => Base, merge?: string) => updateStored(kind, id, e => change(e) as typeof e, merge)
  const setLife = (key: 'begin' | 'end', value: number | null) =>
    edit(e => {
      const out = { ...e }
      if (value == null) delete out[key]
      else out[key] = value
      return out
    })
  const history = stored.history ?? []
  return (
    <Section title="Zeit" open>
      <p class={`hint time-mode${y > since ? ' dated' : ''}`}>
        {y > since ? (
          <>
            Änderungen gelten <strong>ab {formatYear(y, t)}</strong> und werden als Stand dieses Jahres gespeichert.
          </>
        ) : (
          <>Änderungen gelten von Anfang an ({formatYear(since, t)}) – der erste Stand.</>
        )}
      </p>
      <Field label="Besteht seit" hint="leer = von Beginn der Zeitleiste an">
        <span class="inline">
          <YearInput value={stored.begin} onChange={v => setLife('begin', v)} placeholder={String(t.start)} />
          {stored.begin !== y && (
            <button class="small" onClick={() => setLife('begin', y)} title="Entsteht im gezeigten Jahr">
              ab {y}
            </button>
          )}
        </span>
      </Field>
      <Field label="Endet" hint="ab diesem Jahr nicht mehr da; leer = besteht fort">
        <span class="inline">
          <YearInput value={stored.end} onChange={v => setLife('end', v)} placeholder="—" />
          <button class="small" onClick={() => setLife('end', y)} title="Verschwindet ab dem gezeigten Jahr von der Karte (Rückgängig holt es zurück)">
            endet {y}
          </button>
        </span>
      </Field>
      {history.length > 0 ? (
        <ol class="change-list">
          {history.map((c: Change) => (
            <li key={c.year} class={c.year === y ? 'current' : c.year < y ? 'past' : 'future'}>
              <div class="change-head">
                <button class="link change-year" title="Dieses Jahr zeigen" onClick={() => setYear(c.year)}>
                  {formatYear(c.year, t)}
                </button>
                <span class="change-fields">{describeChange(c.set, project.value) || 'nur Anmerkung'}</span>
                <span class="change-actions">
                  <YearInput value={c.year} onChange={to => to != null && edit(e => moveChange(e, c.year, to))} title="In ein anderes Jahr verschieben" />
                  <button class="icon danger" title="Diese Änderung löschen" onClick={() => edit(e => editChange(e, c.year, () => null))}>
                    🗑
                  </button>
                </span>
              </div>
              <input type="text" placeholder="Anlass, Grund …" value={c.note ?? ''} onInput={e => edit(x => editChange(x, c.year, ch => ({ ...ch, note: (e.target as HTMLInputElement).value || undefined })), `note-${c.year}`)} />
              <EventSelect value={c.event} onChange={v => edit(x => editChange(x, c.year, ch => ({ ...ch, event: v || undefined })))} />
            </li>
          ))}
        </ol>
      ) : (
        <p class="hint">Noch keine Änderungen. Zum gewünschten Jahr springen und das Element dort bearbeiten.</p>
      )}
    </Section>
  )
}

// ---------------------------------------------------------------------------------------------
// the chronicle: what happens in the year shown, and the events

const pick = (kind: EntityKind, id: string) => {
  selection.value = { kind, id }
  mapView.current?.focus(kind, id)
}

function YearReport({ y }: { y: number }) {
  const raw = source.value
  const entries = happeningsIn(raw, y)
  const relations = raw.diplomacyHistory.find(c => c.year === y)
  const events = raw.events.filter(e => e.year === y || (e.until != null && e.year < y && y <= e.until))
  // names as they are in the year shown (an element that ends here: as it was before)
  const world = project.value
  const name = (kind: EntityKind, id: string) => `${(world[COLLECTION[kind]] as unknown as Base[]).some(e => e.id === id) ? nameOfId(world, id) : nameOfId(raw, id)} (${KIND_NAMES[kind][0]})`
  const relationName = (id: string) => raw.catalog.relations.find(r => r.id === id)?.name ?? 'keine'
  if (!entries.length && !relations && !events.length) return <p class="empty">In diesem Jahr ändert sich nichts.</p>
  return (
    <ul class="year-report">
      {events.map(e => (
        <li key={e.id} class="event" onClick={() => (selectedEvent.value = e.id)}>
          <Swatch color={raw.catalog.eventTypes.find(k => k.id === e.type)?.color ?? '#9e9e9e'} /> {e.name}
          {e.year !== y && <span class="muted"> · seit {e.year}</span>}
        </li>
      ))}
      {entries.map(entry => (
        <li key={`${entry.kind}:${entry.id}:${entry.what}`} onClick={() => entry.what !== 'end' && pick(entry.kind, entry.id)} class={entry.what}>
          <span class="what">{entry.what === 'begin' ? 'entsteht' : entry.what === 'end' ? 'endet' : 'ändert sich'}</span> {name(entry.kind, entry.id)}
          {entry.change && Object.keys(entry.change.set).length > 0 && <span class="muted"> · {describeChange(entry.change.set, world)}</span>}
          {entry.change?.note && <span class="muted"> · {entry.change.note}</span>}
        </li>
      ))}
      {relations &&
        Object.entries(relations.set)
          .filter(([key]) => key.split('>')[0] < key.split('>')[1])
          .map(([key, value]) => {
            const [a, b] = key.split('>')
            return (
              <li key={key} class="change">
                <span class="what">Beziehung</span> {nameOfId(world, a)} ↔ {nameOfId(world, b)}: {relationName(String(value))}
              </li>
            )
          })}
    </ul>
  )
}

const REF_KINDS: EntityKind[] = ['state', 'province', 'city', 'culture', 'religion', 'institution', 'zone', 'route', 'marker', 'regiment']

function RefPicker({ onAdd }: { onAdd: (ref: EntityRef) => void }) {
  const [kind, setKind] = useState<EntityKind>('state')
  const items = (project.value[COLLECTION[kind]] as unknown as Base[]).slice().sort((a, b) => a.name.localeCompare(b.name, 'de'))
  return (
    <span class="inline ref-picker">
      <select value={kind} onChange={e => setKind((e.target as HTMLSelectElement).value as EntityKind)}>
        {REF_KINDS.map(k => (
          <option key={k} value={k}>
            {KIND_NAMES[k][0]}
          </option>
        ))}
      </select>
      <select
        value=""
        onChange={e => {
          const id = (e.target as HTMLSelectElement).value
          if (id) onAdd({ kind, id })
        }}
      >
        <option value="">hinzufügen …</option>
        {items.map(x => (
          <option key={x.id} value={x.id}>
            {x.name || '(ohne Namen)'}
          </option>
        ))}
      </select>
    </span>
  )
}

function EventEditor({ event }: { event: WorldEvent }) {
  const raw = source.value
  const set = (patch: Partial<WorldEvent>, merge?: string) =>
    patchSource({ events: source.peek().events.map(e => (e.id === event.id ? { ...e, ...patch } : e)) }, merge ? `event:${event.id}:${merge}` : undefined)
  const remove = async () => {
    if (!(await confirmDialog(`Ereignis „${event.name}“ löschen? Änderungen, die darauf verweisen, bleiben, verlieren aber den Verweis.`, { yes: 'Löschen' }))) return
    commitSource(removeEventFromProject(source.peek(), event.id))
    selectedEvent.value = null
  }
  return (
    <div class="event-editor">
      <Field label="Name">
        <Text value={event.name} onInput={v => set({ name: v }, 'name')} />
      </Field>
      <Field label="Jahr">
        <span class="inline">
          <YearInput value={event.year} onChange={v => v != null && set({ year: v })} />
          <span class="muted">bis</span>
          <YearInput value={event.until} onChange={v => set({ until: v != null && v > event.year ? v : null })} placeholder="—" title="Letztes Jahr eines länger dauernden Ereignisses" />
        </span>
      </Field>
      <Field label="Art">
        <Select value={event.type} onChange={v => set({ type: v })} options={raw.catalog.eventTypes.map(k => ({ id: k.id, name: k.name }))} empty="—" />
      </Field>
      <Field label="Betrifft" wide>
        <div class="chips">
          {event.refs.map(r => (
            <span key={`${r.kind}:${r.id}`} class="chip on">
              <button class="link" onClick={() => pick(r.kind, r.id)}>
                {nameOfId(raw, r.id)}
              </button>
              <button class="link" title="Entfernen" onClick={() => set({ refs: event.refs.filter(x => !(x.kind === r.kind && x.id === r.id)) })}>
                ✕
              </button>
            </span>
          ))}
        </div>
        <RefPicker onAdd={ref => !event.refs.some(r => r.kind === ref.kind && r.id === ref.id) && set({ refs: [...event.refs, ref] })} />
      </Field>
      <Text multiline value={event.description} onInput={v => set({ description: v }, 'description')} placeholder="Was geschah, wer war beteiligt, was folgte …" />
      <NoteLink note={event.note} name={event.name} onChange={note => set({ note })} />
      <div class="button-row">
        <button class="danger" onClick={remove}>
          Ereignis löschen
        </button>
      </div>
    </div>
  )
}

export function Chronicle() {
  const raw = source.value
  const t = raw.timeline
  const y = year.value
  const list = useRef<HTMLOListElement>(null)
  useEffect(() => {
    list.current?.querySelector('.on')?.scrollIntoView({ block: 'nearest' })
  }, [selectedEvent.value])
  if (!t || y == null) {
    return (
      <>
        <p class="hint">
          Mit einer Zeitleiste hält der Editor fest, wie sich die Welt entwickelt: Reiche entstehen und vergehen, Provinzen wechseln den Besitzer, Städte wachsen, Bündnisse zerbrechen. Unter der Karte wählst du das Jahr; was du dort änderst, gilt ab diesem Jahr.
        </p>
        <TimelineSetup />
      </>
    )
  }
  const events = [...raw.events].sort((a, b) => a.year - b.year || a.name.localeCompare(b.name, 'de'))
  const addEvent = () => {
    const event = newEvent(raw, y)
    patchSource({ events: [...raw.events, event] })
    selectedEvent.value = event.id
  }
  return (
    <>
      <div class="list-actions">
        <button class="primary" onClick={addEvent}>
          ＋ Ereignis im Jahr {y}
        </button>
      </div>
      <Section title={`Im Jahr ${formatYear(y, t)}`}>
        <YearReport y={y} />
      </Section>
      <Section title="Ereignisse">
        {!events.length ? (
          <p class="empty">Noch keine Ereignisse.</p>
        ) : (
          <ol class="event-list" ref={list}>
            {events.map(e => {
              const open = selectedEvent.value === e.id
              const type = raw.catalog.eventTypes.find(k => k.id === e.type)
              return (
                <li key={e.id} class={`${open ? 'on' : ''}${e.year > y ? ' future' : ''}`}>
                  <button
                    class="event-row"
                    onClick={() => {
                      selectedEvent.value = open ? null : e.id
                      if (!open) setYear(e.year)
                    }}
                  >
                    <span class="event-year">
                      {e.year}
                      {e.until != null ? `–${e.until}` : ''}
                    </span>
                    <Swatch color={type?.color ?? '#9e9e9e'} />
                    <span class="event-name">{e.name}</span>
                    <span class="muted">{type?.name}</span>
                  </button>
                  {open && <EventEditor event={e} />}
                </li>
              )
            })}
          </ol>
        )}
      </Section>
    </>
  )
}

// ---------------------------------------------------------------------------------------------
// settings

function TimelineSetup() {
  const [start, setStart] = useState(0)
  const [end, setEnd] = useState(1000)
  const [unit, setUnit] = useState('')
  const create = () => {
    patchSource({ timeline: newTimeline(start, end, unit.trim()) })
    // what is there now is the first state of the world
    setYear(start)
  }
  return (
    <div class="timeline-setup">
      <Field label="Erstes Jahr" hint="alles Vorhandene gilt ab hier">
        <YearInput value={start} onChange={v => v != null && setStart(v)} />
      </Field>
      <Field label="Letztes Jahr">
        <YearInput value={end} onChange={v => v != null && setEnd(v)} />
      </Field>
      <Field label="Zusatz" hint="hinter jeder Jahreszahl, z. B. „n. Ü.“">
        <Text value={unit} onInput={setUnit} placeholder="optional" />
      </Field>
      <button class="primary" disabled={end <= start} onClick={create}>
        Zeitleiste anlegen
      </button>
    </div>
  )
}

export function TimelineSettings() {
  const raw = source.value
  const t = raw.timeline
  if (!t) return <TimelineSetup />
  const set = (patch: Partial<Timeline>, merge?: string) => patchSource({ timeline: { ...t, ...patch } }, merge ? `timeline-${merge}` : undefined)
  const setEra = (id: string, patch: Partial<Era>, merge?: string) => set({ eras: t.eras.map(e => (e.id === id ? { ...e, ...patch } : e)) }, merge ? `era-${id}-${merge}` : undefined)
  const remove = async () => {
    const y = year.peek() ?? t.end
    const ok = await confirmDialog(
      `Zeitleiste entfernen? Die Welt im Jahr ${formatYear(y, t)} wird zum zeitlosen Stand. Alles, was es in diesem Jahr nicht gibt, und alle datierten Änderungen gehen verloren (Rückgängig holt sie zurück). Ereignisse bleiben erhalten.`,
      { yes: 'Entfernen' },
    )
    if (ok) commitSource(flattenAt(source.peek(), y))
  }
  return (
    <>
      <Field label="Erstes Jahr" hint="was keinen eigenen Beginn hat, besteht ab hier">
        <YearInput value={t.start} onChange={v => v != null && v < t.end && set({ start: v })} />
      </Field>
      <Field label="Letztes Jahr">
        <YearInput value={t.end} onChange={v => v != null && v > t.start && set({ end: v })} />
      </Field>
      <Field label="Zusatz" hint="hinter jeder Jahreszahl">
        <Text value={t.unit} onInput={v => set({ unit: v }, 'unit')} placeholder="z. B. n. Ü." />
      </Field>
      <h4 class="subhead">Epochen</h4>
      {t.eras.length > 0 && (
        <ul class="era-list">
          {[...t.eras]
            .sort((a, b) => a.start - b.start)
            .map(e => (
              <li key={e.id}>
                <Color value={e.color} onChange={v => setEra(e.id, { color: v }, 'color')} />
                <input type="text" value={e.name} onInput={ev => setEra(e.id, { name: (ev.target as HTMLInputElement).value }, 'name')} />
                <span class="muted">ab</span>
                <YearInput value={e.start} onChange={v => v != null && setEra(e.id, { start: v })} />
                <button class="icon danger" title="Epoche löschen" onClick={() => set({ eras: t.eras.filter(x => x.id !== e.id) })}>
                  🗑
                </button>
              </li>
            ))}
        </ul>
      )}
      <div class="button-row">
        <button onClick={() => set({ eras: [...t.eras, { id: newId('era'), name: `Epoche ${t.eras.length + 1}`, start: year.peek() ?? t.start, color: '#8f7aa4' }] })}>＋ Epoche ab {year.value}</button>
        <button class="danger" onClick={remove}>
          Zeitleiste entfernen …
        </button>
      </div>
      <p class="hint">
        {changeYears(raw).length} Jahre mit Änderungen, {raw.events.length} Ereignisse.
      </p>
    </>
  )
}
