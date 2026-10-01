// Application state. The project is immutable: every change builds a new object, which makes undo
// a list of earlier roots and lets the map see what changed by reference.
import { batch, computed, signal } from '@preact/signals'
import { newProject } from './project'
import { COLLECTION, type AreaKind, type Entity, type EntityKind, type EntityMap, type Project } from './types'

export const project = signal<Project>(newProject())
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
 * Replace the project. `merge` folds quick successive edits of the same thing (typing into a
 * field) into one undo step.
 */
export function commit(next: Project, merge?: string) {
  const now = Date.now()
  const merging = merge && lastMerge && lastMerge.key === merge && now - lastMerge.at < 1500
  if (!merging) {
    past.push(project.value)
    if (past.length > 200) past.shift()
  }
  future.length = 0
  lastMerge = merge ? { key: merge, at: now } : null
  batch(() => {
    project.value = next
    dirty.value = true
    historyVersion.value++
  })
}

export function undo() {
  const previous = past.pop()
  if (!previous) return
  future.push(project.value)
  lastMerge = null
  batch(() => {
    project.value = previous
    dirty.value = true
    historyVersion.value++
    fixSelection()
  })
}

export function redo() {
  const next = future.pop()
  if (!next) return
  past.push(project.value)
  lastMerge = null
  batch(() => {
    project.value = next
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
    project.value = next
    filePath.value = path
    dirty.value = false
    selection.value = null
    tool.value = { id: 'select' }
    historyVersion.value++
    projectLoaded.value++
  })
}

function fixSelection() {
  const s = selection.value
  if (s && !findEntity(s.kind, s.id)) selection.value = null
}

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

export function removeEntity(kind: EntityKind, id: string) {
  let next = withList(project.value, kind, list(kind).filter(e => e.id !== id))
  // loose references are cleared, never left dangling
  if (kind === 'state') {
    next = {
      ...next,
      provinces: next.provinces.map(p => (p.stateId === id ? { ...p, stateId: '' } : p)),
      regiments: next.regiments.map(r => (r.stateId === id ? { ...r, stateId: '' } : r)),
      diplomacy: Object.fromEntries(Object.entries(next.diplomacy).filter(([key]) => !key.split('>').includes(id))),
    }
  }
  if (kind === 'city') {
    next = {
      ...next,
      states: next.states.map(s => (s.capitalId === id ? { ...s, capitalId: '' } : s)),
      provinces: next.provinces.map(p => (p.capitalId === id ? { ...p, capitalId: '' } : p)),
    }
  }
  if (kind === 'culture' || kind === 'religion') {
    const field = kind === 'culture' ? 'cultureId' : 'religionId'
    const key = kind === 'culture' ? 'cultures' : 'religions'
    next = {
      ...next,
      states: next.states.map(s => (s[field] === id ? { ...s, [field]: '' } : s)),
      [key]: (next[key] as { id: string; origins: string[] }[]).map(c => ({ ...c, origins: c.origins.filter(o => o !== id) })),
    }
  }
  if (kind === 'river') next = { ...next, rivers: next.rivers.map(r => (r.parentId === id ? { ...r, parentId: '' } : r)) }
  commit(next)
  if (selection.value?.id === id) selection.value = null
}

export function patchProject(patch: Partial<Project>, merge?: string) {
  commit({ ...project.value, ...patch }, merge)
}
