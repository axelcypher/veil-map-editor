// Application state. The project is immutable: every change builds a new object, which makes undo
// a list of earlier roots and lets the map see what changed by reference.
//
// `source` is the project as stored: every element with its dated changes. `project` is the world
// in the year shown, what the map, the lists and all tools work on; an edit of it is written back
// into `source` as changes in that year (see timeline.ts). Without a timeline both are the same.
import { batch, computed, signal } from '@preact/signals'
import { newProject } from './project'
import { baseStrand, reckoningOf, record, removeFromProject, resolveWorld, storedStrand, type View } from './timeline'
import { COLLECTION, type AreaKind, type Entity, type EntityKind, type EntityMap, type Project } from './types'

export const source = signal<Project>(newProject())
/** the year the world is shown in, in base years; null when the project has no timeline */
export const year = signal<number | null>(null)
/** the strand shown; '' until there is a timeline */
export const strand = signal('')
/** the milestone shown; undefined: the timeline's current one, null: all */
export const milestone = signal<string | null | undefined>(undefined)
/** show what the strand holds back of its parent, faintly */
export const showHeld = signal(false)

/** the strand id, made valid for the project (unknown: the base) */
function validStrand(p: Project, wanted: string | undefined) {
  const t = p.timeline
  if (!t) return ''
  return t.strands.some(s => s.id === wanted) ? wanted! : baseStrand(t).id
}

export const view = computed<View>(() => ({ strand: strand.value, milestone: milestone.value }))
export const project = computed<Project>(() => resolveWorld(source.value, year.value, view.value, showHeld.value))
/** how the strand shown counts its years */
export const reckoning = computed(() => {
  const t = source.value.timeline
  return t ? reckoningOf(t, strand.value) : null
})

/** the year in the shown strand's stretch (base years), or null without a timeline */
export function clampYear(p: Project, wanted: number | null | undefined, strandId = strand.peek()): number | null {
  const t = p.timeline
  if (!t) return null
  const r = reckoningOf(t, validStrand(p, strandId))
  return Math.round(Math.min(r.end, Math.max(r.start, wanted ?? r.end)))
}

/** remembered with the view, per device; the view is no undo step and no reason to save */
function rememberView() {
  const p = source.peek()
  p.view = { ...p.view, year: year.peek() ?? undefined, strand: strand.peek() || undefined, milestone: milestone.peek() }
}

/** shows the world in another year (base years) */
export function setYear(wanted: number) {
  const next = clampYear(source.peek(), wanted)
  if (next === year.peek()) return
  year.value = next
  rememberView()
}

/** shows another strand; the year stays where it is in time, as far as the strand's stretch allows */
export function setStrand(id: string) {
  const p = source.peek()
  const next = validStrand(p, id)
  batch(() => {
    strand.value = next
    year.value = clampYear(p, year.peek(), next)
  })
  rememberView()
}

export function setMilestone(id: string | null | undefined) {
  milestone.value = id
  rememberView()
}

/** the strand edited in, as stored on entries (undefined: the base) */
export const editStrand = () => {
  const t = source.peek().timeline
  return t ? storedStrand(t, strand.peek()) : undefined
}

/** keeps strand and year valid after the stored project changed */
function settleView(p: Project) {
  const s = validStrand(p, strand.peek())
  if (s !== strand.peek()) strand.value = s
  year.value = clampYear(p, year.peek(), s)
  if (!p.timeline) milestone.value = undefined
}
export const filePath = signal<string | null>(null)
export const dirty = signal(false)

export interface Selection {
  kind: EntityKind
  id: string
}
export const selection = signal<Selection | null>(null)

export type MeasureMode = 'ruler' | 'path' | 'area'
export type Tool =
  | { id: 'select' }
  | { id: 'place'; kind: 'city' | 'marker' | 'regiment' | 'label' }
  | { id: 'draw-line'; kind: 'route' | 'label' }
  | { id: 'area-new'; kind: AreaKind }
  | { id: 'area-add' | 'area-subtract' | 'area-island'; kind: AreaKind; entityId: string }
  | { id: 'vertices' }
  | { id: 'reshape'; entityId: string }
  | { id: 'measure'; mode: MeasureMode }
  | { id: 'pick'; purpose: string }

export const tool = signal<Tool>({ id: 'select' })
/** the type new markers, routes and labels get */
function storedNumber(key: string, fallback: number) {
  try {
    const value = Number(localStorage.getItem(key))
    return localStorage.getItem(key) != null && Number.isFinite(value) ? value : fallback
  } catch {
    return fallback
  }
}
/** how strongly freehand strokes are smoothed, 0 = off; remembered per machine */
export const freehandSmoothing = signal(storedNumber('veil.smoothing', 3))
freehandSmoothing.subscribe(value => {
  try {
    localStorage.setItem('veil.smoothing', String(value))
  } catch {
    /* storage blocked */
  }
})

/** draw freehand without holding Shift – for touch screens */
export const freehand = signal(false)
/** a tap on a vertex deletes it, instead of Alt+click */
export const deleteVertices = signal(false)

/** route points snap onto cities; remembered per machine */
export const snapCities = signal(storedNumber('veil.snapCities', 1) === 1)
snapCities.subscribe(value => {
  try {
    localStorage.setItem('veil.snapCities', value ? '1' : '0')
  } catch {
    /* storage blocked */
  }
})

export const placeType = signal<Record<string, string>>({ marker: 'poi', route: 'road', city: 'town' })
/** a coordinate picked on the map for a form (control points) */
export const picked = signal<{ purpose: string; lonLat: [number, number] } | null>(null)

export interface Notice {
  id: number
  kind: 'info' | 'error' | 'ok'
  text: string
}
export const notices = signal<Notice[]>([])
let noticeId = 0
export function notify(text: string, kind: Notice['kind'] = 'info') {
  const id = ++noticeId
  notices.value = [...notices.value, { id, kind, text }]
  setTimeout(() => { notices.value = notices.value.filter(n => n.id !== id) }, kind === 'error' ? 9000 : 4500)
}

export const busy = signal<{ stage: string; fraction: number } | null>(null)

const past: Project[] = []
const future: Project[] = []
const historyVersion = signal(0)
let lastMerge: { key: string; at: number } | null = null
export const canUndo = computed(() => (historyVersion.value, past.length > 0))
export const canRedo = computed(() => (historyVersion.value, future.length > 0))

/**
 * Replace the world shown: the differences are written into the stored project, in the year
 * shown. `merge` folds quick successive edits of the same thing (typing into a field) into one
 * undo step.
 */
export function commit(next: Project, merge?: string) {
  commitSource(record(source.peek(), project.peek(), next, year.peek(), view.peek()), merge)
}

/** replaces the stored project itself, history and all */
export function commitSource(next: Project, merge?: string) {
  const now = Date.now()
  const merging = merge && lastMerge && lastMerge.key === merge && now - lastMerge.at < 1500
  if (!merging) {
    past.push(source.peek())
    if (past.length > 200) past.shift()
  }
  future.length = 0
  lastMerge = merge ? { key: merge, at: now } : null
  batch(() => {
    source.value = next
    settleView(next)
    dirty.value = true
    historyVersion.value++
    fixSelection()
  })
}

export function undo() {
  const previous = past.pop()
  if (!previous) return
  future.push(source.peek())
  lastMerge = null
  batch(() => {
    source.value = previous
    settleView(previous)
    dirty.value = true
    historyVersion.value++
    fixSelection()
  })
}

export function redo() {
  const next = future.pop()
  if (!next) return
  past.push(source.peek())
  lastMerge = null
  batch(() => {
    source.value = next
    settleView(next)
    dirty.value = true
    historyVersion.value++
    fixSelection()
  })
}

/** bumps when a project is loaded or created, so the map takes over its saved view */
export const projectLoaded = signal(0)

/** a new or loaded project: no history */
export function resetProject(next: Project, path: string | null) {
  past.length = 0
  future.length = 0
  lastMerge = null
  batch(() => {
    source.value = next
    strand.value = validStrand(next, next.view.strand)
    milestone.value = next.view.milestone
    showHeld.value = false
    year.value = clampYear(next, next.view.year, strand.value)
    filePath.value = path
    dirty.value = false
    selection.value = null
    tool.value = { id: 'select' }
    historyVersion.value++
    projectLoaded.value++
  })
}

function fixSelection() {
  const s = selection.peek()
  if (s && !findEntity(s.kind, s.id)) selection.value = null
}
// an element that does not show in the year and strand now shown is no longer selected
project.subscribe(() => fixSelection())

export function list<K extends EntityKind>(kind: K, p: Project = project.value): EntityMap[K][] {
  return p[COLLECTION[kind]] as unknown as EntityMap[K][]
}

export function findEntity<K extends EntityKind>(kind: K, id: string, p: Project = project.value): EntityMap[K] | undefined {
  return list(kind, p).find(e => e.id === id)
}

export const selectedEntity = computed<Entity | null>(() => {
  const s = selection.value
  return s ? (findEntity(s.kind, s.id, project.value) ?? null) : null
})

function withList<K extends EntityKind>(p: Project, kind: K, items: EntityMap[K][]): Project {
  return { ...p, [COLLECTION[kind]]: items }
}

export function addEntity<K extends EntityKind>(kind: K, entity: EntityMap[K], select = true) {
  commit(withList(project.value, kind, [...list(kind), entity]))
  if (select) selection.value = { kind, id: entity.id }
}

export function addEntities<K extends EntityKind>(kind: K, entities: EntityMap[K][]) {
  commit(withList(project.value, kind, [...list(kind), ...entities]))
}

export function updateEntity<K extends EntityKind>(kind: K, id: string, patch: Partial<EntityMap[K]>, merge?: string) {
  const items = list(kind).map(e => (e.id === id ? { ...e, ...patch } : e))
  commit(withList(project.value, kind, items), merge ? `${kind}:${id}:${merge}` : undefined)
}

/** several elements of one kind in one undo step */
export function updateMany<K extends EntityKind>(kind: K, patches: Map<string, Partial<EntityMap[K]>>) {
  if (!patches.size) return
  const items = list(kind).map(e => (patches.has(e.id) ? { ...e, ...patches.get(e.id) } : e))
  commit(withList(project.value, kind, items))
}

/**
 * Deletes an element for good, in every year, with every reference to it (loose references are
 * cleared, never left dangling). To let it end in a year, set its `end` instead.
 */
export function removeEntity(kind: EntityKind, id: string) {
  const stored = storedEntity(kind, id)
  // an element of another strand is only hidden in the strand shown
  if (stored && stored.strand !== editStrand()) commit(withList(project.peek(), kind, list(kind).filter(e => e.id !== id)))
  else commitSource(removeFromProject(source.peek(), kind, id))
  if (selection.value?.id === id) selection.value = null
}

/** the stored element (with its whole history), not the one of the year shown */
export const storedEntity = <K extends EntityKind>(kind: K, id: string) => list(kind, source.value).find(e => e.id === id)

/** changes the stored element itself: its history, its life span */
export function updateStored<K extends EntityKind>(kind: K, id: string, edit: (e: EntityMap[K]) => EntityMap[K], merge?: string) {
  const p = source.peek()
  commitSource(withList(p, kind, list(kind, p).map(e => (e.id === id ? edit(e) : e))), merge ? `stored:${kind}:${id}:${merge}` : undefined)
}

export function patchSource(patch: Partial<Project>, merge?: string) {
  commitSource({ ...source.peek(), ...patch }, merge)
}

export function patchProject(patch: Partial<Project>, merge?: string) {
  commit({ ...project.value, ...patch }, merge)
}

/** adds an element to the stored project as it is (e.g. a copy for another strand) */
export function addStored<K extends EntityKind>(kind: K, entity: EntityMap[K]) {
  const p = source.peek()
  commitSource(withList(p, kind, [...list(kind, p), entity]))
}
