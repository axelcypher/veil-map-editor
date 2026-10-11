// The timeline. A project keeps every element as it first was, plus its dated changes; the map
// shows the world as it was in one year. Edits are made to that world as if it were a plain
// project and are then written back as changes in that year (`record`), so every tool works
// unchanged.
//
// Strands: one base strand, and strands derived from it (and from each other). A derived strand
// shows its parent's world – all of it, or only what is released there – plus its own entries:
// own elements, own events, and deviations (own changes on inherited elements). Every entry
// (element, change, event) belongs to one strand; `strand` absent means the base strand. Years are
// stored in the base strand's reckoning; each strand shows them shifted by its `zero`.
// Milestones (an ordered list) can limit releases, hidings and deviations to a stretch of them.
//
// Pure and without imports beyond types: other programs reading the project from the sync server
// (veil-agents) can copy this file to see the world of any strand in any year.
import type { Base, Change, EntityKind, EntityRef, Era, Owned, Project, Strand, Timeline, Visibility, WorldEvent } from './types'

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

export type CollectionKey = (typeof COLLECTIONS)[EntityKind]
const COLLECTION_KEYS = Object.values(COLLECTIONS) as CollectionKey[]
const COLLECTION_SET = new Set<string>(COLLECTION_KEYS)

type Item = Base & Record<string, unknown>

// ---------------------------------------------------------------------------------------------
// strands and their reckoning

/** the strand without parent */
export const baseStrand = (t: Timeline): Strand => t.strands.find(s => s.parent == null) ?? t.strands[0]

/** the strands from the base down to `id` (the base alone when `id` is unknown) */
export function chainOf(t: Timeline, id: string): Strand[] {
  const byId = new Map(t.strands.map(s => [s.id, s]))
  const chain: Strand[] = []
  let current = byId.get(id)
  while (current && !chain.includes(current)) {
    chain.unshift(current)
    current = current.parent ? byId.get(current.parent) : undefined
  }
  if (!chain.length || chain[0].parent != null) return [baseStrand(t)]
  return chain
}

export interface Reckoning {
  /** the base year that is year 0 in this strand */
  zero: number
  unit: string
  /** the stretch shown, in base years */
  start: number
  end: number
  /** in the strand's own years, oldest first */
  eras: Era[]
}

/** how a strand counts and what it shows; what it leaves open comes from its parent */
export function reckoningOf(t: Timeline, id: string): Reckoning {
  let out: Reckoning = { zero: 0, unit: '', start: 0, end: 1000, eras: [] }
  for (const s of chainOf(t, id)) {
    const zero = s.zero ?? out.zero
    out = {
      zero,
      unit: s.unit ?? out.unit,
      start: s.start != null ? zero + s.start : out.start,
      end: s.end != null ? zero + s.end : out.end,
      // inherited eras keep their place in time, counted in the own years
      eras: s.eras.length ? [...s.eras] : out.eras.map(e => ({ ...e, start: e.start + out.zero - zero })),
    }
  }
  out.eras.sort((a, b) => a.start - b.start)
  return out
}

export const toOwnYear = (r: Reckoning, baseYear: number) => baseYear - r.zero
export const toBaseYear = (r: Reckoning, ownYear: number) => ownYear + r.zero

/** a timeline in the old form (one range, no strands) becomes a single base strand */
export function migrateTimeline(t: unknown): Timeline | null {
  if (!t || typeof t !== 'object') return null
  const old = t as Partial<Timeline> & { start?: number; end?: number; unit?: string; eras?: Era[] }
  if (Array.isArray(old.strands) && old.strands.length) return { strands: old.strands, milestones: old.milestones ?? [], current: old.current ?? null }
  return {
    strands: [{ id: 'main', name: 'Hauptstrang', color: '#8f7aa4', parent: null, inherit: 'all', zero: 0, unit: old.unit ?? '', start: old.start ?? 0, end: old.end ?? 1000, eras: old.eras ?? [] }],
    milestones: [],
    current: null,
  }
}

// ---------------------------------------------------------------------------------------------
// what a view sees

/** a strand, and the milestone the story has reached (null: the timeline's current one) */
export interface View {
  strand: string
  milestone?: string | null
}

interface Context {
  /** unique per timeline and view: what results are kept under */
  key: string
  base: string
  /** strand ids from the base down to the strand shown */
  chain: string[]
  depth: Map<string, number>
  released: boolean[]
  /** index of the milestone shown; Infinity: no milestones */
  milestone: number
  milestones: Map<string, number>
  reckoning: Reckoning
}

const contexts = new WeakMap<Timeline, Map<string, Context>>()
let contextCount = 0
function contextOf(t: Timeline, view: View): Context {
  const milestoneId = view.milestone === undefined ? t.current : view.milestone
  const key = `${view.strand}|${milestoneId ?? ''}`
  let byKey = contexts.get(t)
  if (!byKey) contexts.set(t, (byKey = new Map()))
  const hit = byKey.get(key)
  if (hit) return hit
  const chain = chainOf(t, view.strand)
  const milestones = new Map(t.milestones.map((m, i) => [m.id, i]))
  const index = milestoneId != null ? milestones.get(milestoneId) : undefined
  const context: Context = {
    // another timeline object (a strand or milestone changed) gets other keys
    key: `${++contextCount}`,
    base: chain[0].id,
    chain: chain.map(s => s.id),
    depth: new Map(chain.map((s, i) => [s.id, i])),
    released: chain.map(s => s.inherit === 'released'),
    // no milestone (or an unknown one): everything, every correction included
    milestone: index ?? Infinity,
    milestones,
    reckoning: reckoningOf(t, view.strand),
  }
  byKey.set(key, context)
  return context
}

export const ownerOf = (entry: Owned, base: string) => entry.strand ?? base

/** is the milestone shown within from…until (milestone ids; absent: open)? */
function within(c: Context, from?: string, until?: string) {
  const f = from != null ? c.milestones.get(from) : undefined
  const u = until != null ? c.milestones.get(until) : undefined
  return (f == null || f <= c.milestone) && (u == null || c.milestone < u)
}

/**
 * Does an entry show in the view? It must belong to a strand of the chain above `limit` (the
 * length of the chain: the strand shown; one less: its parent), hold at the milestone shown, and on
 * every step below its owner be released (strands taking only what is released) or not hidden.
 */
function seen(entry: Owned, c: Context, limit = c.chain.length) {
  const k = c.depth.get(entry.strand ?? c.base)
  if (k == null || k >= limit) return false
  // a change may hold only for a stretch of milestones (an event's `until` is a year, not that)
  const span = entry as { from?: unknown; until?: unknown }
  if (!within(c, typeof span.from === 'string' ? span.from : undefined, typeof span.until === 'string' ? span.until : undefined)) return false
  for (let i = k + 1; i < limit; i++) {
    const v = entry.visibility?.[c.chain[i]]
    if (c.released[i]) {
      if (!(v?.show && within(c, v.from, v.until))) return false
    } else if (v && !v.show && within(c, v.from, v.until)) return false
  }
  return true
}

/** begin and end in the view: the deepest strand of the chain that set its own wins */
function lifeIn(e: Item, c: Context, limit = c.chain.length): { begin: number | null; end: number | null } {
  for (let i = limit - 1; i >= 0; i--) {
    const own = e.life?.[c.chain[i]]
    if (own) return own
  }
  return { begin: e.begin ?? null, end: e.end ?? null }
}

/** does the element exist in this year? */
export const existsIn = (e: { begin?: number | null; end?: number | null }, year: number) => (e.begin == null || e.begin <= year) && (e.end == null || year < e.end)

/** the changes of an element that count in the view, by year; in one year the deeper strand last */
function changesIn(e: Item, c: Context, limit = c.chain.length): Change[] {
  if (!e.history?.length) return []
  return e.history.filter(ch => seen(ch, c, limit)).sort((a, b) => a.year - b.year || (c.depth.get(a.strand ?? c.base) ?? 0) - (c.depth.get(b.strand ?? c.base) ?? 0))
}

function applyChanges<T extends object>(base: T, changes: Change[], count: number): T {
  const out = { ...base } as Record<string, unknown>
  for (let i = 0; i < count; i++) Object.assign(out, changes[i].set)
  return out as T
}

const countUpTo = (changes: Change[], year: number) => {
  let n = 0
  while (n < changes.length && changes[n].year <= year) n++
  return n
}

// Results are kept per element and view, so an element that did not change between two years stays
// the same object (the map and the styles see what changed by reference).
const entityMemo = new WeakMap<object, Map<string, { changes: Change[]; life: { begin: number | null; end: number | null }; count: number; value: Item }>>()
function resolveEntity(entity: Item, year: number, c: Context, limit = c.chain.length): Item {
  const key = `${c.key}|${limit}`
  let byView = entityMemo.get(entity)
  if (!byView) entityMemo.set(entity, (byView = new Map()))
  let hit = byView.get(key)
  if (!hit) {
    hit = { changes: changesIn(entity, c, limit), life: lifeIn(entity, c, limit), count: -1, value: entity }
    byView.set(key, hit)
  }
  const count = countUpTo(hit.changes, year)
  if (count !== hit.count) {
    let value = count ? applyChanges(entity, hit.changes, count) : entity
    // the begin and end of the strand shown
    if ((hit.life.begin ?? undefined) !== entity.begin || (hit.life.end ?? undefined) !== entity.end) {
      value = { ...value }
      if (hit.life.begin == null) delete value.begin
      else value.begin = hit.life.begin
      if (hit.life.end == null) delete value.end
      else value.end = hit.life.end
    }
    hit.count = count
    hit.value = value
  }
  return hit.value
}

/** an element as it was in `year` in the view (whether it existed then or not) */
export function entityAt<T extends Base>(entity: T, year: number, project?: Project, view?: View): T {
  const t = project?.timeline
  if (!t) {
    const changes = [...(entity.history ?? [])].sort((a, b) => a.year - b.year)
    return applyChanges(entity, changes, countUpTo(changes, year))
  }
  return resolveEntity(entity as unknown as Item, year, contextOf(t, view ?? { strand: baseStrand(t).id })) as unknown as T
}

const listMemo = new WeakMap<object, Map<string, { year: number; out: Item[] }>>()
function resolveList(items: Item[], year: number, c: Context, limit = c.chain.length, filter?: (e: Item) => boolean): Item[] {
  const key = `${c.key}|${limit}|${filter ? 'f' : ''}`
  let byView = listMemo.get(items)
  if (!byView) listMemo.set(items, (byView = new Map()))
  const previous = byView.get(key)
  if (previous?.year === year && !filter) return previous.out
  const out: Item[] = []
  for (const item of items) {
    if (filter && !filter(item)) continue
    if (!seen(item, c, limit) || !existsIn(lifeIn(item, c, limit), year)) continue
    out.push(resolveEntity(item, year, c, limit))
  }
  const same = previous && previous.out.length === out.length && previous.out.every((x, i) => x === out[i])
  const result = same ? previous.out : out
  byView.set(key, { year, out: result })
  return result
}

/** the relations in force in `year`: the first ones between states that show, then the changes that count */
function diplomacyIn(project: Project, year: number, c: Context, states: Set<string>): Record<string, string> {
  const changes = (project.diplomacyHistory ?? []).filter(ch => ch.year <= year && seen(ch, c)).sort((a, b) => a.year - b.year || (c.depth.get(a.strand ?? c.base) ?? 0) - (c.depth.get(b.strand ?? c.base) ?? 0))
  const base = project.diplomacy
  const filtered = Object.keys(base).every(key => key.split('>').every(id => states.has(id))) ? base : Object.fromEntries(Object.entries(base).filter(([key]) => key.split('>').every(id => states.has(id))))
  if (!changes.length) return filtered
  const out = { ...filtered }
  for (const ch of changes) {
    for (const [key, value] of Object.entries(ch.set)) {
      if (value) out[key] = value as string
      else delete out[key]
    }
  }
  return out
}

/** the relations in force in `year` (without strands) */
export function diplomacyAt(base: Record<string, string>, history: Change[] | undefined, year: number): Record<string, string> {
  const changes = (history ?? []).filter(c => c.year <= year).sort((a, b) => a.year - b.year)
  if (!changes.length) return base
  const out = { ...base }
  for (const ch of changes) {
    for (const [key, value] of Object.entries(ch.set)) {
      if (value) out[key] = value as string
      else delete out[key]
    }
  }
  return out
}

/** what the strand shown holds back of its parent's world: shown faintly, to be released */
export type Ghosts = Partial<Record<CollectionKey, Item[]>>
/** the world carries its held-back elements under this key (never stored) */
export const GHOSTS = '__ghosts'

let lastWorld: { source: Project; key: string; world: Project } | null = null

/**
 * The world of a strand in `year` (base years): only what shows there and exists then, each
 * element with the changes that count up to then. Without a timeline (or a year) the project is
 * its own world. `ghosts`: also gather what the parent shows and this strand holds back.
 */
export function resolveWorld(project: Project, year: number | null, view?: View, ghosts = false): Project {
  const t = project.timeline
  if (year == null || !t) return project
  const c = contextOf(t, view ?? { strand: baseStrand(t).id })
  const out = { ...project } as Record<string, unknown>
  for (const key of COLLECTION_KEYS) out[key] = resolveList((project[key] ?? []) as unknown as Item[], year, c)
  out.diplomacy = diplomacyIn(project, year, c, new Set((out.states as Item[]).map(s => s.id)))
  out.events = (project.events ?? []).filter(e => seen(e, c))
  if (ghosts && c.chain.length > 1) {
    const held: Ghosts = {}
    for (const key of COLLECTION_KEYS) {
      const shown = new Set((out[key] as Item[]).map(e => e.id))
      const list = resolveList((project[key] ?? []) as unknown as Item[], year, c, c.chain.length - 1, e => !shown.has(e.id))
      if (list.length) held[key] = list
    }
    out[GHOSTS] = held
  }
  // the same source and the same picture in another year: keep the world object
  const key = `${c.key}|${ghosts}`
  const last = lastWorld
  if (
    last?.source === project &&
    last.key === key &&
    last.world.diplomacy === out.diplomacy &&
    COLLECTION_KEYS.every(k => last.world[k] === out[k]) &&
    (last.world.events.length === (out.events as WorldEvent[]).length && last.world.events.every((e, i) => e === (out.events as WorldEvent[])[i])) &&
    !ghosts
  ) {
    lastWorld = { source: project, key, world: last.world }
    return last.world
  }
  const world = out as unknown as Project
  lastWorld = { source: project, key, world }
  return world
}

/** the events that show in the view (all of them without a timeline) */
export function eventsIn(project: Project, view: View, limit?: number): WorldEvent[] {
  const t = project.timeline
  if (!t) return project.events ?? []
  const c = contextOf(t, view)
  return (project.events ?? []).filter(e => seen(e, c, limit ?? c.chain.length))
}

/** can the entry be seen in the view (the strand shown, or with `parent` its parent)? */
export function visibleIn(project: Project, view: View, entry: Owned, parent = false): boolean {
  const t = project.timeline
  if (!t) return true
  const c = contextOf(t, view)
  return seen(entry, c, parent ? c.chain.length - 1 : c.chain.length)
}

/** the changes of an element that count in the view, in the order they apply */
export function changesOf(project: Project, view: View, entity: Base, parent = false): Change[] {
  const t = project.timeline
  if (!t) return entity.history ?? []
  const c = contextOf(t, view)
  return changesIn(entity as Item, c, parent ? c.chain.length - 1 : c.chain.length)
}

/** begin and end of an element in the view */
export function lifeOf(project: Project, view: View, entity: Base) {
  const t = project.timeline
  if (!t) return { begin: entity.begin ?? null, end: entity.end ?? null }
  return lifeIn(entity as Item, contextOf(t, view))
}

// ---------------------------------------------------------------------------------------------
// writing: an edited world becomes changes in the project

/** fields that describe the element's life and place, not its state; never kept as a change */
const META = new Set(['id', 'begin', 'end', 'history', 'strand', 'visibility', 'life'])

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

const emptyChange = (c: Change) => !Object.keys(c.set).length && !c.note && !c.event

/** a change of `strand` (undefined: the base) in `year`, inserted in year order when there is none yet */
function changeIndex(history: Change[], year: number, strand: string | undefined) {
  const found = history.findIndex(c => c.year === year && c.strand === strand)
  if (found >= 0) return found
  let index = history.findIndex(c => c.year > year)
  if (index < 0) index = history.length
  history.splice(index, 0, strand ? { year, set: {}, strand } : { year, set: {} })
  return index
}

interface Writer {
  /** new changes of a derived strand hold from this milestone on (the one picked in the view) */
  from?: string
  c: Context
  /** the strand edited in: the last of the chain */
  strand: string
  /** its id as stored on entries (undefined for the base) */
  stored: string | undefined
  year: number
}

/** writes the changed fields of one element */
function applyEdit(raw: Item, prev: Item, next: Item, w: Writer): Item {
  const { c, strand, stored, year } = w
  const own = ownerOf(raw, c.base) === strand
  const changed: string[] = []
  let out: Item = raw
  let lifeChanged = false
  for (const key of new Set([...Object.keys(prev), ...Object.keys(next)])) {
    if (key === 'id' || same(prev[key], next[key], key)) continue
    if (key === 'begin' || key === 'end') lifeChanged = true
    else if (!META.has(key)) changed.push(key)
  }
  if (lifeChanged) {
    out = { ...out }
    if (own) {
      for (const key of ['begin', 'end'] as const) {
        if (next[key] == null) delete out[key]
        else out[key] = next[key] as number
      }
    } else out.life = { ...out.life, [strand]: { begin: (next.begin as number | undefined) ?? null, end: (next.end as number | undefined) ?? null } }
  }
  if (!changed.length) return out
  const since = own ? (out.begin ?? c.reckoning.start) : -Infinity
  if (own && year <= since) {
    // the element's first state: write it there, and drop what earlier own changes would put over it
    out = { ...out }
    for (const key of changed) {
      if (next[key] === undefined) delete out[key]
      else out[key] = next[key]
    }
    if (out.history) {
      const history = out.history
        .map(ch => (ch.year <= year && ch.strand === stored && changed.some(k => k in ch.set) ? { ...ch, set: Object.fromEntries(Object.entries(ch.set).filter(([k]) => !changed.includes(k))) } : ch))
        .filter(ch => !emptyChange(ch))
      if (history.length) out.history = history
      else delete out.history
    }
    return out
  }
  // a change (or, on an element of another strand, a deviation) of the strand edited in
  const history = [...(out.history ?? [])]
  const fresh = !history.some(ch => ch.year === year && ch.strand === stored)
  const index = changeIndex(history, year, stored)
  if (fresh && w.from) history[index] = { ...history[index], from: w.from }
  const depth = c.depth.get(strand) ?? 0
  const earlier = changesIn({ ...out, history: history.filter((_, i) => i !== index) }, c).filter(ch => ch.year < year || (ch.year === year && (c.depth.get(ch.strand ?? c.base) ?? 0) < depth))
  const before = applyChanges(out, earlier, earlier.length)
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

const hideIn = <T extends Owned>(entry: T, strand: string): T => ({ ...entry, visibility: { ...entry.visibility, [strand]: { show: false } } })

function recordList(raw: Item[], prev: Item[], next: Item[], w: Writer): Item[] {
  const before = new Map(prev.map(e => [e.id, e]))
  const after = new Map(next.map(e => [e.id, e]))
  const known = new Set(raw.map(e => e.id))
  const out: Item[] = []
  for (const item of raw) {
    const p = before.get(item.id)
    // not there in this view and year: untouched
    if (!p) {
      out.push(item)
      continue
    }
    const n = after.get(item.id)
    // gone from the world: an own element goes for good, one of another strand is hidden here
    if (!n) {
      if (ownerOf(item, w.c.base) !== w.strand) out.push(hideIn(item, w.strand))
      continue
    }
    out.push(n === p ? item : applyEdit(item, p, n, w))
  }
  // new elements belong to the strand edited in and exist from the year they were added in
  for (const item of next) {
    if (before.has(item.id) || known.has(item.id)) continue
    let added: Item = w.stored ? { ...item, strand: w.stored } : item
    if (w.year > w.c.reckoning.start && added.begin == null) added = { ...added, begin: w.year }
    out.push(added)
  }
  return out
}

function recordDiplomacy(raw: Project, prev: Record<string, string>, next: Record<string, string>, w: Writer): Pick<Project, 'diplomacy' | 'diplomacyHistory'> {
  const changed = [...new Set([...Object.keys(prev), ...Object.keys(next)])].filter(k => (prev[k] ?? '') !== (next[k] ?? ''))
  let diplomacy = raw.diplomacy
  let history = [...(raw.diplomacyHistory ?? [])]
  if (!changed.length) return { diplomacy, diplomacyHistory: history }
  if (!w.stored && w.year <= w.c.reckoning.start) {
    diplomacy = { ...diplomacy }
    for (const key of changed) {
      if (next[key]) diplomacy[key] = next[key]
      else delete diplomacy[key]
    }
    history = history.map(c => (c.year <= w.year && !c.strand ? { ...c, set: Object.fromEntries(Object.entries(c.set).filter(([k]) => !changed.includes(k))) } : c)).filter(c => !emptyChange(c))
    return { diplomacy, diplomacyHistory: history }
  }
  const fresh = !history.some(ch => ch.year === w.year && ch.strand === w.stored)
  const index = changeIndex(history, w.year, w.stored)
  if (fresh && w.from) history[index] = { ...history[index], from: w.from }
  const depth = w.c.depth.get(w.strand) ?? 0
  const counted = history.filter((ch, i) => i !== index && (ch.year < w.year || (ch.year === w.year && (w.c.depth.get(ch.strand ?? w.c.base) ?? 0) < depth)) && seen(ch, w.c))
  const before = diplomacyAt(diplomacy, counted, w.year)
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
 * The project after an edit of its world in `year` (base years) in a strand: what changed between
 * `prev` and `next` (both worlds of `raw` in that view and year) is written as changes of that
 * strand in that year, or into the first state of an own element in its first year. Removed own
 * elements go for good, removed inherited ones are hidden in the strand; new ones belong to the
 * strand and begin in that year.
 */
export function record(raw: Project, prev: Project, next: Project, year: number | null, view?: View): Project {
  const t = raw.timeline
  if (prev === raw || year == null || !t) return next
  const c = contextOf(t, view ?? { strand: baseStrand(t).id })
  const strand = c.chain[c.chain.length - 1]
  // a milestone picked on purpose: what a derived strand changes now holds from there on
  const from = strand !== c.base && typeof view?.milestone === 'string' ? view.milestone : undefined
  const w: Writer = { c, strand, stored: strand === c.base ? undefined : strand, year, from }
  const out = { ...raw } as Record<string, unknown>
  const p = prev as unknown as Record<string, unknown>
  const n = next as unknown as Record<string, unknown>
  for (const key of Object.keys(n)) {
    if (COLLECTION_SET.has(key) || key === 'diplomacy' || key === 'events' || key === GHOSTS) continue
    if (n[key] !== p[key]) out[key] = n[key]
  }
  for (const key of COLLECTION_KEYS) {
    if (n[key] !== p[key]) out[key] = recordList(raw[key] as unknown as Item[], p[key] as Item[], n[key] as Item[], w)
  }
  if (next.diplomacy !== prev.diplomacy) Object.assign(out, recordDiplomacy(raw, prev.diplomacy, next.diplomacy, w))
  return out as unknown as Project
}

// ---------------------------------------------------------------------------------------------
// removing: an element goes with every reference to it, in all years and strands

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

/** the project without an element, in every year and strand, and without any reference to it */
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

const unlinkEvent = (c: Change, id: string) => (c.event === id ? (({ event: _, ...rest }) => rest)(c) : c)

/** the project without an event; changes that named it lose the link */
export function removeEventFromProject(raw: Project, id: string): Project {
  const out = { ...raw, events: raw.events.filter(e => e.id !== id), diplomacyHistory: (raw.diplomacyHistory ?? []).map(c => unlinkEvent(c, id)) } as Record<string, unknown>
  for (const key of COLLECTION_KEYS) {
    const items = raw[key] as unknown as Item[]
    if (items.some(e => e.history?.some(c => c.event === id))) out[key] = items.map(e => (e.history?.some(c => c.event === id) ? { ...e, history: e.history.map(c => unlinkEvent(c, id)) } : e))
  }
  return out as unknown as Project
}

/**
 * The project without a strand (one no other strand derives from): its own elements, changes and
 * events go, and so does whatever other entries say about it (releases, hidings, begin and end).
 */
export function removeStrandFromProject(raw: Project, strandId: string): Project {
  const t = raw.timeline
  if (!t || t.strands.some(s => s.parent === strandId) || baseStrand(t).id === strandId) return raw
  let out: Project = raw
  // own elements, with every reference to them
  for (const [kind, key] of Object.entries(COLLECTIONS) as [EntityKind, CollectionKey][]) {
    for (const e of (raw[key] as unknown as Item[]).filter(x => x.strand === strandId)) out = removeFromProject(out, kind, e.id)
  }
  for (const e of out.events.filter(x => x.strand === strandId)) out = removeEventFromProject(out, e.id)
  const clean = <T extends Owned>(entry: T): T => {
    if (!entry.visibility?.[strandId]) return entry
    const { [strandId]: _, ...visibility } = entry.visibility
    return { ...entry, visibility }
  }
  const result = { ...out, timeline: { ...t, strands: t.strands.filter(s => s.id !== strandId) } } as Record<string, unknown>
  for (const key of COLLECTION_KEYS) {
    result[key] = (out[key] as unknown as Item[]).map(e => {
      let x = clean(e)
      if (x.life?.[strandId]) {
        const { [strandId]: _, ...life } = x.life
        x = { ...x, life }
      }
      if (x.history?.some(c => c.strand === strandId || c.visibility?.[strandId])) x = { ...x, history: x.history!.filter(c => c.strand !== strandId).map(clean) }
      return x
    })
  }
  result.events = out.events.map(clean)
  result.diplomacyHistory = (out.diplomacyHistory ?? []).filter(c => c.strand !== strandId).map(clean)
  return result as unknown as Project
}

// ---------------------------------------------------------------------------------------------
// entries between strands, releases

const sameOwner = (a: Owned, b: string | undefined) => a.strand === b

/** a change of an element addressed by year and strand */
export interface ChangeRef {
  year: number
  strand?: string
}
const isChange = (c: Change, ref: ChangeRef) => c.year === ref.year && c.strand === ref.strand

/** the change moved to another year; it merges into a change of the same strand already there (the moved one wins) */
export function moveChange<T extends Base>(entity: T, ref: ChangeRef, to: number): T {
  const history = [...(entity.history ?? [])]
  const index = history.findIndex(c => isChange(c, ref))
  if (index < 0 || ref.year === to) return entity
  const [moved] = history.splice(index, 1)
  const target = history.findIndex(c => c.year === to && sameOwner(c, ref.strand))
  if (target >= 0) history[target] = { ...history[target], ...moved, year: to, set: { ...history[target].set, ...moved.set } }
  else history.splice(changeIndex(history, to, ref.strand), 1, { ...moved, year: to })
  return { ...entity, history }
}

export function editChange<T extends Base>(entity: T, ref: ChangeRef, edit: (c: Change) => Change | null): T {
  const history = (entity.history ?? []).map(c => (isChange(c, ref) ? edit(c) : c)).filter((c): c is Change => !!c)
  const out: T = { ...entity, history }
  if (!history.length) delete (out as Base).history
  return out
}

/** the strand id as stored: undefined for the base */
export const storedStrand = (t: Timeline, strand: string) => (strand === baseStrand(t).id ? undefined : strand)

/** a change given to another strand (copy: also kept); it merges into that strand's change of the same year */
export function changeToStrand<T extends Base>(t: Timeline, entity: T, ref: ChangeRef, target: string, copy: boolean): T {
  const history = [...(entity.history ?? [])]
  const index = history.findIndex(c => isChange(c, ref))
  const to = storedStrand(t, target)
  if (index < 0 || ref.strand === to) return entity
  const change = history[index]
  if (!copy) history.splice(index, 1)
  const { strand: _s, visibility: _v, ...rest } = change
  const there = history.findIndex(c => c.year === change.year && c.strand === to)
  if (there >= 0) history[there] = { ...history[there], ...rest, set: { ...history[there].set, ...change.set }, ...(to ? { strand: to } : {}) }
  else history.splice(changeIndex(history, change.year, to), 1, { ...rest, ...(to ? { strand: to } : {}) })
  return { ...entity, history }
}

/** an element given to another strand, with its changes of the old strand (deviations of other strands stay) */
export function elementToStrand<T extends Base>(t: Timeline, entity: T, target: string): T {
  const from = entity.strand
  const to = storedStrand(t, target)
  if (from === to) return entity
  const out = { ...entity } as T & Base
  if (to) out.strand = to
  else delete out.strand
  if (out.history) out.history = out.history.map(c => (c.strand === from ? (to ? { ...c, strand: to } : (({ strand: _, ...rest }) => rest)(c)) : c))
  return out
}

/** a copy of an element for another strand: new id, its state and the changes of its own strand */
export function copyElement<T extends Base>(t: Timeline, entity: T, target: string, id: string): T {
  const to = storedStrand(t, target)
  const { strand: _s, visibility: _v, life: _l, history, ...rest } = entity
  const own = (history ?? []).filter(c => c.strand === entity.strand).map(({ strand: _x, visibility: _y, ...c }) => (to ? { ...c, strand: to } : c))
  return { ...rest, id, ...(to ? { strand: to } : {}), ...(own.length ? { history: own } : {}) } as unknown as T
}

/** an event given to another strand */
export function eventToStrand(t: Timeline, event: WorldEvent, target: string): WorldEvent {
  const to = storedStrand(t, target)
  const { strand: _, ...rest } = event
  return to ? { ...rest, strand: to } : rest
}

/** releases (or, with null, withdraws) an entry in a strand; in a strand inheriting all, show: false hides it */
export function setVisibility<T extends Owned>(entry: T, strand: string, visibility: Visibility | null): T {
  const rest = { ...entry.visibility }
  if (visibility) rest[strand] = visibility
  else delete rest[strand]
  const out: T = { ...entry, visibility: rest }
  if (!Object.keys(rest).length) delete (out as Owned).visibility
  return out
}

/** is the entry released (or not hidden) in exactly this strand? */
export function shownIn(t: Timeline, entry: Owned, strand: string): boolean {
  const s = t.strands.find(x => x.id === strand)
  const v = entry.visibility?.[strand]
  return s?.inherit === 'released' ? !!v?.show : !(v && !v.show)
}

// ---------------------------------------------------------------------------------------------
// reading the history

/** every year (base years) in which something changes in the view */
export function changeYears(project: Project, view?: View): number[] {
  const t = project.timeline
  const years = new Set<number>()
  const c = t ? contextOf(t, view ?? { strand: baseStrand(t).id }) : null
  const counts = (entry: Owned) => !c || seen(entry, c)
  for (const key of COLLECTION_KEYS) {
    for (const e of project[key] as unknown as Item[]) {
      if (!counts(e)) continue
      const life = c ? lifeIn(e, c) : { begin: e.begin, end: e.end }
      if (life.begin != null) years.add(life.begin)
      if (life.end != null) years.add(life.end)
      for (const ch of e.history ?? []) if (counts(ch)) years.add(ch.year)
    }
  }
  for (const ch of project.diplomacyHistory ?? []) if (counts(ch)) years.add(ch.year)
  for (const e of project.events ?? []) if (counts(e)) years.add(e.year)
  return [...years].sort((a, b) => a - b)
}

/** the years one element changes in, in the view */
export function entityYears(entity: Base, project?: Project, view?: View): number[] {
  const t = project?.timeline
  const c = t ? contextOf(t, view ?? { strand: baseStrand(t).id }) : null
  const years = new Set<number>()
  const life = c ? lifeIn(entity as Item, c) : { begin: entity.begin, end: entity.end }
  if (life.begin != null) years.add(life.begin)
  if (life.end != null) years.add(life.end)
  for (const ch of entity.history ?? []) if (!c || seen(ch, c)) years.add(ch.year)
  return [...years].sort((a, b) => a - b)
}

export interface YearEntry {
  kind: EntityKind
  id: string
  what: 'begin' | 'end' | 'change'
  fields: string[]
  change?: Change
}

/** what happens in one year (base years) in the view, element by element */
export function happeningsIn(project: Project, year: number, view?: View): YearEntry[] {
  const t = project.timeline
  const c = t ? contextOf(t, view ?? { strand: baseStrand(t).id }) : null
  const out: YearEntry[] = []
  for (const [kind, key] of Object.entries(COLLECTIONS) as [EntityKind, CollectionKey][]) {
    for (const e of project[key] as unknown as Item[]) {
      if (c && !seen(e, c)) continue
      const life = c ? lifeIn(e, c) : { begin: e.begin, end: e.end }
      if (life.begin === year) out.push({ kind, id: e.id, what: 'begin', fields: [] })
      if (life.end === year) out.push({ kind, id: e.id, what: 'end', fields: [] })
      for (const change of e.history ?? []) {
        if (change.year === year && (!c || seen(change, c))) out.push({ kind, id: e.id, what: 'change', fields: Object.keys(change.set), change })
      }
    }
  }
  return out
}

/** the world of one year and strand as a timeless project: what does not exist then is gone, changes too */
export function flattenAt(raw: Project, year: number, view?: View): Project {
  const world = resolveWorld(raw, year, view)
  const out = { ...raw, timeline: null, diplomacy: world.diplomacy, diplomacyHistory: [], events: world.events.map(({ strand: _s, visibility: _v, ...e }) => e) } as Record<string, unknown>
  for (const key of COLLECTION_KEYS) {
    out[key] = (world[key] as unknown as Item[]).map(item => {
      const { begin: _b, end: _e, history: _h, strand: _s, visibility: _v, life: _l, ...rest } = item
      return rest
    })
  }
  return out as unknown as Project
}

// ---------------------------------------------------------------------------------------------
// comparing two views

export interface Difference {
  kind: EntityKind
  id: string
  /** only in the first view, only in the second, or in both but different */
  what: 'a' | 'b' | 'changed'
  /** the fields that differ */
  fields: string[]
}

/** how the worlds of two views differ in one year (base years) */
export function compareViews(project: Project, year: number, a: View, b: View): Difference[] {
  const left = resolveWorld(project, year, a)
  const right = resolveWorld(project, year, b)
  const out: Difference[] = []
  for (const [kind, key] of Object.entries(COLLECTIONS) as [EntityKind, CollectionKey][]) {
    const there = new Map((right[key] as unknown as Item[]).map(e => [e.id, e]))
    for (const e of left[key] as unknown as Item[]) {
      const other = there.get(e.id)
      if (!other) {
        out.push({ kind, id: e.id, what: 'a', fields: [] })
        continue
      }
      there.delete(e.id)
      if (other === e) continue
      const fields = [...new Set([...Object.keys(e), ...Object.keys(other)])].filter(k => !META.has(k) && !(k === 'geometry' ? e[k] === other[k] || JSON.stringify(e[k]) === JSON.stringify(other[k]) : same(e[k], other[k], k)))
      if (fields.length) out.push({ kind, id: e.id, what: 'changed', fields })
    }
    for (const e of there.values()) out.push({ kind, id: e.id, what: 'b', fields: [] })
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// releasing: what a derived strand takes over from its parent

/** lets an entry show in the strand: released there, or no longer hidden */
export function showEntry<T extends Owned>(t: Timeline, entry: T, strand: string, from?: string): T {
  const s = t.strands.find(x => x.id === strand)
  if (s?.inherit === 'released') return setVisibility(entry, strand, from ? { show: true, from } : { show: true })
  return setVisibility(entry, strand, null)
}

/** keeps an entry back in the strand: no longer released there, or hidden */
export function holdEntry<T extends Owned>(t: Timeline, entry: T, strand: string): T {
  const s = t.strands.find(x => x.id === strand)
  if (s?.inherit === 'released') return setVisibility(entry, strand, null)
  return setVisibility(entry, strand, { show: false })
}

export interface HeldEntry {
  type: 'element' | 'change' | 'relation' | 'event'
  kind?: EntityKind
  /** the element's or event's id */
  id: string
  change?: Change
}

/** what the strand shown holds back of its parent's world in a year (base years) */
export function heldIn(project: Project, view: View, year: number): HeldEntry[] {
  const t = project.timeline
  if (!t) return []
  const c = contextOf(t, view)
  const parent = c.chain.length - 1
  if (parent < 1) return []
  const out: HeldEntry[] = []
  for (const [kind, key] of Object.entries(COLLECTIONS) as [EntityKind, CollectionKey][]) {
    for (const e of project[key] as unknown as Item[]) {
      if (!seen(e, c, parent)) continue
      if (!seen(e, c) && lifeIn(e, c, parent).begin === year) out.push({ type: 'element', kind, id: e.id })
      for (const ch of e.history ?? []) if (ch.year === year && seen(ch, c, parent) && !seen(ch, c)) out.push({ type: 'change', kind, id: e.id, change: ch })
    }
  }
  for (const ch of project.diplomacyHistory ?? []) if (ch.year === year && seen(ch, c, parent) && !seen(ch, c)) out.push({ type: 'relation', id: '', change: ch })
  for (const e of project.events ?? []) if (e.year === year && seen(e, c, parent) && !seen(e, c)) out.push({ type: 'event', id: e.id })
  return out
}

/**
 * The project with some entries of the parent's world shown in the strand: `element` decides per
 * element, `change` per change (of an element, or of the relations: then without element), `event`
 * per event. Only what the parent shows and the strand holds back is touched.
 */
function release(
  project: Project,
  view: View,
  pick: { element?: (e: Item, life: { begin: number | null; end: number | null }) => boolean; change?: (ch: Change, e: Item | null) => boolean; event?: (e: WorldEvent) => boolean },
  from?: string,
): Project {
  const t = project.timeline
  if (!t) return project
  const c = contextOf(t, view)
  const parent = c.chain.length - 1
  if (parent < 1) return project
  const strand = c.chain[parent]
  const held = (entry: Owned) => seen(entry, c, parent) && !seen(entry, c)
  const out = { ...project } as Record<string, unknown>
  for (const key of COLLECTION_KEYS) {
    const items = project[key] as unknown as Item[]
    let touched = false
    const next = items.map(e => {
      if (!seen(e, c, parent)) return e
      let x = e
      if (held(e) && pick.element?.(e, lifeIn(e, c, parent))) x = showEntry(t, x, strand, from)
      if (pick.change && x.history?.some(ch => held(ch) && pick.change!(ch, e))) x = { ...x, history: x.history!.map(ch => (held(ch) && pick.change!(ch, e) ? showEntry(t, ch, strand, from) : ch)) }
      if (x !== e) touched = true
      return x
    })
    if (touched) out[key] = next
  }
  if (pick.change && (project.diplomacyHistory ?? []).some(ch => held(ch) && pick.change!(ch, null))) {
    out.diplomacyHistory = project.diplomacyHistory.map(ch => (held(ch) && pick.change!(ch, null) ? showEntry(t, ch, strand, from) : ch))
  }
  if (pick.event && project.events.some(e => held(e) && pick.event!(e))) out.events = project.events.map(e => (held(e) && pick.event!(e) ? showEntry(t, e, strand, from) : e))
  return out as unknown as Project
}

/** releases an element in the strand shown; with `upTo` also its changes up to that year */
export const releaseElement = (project: Project, view: View, id: string, upTo: number | null, from?: string) =>
  release(project, view, { element: e => e.id === id, change: (ch, e) => upTo != null && e?.id === id && ch.year <= upTo }, from)

/** releases an event with every change that names it */
export const releaseEvent = (project: Project, view: View, id: string, from?: string) =>
  release(project, view, { event: e => e.id === id, change: ch => ch.event === id }, from)

/** releases everything the strand holds back in a year: elements beginning, changes, relations, events */
export const releaseYear = (project: Project, view: View, year: number, from?: string) =>
  release(project, view, { element: (_, life) => life.begin === year, change: ch => ch.year === year, event: e => e.year === year }, from)
