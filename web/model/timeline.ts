// The timeline. A project keeps every element as it first was, plus its dated changes; the map
// shows the world as it was in one year. Edits are made to that world as if it were a plain
// project and are then written back as changes in that year (`record`), so every tool works
// unchanged.
//
// Pure and without imports beyond types: other programs reading the project from the sync server
// (veil-agents) can copy this file to see the world in any year.
import type { Base, Change, EntityKind, EntityRef, Project } from './types'

/** the element lists of a project, by kind */
export const COLLECTIONS = {
  state: 'states',
  province: 'provinces',
  culture: 'cultures',
  religion: 'religions',
  zone: 'zones',
  institution: 'institutions',
  city: 'cities',
  route: 'routes',
  river: 'rivers',
  label: 'labels',
  marker: 'markers',
  regiment: 'regiments',
} as const satisfies Record<EntityKind, string>

type CollectionKey = (typeof COLLECTIONS)[EntityKind]
const COLLECTION_KEYS = Object.values(COLLECTIONS) as CollectionKey[]
const COLLECTION_SET = new Set<string>(COLLECTION_KEYS)

type Item = Base & Record<string, unknown>

/** does the element exist in this year? */
export const existsIn = (e: { begin?: number; end?: number }, year: number) => (e.begin == null || e.begin <= year) && (e.end == null || year < e.end)

/** how many of the changes (oldest first) have happened by `year` */
function appliedCount(history: Change[] | undefined, year: number) {
  let n = 0
  while (history && n < history.length && history[n].year <= year) n++
  return n
}

function applyChanges<T extends object>(base: T, history: Change[], count: number): T {
  const out = { ...base } as Record<string, unknown>
  for (let i = 0; i < count; i++) Object.assign(out, history[i].set)
  return out as T
}

/** an element as it was in `year` (whether it existed then or not) */
export function entityAt<T extends Base>(entity: T, year: number): T {
  const count = appliedCount(entity.history, year)
  return count ? applyChanges(entity, entity.history!, count) : entity
}

// ---------------------------------------------------------------------------------------------
// reading: the world in one year. Results are kept per element, so an element that did not change
// between two years stays the same object (the map and the styles see what changed by reference).

const entityMemo = new WeakMap<object, { count: number; value: Item }>()
function resolveEntity(entity: Item, year: number): Item {
  const count = appliedCount(entity.history, year)
  if (!count) return entity
  const hit = entityMemo.get(entity)
  if (hit && hit.count === count) return hit.value
  const value = applyChanges(entity, entity.history!, count)
  entityMemo.set(entity, { count, value })
  return value
}

const listMemo = new WeakMap<object, { year: number; out: Item[] }>()
function resolveList(items: Item[], year: number): Item[] {
  const previous = listMemo.get(items)
  if (previous?.year === year) return previous.out
  const out: Item[] = []
  for (const item of items) if (existsIn(item, year)) out.push(resolveEntity(item, year))
  const same = previous && previous.out.length === out.length && previous.out.every((x, i) => x === out[i])
  const result = same ? previous.out : out
  listMemo.set(items, { year, out: result })
  return result
}

/** the relations in force in `year` */
export function diplomacyAt(base: Record<string, string>, history: Change[] | undefined, year: number): Record<string, string> {
  const count = appliedCount(history, year)
  if (!count) return base
  const out = { ...base }
  for (let i = 0; i < count; i++) {
    for (const [key, value] of Object.entries(history![i].set)) {
      if (value) out[key] = value as string
      else delete out[key]
    }
  }
  return out
}

let lastWorld: { source: Project; year: number; world: Project } | null = null

/**
 * The world in `year`: only what exists then, each element with the changes up to then. Without a
 * timeline (or a year) the project is its own world.
 */
export function resolveWorld(project: Project, year: number | null): Project {
  if (year == null || !project.timeline) return project
  const out = { ...project } as Record<string, unknown>
  for (const key of COLLECTION_KEYS) out[key] = resolveList((project[key] ?? []) as unknown as Item[], year)
  out.diplomacy = diplomacyAt(project.diplomacy, project.diplomacyHistory, year)
  // the same source and the same picture in another year: keep the world object
  const last = lastWorld
  if (last?.source === project && last.world.diplomacy === out.diplomacy && COLLECTION_KEYS.every(k => last.world[k] === out[k])) {
    lastWorld = { source: project, year, world: last.world }
    return last.world
  }
  const world = out as unknown as Project
  lastWorld = { source: project, year, world }
  return world
}

// ---------------------------------------------------------------------------------------------
// writing: an edited world becomes changes in the project

/** fields that describe the element's life, not its state; never kept as a change */
const META = new Set(['id', 'begin', 'end', 'history'])

const norm = (v: unknown) => (v === undefined ? null : v)

function same(a: unknown, b: unknown, key: string) {
  a = norm(a)
  b = norm(b)
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  // shapes are compared by reference: a drawn change is always a new object
  if (key === 'geometry') return false
  return JSON.stringify(a) === JSON.stringify(b)
}

/** the place of the change in `year`, inserted when there is none yet */
function changeIndex(history: Change[], year: number) {
  let index = history.findIndex(c => c.year >= year)
  if (index < 0) index = history.length
  if (history[index]?.year !== year) history.splice(index, 0, { year, set: {} })
  return index
}

const emptyChange = (c: Change) => !Object.keys(c.set).length && !c.note && !c.event

/** writes the changed fields of one element */
function applyEdit(raw: Item, prev: Item, next: Item, year: number, start: number): Item {
  const changed: string[] = []
  let out: Item = raw
  for (const key of new Set([...Object.keys(prev), ...Object.keys(next)])) {
    if (key === 'id' || key === 'history' || same(prev[key], next[key], key)) continue
    if (META.has(key)) {
      out = { ...out }
      if (next[key] == null) delete out[key]
      else out[key] = next[key]
    } else changed.push(key)
  }
  if (!changed.length) return out
  const since = out.begin ?? start
  if (year <= since) {
    // the element's first state: write it there, and drop what earlier changes would put over it
    out = { ...out }
    for (const key of changed) {
      if (next[key] === undefined) delete out[key]
      else out[key] = next[key]
    }
    if (out.history) {
      const history = out.history
        .map(c => (c.year <= year && changed.some(k => k in c.set) ? { ...c, set: Object.fromEntries(Object.entries(c.set).filter(([k]) => !changed.includes(k))) } : c))
        .filter(c => !emptyChange(c))
      if (history.length) out.history = history
      else delete out.history
    }
    return out
  }
  const history = [...(out.history ?? [])]
  const index = changeIndex(history, year)
  const before = applyChanges(out, history, index)
  const set = { ...history[index].set }
  for (const key of changed) {
    const value = norm(next[key])
    if (same(before[key], value, key)) delete set[key]
    else set[key] = value
  }
  history[index] = { ...history[index], set }
  if (emptyChange(history[index])) history.splice(index, 1)
  out = { ...out, history }
  if (!history.length) delete out.history
  return out
}

function recordList(raw: Item[], prev: Item[], next: Item[], year: number, start: number): Item[] {
  const before = new Map(prev.map(e => [e.id, e]))
  const after = new Map(next.map(e => [e.id, e]))
  const known = new Set(raw.map(e => e.id))
  const out: Item[] = []
  for (const item of raw) {
    const p = before.get(item.id)
    // not there in this year: untouched
    if (!p) {
      out.push(item)
      continue
    }
    const n = after.get(item.id)
    if (!n) continue
    out.push(n === p ? item : applyEdit(item, p, n, year, start))
  }
  // new elements exist from the year they were added in
  for (const item of next) {
    if (before.has(item.id) || known.has(item.id)) continue
    out.push(year > start && item.begin == null ? { ...item, begin: year } : item)
  }
  return out
}

function recordDiplomacy(raw: Project, prev: Record<string, string>, next: Record<string, string>, year: number, start: number): Pick<Project, 'diplomacy' | 'diplomacyHistory'> {
  const changed = [...new Set([...Object.keys(prev), ...Object.keys(next)])].filter(k => (prev[k] ?? '') !== (next[k] ?? ''))
  let diplomacy = raw.diplomacy
  let history = [...(raw.diplomacyHistory ?? [])]
  if (!changed.length) return { diplomacy, diplomacyHistory: history }
  if (year <= start) {
    diplomacy = { ...diplomacy }
    for (const key of changed) {
      if (next[key]) diplomacy[key] = next[key]
      else delete diplomacy[key]
    }
    history = history.map(c => (c.year <= year ? { ...c, set: Object.fromEntries(Object.entries(c.set).filter(([k]) => !changed.includes(k))) } : c)).filter(c => !emptyChange(c))
    return { diplomacy, diplomacyHistory: history }
  }
  const index = changeIndex(history, year)
  const before = diplomacyAt(diplomacy, history, history[index - 1]?.year ?? -Infinity)
  const set = { ...history[index].set }
  for (const key of changed) {
    const value = next[key] ?? ''
    if ((before[key] ?? '') === value) delete set[key]
    else set[key] = value
  }
  history[index] = { ...history[index], set }
  if (emptyChange(history[index])) history.splice(index, 1)
  return { diplomacy, diplomacyHistory: history }
}

/**
 * The project after an edit of its world in `year`: what changed between `prev` and `next` (both
 * worlds of `raw` in that year) is written as changes in that year, or into the first state of an
 * element when the year is its first. Removed elements go for good; new ones begin in that year.
 */
export function record(raw: Project, prev: Project, next: Project, year: number | null): Project {
  if (prev === raw || year == null || !raw.timeline) return next
  const start = raw.timeline.start
  const out = { ...raw } as Record<string, unknown>
  const p = prev as unknown as Record<string, unknown>
  const n = next as unknown as Record<string, unknown>
  for (const key of Object.keys(n)) {
    if (COLLECTION_SET.has(key) || key === 'diplomacy') continue
    if (n[key] !== p[key]) out[key] = n[key]
  }
  for (const key of COLLECTION_KEYS) {
    if (n[key] !== p[key]) out[key] = recordList(raw[key] as unknown as Item[], p[key] as Item[], n[key] as Item[], year, start)
  }
  if (next.diplomacy !== prev.diplomacy) Object.assign(out, recordDiplomacy(raw, prev.diplomacy, next.diplomacy, year, start))
  return out as unknown as Project
}

// ---------------------------------------------------------------------------------------------
// removing: an element goes with every reference to it, in all years

/** single-id fields that point at an element of a kind */
const REF_FIELDS: Partial<Record<EntityKind, string[]>> = {
  state: ['stateId'],
  city: ['capitalId', 'seatId'],
  culture: ['cultureId'],
  religion: ['religionId'],
  river: ['parentId'],
}

function scrubFields(fields: Record<string, unknown>, kind: EntityKind, id: string): Record<string, unknown> {
  let out = fields
  const edit = () => (out === fields ? (out = { ...fields }) : out)
  for (const field of REF_FIELDS[kind] ?? []) if (fields[field] === id) edit()[field] = ''
  if ((kind === 'culture' || kind === 'religion') && Array.isArray(fields.origins) && fields.origins.includes(id)) edit().origins = (fields.origins as string[]).filter(o => o !== id)
  const junctions = fields.junctions as { start?: string; end?: string } | null | undefined
  if (kind === 'route' && junctions && (junctions.start === id || junctions.end === id)) {
    const rest = { start: junctions.start === id ? undefined : junctions.start, end: junctions.end === id ? undefined : junctions.end }
    // an element drops the field; a change keeps it as emptied
    const isElement = 'id' in fields
    edit().junctions = rest.start || rest.end ? rest : isElement ? undefined : null
  }
  return out
}

function scrubItem(item: Item, kind: EntityKind, id: string): Item {
  let out = scrubFields(item, kind, id) as Item
  if (item.history?.some(c => scrubFields(c.set, kind, id) !== c.set)) {
    out = { ...out, history: item.history.map(c => ({ ...c, set: scrubFields(c.set, kind, id) })) }
  }
  return out
}

const withoutStateKeys = (relations: Record<string, unknown>, id: string) => Object.fromEntries(Object.entries(relations).filter(([key]) => !key.split('>').includes(id)))

/** the project without an element, in every year, and without any reference to it */
export function removeFromProject(raw: Project, kind: EntityKind, id: string): Project {
  const out = { ...raw } as Record<string, unknown>
  out[COLLECTIONS[kind]] = (raw[COLLECTIONS[kind]] as unknown as Item[]).filter(e => e.id !== id)
  for (const key of COLLECTION_KEYS) {
    const items = out[key] as Item[]
    const scrubbed = items.map(item => scrubItem(item, kind, id))
    if (scrubbed.some((x, i) => x !== items[i])) out[key] = scrubbed
  }
  if (kind === 'state') {
    out.diplomacy = withoutStateKeys(raw.diplomacy, id)
    out.diplomacyHistory = (raw.diplomacyHistory ?? []).map(c => ({ ...c, set: withoutStateKeys(c.set, id) })).filter(c => !emptyChange(c))
  }
  if (raw.events?.some(e => e.refs.some(r => r.kind === kind && r.id === id))) {
    out.events = raw.events.map(e => ({ ...e, refs: e.refs.filter((r: EntityRef) => !(r.kind === kind && r.id === id)) }))
  }
  return out as unknown as Project
}

/** the project without an event; changes that named it lose the link */
export function removeEventFromProject(raw: Project, id: string): Project {
  const unlink = (c: Change) => (c.event === id ? (({ event: _, ...rest }) => rest)(c) : c)
  const out = { ...raw, events: raw.events.filter(e => e.id !== id), diplomacyHistory: (raw.diplomacyHistory ?? []).map(unlink) } as Record<string, unknown>
  for (const key of COLLECTION_KEYS) {
    const items = raw[key] as unknown as Item[]
    if (items.some(e => e.history?.some(c => c.event === id))) out[key] = items.map(e => (e.history?.some(c => c.event === id) ? { ...e, history: e.history.map(unlink) } : e))
  }
  return out as unknown as Project
}

// ---------------------------------------------------------------------------------------------
// the history of one element

/** a change moved to another year; it merges into a change already there (the moved one wins) */
export function moveChange<T extends Base>(entity: T, from: number, to: number): T {
  const history = [...(entity.history ?? [])]
  const index = history.findIndex(c => c.year === from)
  if (index < 0 || from === to) return entity
  const [moved] = history.splice(index, 1)
  const target = history.findIndex(c => c.year === to)
  if (target >= 0) history[target] = { ...history[target], ...moved, year: to, set: { ...history[target].set, ...moved.set } }
  else history.splice(changeIndex(history, to), 1, { ...moved, year: to })
  return { ...entity, history }
}

export function editChange<T extends Base>(entity: T, year: number, edit: (c: Change) => Change | null): T {
  const history = (entity.history ?? []).map(c => (c.year === year ? edit(c) : c)).filter((c): c is Change => !!c)
  const out: T = { ...entity, history }
  if (!history.length) delete (out as Base).history
  return out
}

/** every year in which something changes: elements begin or end, change, relations shift, events happen */
export function changeYears(project: Project): number[] {
  const years = new Set<number>()
  for (const key of COLLECTION_KEYS) {
    for (const e of project[key] as unknown as Item[]) {
      if (e.begin != null) years.add(e.begin)
      if (e.end != null) years.add(e.end)
      for (const c of e.history ?? []) years.add(c.year)
    }
  }
  for (const c of project.diplomacyHistory ?? []) years.add(c.year)
  for (const e of project.events ?? []) years.add(e.year)
  return [...years].sort((a, b) => a - b)
}

/** the years one element changes in */
export function entityYears(entity: Base): number[] {
  const years = new Set<number>()
  if (entity.begin != null) years.add(entity.begin)
  if (entity.end != null) years.add(entity.end)
  for (const c of entity.history ?? []) years.add(c.year)
  return [...years].sort((a, b) => a - b)
}

export interface YearEntry {
  kind: EntityKind
  id: string
  what: 'begin' | 'end' | 'change'
  fields: string[]
  change?: Change
}

/** what happens in one year, element by element */
export function happeningsIn(project: Project, year: number): YearEntry[] {
  const out: YearEntry[] = []
  for (const [kind, key] of Object.entries(COLLECTIONS) as [EntityKind, CollectionKey][]) {
    for (const e of project[key] as unknown as Item[]) {
      if (e.begin === year) out.push({ kind, id: e.id, what: 'begin', fields: [] })
      if (e.end === year) out.push({ kind, id: e.id, what: 'end', fields: [] })
      const change = e.history?.find(c => c.year === year)
      if (change) out.push({ kind, id: e.id, what: 'change', fields: Object.keys(change.set), change })
    }
  }
  return out
}

/** the world of one year as a timeless project: what does not exist then is gone, changes too */
export function flattenAt(raw: Project, year: number): Project {
  const world = resolveWorld(raw, year)
  const out = { ...raw, timeline: null, diplomacy: world.diplomacy, diplomacyHistory: [] } as Record<string, unknown>
  for (const key of COLLECTION_KEYS) {
    out[key] = (world[key] as unknown as Item[]).map(item => {
      const { begin: _b, end: _e, history: _h, ...rest } = item
      return rest
    })
  }
  return out as unknown as Project
}
