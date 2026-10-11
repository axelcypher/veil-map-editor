// Where the Obsidian vault lives is a matter of the device, not of the project: a Windows folder,
// an Android path, the REST API in the browser. Kept per device, so a synced project never carries
// one device's folder to another.
import { signal } from '@preact/signals'

export interface OverviewSettings {
  /** write the map overview note into the vault */
  on: boolean
  /** vault-relative path of that note, with ".md" */
  note: string
}

export interface VaultSettings {
  /** folder of the vault; web: "https://127.0.0.1:27124|<api key>" of the plugin Local REST API */
  path: string
  /** for obsidian:// links; '' = the folder name */
  name: string
  /** per project (sync item or file path): the overview note, off unless switched on */
  overviews: Record<string, OverviewSettings>
}

const KEY = 'veil.vault'

function read(): VaultSettings {
  const fallback: VaultSettings = { path: '', name: '', overviews: {} }
  try {
    return { ...fallback, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }
  } catch {
    return fallback
  }
}

export const vaultSettings = signal<VaultSettings>(read())
vaultSettings.subscribe(value => {
  try {
    localStorage.setItem(KEY, JSON.stringify(value))
  } catch {
    /* storage blocked */
  }
})

export const patchVault = (patch: Partial<VaultSettings>) => (vaultSettings.value = { ...vaultSettings.value, ...patch })

/** whether a vault path can be one of this device: a synced project may bring the folder of another */
function fitsThisDevice(path: string) {
  if (!('__TAURI_INTERNALS__' in window)) return path.includes('|')
  const windowsPath = /^[a-z]:[\\/]|^\\\\/i.test(path)
  return windowsPath === navigator.userAgent.includes('Windows')
}

/** projects up to 0.10 kept the vault in the file: taken over once, if this device has none yet */
export function adoptLegacyVault(legacy: { vaultPath?: string; vaultName?: string } | undefined) {
  if (!legacy?.vaultPath || vaultSettings.peek().path || !fitsThisDevice(legacy.vaultPath)) return
  patchVault({ path: legacy.vaultPath, name: legacy.vaultName ?? '' })
}
