import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { open, save } from '@tauri-apps/plugin-dialog'
import type { Platform } from './types'

const android = /Android/i.test(navigator.userAgent)
const mobile = android || /iPhone|iPad/i.test(navigator.userAgent)
// custom protocols are served as http://<scheme>.localhost on Windows and Android
const protocolBase = navigator.userAgent.includes('Windows') || android ? 'http://veil.localhost/' : 'veil://localhost/'

/**
 * Android's folder picker hands out a tree URI. Files in the vault are read by path (with "all
 * files access"), so a folder on the internal storage becomes its path again.
 */
function treeToPath(uri: string) {
  const match = uri.match(/^content:\/\/com\.android\.externalstorage\.documents\/tree\/([^/]+)/)
  if (!match) return uri
  const [volume, ...rest] = decodeURIComponent(match[1]).split(':')
  const base = volume === 'primary' ? '/storage/emulated/0' : `/storage/${volume}`
  return rest.join(':') ? `${base}/${rest.join(':')}` : base
}

const appWindow = () => getCurrentWindow()

const updater: Platform['updater'] = mobile
  ? undefined
  : {
      ready: () => invoke<boolean>('updater_ready'),
      async install(onProgress) {
        // loaded on demand: the plugin exists only in desktop builds
        const { check } = await import('@tauri-apps/plugin-updater')
        const update = await check()
        if (!update) return false
        let total = 0
        let done = 0
        await update.downloadAndInstall(event => {
          if (event.event === 'Started') total = event.data.contentLength ?? 0
          else if (event.event === 'Progress') {
            done += event.data.chunkLength
            onProgress(total ? done / total : null)
          }
        })
        return true
      },
      async relaunch() {
        const { relaunch } = await import('@tauri-apps/plugin-process')
        await relaunch()
      },
    }

export const tauriPlatform: Platform = {
  updater,
  window: mobile
    ? undefined
    : {
        minimize: () => appWindow().minimize(),
        toggleMaximize: () => appWindow().toggleMaximize(),
        close: () => appWindow().close(),
        isMaximized: () => appWindow().isMaximized(),
        onResized(handler) {
          let stop: (() => void) | null = null
          let cancelled = false
          appWindow()
            .onResized(() => handler())
            .then(unlisten => {
              if (cancelled) unlisten()
              else stop = unlisten
            })
          return () => {
            cancelled = true
            stop?.()
          }
        },
      },
  kind: 'desktop',
  mobile,
  async pickFile(title, filters) {
    // Android filters by MIME type; our own endings have none, so everything is offered there
    const result = await open({ title, filters: android ? [] : filters, multiple: false, directory: false })
    return typeof result === 'string' ? result : null
  },
  async pickSavePath(title, suggested, filters) {
    return (await save({ title, defaultPath: suggested, filters: android ? [] : filters })) ?? null
  },
  async pickFolder(title) {
    const result = await open({ title, multiple: false, directory: true })
    if (typeof result !== 'string') return null
    return android ? treeToPath(result) : result
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

  recovery: {
    // raw bytes: a large project is not escaped once more into a JSON argument
    write: text => invoke('recovery_write', new TextEncoder().encode(text)),
    read: () => invoke<string | null>('recovery_read'),
    clear: () => invoke('recovery_clear'),
  },

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
