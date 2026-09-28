// Browser build of the adapter. Projects and exports go through upload and download; the vault is
// reached through the Obsidian plugin "Local REST API". Raster imports need the desktop app for now
// (a WASM build of the Rust importers would slot in here).
import type { Platform } from './types'

const desktopOnly = () => Promise.reject(new Error('Dieser Import braucht die Desktop-App.'))
const files = new Map<string, File>()

function pick(accept: string): Promise<File | null> {
  return new Promise(resolve => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.onchange = () => resolve(input.files?.[0] ?? null)
    input.click()
  })
}

function download(blob: Blob, path: string) {
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = path.replace(/^download:/, '')
  link.click()
  setTimeout(() => URL.revokeObjectURL(link.href), 10_000)
}

/** vault root in the web build is "https://127.0.0.1:27124|<api key>" */
function restApi(root: string) {
  const [base, key] = root.split('|')
  return { base: base.replace(/\/$/, ''), headers: { Authorization: `Bearer ${key}` } }
}

export const webPlatform: Platform = {
  kind: 'web',
  mobile: false,
  async pickFile(_title, filters) {
    const file = await pick(filters.flatMap(f => f.extensions.map(e => `.${e}`)).join(','))
    if (!file) return null
    const key = `upload:${file.name}`
    files.set(key, file)
    return key
  },
  async pickSavePath(_title, suggested) {
    return `download:${suggested.split(/[\\/]/).pop()}`
  },
  async pickFolder() {
    return null
  },
  async readText(path) {
    const file = files.get(path)
    if (!file) throw new Error(`Datei nicht verfügbar: ${path}`)
    return file.text()
  },
  async writeText(path, content) {
    download(new Blob([content], { type: 'application/json' }), path)
  },
  fileExists: async path => files.has(path),
  async fileUrl(path) {
    const file = files.get(path)
    if (!file) throw new Error(`Datei nicht verfügbar: ${path}`)
    return URL.createObjectURL(file)
  },
  async openExternal(url) {
    window.open(url, '_blank')
  },
  openFile: desktopOnly,
  importTerrain: desktopOnly,
  openTerrain: desktopOnly,
  closeTerrain: async () => {},
  heights: async points => points.map(() => null),
  cacheUrl: path => `cache/${path}`,
  importRivers: desktopOnly,
  importKoppen: desktopOnly,
  koppenHistogram: desktopOnly,
  importSatellite: desktopOnly,
  async openProject(path) {
    const file = files.get(path)
    if (!file) throw new Error(`Datei nicht verfügbar: ${path}`)
    const head = new Uint8Array(await file.slice(0, 2).arrayBuffer())
    if (head[0] === 0x50 && head[1] === 0x4b) throw new Error('Archive (.veilmap) lassen sich nur in der App öffnen.')
    return { project: await file.text(), archive: false, unpacked: [] }
  },
  saveArchive: desktopOnly,
  async writeBinary(path, data) {
    download(new Blob([data as BlobPart]), path)
  },
  async vaultList(root) {
    const api = restApi(root)
    const walk = async (dir: string): Promise<{ path: string; modified: number }[]> => {
      const response = await fetch(`${api.base}/vault/${dir}`, { headers: api.headers })
      const { files: entries } = (await response.json()) as { files: string[] }
      const out: { path: string; modified: number }[] = []
      for (const entry of entries) {
        if (entry.endsWith('/')) out.push(...(await walk(dir + entry)))
        else if (entry.endsWith('.md')) out.push({ path: dir + entry, modified: 0 })
      }
      return out
    }
    return walk('')
  },
  async vaultRead(root, path) {
    const api = restApi(root)
    const response = await fetch(`${api.base}/vault/${path.split('/').map(encodeURIComponent).join('/')}`, { headers: api.headers })
    if (!response.ok) throw new Error(`Note nicht lesbar: ${path}`)
    return response.text()
  },
  onProgress: () => () => {},
}
