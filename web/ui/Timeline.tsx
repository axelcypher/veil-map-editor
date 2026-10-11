// The timeline in the interface: the bar under the map that picks strand and year, the life and
// history of the selected element, the chronicle of events, and the settings of strands.
import { signal } from '@preact/signals'
import { useEffect, useRef, useState } from 'preact/hooks'
import { confirmDialog } from '../model/actions'
import { KIND_NAMES, newEvent, newId, newStrand, newTimeline } from '../model/project'
import {
  addStored, commitSource, compareWith, differences, editStrand, milestone, patchSource, project, reckoning, selection, setMilestone, setStrand, setYear, showHeld, source, storedEntity, strand, updateEntity,
  updateStored, view, year,
} from '../model/store'
import {
  baseStrand, chainOf, changesOf, changeToStrand, changeYears, copyElement, editChange, elementToStrand, entityYears, eventsIn, eventToStrand, flattenAt, happeningsIn,
  heldIn, holdEntry, lifeOf, moveChange, reckoningOf, releaseElement, releaseEvent, releaseYear, removeEventFromProject, removeStrandFromProject, resolveWorld, setVisibility, showEntry, storedStrand,
  toBaseYear, toOwnYear, visibleIn, type Reckoning,
} from '../model/timeline'
import { COLLECTION, type Base, type Change, type EntityKind, type EntityRef, type Era, type Milestone, type Owned, type Project, type Strand, type Timeline, type Visibility, type WorldEvent } from '../model/types'
import { mapView } from './mapRef'
import { NoteLink } from './NoteLink'
import { Color, Field, Section, Select, Swatch, Text } from './components'

/** the event open in the chronicle */
export const selectedEvent = signal<string | null>(null)
/** asks the app to show the chronicle (a click on an event in the bar) */
export const chronicleRequest = signal(0)

/** a year (base years) as the strand shown counts it, with its unit */
export const formatYear = (baseYear: number, r: Reckoning | null = reckoning.value) => (r ? `${toOwnYear(r, baseYear)}${r.unit ? ` ${r.unit}` : ''}` : String(baseYear))

const strandOf = (t: Timeline, id: string | undefined) => t.strands.find(s => s.id === (id ?? baseStrand(t).id))
export const strandName = (t: Timeline, id: string | undefined) => strandOf(t, id)?.name ?? '?'

/** the era a year (own years) falls in */
export function eraAt(r: Reckoning, ownYear: number): Era | null {
  let found: Era | null = null
  for (const era of r.eras) if (era.start <= ownYear) found = era
  return found
}

/** the strands as a tree: each with its depth, parents before their children */
export function strandTree(t: Timeline): { strand: Strand; depth: number }[] {
  const out: { strand: Strand; depth: number }[] = []
  const walk = (parent: string | null, depth: number) => {
    for (const s of t.strands.filter(x => x.parent === parent)) {
      out.push({ strand: s, depth })
      walk(s.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
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

/** the same, in the own years of a reckoning while the value is in base years */
function OwnYearInput({ value, onChange, r, placeholder, title }: { value: number | null | undefined; onChange: (base: number | null) => void; r: Reckoning; placeholder?: string; title?: string }) {
  return <YearInput value={value == null ? value : toOwnYear(r, value)} onChange={v => onChange(v == null ? null : toBaseYear(r, v))} placeholder={placeholder} title={title} />
}

/** the strands to choose from, indented as a tree */
function StrandSelect({ value, onChange, exclude, label }: { value: string; onChange: (id: string) => void; exclude?: string[]; label?: string }) {
  const t = source.value.timeline
  if (!t) return null
  return (
    <select value={value} onChange={e => onChange((e.target as HTMLSelectElement).value)} aria-label={label ?? 'Strang'}>
      {strandTree(t)
        .filter(x => !exclude?.includes(x.strand.id))
        .map(({ strand: s, depth }) => (
          <option key={s.id} value={s.id}>
            {' '.repeat(depth)}
            {s.name}
          </option>
        ))}
    </select>
  )
}

/** the strand shown, if it derives from another: what it calls taking over and holding back */
export function heldWords(t: Timeline | null = source.value.timeline, id = strand.value) {
  const s = t?.strands.find(x => x.id === id)
  if (!t || !s?.parent) return null
  return s.inherit === 'released'
    ? { show: 'freigeben', hold: 'Freigabe zurücknehmen', held: 'nicht freigegeben', strand: s }
    : { show: 'einblenden', hold: 'ausblenden', held: 'ausgeblendet', strand: s }
}

/** the milestone picked in the bar on purpose: releases and deviations made now hold from there on */
const pickedMilestone = () => (typeof milestone.peek() === 'string' ? (milestone.peek() as string) : undefined)

/** from … until, as two choices over the milestones; empty: open */
function MilestoneSpan({ from, until, onChange, label }: { from?: string; until?: string; onChange: (from?: string, until?: string) => void; label: string }) {
  const t = source.value.timeline
  if (!t?.milestones.length) return null
  const options = t.milestones.map(m => ({ id: m.id, name: m.name }))
  return (
    <span class="inline milestone-span" title={label}>
      <span class="muted">ab</span>
      <Select value={from ?? ''} onChange={v => onChange(v || undefined, until)} options={options} empty="—" />
      <span class="muted">bis vor</span>
      <Select value={until ?? ''} onChange={v => onChange(from, v || undefined)} options={options} empty="—" />
    </span>
  )
}

/** a release (or hiding) of an entry in the strand shown, with its stretch of milestones */
function ReleaseSpan<T extends Owned>({ entry, update }: { entry: T; update: (edit: (x: T) => T) => void }) {
  const t = source.value.timeline
  const words = heldWords()
  const v = entry.visibility?.[strand.value]
  if (!t?.milestones.length || !words || !v) return null
  return (
    <MilestoneSpan
      label={`Zwischen welchen Meilensteinen es in „${words.strand.name}“ ${v.show ? 'freigegeben' : 'ausgeblendet'} ist`}
      from={v.from}
      until={v.until}
      onChange={(from, until) => update(x => setVisibility(x, strand.peek(), { show: v.show, ...(from ? { from } : {}), ...(until ? { until } : {}) } as Visibility))}
    />
  )
}

/** applies a release to the stored project, in the view shown */
const releaseNow = (fn: (p: Project) => Project) => commitSource(fn(source.peek()))

// ---------------------------------------------------------------------------------------------
// the bar

const percent = (r: Reckoning, y: number) => `${((Math.min(r.end, Math.max(r.start, y)) - r.start) / Math.max(1, r.end - r.start)) * 100}%`

/** the next year (after or before the one shown) in which something changes */
function neighbour(years: number[], from: number, direction: 1 | -1) {
  return direction > 0 ? years.find(y => y > from) : [...years].reverse().find(y => y < from)
}

export function TimelineBar() {
  const raw = source.value
  const t = raw.timeline
  const y = year.value
  const r = reckoning.value
  const v = view.value
  const [playing, setPlaying] = useState(false)
  const years = t ? changeYears(raw, v) : []
  const s = selection.value
  const stored = s ? storedEntity(s.kind, s.id) : undefined
  const own = stored ? entityYears(stored, raw, v) : []
  // playing walks through the years in which something changes
  useEffect(() => {
    if (!playing) return
    const timer = window.setInterval(() => {
      const p = source.peek()
      const end = reckoning.peek()?.end ?? 0
      const next = neighbour(changeYears(p, view.peek()), year.peek() ?? 0, 1)
      if (next == null || next > end) setPlaying(false)
      else setYear(next)
    }, 1200)
    return () => clearInterval(timer)
  }, [playing])
  if (!t || y == null || !r) return null
  const current = strandOf(t, strand.value)
  const era = eraAt(r, toOwnYear(r, y))
  const step = (direction: 1 | -1) => {
    const next = neighbour(years, y, direction)
    if (next != null) setYear(next)
  }
  const addEvent = () => {
    const event = newEvent(raw, y, editStrand())
    patchSource({ events: [...raw.events, event] })
    selectedEvent.value = event.id
    chronicleRequest.value++
  }
  const eraBase = (e: Era) => toBaseYear(r, e.start)
  return (
    <div class="timeline-bar" aria-label="Zeitleiste">
      {t.strands.length > 1 && (
        <span class="tl-strand" style={{ borderColor: current?.color }} title="Gezeigter Strang">
          <StrandSelect value={strand.value} onChange={setStrand} />
        </span>
      )}
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
        <OwnYearInput value={y} onChange={x => x != null && setYear(x)} r={r} title="Jahr eingeben" />
        {r.unit && <span class="tl-unit">{r.unit}</span>}
        {era && (
          <span class="tl-era" style={{ borderColor: era.color }}>
            {era.name}
          </span>
        )}
      </div>
      <div class="tl-track">
        <div class="tl-marks">
          <span class="tl-line" />
          <span class="tl-progress" style={{ width: percent(r, y) }} />
          {r.eras.map((e, i) => (
            <span
              key={e.id}
              class="tl-era-band"
              title={e.name}
              style={{ left: percent(r, eraBase(e)), width: `calc(${percent(r, r.eras[i + 1] ? eraBase(r.eras[i + 1]) : r.end)} - ${percent(r, eraBase(e))})`, background: e.color }}
            />
          ))}
          {years
            .filter(x => x >= r.start && x <= r.end)
            .map(x => (
              <span key={x} class={`tl-tick${own.includes(x) ? ' own' : ''}`} style={{ left: percent(r, x) }} />
            ))}
          {eventsIn(raw, v)
            .filter(e => (e.until ?? e.year) >= r.start && e.year <= r.end)
            .map(e => {
              const color = raw.catalog.eventTypes.find(k => k.id === e.type)?.color ?? '#9e9e9e'
              return (
                <button
                  key={e.id}
                  class={`tl-event${selectedEvent.value === e.id ? ' on' : ''}`}
                  title={`${formatYear(e.year, r)}${e.until != null ? `–${toOwnYear(r, e.until)}` : ''}: ${e.name}`}
                  style={{ left: percent(r, e.year), width: e.until != null ? `calc(${percent(r, e.until)} - ${percent(r, e.year)} + 9px)` : undefined, background: color }}
                  onClick={() => {
                    setYear(e.year)
                    selectedEvent.value = e.id
                    chronicleRequest.value++
                  }}
                />
              )
            })}
        </div>
        <input type="range" min={r.start} max={r.end} step={1} value={y} onInput={e => setYear(Number((e.target as HTMLInputElement).value))} aria-label="Jahr" />
        <div class="tl-ends">
          <span>{toOwnYear(r, r.start)}</span>
          <span>{toOwnYear(r, r.end)}</span>
        </div>
      </div>
      {t.milestones.length > 0 && (
        <select
          class="tl-milestone"
          value={milestone.value === undefined ? '' : (milestone.value ?? '*')}
          onChange={e => {
            const value = (e.target as HTMLSelectElement).value
            setMilestone(value === '' ? undefined : value === '*' ? null : value)
          }}
          title="Stand der Erzählung: was bis zu diesem Meilenstein freigegeben ist. Ein ausdrücklich gewählter Meilenstein datiert neue Freigaben und Abweichungen."
        >
          <option value="">Stand: {t.milestones.find(m => m.id === t.current)?.name ?? 'alles'}</option>
          {t.milestones.map(m => (
            <option key={m.id} value={m.id}>
              bis {m.name}
            </option>
          ))}
          <option value="*">alles</option>
        </select>
      )}
      {t.strands.length > 1 && (
        <select
          class={`tl-compare${compareWith.value ? ' on' : ''}`}
          value={compareWith.value ?? ''}
          onChange={e => {
            compareWith.value = (e.target as HTMLSelectElement).value || null
            if (compareWith.value) chronicleRequest.value++
          }}
          title="Mit einem anderen Strang vergleichen: die Karte markiert, was im gezeigten Jahr anders ist; die Chronik listet es"
        >
          <option value="">Vergleich: aus</option>
          {strandTree(t)
            .filter(x => x.strand.id !== strand.value)
            .map(({ strand: s }) => (
              <option key={s.id} value={s.id}>
                mit {s.name}
              </option>
            ))}
        </select>
      )}
      {current?.parent && (
        <button
          class={`small${showHeld.value ? ' active' : ''}`}
          onClick={() => (showHeld.value = !showHeld.value)}
          title={`Was „${current.name}“ vom Elternstrang ${current.inherit === 'released' ? 'nicht freigegeben' : 'ausgeblendet'} hat, blass zeigen – zum ${current.inherit === 'released' ? 'Freigeben' : 'Einblenden'}`}
        >
          ◌ Zurückgehaltenes
        </button>
      )}
      <button class="small" onClick={addEvent} title="Neues Ereignis in diesem Jahr und Strang, in der Chronik bearbeiten">
        ＋ Ereignis
      </button>
    </div>
  )
}

/** the inspector for an element the strand shown holds back: what it is, and taking it over */
export function HeldInspector({ kind, entity }: { kind: EntityKind; entity: Base }) {
  const t = source.value.timeline
  const y = year.value
  const r = reckoning.value
  const words = heldWords()
  if (!t || !words || y == null || !r) return null
  const stored = storedEntity(kind, entity.id)
  const later = stored ? changesOf(source.value, view.value, stored, true).filter(c => c.year <= y && !visibleIn(source.value, view.value, c)).length : 0
  return (
    <aside class="inspector held">
      <header>
        <span class="kind">
          {KIND_NAMES[kind][0]} <span class="edit-year deviation">{words.held}</span>
        </span>
        <div class="header-actions">
          <button class="icon" title="Schließen" onClick={() => (selection.value = null)}>
            ✕
          </button>
        </div>
      </header>
      <div class="inspector-body">
        <h3 class="held-name">{entity.name || '(ohne Namen)'}</h3>
        <p class="hint">
          Gehört zu „{strandName(t, stored?.strand)}“ und ist in „{words.strand.name}“ {words.held}. So sieht es im Elternstrang aus; bearbeiten lässt es sich erst, wenn es hier sichtbar ist.
        </p>
        {entity.description && <p class="muted">{entity.description}</p>}
        <div class="button-grid">
          <button class="primary" onClick={() => releaseNow(p => releaseElement(p, view.peek(), entity.id, null, pickedMilestone()))} title="Nur das Element mit seinem ersten Stand; spätere Änderungen bleiben zurückgehalten">
            {words.show}
          </button>
          {later > 0 && (
            <button onClick={() => releaseNow(p => releaseElement(p, view.peek(), entity.id, y, pickedMilestone()))} title={`Auch die ${later} Änderungen bis ${formatYear(y, r)}`}>
              mit Verlauf bis {toOwnYear(r, y)} {words.show}
            </button>
          )}
        </div>
      </div>
    </aside>
  )
}

// ---------------------------------------------------------------------------------------------
// the selected element: where it comes from, its life span and its changes

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
  const r = reckoning.value
  const events = [...eventsIn(source.value, view.value)].sort((a, b) => a.year - b.year)
  if (!events.length) return null
  return <Select value={value ?? ''} onChange={onChange} options={events.map(e => ({ id: e.id, name: `${r ? toOwnYear(r, e.year) : e.year} · ${e.name}` }))} empty="kein Ereignis" />
}

/** a short choice "move to …" / "copy to …" over the other strands */
function StrandAction({ current, onMove, onCopy, title }: { current: string; onMove: (target: string) => void; onCopy: (target: string) => void; title: string }) {
  const t = source.value.timeline
  if (!t || t.strands.length < 2) return null
  const others = strandTree(t).filter(x => x.strand.id !== current)
  return (
    <select
      class="strand-action"
      value=""
      title={title}
      onChange={e => {
        const [action, target] = (e.target as HTMLSelectElement).value.split(':')
        if (action === 'move') onMove(target)
        if (action === 'copy') onCopy(target)
      }}
    >
      <option value="">⇄</option>
      <optgroup label="Verschieben nach">
        {others.map(({ strand: s }) => (
          <option key={`m${s.id}`} value={`move:${s.id}`}>
            {s.name}
          </option>
        ))}
      </optgroup>
      <optgroup label="Kopieren nach">
        {others.map(({ strand: s }) => (
          <option key={`c${s.id}`} value={`copy:${s.id}`}>
            {s.name}
          </option>
        ))}
      </optgroup>
    </select>
  )
}

/** in the inspector's head: where an element comes from, and from which year an edit holds */
export function EditYear({ kind, id }: { kind: EntityKind; id: string }) {
  const t = source.value.timeline
  const y = year.value
  const r = reckoning.value
  const stored = storedEntity(kind, id)
  if (!t || y == null || !r || !stored) return null
  const own = stored.strand === editStrand()
  const since = stored.begin ?? r.start
  if (own) {
    if (y <= since) return null
    return (
      <span class="edit-year" title="Was du hier änderst, gilt ab diesem Jahr; frühere Jahre bleiben, wie sie waren">
        Änderung ab {formatYear(y, r)}
      </span>
    )
  }
  return (
    <span class="edit-year deviation" title={`Das Element gehört zu „${strandName(t, stored.strand)}“. Was du hier änderst, ist eine Abweichung in „${strandName(t, strand.value)}“ ab diesem Jahr; das Original bleibt.`}>
      Abweichung ab {formatYear(y, r)}
    </span>
  )
}

/** life span, origin and dated changes of the selected element; only with a timeline */
export function TimeSection({ kind, id }: { kind: EntityKind; id: string }) {
  const raw = source.value
  const t = raw.timeline
  const y = year.value
  const r = reckoning.value
  const v = view.value
  const stored = storedEntity(kind, id)
  if (!t || y == null || !r || !stored) return null
  const me = editStrand()
  const own = stored.strand === me
  const life = lifeOf(raw, v, stored)
  const since = own ? (stored.begin ?? r.start) : -Infinity
  const editStored = (change: (e: Base) => Base, merge?: string) => updateStored(kind, id, e => change(e) as typeof e, merge)
  // begin and end go through the world: on an own element they are its own, on another one a deviation
  const setLife = (key: 'begin' | 'end', value: number | null) => updateEntity(kind, id, { [key]: value ?? undefined } as never)
  const changes = changesOf(raw, v, stored)
  const words = heldWords(t)
  // what the parent has and this strand holds back, when asked for
  const held = words && showHeld.value ? changesOf(raw, v, stored, true).filter(c => !changes.includes(c)) : []
  const many = t.strands.length > 1
  const setChangeShown = (c: Change, show: boolean) =>
    editStored(e => ({ ...e, history: (e.history ?? []).map(x => (x === c ? (show ? showEntry(t, x, strand.peek(), pickedMilestone()) : holdEntry(t, x, strand.peek())) : x)) }))
  return (
    <Section title="Zeit" open>
      {many && (
        <p class="hint origin">
          <Swatch color={strandOf(t, stored.strand)?.color ?? '#999'} /> gehört zu <strong>{strandName(t, stored.strand)}</strong>
          {!own && <> · hier gezeigt in „{strandName(t, strand.value)}“</>}
          <StrandAction
            current={stored.strand ?? baseStrand(t).id}
            title="Element in einen anderen Strang verschieben oder dorthin kopieren"
            onMove={target => editStored(e => elementToStrand(t, e, target))}
            onCopy={target => {
              addStored(kind, copyElement(t, stored, target, newId(kind)) as never)
              // the copy replaces the original where it lives: hidden there
              if (target === strand.value) editStored(e => setVisibility(e, target, { show: false }))
            }}
          />
        </p>
      )}
      {!own && <ReleaseSpan<Base> entry={stored} update={edit => editStored(e => edit(e))} />}
      <p class={`hint time-mode${y > since ? ' dated' : ''}`}>
        {!own ? (
          <>
            Änderungen sind eine <strong>Abweichung</strong> in „{strandName(t, strand.value)}“ ab {formatYear(y, r)}; das Original in „{strandName(t, stored.strand)}“ bleibt.
          </>
        ) : y > since ? (
          <>
            Änderungen gelten <strong>ab {formatYear(y, r)}</strong> und werden als Stand dieses Jahres gespeichert.
          </>
        ) : (
          <>Änderungen gelten von Anfang an ({formatYear(since, r)}) – der erste Stand.</>
        )}
      </p>
      <Field label="Besteht seit" hint={own ? 'leer = von Beginn des Ausschnitts an' : 'abweichend von der Herkunft möglich'}>
        <span class="inline">
          <OwnYearInput value={life.begin} onChange={x => setLife('begin', x)} r={r} placeholder={String(toOwnYear(r, r.start))} />
          {life.begin !== y && (
            <button class="small" onClick={() => setLife('begin', y)} title="Entsteht im gezeigten Jahr">
              ab {toOwnYear(r, y)}
            </button>
          )}
        </span>
      </Field>
      <Field label="Endet" hint="ab diesem Jahr nicht mehr da; leer = besteht fort">
        <span class="inline">
          <OwnYearInput value={life.end} onChange={x => setLife('end', x)} r={r} placeholder="—" />
          <button class="small" onClick={() => setLife('end', y)} title="Verschwindet ab dem gezeigten Jahr von der Karte (Rückgängig holt es zurück)">
            endet {toOwnYear(r, y)}
          </button>
        </span>
      </Field>
      {changes.length > 0 ? (
        <ol class="change-list">
          {changes.map((c: Change) => {
            const ref = { year: c.year, strand: c.strand }
            const mine = c.strand === me
            return (
              <li key={`${c.year}|${c.strand ?? ''}`} class={`${c.year === y ? 'current' : c.year < y ? 'past' : 'future'}${mine ? '' : ' inherited'}`}>
                <div class="change-head">
                  <button class="link change-year" title="Dieses Jahr zeigen" onClick={() => setYear(c.year)}>
                    {formatYear(c.year, r)}
                  </button>
                  <span class="change-fields">{describeChange(c.set, project.value) || 'nur Anmerkung'}</span>
                  {mine && (
                    <span class="change-actions">
                      <OwnYearInput value={c.year} onChange={to => to != null && editStored(e => moveChange(e, ref, to))} r={r} title="In ein anderes Jahr verschieben" />
                      <StrandAction
                        current={c.strand ?? baseStrand(t).id}
                        title="Änderung in einen anderen Strang verschieben oder dorthin kopieren"
                        onMove={target => editStored(e => changeToStrand(t, e, ref, target, false))}
                        onCopy={target => editStored(e => changeToStrand(t, e, ref, target, true))}
                      />
                      <button class="icon danger" title="Diese Änderung löschen" onClick={() => editStored(e => editChange(e, ref, () => null))}>
                        🗑
                      </button>
                    </span>
                  )}
                </div>
                {many && c.strand !== stored.strand && <span class="change-strand">{mine ? 'Abweichung' : 'aus'} „{strandName(t, c.strand)}“</span>}
                {!mine && words && (
                  <span class="inline">
                    <button class="small hold" onClick={() => setChangeShown(c, false)} title={`Diese Änderung in „${words.strand.name}“ zurückhalten`}>
                      {words.hold}
                    </button>
                    <ReleaseSpan entry={c} update={edit => editStored(e => ({ ...e, history: (e.history ?? []).map(x => (x === c ? edit(x) : x)) }))} />
                  </span>
                )}
                {mine ? (
                  <>
                    <input type="text" placeholder="Anlass, Grund …" value={c.note ?? ''} onInput={e => editStored(x => editChange(x, ref, ch => ({ ...ch, note: (e.target as HTMLInputElement).value || undefined })), `note-${c.year}`)} />
                    <EventSelect value={c.event} onChange={id => editStored(x => editChange(x, ref, ch => ({ ...ch, event: id || undefined })))} />
                    {c.strand && (
                      <MilestoneSpan
                        label="Zwischen welchen Meilensteinen diese Abweichung gilt, z. B. bis zu ihrer Richtigstellung"
                        from={c.from}
                        until={c.until}
                        onChange={(from, until) =>
                          editStored(x =>
                            editChange(x, ref, ch => {
                              const { from: _f, until: _u, ...rest } = ch
                              return { ...rest, ...(from ? { from } : {}), ...(until ? { until } : {}) }
                            }),
                          )
                        }
                      />
                    )}
                  </>
                ) : (
                  c.note && <span class="muted">{c.note}</span>
                )}
              </li>
            )
          })}
        </ol>
      ) : (
        <p class="hint">Noch keine Änderungen. Zum gewünschten Jahr springen und das Element dort bearbeiten.</p>
      )}
      {held.length > 0 && words && (
        <>
          <h4 class="subhead">{words.held[0].toUpperCase() + words.held.slice(1)}</h4>
          <ol class="change-list">
            {held.map(c => (
              <li key={`${c.year}|${c.strand ?? ''}`} class="held">
                <div class="change-head">
                  <button class="link change-year" onClick={() => setYear(c.year)}>
                    {formatYear(c.year, r)}
                  </button>
                  <span class="change-fields">{describeChange(c.set, project.value) || 'nur Anmerkung'}</span>
                  <button class="small" onClick={() => setChangeShown(c, true)}>
                    {words.show}
                  </button>
                </div>
              </li>
            ))}
          </ol>
        </>
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
  const v = view.value
  const entries = happeningsIn(raw, y, v)
  const relations = raw.diplomacyHistory.filter(c => c.year === y && visibleIn(raw, v, c))
  const events = eventsIn(raw, v).filter(e => e.year === y || (e.until != null && e.year < y && y <= e.until))
  const r = reckoning.value
  // names as they are in the year shown (an element that ends here: as it was before)
  const world = project.value
  const name = (kind: EntityKind, id: string) => `${(world[COLLECTION[kind]] as unknown as Base[]).some(e => e.id === id) ? nameOfId(world, id) : nameOfId(raw, id)} (${KIND_NAMES[kind][0]})`
  const relationName = (id: string) => raw.catalog.relations.find(rel => rel.id === id)?.name ?? 'keine'
  const words = heldWords()
  const held = words ? heldIn(raw, v, y) : []
  const heldPart = held.length > 0 && words && (
    <div class="held-report">
      <span class="muted">
        {held.length} {words.held}
      </span>
      <button class="small" onClick={() => releaseNow(p => releaseYear(p, view.peek(), y, pickedMilestone()))} title="Elemente, die hier entstehen, Änderungen, Beziehungen und Ereignisse dieses Jahres">
        alles aus diesem Jahr {words.show}
      </button>
      {showHeld.value && (
        <ul class="year-report">
          {held.map((h, i) => (
            <li key={i} class="held" onClick={() => h.kind && pick(h.kind, h.id)}>
              <span class="what">{h.type === 'element' ? 'entsteht' : h.type === 'event' ? 'Ereignis' : h.type === 'relation' ? 'Beziehung' : 'ändert sich'}</span>{' '}
              {h.type === 'event' ? raw.events.find(e => e.id === h.id)?.name : h.kind ? name(h.kind, h.id) : ''}
              {h.change && <span class="muted"> · {describeChange(h.change.set, world)}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
  if (!entries.length && !relations.length && !events.length) {
    return (
      <>
        <p class="empty">In diesem Jahr ändert sich nichts{held.length ? ' Sichtbares' : ''}.</p>
        {heldPart}
      </>
    )
  }
  return (
    <>
    {heldPart}
    <ul class="year-report">
      {events.map(e => (
        <li key={e.id} class="event" onClick={() => (selectedEvent.value = e.id)}>
          <Swatch color={raw.catalog.eventTypes.find(k => k.id === e.type)?.color ?? '#9e9e9e'} /> {e.name}
          {e.year !== y && <span class="muted"> · seit {r ? toOwnYear(r, e.year) : e.year}</span>}
        </li>
      ))}
      {entries.map(entry => (
        <li key={`${entry.kind}:${entry.id}:${entry.what}:${entry.change?.strand ?? ''}`} onClick={() => entry.what !== 'end' && pick(entry.kind, entry.id)} class={entry.what}>
          <span class="what">{entry.what === 'begin' ? 'entsteht' : entry.what === 'end' ? 'endet' : 'ändert sich'}</span> {name(entry.kind, entry.id)}
          {entry.change && Object.keys(entry.change.set).length > 0 && <span class="muted"> · {describeChange(entry.change.set, world)}</span>}
          {entry.change?.note && <span class="muted"> · {entry.change.note}</span>}
        </li>
      ))}
      {relations.flatMap(change =>
        Object.entries(change.set)
          .filter(([key]) => key.split('>')[0] < key.split('>')[1])
          .map(([key, value]) => {
            const [a, b] = key.split('>')
            return (
              <li key={`${key}|${change.strand ?? ''}`} class="change">
                <span class="what">Beziehung</span> {nameOfId(world, a)} ↔ {nameOfId(world, b)}: {relationName(String(value))}
              </li>
            )
          }),
      )}
    </ul>
    </>
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

const setEvents = (events: WorldEvent[], merge?: string) => patchSource({ events }, merge)

function EventEditor({ event }: { event: WorldEvent }) {
  const raw = source.value
  const t = raw.timeline
  const r = reckoning.value
  const own = event.strand === editStrand()
  const set = (patch: Partial<WorldEvent>, merge?: string) => setEvents(source.peek().events.map(e => (e.id === event.id ? { ...e, ...patch } : e)), merge ? `event:${event.id}:${merge}` : undefined)
  const remove = async () => {
    if (!(await confirmDialog(`Ereignis „${event.name}“ löschen? Änderungen, die darauf verweisen, bleiben, verlieren aber den Verweis.`, { yes: 'Löschen' }))) return
    commitSource(removeEventFromProject(source.peek(), event.id))
    selectedEvent.value = null
  }
  /** an own version of an inherited event: a copy in the strand shown, the original hidden there */
  const deviate = () => {
    if (!t) return
    const copy = { ...eventToStrand(t, event, strand.value), id: newId('event'), visibility: undefined }
    setEvents([...source.peek().events.map(e => (e.id === event.id ? setVisibility(e, strand.value, { show: false }) : e)), copy])
    selectedEvent.value = copy.id
  }
  if (!own && t) {
    return (
      <div class="event-editor">
        <p class="hint">
          Aus „{strandName(t, event.strand)}“. {event.description || 'Keine Beschreibung.'}
        </p>
        {event.refs.length > 0 && (
          <div class="chips">
            {event.refs.map(ref => (
              <button key={`${ref.kind}:${ref.id}`} class="chip link" onClick={() => pick(ref.kind, ref.id)}>
                {nameOfId(raw, ref.id)}
              </button>
            ))}
          </div>
        )}
        <div class="button-row">
          {visibleIn(raw, view.value, event) ? (
            <>
              <button onClick={deviate} title="Eine eigene Fassung in diesem Strang anlegen; das Original wird hier ausgeblendet">
                Abweichende Fassung in „{strandName(t, strand.value)}“
              </button>
              {heldWords() && <button onClick={() => setEvents(source.peek().events.map(e => (e.id === event.id ? holdEntry(t, e, strand.peek()) : e)))}>{heldWords()!.hold}</button>}
            </>
          ) : (
            heldWords() && (
              <>
                <button class="primary" onClick={() => setEvents(source.peek().events.map(e => (e.id === event.id ? showEntry(t, e, strand.peek(), pickedMilestone()) : e)))}>
                  {heldWords()!.show}
                </button>
                <button onClick={() => releaseNow(p => releaseEvent(p, view.peek(), event.id, pickedMilestone()))} title="Das Ereignis und alle Änderungen, die es nennen">
                  mit seinen Änderungen {heldWords()!.show}
                </button>
              </>
            )
          )}
        </div>
      </div>
    )
  }
  return (
    <div class="event-editor">
      <Field label="Name">
        <Text value={event.name} onInput={v => set({ name: v }, 'name')} />
      </Field>
      <Field label="Jahr">
        <span class="inline">
          {r && <OwnYearInput value={event.year} onChange={v => v != null && set({ year: v })} r={r} />}
          <span class="muted">bis</span>
          {r && <OwnYearInput value={event.until} onChange={v => set({ until: v != null && v > event.year ? v : null })} r={r} placeholder="—" title="Letztes Jahr eines länger dauernden Ereignisses" />}
        </span>
      </Field>
      <Field label="Art">
        <Select value={event.type} onChange={v => set({ type: v })} options={raw.catalog.eventTypes.map(k => ({ id: k.id, name: k.name }))} empty="—" />
      </Field>
      <Field label="Betrifft" wide>
        <div class="chips">
          {event.refs.map(ref => (
            <span key={`${ref.kind}:${ref.id}`} class="chip on">
              <button class="link" onClick={() => pick(ref.kind, ref.id)}>
                {nameOfId(raw, ref.id)}
              </button>
              <button class="link" title="Entfernen" onClick={() => set({ refs: event.refs.filter(x => !(x.kind === ref.kind && x.id === ref.id)) })}>
                ✕
              </button>
            </span>
          ))}
        </div>
        <RefPicker onAdd={ref => !event.refs.some(x => x.kind === ref.kind && x.id === ref.id) && set({ refs: [...event.refs, ref] })} />
      </Field>
      <Text multiline value={event.description} onInput={v => set({ description: v }, 'description')} placeholder="Was geschah, wer war beteiligt, was folgte …" />
      <NoteLink note={event.note} name={event.name} onChange={note => set({ note })} />
      <div class="button-row">
        {t && t.strands.length > 1 && (
          <StrandAction
            current={event.strand ?? baseStrand(t).id}
            title="Ereignis in einen anderen Strang verschieben oder dorthin kopieren"
            onMove={target => set({ ...eventToStrand(t, event, target), strand: storedStrand(t, target) })}
            onCopy={target => setEvents([...source.peek().events, { ...eventToStrand(t, event, target), id: newId('event'), visibility: undefined }])}
          />
        )}
        <button class="danger" onClick={remove}>
          Ereignis löschen
        </button>
      </div>
    </div>
  )
}

/** what differs between the strand shown and the one compared with, in the year shown */
function Comparison() {
  const t = source.value.timeline
  const other = compareWith.value
  const list = differences.value
  if (!t || !other) return null
  const here = project.value
  const there = resolveWorld(source.value, year.value, { strand: other, milestone: milestone.value })
  const name = (kind: EntityKind, id: string) => {
    const find = (p: Project) => (p[COLLECTION[kind]] as unknown as Base[]).find(e => e.id === id)
    return `${find(here)?.name ?? find(there)?.name ?? id} (${KIND_NAMES[kind][0]})`
  }
  const valueIn = (p: Project, kind: EntityKind, id: string, field: string) => {
    const e = (p[COLLECTION[kind]] as unknown as Record<string, unknown>[]).find(x => x.id === id)
    return e ? describeChange({ [field]: e[field] }, p) : ''
  }
  return (
    <Section title={`Vergleich mit „${strandName(t, other)}“`}>
      {!list.length ? (
        <p class="empty">Im gezeigten Jahr gleich.</p>
      ) : (
        <ul class="year-report comparison">
          {list.map(d => (
            <li key={`${d.kind}:${d.id}`} class={`diff-${d.what}`} onClick={() => d.what !== 'b' && pick(d.kind, d.id)}>
              <span class="what">{d.what === 'a' ? 'nur hier' : d.what === 'b' ? 'nur dort' : 'anders'}</span> {name(d.kind, d.id)}
              {d.what === 'changed' && (
                <span class="muted">
                  {' · '}
                  {d.fields
                    .map(f => (f === 'geometry' ? 'Gebiet bzw. Lage' : `${valueIn(here, d.kind, d.id, f)} ↔ ${valueIn(there, d.kind, d.id, f).replace(/^[^→]*→ /, '')}`))
                    .join(' · ')}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <p class="hint">Rosa: nur im gezeigten Strang · Türkis: nur im verglichenen (gestrichelt sein Umriss) · Gelb: in beiden, aber anders.</p>
    </Section>
  )
}

export function Chronicle() {
  const raw = source.value
  const t = raw.timeline
  const y = year.value
  const r = reckoning.value
  const list = useRef<HTMLOListElement>(null)
  useEffect(() => {
    list.current?.querySelector('.on')?.scrollIntoView({ block: 'nearest' })
  }, [selectedEvent.value])
  if (!t || y == null || !r) {
    return (
      <>
        <p class="hint">
          Mit einer Zeitleiste hält der Editor fest, wie sich die Welt entwickelt: Reiche entstehen und vergehen, Provinzen wechseln den Besitzer, Städte wachsen, Bündnisse zerbrechen. Unter der Karte wählst du das Jahr; was du dort änderst, gilt ab diesem Jahr.
        </p>
        <TimelineSetup />
      </>
    )
  }
  const shown = eventsIn(raw, view.value)
  const heldEvents = heldWords() && showHeld.value ? eventsIn(raw, view.value, Math.max(1, chainOf(t, strand.value).length - 1)).filter(e => !shown.includes(e)) : []
  const events = [...shown, ...heldEvents].sort((a, b) => a.year - b.year || a.name.localeCompare(b.name, 'de'))
  const addEvent = () => {
    const event = newEvent(raw, y, editStrand())
    patchSource({ events: [...raw.events, event] })
    selectedEvent.value = event.id
  }
  return (
    <>
      <div class="list-actions">
        <button class="primary" onClick={addEvent}>
          ＋ Ereignis im Jahr {toOwnYear(r, y)}
        </button>
        {t.strands.length > 1 && <span class="muted">in „{strandName(t, strand.value)}“</span>}
      </div>
      {compareWith.value && <Comparison />}
      <Section title={`Im Jahr ${formatYear(y, r)}`}>
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
                <li key={e.id} class={`${open ? 'on' : ''}${e.year > y ? ' future' : ''}${heldEvents.includes(e) ? ' held' : ''}`}>
                  <button
                    class="event-row"
                    onClick={() => {
                      selectedEvent.value = open ? null : e.id
                      if (!open) setYear(e.year)
                    }}
                  >
                    <span class="event-year">
                      {toOwnYear(r, e.year)}
                      {e.until != null ? `–${toOwnYear(r, e.until)}` : ''}
                    </span>
                    <Swatch color={type?.color ?? '#9e9e9e'} />
                    <span class="event-name">{e.name}</span>
                    {t.strands.length > 1 && e.strand !== editStrand() && <span class="strand-tag">{strandName(t, e.strand)}</span>}
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
// settings: strands and their reckoning

function TimelineSetup() {
  const [start, setStart] = useState(0)
  const [end, setEnd] = useState(1000)
  const [unit, setUnit] = useState('')
  const create = () => {
    const timeline = newTimeline(start, end, unit.trim())
    patchSource({ timeline })
    setStrand(timeline.strands[0].id)
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

const setTimeline = (t: Timeline, merge?: string) => patchSource({ timeline: t }, merge)

function EraList({ s, t }: { s: Strand; t: Timeline }) {
  const set = (eras: Era[], merge?: string) => setTimeline({ ...t, strands: t.strands.map(x => (x.id === s.id ? { ...x, eras } : x)) }, merge)
  const setEra = (id: string, patch: Partial<Era>, merge?: string) => set(s.eras.map(e => (e.id === id ? { ...e, ...patch } : e)), merge ? `era-${id}-${merge}` : undefined)
  const r = reckoningOf(t, s.id)
  const y = year.value
  return (
    <>
      {s.eras.length > 0 ? (
        <ul class="era-list">
          {[...s.eras]
            .sort((a, b) => a.start - b.start)
            .map(e => (
              <li key={e.id}>
                <Color value={e.color} onChange={v => setEra(e.id, { color: v }, 'color')} />
                <input type="text" value={e.name} onInput={ev => setEra(e.id, { name: (ev.target as HTMLInputElement).value }, 'name')} />
                <span class="muted">ab</span>
                <YearInput value={e.start} onChange={v => v != null && setEra(e.id, { start: v })} />
                <button class="icon danger" title="Epoche löschen" onClick={() => set(s.eras.filter(x => x.id !== e.id))}>
                  🗑
                </button>
              </li>
            ))}
        </ul>
      ) : (
        s.parent && <p class="hint">Ohne eigene Epochen gelten die des Elternstrangs.</p>
      )}
      <button class="small" onClick={() => set([...s.eras, { id: newId('era'), name: `Epoche ${s.eras.length + 1}`, start: y != null ? toOwnYear(r, y) : toOwnYear(r, r.start), color: '#8f7aa4' }])}>
        ＋ Epoche
      </button>
    </>
  )
}

function StrandEditor({ s, t }: { s: Strand; t: Timeline }) {
  const update = (patch: Partial<Strand>, merge?: string) => setTimeline({ ...t, strands: t.strands.map(x => (x.id === s.id ? { ...x, ...patch } : x)) }, merge ? `strand-${s.id}-${merge}` : undefined)
  const isBase = s.parent == null
  // strands below this one cannot become its parent
  const below = t.strands.filter(x => chainOf(t, x.id).some(c => c.id === s.id)).map(x => x.id)
  const r = reckoningOf(t, s.id)
  const ownReckoning = isBase || s.zero != null || s.unit != null || s.start != null || s.end != null
  const children = t.strands.filter(x => x.parent === s.id)
  const remove = async () => {
    const ok = await confirmDialog(`Strang „${s.name}“ löschen? Seine eigenen Elemente, Änderungen und Ereignisse gehen mit, ebenso alle Freigaben für ihn. Rückgängig holt alles zurück.`, { yes: 'Löschen' })
    if (!ok) return
    if (strand.peek() === s.id) setStrand(s.parent ?? baseStrand(t).id)
    commitSource(removeStrandFromProject(source.peek(), s.id))
  }
  return (
    <div class="strand-editor">
      <Field label="Name">
        <span class="inline">
          <Color value={s.color} onChange={v => update({ color: v }, 'color')} />
          <Text value={s.name} onInput={v => update({ name: v }, 'name')} />
        </span>
      </Field>
      {!isBase && (
        <>
          <Field label="Leitet ab von">
            <StrandSelect value={s.parent!} onChange={v => update({ parent: v })} exclude={below} label="Elternstrang" />
          </Field>
          <Field label="Übernimmt" hint={s.inherit === 'released' ? 'vom Elternstrang ist nur sichtbar, was hier freigegeben wird' : 'alles, was der Elternstrang zeigt, außer hier Verborgenem'}>
            <Select
              value={s.inherit}
              onChange={v => update({ inherit: v })}
              options={[
                { id: 'all', name: 'alles' },
                { id: 'released', name: 'nur Freigegebenes' },
              ]}
            />
          </Field>
        </>
      )}
      {!isBase && (
        <label class="check">
          <input
            type="checkbox"
            checked={!ownReckoning}
            onChange={e =>
              (e.target as HTMLInputElement).checked
                ? update({ zero: null, unit: null, start: null, end: null })
                : update({ zero: r.zero, unit: r.unit, start: toOwnYear(r, r.start), end: toOwnYear(r, r.end) })
            }
          />
          <span>Zeitrechnung und Ausschnitt wie der Elternstrang</span>
        </label>
      )}
      {ownReckoning && (
        <>
          {!isBase && (
            <Field label="Jahr 0 entspricht" hint="diesem Jahr des Basisstrangs">
              <YearInput value={s.zero} onChange={v => update({ zero: v ?? 0 })} />
            </Field>
          )}
          <Field label="Zusatz" hint="hinter jeder Jahreszahl">
            <Text value={s.unit ?? ''} onInput={v => update({ unit: v }, 'unit')} placeholder="z. B. n. Ü." />
          </Field>
          <Field label="Ausschnitt" hint="in den Jahren dieses Strangs">
            <span class="inline">
              <YearInput value={s.start ?? toOwnYear(r, r.start)} onChange={v => v != null && v < toOwnYear(r, r.end) && update({ start: v })} />
              <span class="muted">bis</span>
              <YearInput value={s.end ?? toOwnYear(r, r.end)} onChange={v => v != null && v > toOwnYear(r, r.start) && update({ end: v })} />
            </span>
          </Field>
        </>
      )}
      <h4 class="subhead">Epochen</h4>
      <EraList s={s} t={t} />
      {!isBase && (
        <div class="button-row">
          <button class="danger" disabled={children.length > 0} title={children.length ? 'Erst die abgeleiteten Stränge löschen oder umhängen' : undefined} onClick={remove}>
            Strang löschen …
          </button>
        </div>
      )}
    </div>
  )
}

/** the points in the telling of the story, in order, and the one reached now */
function Milestones({ t }: { t: Timeline }) {
  const set = (milestones: Milestone[], merge?: string) => setTimeline({ ...t, milestones }, merge)
  const edit = (id: string, patch: Partial<Milestone>, merge?: string) => set(t.milestones.map(m => (m.id === id ? { ...m, ...patch } : m)), merge ? `milestone-${id}-${merge}` : undefined)
  const move = (index: number, by: number) => {
    const list = [...t.milestones]
    const [item] = list.splice(index, 1)
    list.splice(index + by, 0, item)
    set(list)
  }
  const remove = async (m: Milestone) => {
    if (!(await confirmDialog(`Meilenstein „${m.name}“ löschen? Freigaben und Abweichungen, die ab oder bis zu ihm gelten, gelten danach ohne diese Grenze.`, { yes: 'Löschen' }))) return
    setTimeline({ ...t, milestones: t.milestones.filter(x => x.id !== m.id), current: t.current === m.id ? null : t.current })
  }
  return (
    <>
      <p class="hint">
        Stände der Erzählung, in Reihenfolge – frei benannt, z. B. Folgen, Kapitel oder Termine. Freigaben und Abweichungen können ab oder bis zu einem Meilenstein gelten; in der Leiste wählst du, welchen Stand du siehst.
      </p>
      {t.milestones.length > 0 && (
        <ol class="milestone-list">
          {t.milestones.map((m, i) => (
            <li key={m.id}>
              <input type="text" value={m.name} onInput={e => edit(m.id, { name: (e.target as HTMLInputElement).value }, 'name')} />
              <input type="text" class="milestone-description" placeholder="Beschreibung" value={m.description} onInput={e => edit(m.id, { description: (e.target as HTMLInputElement).value }, 'description')} />
              <button class="icon" title="Nach oben" disabled={i === 0} onClick={() => move(i, -1)}>
                ↑
              </button>
              <button class="icon" title="Nach unten" disabled={i === t.milestones.length - 1} onClick={() => move(i, 1)}>
                ↓
              </button>
              <button class="icon danger" title="Löschen" onClick={() => remove(m)}>
                🗑
              </button>
            </li>
          ))}
        </ol>
      )}
      <div class="button-row">
        <button class="small" onClick={() => set([...t.milestones, { id: newId('ms'), name: `Meilenstein ${t.milestones.length + 1}`, description: '' }])}>
          ＋ Meilenstein
        </button>
      </div>
      {t.milestones.length > 0 && (
        <Field label="Erreichter Stand" hint="was eine Ansicht ohne eigene Wahl zeigt, auch für veil-agents">
          <Select value={t.current ?? ''} onChange={v => setTimeline({ ...t, current: v || null })} options={t.milestones.map(m => ({ id: m.id, name: m.name }))} empty="alles" />
        </Field>
      )}
    </>
  )
}

export function TimelineSettings() {
  const raw = source.value
  const t = raw.timeline
  const [open, setOpen] = useState<string | null>(null)
  if (!t) return <TimelineSetup />
  const derive = (parent: Strand) => {
    const created = newStrand(parent, `Strang ${t.strands.length + 1}`)
    setTimeline({ ...t, strands: [...t.strands, created] })
    setOpen(created.id)
  }
  const removeTimeline = async () => {
    const y = year.peek() ?? 0
    const ok = await confirmDialog(
      `Zeitleiste entfernen? Die Welt im Jahr ${formatYear(y)} im Strang „${strandName(t, strand.peek())}“ wird zum zeitlosen Stand. Alles andere – andere Jahre, andere Stränge, datierte Änderungen – geht verloren (Rückgängig holt es zurück). Ereignisse dieses Strangs bleiben erhalten.`,
      { yes: 'Entfernen' },
    )
    if (ok) commitSource(flattenAt(source.peek(), y, view.peek()))
  }
  return (
    <>
      <p class="hint">
        Ein Basisstrang, beliebig viele abgeleitete. Ein abgeleiteter Strang zeigt die Welt seines Elternstrangs – alles oder nur Freigegebenes – und dazu Eigenes. Was du in einem Strang änderst, gilt dort und darunter.
      </p>
      <ul class="strand-tree">
        {strandTree(t).map(({ strand: s, depth }) => (
          <li key={s.id} style={{ paddingLeft: `${depth * 16}px` }}>
            <div class="strand-row">
              <Swatch color={s.color} />
              <button class="link strand-name" onClick={() => setOpen(open === s.id ? null : s.id)}>
                {s.name || '(ohne Namen)'}
              </button>
              <span class="muted">{s.parent == null ? 'Basis' : s.inherit === 'released' ? 'nur Freigegebenes' : 'erbt alles'}</span>
              {strand.value === s.id ? (
                <span class="strand-tag">gezeigt</span>
              ) : (
                <button class="small" onClick={() => setStrand(s.id)}>
                  zeigen
                </button>
              )}
              <button class="small" title="Einen Strang anlegen, der von diesem ableitet" onClick={() => derive(s)}>
                ＋ ableiten
              </button>
            </div>
            {open === s.id && <StrandEditor s={s} t={t} />}
          </li>
        ))}
      </ul>
      <h4 class="subhead">Meilensteine</h4>
      <Milestones t={t} />
      <div class="button-row">
        <button class="danger" onClick={removeTimeline}>
          Zeitleiste entfernen …
        </button>
      </div>
      <p class="hint">
        {changeYears(raw, view.value).length} Jahre mit Änderungen im gezeigten Strang, {raw.events.length} Ereignisse insgesamt.
      </p>
    </>
  )
}
