// Updates from the public GitHub releases. The desktop app installs them itself (signed by the
// release workflow, checked by the Tauri updater); on Android the APK is downloaded through the
// browser and Android installs it over the old one (same signing key). Builds without the update
// key, and the web build, point to the release page.
import { signal } from '@preact/signals'
import { platform } from '../platform'
import { confirmDialog } from './actions'
import { busy, dirty, notify } from './store'

const REPO = 'axelcypher/veil-map-editor'
const LATEST = `https://api.github.com/repos/${REPO}/releases/latest`
const DAY = 24 * 60 * 60 * 1000

export interface AvailableUpdate {
  version: string
  notes: string
  /** the release page */
  page: string
  apk: string | null
}

export const availableUpdate = signal<AvailableUpdate | null>(null)

function storage(key: string, value?: string) {
  try {
    if (value === undefined) return localStorage.getItem(key)
    localStorage.setItem(key, value)
  } catch {
    /* storage blocked */
  }
  return null
}

/** check at start-up, at most once a day; on unless switched off */
export const autoCheck = signal(storage('veil.update.auto') !== 'off')
autoCheck.subscribe(on => storage('veil.update.auto', on ? 'on' : 'off'))

/** "0.10.1" > "0.9.3": compares the numbers, ignores a leading v and anything after a dash */
export function isNewer(candidate: string, current: string) {
  const parts = (v: string) => v.replace(/^v/, '').split('-')[0].split('.').map(n => parseInt(n, 10) || 0)
  const a = parts(candidate)
  const b = parts(current)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return false
}

/** asks GitHub for the latest release; `manual` also reports "up to date" and errors */
export async function checkForUpdate(manual = false) {
  try {
    const response = await fetch(LATEST, { headers: { Accept: 'application/vnd.github+json' } })
    if (!response.ok) throw new Error(`GitHub antwortet mit ${response.status}`)
    const release = (await response.json()) as { tag_name: string; body?: string; html_url: string; assets?: { name: string; browser_download_url: string }[] }
    storage('veil.update.checked', String(Date.now()))
    if (!isNewer(release.tag_name, __APP_VERSION__)) {
      availableUpdate.value = null
      if (manual) notify(`VEIL Map Editor ${__APP_VERSION__} ist die neueste Version.`, 'ok')
      return null
    }
    const update: AvailableUpdate = {
      version: release.tag_name.replace(/^v/, ''),
      notes: release.body ?? '',
      page: release.html_url,
      apk: release.assets?.find(a => a.name.endsWith('.apk'))?.browser_download_url ?? null,
    }
    availableUpdate.value = update
    if (manual) await applyUpdate()
    else notify(`Update verfügbar: VEIL Map Editor ${update.version}. Unten rechts installieren.`)
    return update
  } catch (error) {
    if (manual) notify(`Update-Prüfung fehlgeschlagen: ${error instanceof Error ? error.message : error}`, 'error')
    return null
  }
}

export function checkAtStartup() {
  if (!autoCheck.value) return
  const last = Number(storage('veil.update.checked') ?? 0)
  if (Date.now() - last < DAY) return
  // a moment after start, so opening a project is not slowed down
  setTimeout(() => checkForUpdate(false), 4000)
}

/** installs the found update the way this platform can */
export async function applyUpdate() {
  const update = availableUpdate.value
  if (!update) return
  const updater = platform.updater
  if (updater && (await updater.ready().catch(() => false))) {
    const warning = dirty.value ? ' Ungespeicherte Änderungen gehen beim Neustart verloren – vorher speichern.' : ''
    if (!(await confirmDialog(`VEIL Map Editor ${update.version} herunterladen, installieren und neu starten?${warning}`))) return
    busy.value = { stage: `Update ${update.version} laden`, fraction: 0 }
    try {
      const installed = await updater.install(fraction => (busy.value = { stage: `Update ${update.version} laden`, fraction: fraction ?? 0 }))
      if (!installed) {
        notify('Das Update ist noch nicht für diese Plattform bereit. Später noch einmal versuchen.', 'error')
        return
      }
      busy.value = { stage: 'Neu starten', fraction: 1 }
      await updater.relaunch()
    } catch (error) {
      notify(`Update fehlgeschlagen: ${error instanceof Error ? error.message : error}`, 'error')
    } finally {
      busy.value = null
    }
    return
  }
  if (platform.mobile && update.apk) {
    if (!(await confirmDialog(`VEIL Map Editor ${update.version} herunterladen? Android fragt danach, ob die App aktualisiert werden soll.`))) return
    await platform.openExternal(update.apk)
    return
  }
  await platform.openExternal(update.page)
}
