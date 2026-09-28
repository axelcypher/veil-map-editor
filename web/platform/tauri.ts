import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open, save } from '@tauri-apps/plugin-dialog'
import type { Platform } from './types'

// custom protocols are served as http://<scheme>.localhost on Windows
const protocolBase = navigator.userAgent.includes('Windows') ? 'http://veil.localhost/' : 'veil://localhost/'

export const tauriPlatform: Platform = {
  kind: 'desktop',
  async pickFile(title, filters) {
    const result = await open({ title, filters, multiple: false, directory: false })
    return typeof result === 'string' ? result : null
  },
  async pickSavePath(title, suggested, filters) {
    return (await save({ title, defaultPath: suggested, filters })) ?? null
  },
  async pickFolder(title) {
    const result = await open({ title, multiple: false, directory: true })
    return typeof result === 'string' ? result : null
  },
  readText: path => invoke('read_text', { path }),
  writeText: (path, content) => invoke('write_text', { path, content }),
  fileExists: path => invoke('file_exists', { path }),
  async fileUrl(path) {
    const token = await invoke<string>('register_file', { path })
    return `${protocolBase}file/${token}`
  },
  openExternal: url => invoke('open_external', { url }),
  openFile: path => invoke('open_file', { path }),

  importTerrain: (options, radiusM) => invoke('terrain_import', { options, radiusM }),
  openTerrain: id => invoke('terrain_open', { id }),
  closeTerrain: () => invoke('terrain_close'),
  heights: points => invoke('terrain_heights', { points }),
  cacheUrl: path => `${protocolBase}cache/${path}`,
  importRivers: (options, radiusM) => invoke('rivers_import', { options: { ...options, prunePx: 4 }, radiusM }),
  importKoppen: options => invoke('koppen_import', { options }),
  koppenHistogram: path => invoke('koppen_histogram', { path }),
  importSatellite: options => invoke('satellite_import', { options }),
  openProject: path => invoke('project_open', { path }),
  saveArchive: (path, content, options) =>
    invoke('archive_save', {
      path,
      options: { ...content, tiles: { quality: options.quality, lossless: options.lossless }, heights: options.heights },
    }),
  writeBinary: (path, data) => invoke('write_binary', data, { headers: { path: encodeURIComponent(path) } }),

  vaultList: root => invoke('vault_list', { root }),
  vaultRead: (root, path) => invoke('vault_read', { root, path }),

  onProgress(handler) {
    let stop: (() => void) | null = null
    let cancelled = false
    listen<{ stage: string; fraction: number }>('progress', event => handler(event.payload)).then(unlisten => {
      if (cancelled) unlisten()
      else stop = unlisten
    })
    return () => {
      cancelled = true
      stop?.()
    }
  },
}
