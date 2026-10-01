// Keeping a project in step through the own sync server (sync-server/ in this repo). The server
// stores bytes per item and revision and refuses a write that does not build on the newest one;
// what an item means is decided here: one item per project, the .veil JSON.
import { effect, signal } from '@preact/signals'
import { adoptProject, CLOUD_RECENT, confirmDialog, forgetRecent, reloadChangedRasters, rememberRecent } from './actions'
import { parseProject, serializeProject } from './project'
import { commit, notify, patchProject, project } from './store'
import type { Project } from './types'

export interface SyncSettings {
  /** e.g. https://sync.example.org */
  url: string
  /** the secret that opens the space; the same on every device */
  code: string
  /** only needed once, when the space is made, if the server asks for it */
  serverKey: string
  /** upload changes and fetch new ones by itself */
  auto: boolean
}

export interface RemoteItem {
  name: string
  rev: number
  size: number
  updated: number
}

export type SyncState = 'off' | 'idle' | 'busy' | 'offline' | 'conflict' | 'error'

const SETTINGS_KEY = 'veil.sync'
const REVS_KEY = 'veil.sync.revs'
const PUSH_DELAY = 2000
const POLL_EVERY = 20_000

function readJson<T>(key: string, fallback: T): T {
  try {
    return { ...fallback, ...JSON.parse(localStorage.getItem(key) ?? '{}') }
  } catch {
    return fallback
  }
}
function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage blocked */
  }
}

/** the own server; any other can be entered in the dialog */
export const DEFAULT_SYNC_URL = 'https://veilmap.pendzialek.net'

function readSettings(): SyncSettings {
  const stored = readJson<SyncSettings>(SETTINGS_KEY, { url: '', code: '', serverKey: '', auto: true })
  return { ...stored, url: stored.url.trim() || DEFAULT_SYNC_URL }
}

/** per device, never in the project file: the code is a password */
export const syncSettings = signal<SyncSettings>(readSettings())
syncSettings.subscribe(value => writeJson(SETTINGS_KEY, value))

export const syncStatus = signal<{ state: SyncState; text: string; rev?: number; at?: number }>({ state: 'off', text: 'Nicht verbunden' })

/** the project name of each item, for the recent list (the item name is only a slug) */
const NAMES_KEY = 'veil.sync.names'
export const remoteNames = signal<Record<string, string>>(readJson(NAMES_KEY, {}))
function remember(item: string, name: string) {
  remoteNames.value = { ...remoteNames.value, [item]: name }
  writeJson(NAMES_KEY, remoteNames.value)
  rememberRecent(CLOUD_RECENT + item)
}

/** the revision each item was last exchanged at, on this device */
const revs: Record<string, number> = readJson(REVS_KEY, {})
const setRev = (item: string, rev: number) => {
  revs[item] = rev
  writeJson(REVS_KEY, revs)
}

export const configured = () => {
  const s = syncSettings.value
  return !!s.url.trim() && s.code.trim().length >= 24
}

/** a new code: 24 random bytes, URL-safe, 32 characters */
export function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_')
}

class SyncError extends Error {
  /** HTTP status; 0 when the server was not reached */
  status: number
  body: Record<string, unknown>
  constructor(message: string, status = 0, body: Record<string, unknown> = {}) {
    super(message)
    this.status = status
    this.body = body
  }
}

async function request(path: string, init: RequestInit = {}, settings = syncSettings.peek()): Promise<Response> {
  const base = settings.url.trim().replace(/\/+$/, '')
  if (!base) throw new SyncError('Keine Server-Adresse eingetragen.')
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${settings.code.trim()}`)
  if (settings.serverKey.trim()) headers.set('X-Server-Key', settings.serverKey.trim())
  let response: Response
  try {
    response = await fetch(`${base}${path}`, { ...init, headers, cache: 'no-store', signal: AbortSignal.timeout(20_000) })
  } catch (error) {
    throw new SyncError(`Server nicht erreichbar (${error instanceof Error ? error.message : error})`)
  }
  if (response.ok || response.status === 304) return response
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
  throw new SyncError(String(body.error ?? `HTTP ${response.status}`), response.status, body)
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** checks address, code and server; answers with a short report */
export async function testConnection(settings: SyncSettings): Promise<string> {
  const base = settings.url.trim().replace(/\/+$/, '')
  try {
    const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(10_000) })
    if (!health.ok) return `Server antwortet mit HTTP ${health.status}.`
  } catch (error) {
    return `Server nicht erreichbar: ${describe(error)}`
  }
  try {
    const items = (await (await request('/v1/items', {}, settings)).json()) as RemoteItem[]
    return items.length ? `Verbunden – ${items.length} Einträge in diesem Bereich.` : 'Verbunden – der Bereich ist noch leer.'
  } catch (error) {
    return `Server erreichbar, aber: ${describe(error)}`
  }
}

export async function listRemote(): Promise<RemoteItem[]> {
  return (await (await request('/v1/items')).json()) as RemoteItem[]
}

// ---------------------------------------------------------------------------------------------
// one project, one item

/** the JSON last exchanged with the server for the current item: what "no local change" means */
let exchanged: { item: string; json: string } | null = null
let running = false
let conflictOpen = false

const itemOf = (p: Project) => p.sync?.item ?? null

/** what is exchanged: the project without the map view, which belongs to each device */
const syncJson = (p: Project) => serializeProject({ ...p, view: undefined as unknown as Project['view'] })

function slug(name: string) {
  const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'projekt'
  const tail = Array.from(crypto.getRandomValues(new Uint8Array(3)), b => b.toString(16).padStart(2, '0')).join('')
  return `${base}-${tail}`
}

/** uploads the open project as a new item and keeps it in step from now on */
export async function linkProject() {
  const item = slug(project.peek().name)
  patchProject({ sync: { item } })
  const json = syncJson(project.peek())
  try {
    const response = await request(`/v1/items/${item}`, { method: 'PUT', headers: { 'If-Match': '"0"', 'Content-Type': 'application/json' }, body: json })
    const meta = (await response.json()) as { rev: number }
    setRev(item, meta.rev)
    exchanged = { item, json }
    setStatus('idle', 'Synchronisiert', meta.rev)
    remember(item, project.peek().name)
    notify('Projekt liegt jetzt auf dem Sync-Server.', 'ok')
  } catch (error) {
    patchProject({ sync: null })
    setStatus('error', describe(error))
    notify(`Verknüpfen fehlgeschlagen: ${describe(error)}`, 'error')
  }
}

export function unlinkProject() {
  exchanged = null
  patchProject({ sync: null })
  setStatus('off', 'Nicht verbunden')
}

/** opens an item from the server in place of the open project */
export async function openRemote(item: string) {
  try {
    const response = await request(`/v1/items/${item}`)
    const rev = Number(response.headers.get('x-revision') ?? 0)
    const next = parseProject(await response.text())
    next.sync = { item }
    // known before the project changes, so the check that follows the switch finds it current
    setRev(item, rev)
    await adoptProject(next, null)
    exchanged = { item, json: syncJson(project.peek()) }
    setStatus('idle', 'Synchronisiert', rev)
    remember(item, next.name)
  } catch (error) {
    notify(`Laden vom Server fehlgeschlagen: ${describe(error)}`, 'error')
  }
}

/**
 * Removes an item with its history from the server; `rev` is the revision it was seen at, so a
 * newer upload from another device is not removed unseen. The open project only loses its link.
 */
export async function deleteRemote(item: string, rev: number) {
  try {
    await request(`/v1/items/${item}`, { method: 'DELETE', headers: { 'If-Match': `"${rev}"` } })
  } catch (error) {
    if (error instanceof SyncError && error.status === 409) notify('Der Stand wurde inzwischen von einem anderen Gerät geändert – Liste neu laden und erneut löschen.', 'error')
    else notify(`Löschen fehlgeschlagen: ${describe(error)}`, 'error')
    return false
  }
  delete revs[item]
  writeJson(REVS_KEY, revs)
  forgetRecent(CLOUD_RECENT + item)
  if (project.peek().sync?.item === item) unlinkProject()
  notify('Vom Server gelöscht.', 'ok')
  return true
}

function setStatus(state: SyncState, text: string, rev?: number) {
  syncStatus.value = { state, text, rev: rev ?? syncStatus.peek().rev, at: Date.now() }
}

/** takes over the server's state: an undo step, so it can be taken back */
async function applyRemote(item: string, text: string, rev: number) {
  const before = project.peek()
  const next = parseProject(text)
  next.sync = { item }
  // the view is local to each device
  next.view = before.view
  commit(next)
  setRev(item, rev)
  exchanged = { item, json: syncJson(project.peek()) }
  setStatus('idle', 'Synchronisiert', rev)
  await reloadChangedRasters(before, next)
}

async function resolveConflict(item: string, remoteText: string, remoteRev: number, updated: number | null) {
  if (conflictOpen) return
  conflictOpen = true
  setStatus('conflict', 'Konflikt mit dem Server-Stand')
  const when = updated ? new Date(updated).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : 'unbekannt'
  try {
    const takeServer = await confirmDialog(
      `Auf dem Server liegt ein anderer Stand von „${project.peek().name}“ (Revision ${remoteRev}, ${when}), und hier gibt es Änderungen, die noch nicht hochgeladen sind. Welcher Stand soll bleiben? Der andere ist danach über Rückgängig bzw. die Server-Historie noch erreichbar.`,
      { title: 'Synchronisierung', yes: 'Server-Stand übernehmen', no: 'Meinen Stand behalten' },
    )
    if (takeServer) await applyRemote(item, remoteText, remoteRev)
    else {
      // overwrite on purpose, building on exactly the revision just seen
      setRev(item, remoteRev)
      exchanged = { item, json: remoteText }
      conflictOpen = false
      await push()
    }
  } finally {
    conflictOpen = false
  }
}

/** uploads local changes, building on the revision last seen */
async function push() {
  const p = project.peek()
  const item = itemOf(p)
  if (!item || !configured() || conflictOpen) return
  const json = syncJson(p)
  if (exchanged?.item === item && exchanged.json === json) return
  setStatus('busy', 'Lädt hoch …')
  try {
    const response = await request(`/v1/items/${item}`, {
      method: 'PUT',
      headers: { 'If-Match': `"${revs[item] ?? 0}"`, 'Content-Type': 'application/json' },
      body: json,
    })
    const meta = (await response.json()) as { rev: number }
    setRev(item, meta.rev)
    exchanged = { item, json }
    setStatus('idle', 'Synchronisiert', meta.rev)
  } catch (error) {
    if (error instanceof SyncError && error.status === 409) {
      // someone else was first: fetch theirs and decide
      await pull(true)
      return
    }
    setStatus(error instanceof SyncError && error.status === 0 ? 'offline' : 'error', describe(error))
  }
}

/** fetches a newer server state; `force` reads it even when the revision looks current */
async function pull(force = false) {
  const p = project.peek()
  const item = itemOf(p)
  if (!item || !configured() || conflictOpen) return
  const known = revs[item]
  try {
    const response = await request(`/v1/items/${item}`, { headers: known && !force ? { 'If-None-Match': `"${known}"` } : {} })
    if (response.status === 304) {
      if (exchanged?.item !== item) exchanged = { item, json: syncJson(p) }
      if (syncStatus.peek().state !== 'busy') setStatus('idle', 'Synchronisiert', known)
      return
    }
    const text = await response.text()
    const rev = Number(response.headers.get('x-revision') ?? 0)
    // the server has nothing newer than what this device builds on: local changes simply go up
    if (known !== undefined && rev <= known) return
    const updated = Number(response.headers.get('x-updated') ?? 0) || null
    const local = syncJson(project.peek())
    const remote = syncJson({ ...parseProject(text), sync: { item } })
    if (remote === local) {
      setRev(item, rev)
      exchanged = { item, json: local }
      setStatus('idle', 'Synchronisiert', rev)
      return
    }
    // no local change since the last exchange: simply take the server's state
    const untouched = exchanged?.item === item && exchanged.json === local
    if (untouched) await applyRemote(item, text, rev)
    else await resolveConflict(item, text, rev, updated)
  } catch (error) {
    if (error instanceof SyncError && error.status === 404) {
      setStatus('error', 'Das Projekt gibt es auf dem Server nicht mehr.')
      return
    }
    setStatus(error instanceof SyncError && error.status === 0 ? 'offline' : 'error', describe(error))
  }
}

/** one sync step at a time: fetch first, then upload what is left */
export async function syncNow() {
  if (running) return
  running = true
  try {
    await pull()
    await push()
  } finally {
    running = false
  }
}

/** runs for the life of the app: uploads after a pause in editing, fetches on a timer and on focus */
export function startSync() {
  let timer = 0
  let item: string | null = null
  const stopEffect = effect(() => {
    const p = project.value
    const s = syncSettings.value
    const current = itemOf(p)
    if (current !== item) {
      item = current
      if (exchanged?.item !== current) exchanged = null
      if (current && configured()) syncNow()
    }
    if (!current) {
      if (syncStatus.peek().state !== 'off') setStatus('off', 'Nicht verbunden')
      return
    }
    if (!configured()) {
      setStatus('off', 'Sync nicht eingerichtet')
      return
    }
    if (!s.auto) return
    clearTimeout(timer)
    timer = window.setTimeout(() => syncNow(), PUSH_DELAY)
  })
  const poll = window.setInterval(() => {
    if (syncSettings.peek().auto) syncNow()
  }, POLL_EVERY)
  const onFocus = () => {
    if (syncSettings.peek().auto) syncNow()
  }
  window.addEventListener('focus', onFocus)
  return () => {
    stopEffect()
    clearTimeout(timer)
    clearInterval(poll)
    window.removeEventListener('focus', onFocus)
  }
}
