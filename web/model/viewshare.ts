// Sharing the editor's view with other programs, e.g. the stream overlay of veil-agents: strand,
// year, milestone, layers and the map frame go to the sync server as an item of their own next to
// the project ("<item>.view"); the project item is never touched. One set per strand: a strand's
// set changes only while that strand is shown, so a reader that shows one strand never sees what
// was done in another, and picks itself which sets it follows. Per device, off unless switched on.
import { effect, signal } from '@preact/signals'
import { milestone, project, source, strand, year } from './store'
import { configured, request, SyncError, syncSettings } from './sync'
import { reckoningOf, toOwnYear } from './timeline'
import type { LayerId, LonLat, Project } from './types'

export const VIEW_SUFFIX = '.view'
export const viewItemOf = (item: string) => `${item}${VIEW_SUFFIX}`
export const isViewItem = (name: string) => name.endsWith(VIEW_SUFFIX)

/** at most one upload per this many ms; during playback the overlay follows with this delay */
const PUBLISH_EVERY = 700

export interface ViewSet {
  /** '' without a timeline */
  strand: string
  strandName: string
  /** base years; null without a timeline */
  year: number | null
  /** the year as the strand counts it, with its unit */
  ownYear: number | null
  unit: string
  /** the milestone shown (the timeline's current one unless one was picked); null: all */
  milestone: string | null
  milestoneName: string
  layers: { id: LayerId; visible: boolean; opacity: number; labels: boolean | null }[]
  /** the map frame: centre and zoom as the editor counts them, and the visible area in degrees */
  center: LonLat
  zoom: number
  extent: [number, number, number, number]
  /** degrees, clockwise */
  rotation: number
  updated: number
}

export interface SharedView {
  format: 'veil-view'
  version: 1
  /** the project item */
  project: string
  /** the strand shown in the editor right now */
  active: string
  updated: number
  /** per strand id ('' without a timeline): how it was last shown */
  strands: Record<string, ViewSet>
}

/** where the map looks; set by the map after each move */
export const mapFrame = signal<{ center: LonLat; zoom: number; extent: [number, number, number, number]; rotation: number } | null>(null)

const KEY = 'veil.viewShare'
function readShared(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}')
  } catch {
    return {}
  }
}
/** per device and project item */
export const viewShare = signal<Record<string, boolean>>(readShared())
viewShare.subscribe(value => {
  try {
    localStorage.setItem(KEY, JSON.stringify(value))
  } catch {
    /* storage blocked */
  }
})
export const setViewShare = (item: string, on: boolean) => (viewShare.value = { ...viewShare.value, [item]: on })

export const viewShareStatus = signal<{ at: number; text: string; error: boolean } | null>(null)

function currentSet(p: Project): ViewSet | null {
  const frame = mapFrame.peek()
  if (!frame) return null
  const t = p.timeline
  const s = t?.strands.find(x => x.id === strand.peek())
  const r = t && s ? reckoningOf(t, s.id) : null
  const y = year.peek()
  const picked = milestone.peek()
  const milestoneId = !t ? null : picked === undefined ? t.current : picked
  return {
    strand: s?.id ?? '',
    strandName: s?.name ?? '',
    year: y,
    ownYear: r && y != null ? toOwnYear(r, y) : null,
    unit: r?.unit ?? '',
    milestone: milestoneId ?? null,
    milestoneName: t?.milestones.find(m => m.id === milestoneId)?.name ?? '',
    layers: p.layers.map(l => ({ id: l.id, visible: l.visible, opacity: l.opacity, labels: (p.style as Record<string, { showLabels?: boolean }>)[l.id]?.showLabels ?? null })),
    center: frame.center,
    zoom: frame.zoom,
    extent: frame.extent,
    rotation: frame.rotation,
    updated: 0,
  }
}

// what the server holds for the item, as far as this device knows
let held: { item: string; rev: number; view: SharedView } | null = null
let lastSent = ''

async function fetchShared(item: string): Promise<{ rev: number; view: SharedView | null }> {
  try {
    const response = await request(`/v1/items/${viewItemOf(item)}`)
    const view = (await response.json()) as SharedView
    return { rev: Number(response.headers.get('x-revision') ?? 0), view: view?.format === 'veil-view' ? view : null }
  } catch (error) {
    if (error instanceof SyncError && error.status === 404) return { rev: 0, view: null }
    throw error
  }
}

async function publish(item: string, set: ViewSet) {
  if (held?.item !== item) {
    const { rev, view } = await fetchShared(item)
    held = { item, rev, view: view ?? { format: 'veil-view', version: 1, project: item, active: '', updated: 0, strands: {} } }
  }
  // another device may have written in between: then build on its state and try once more
  for (let attempt = 0; attempt < 2; attempt++) {
    const now = Date.now()
    const view: SharedView = { ...held.view, project: item, active: set.strand, updated: now, strands: { ...held.view.strands, [set.strand]: { ...set, updated: now } } }
    try {
      const response = await request(`/v1/items/${viewItemOf(item)}`, {
        method: 'PUT',
        headers: { 'If-Match': `"${held.rev}"`, 'Content-Type': 'application/json' },
        body: JSON.stringify(view),
      })
      const meta = (await response.json()) as { rev: number }
      held = { item, rev: meta.rev, view }
      return
    } catch (error) {
      if (!(error instanceof SyncError && error.status === 409) || attempt > 0) throw error
      const fresh = await fetchShared(item)
      held = { item, rev: fresh.rev, view: fresh.view ?? held.view }
    }
  }
}

/** keeps the shared view in step while it is switched on; returns the stop function */
export function startViewShare() {
  let timer: ReturnType<typeof setTimeout> | undefined
  let busy = false
  const run = async () => {
    timer = undefined
    const p = project.peek()
    const item = source.peek().sync?.item
    if (!item || !viewShare.peek()[item] || !configured() || busy) return
    const set = currentSet(p)
    if (!set) return
    const text = JSON.stringify({ item, set })
    if (text === lastSent) return
    busy = true
    try {
      await publish(item, set)
      lastSent = text
      viewShareStatus.value = { at: Date.now(), text: 'Ansicht geteilt.', error: false }
    } catch (error) {
      viewShareStatus.value = { at: Date.now(), text: `Ansicht nicht geteilt: ${error instanceof Error ? error.message : error}`, error: true }
    } finally {
      busy = false
      // what changed during the upload goes up next
      if (JSON.stringify({ item, set: currentSet(project.peek()) }) !== lastSent) timer ??= setTimeout(run, PUBLISH_EVERY)
    }
  }
  const stop = effect(() => {
    // everything the shared view is made of
    void project.value
    void year.value
    void strand.value
    void milestone.value
    void mapFrame.value
    void syncSettings.value
    const item = source.value.sync?.item
    if (!item || !viewShare.value[item]) return
    timer ??= setTimeout(run, PUBLISH_EVERY)
  })
  return () => {
    clearTimeout(timer)
    stop()
  }
}
