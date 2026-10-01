// Operations the UI triggers: files, imports, drawing areas, conflicts after a new terrain.
import { effect, signal } from '@preact/signals'
import polygonClipping, { type MultiPolygon as PcMulti } from 'polygon-clipping'
import { platform, type ImportReport } from '../platform'
import { defaultKoppenClasses } from './catalog'
import { bboxHit, bboxOf, distanceM } from './geo'
import { create, newId, newProject, parseProject, serializeProject } from './project'
import {
  addEntity, busy, commit, dirty, filePath, findEntity, list, notify, patchProject, placeType, project, resetProject, selection, snapCities, tool,
  updateEntity, type Tool,
} from './store'
import { avoidLand, dockEnds, followPoint, reshapeLine, settleJunctions, snapEnds } from './routing'
import { simplifyLine } from './geo'
import {
  clearTerrain, imageLayerData, islandAt, loadImageLayerData, loadKoppenData, loadSatelliteData, loadTerrainData, koppen as koppenData,
  satellite as satelliteData, terrain,
} from './terrain'
import {
  AREA_KINDS, type AreaBase, type AreaGeometry, type AreaKind, type EntityKind, type KoppenMatch, type LineGeometry, type LonLat,
  type PointGeometry, type Project, type River, type Route,
} from './types'

export const PROJECT_FILTER = [{ name: 'VEIL-Projekt oder -Archiv', extensions: ['veil', 'veilmap'] }]
const SAVE_FILTER = [{ name: 'VEIL-Projekt', extensions: ['veil'] }]
export const ARCHIVE_FILTER = [{ name: 'VEIL-Archiv mit Gelände', extensions: ['veilmap'] }]
/** the open file is a .veilmap archive; saving writes the archive again */
export const fileIsArchive = signal(false)
export const IMAGE_FILTER = [{ name: 'Raster', extensions: ['tif', 'tiff', 'png', 'r16', 'raw', 'jpg', 'jpeg', 'webp'] }]

export interface Conflict {
  kind: EntityKind
  id: string
  text: string
  at: LonLat | null
}
export const conflicts = signal<Conflict[]>([])
export const lastReport = signal<ImportReport | null>(null)

// ---------------------------------------------------------------------------------------------
// files

export async function newFile() {
  if (dirty.value && !(await confirmDiscard())) return
  await platform.closeTerrain()
  clearRasters()
  fileIsArchive.value = false
  resetProject(newProject(), null)
}

function clearRasters() {
  clearTerrain()
  koppenData.value = null
  satelliteData.value = null
  imageLayerData.value = new Map()
  conflicts.value = []
}

export interface ConfirmRequest {
  text: string
  resolve: (ok: boolean) => void
  title?: string
  yes?: string
  no?: string
}
export const confirmRequest = signal<ConfirmRequest | null>(null)
export const confirmDialog = (text: string, labels: Pick<ConfirmRequest, 'title' | 'yes' | 'no'> = {}) =>
  new Promise<boolean>(resolve => { confirmRequest.value = { text, resolve, ...labels } })
const confirmDiscard = () => confirmDialog('Ungespeicherte Änderungen verwerfen?')

export async function openFile(path?: string) {
  if (dirty.value && !(await confirmDiscard())) return
  const chosen = path ?? (await platform.pickFile('Projekt öffnen', PROJECT_FILTER))
  if (!chosen) return
  try {
    const opened = await withBusy('Projekt öffnen', () => platform.openProject(chosen))
    const next = parseProject(opened.project)
    await platform.closeTerrain()
    clearRasters()
    fileIsArchive.value = opened.archive
    resetProject(next, chosen)
    rememberRecent(chosen)
    await restoreRasters(next)
  } catch (error) {
    notify(`Öffnen fehlgeschlagen: ${error instanceof Error ? error.message : error}`, 'error')
  }
}

// ---------------------------------------------------------------------------------------------
// crash copy: every change to an unsaved project is written at once, outside the project file

interface RecoveryCopy {
  savedAt: number
  filePath: string | null
  archive: boolean
  project: Project
}

/** the latest wish wins; a write and a clear never overtake each other */
let recoveryWant: 'write' | 'clear' | null = null
let recoveryBusy = false
async function recoveryFlush() {
  if (recoveryBusy) return
  recoveryBusy = true
  try {
    while (recoveryWant) {
      const want = recoveryWant
      recoveryWant = null
      try {
        if (want === 'clear') await platform.recovery.clear()
        else {
          const copy: RecoveryCopy = { savedAt: Date.now(), filePath: filePath.peek(), archive: fileIsArchive.peek(), project: project.peek() }
          await platform.recovery.write(JSON.stringify(copy))
        }
      } catch (error) {
        console.warn('Wiederherstellungskopie', error)
      }
    }
  } finally {
    recoveryBusy = false
  }
}

/** keeps the crash copy in step with the project; call after the startup offer */
export function startRecovery() {
  return effect(() => {
    void project.value
    recoveryWant = dirty.value ? 'write' : 'clear'
    recoveryFlush()
  })
}

/** after a crash: offers the unsaved state of the last session */
export async function offerRecovery() {
  let copy: RecoveryCopy
  try {
    const text = await platform.recovery.read()
    if (!text) return
    copy = JSON.parse(text) as RecoveryCopy
  } catch {
    return
  }
  const when = new Date(copy.savedAt).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })
  const name = copy.project?.name || copy.filePath?.split(/[\\/]/).pop() || 'ohne Namen'
  const restore = await confirmDialog(`Die letzte Sitzung wurde nicht sauber beendet. Ungespeicherte Änderungen an „${name}“ vom ${when} wiederherstellen?`, {
    title: 'Wiederherstellen',
    yes: 'Wiederherstellen',
    no: 'Verwerfen',
  })
  if (!restore) return
  try {
    const next = parseProject(JSON.stringify(copy.project))
    await platform.closeTerrain()
    clearRasters()
    fileIsArchive.value = copy.archive
    resetProject(next, copy.filePath)
    dirty.value = true
    await restoreRasters(next)
    notify('Wiederhergestellt – bitte speichern.', 'ok')
  } catch (error) {
    notify(`Wiederherstellen fehlgeschlagen: ${error instanceof Error ? error.message : error}`, 'error')
  }
}

/** a project from elsewhere (the sync server) replaces the open one, rasters included */
export async function adoptProject(next: Project, path: string | null) {
  await platform.closeTerrain()
  clearRasters()
  fileIsArchive.value = false
  resetProject(next, path)
  await restoreRasters(next)
}

/** after a change from the sync server: rasters whose reference changed are loaded again */
export async function reloadChangedRasters(before: Project, after: Project) {
  const changed = before.terrain?.id !== after.terrain?.id || before.koppen?.id !== after.koppen?.id || before.satellite?.id !== after.satellite?.id ||
    before.imageLayers.map(l => l.id).join() !== after.imageLayers.map(l => l.id).join()
  if (!changed) return
  await platform.closeTerrain()
  clearRasters()
  await restoreRasters(after)
}

async function restoreRasters(p: Project) {
  if (p.terrain) {
    try {
      const meta = await withBusy('Gelände laden', () => platform.openTerrain(p.terrain!.id))
      await loadTerrainData(meta)
    } catch {
      // the cache is gone (new machine, cleared): build it again from the source, with all checks
      if (await platform.fileExists(p.terrain.source)) {
        notify('Gelände-Cache fehlt, die Heightmap wird neu eingelesen.')
        await importTerrain(p.terrain.source, p.terrain.cropSquare)
      } else notify(`Heightmap nicht gefunden: ${p.terrain.source}`, 'error')
    }
  }
  if (p.koppen) {
    try {
      await loadKoppenData(p.koppen.id)
    } catch {
      if (await platform.fileExists(p.koppen.source)) await importKoppen(p.koppen.source, p.koppen.cropSquare, p.koppen.tolerance)
    }
  }
  if (p.satellite) {
    try {
      await loadSatelliteData(p.satellite.id)
    } catch {
      if (await platform.fileExists(p.satellite.source)) await importSatellite(p.satellite.source, p.satellite.cropSquare)
      else notify(`Satellitenbild nicht gefunden: ${p.satellite.source}`, 'error')
    }
  }
  for (const layer of p.imageLayers) {
    try {
      await loadImageLayerData(layer.id)
    } catch {
      // the cache is gone: tile the source again, under the same id (same file, same crop)
      if (await platform.fileExists(layer.source)) {
        try {
          await withBusy(`Bildebene „${layer.name}“ kacheln`, () => platform.importSatellite({ path: layer.source, cropSquare: layer.cropSquare }))
          await loadImageLayerData(layer.id)
        } catch (error) {
          notify(`Bildebene „${layer.name}“: ${error}`, 'error')
        }
      } else notify(`Bildebene „${layer.name}“ nicht gefunden: ${layer.source}`, 'error')
    }
  }
}

export async function saveFile(saveAs = false) {
  if (fileIsArchive.value && !saveAs && filePath.value && !filePath.value.startsWith('upload:')) return saveArchive(false)
  let path = filePath.value
  if (!path || saveAs || fileIsArchive.value || path.startsWith('upload:')) {
    path = await platform.pickSavePath('Projekt speichern', `${project.value.name || 'karte'}.veil`, SAVE_FILTER)
    if (!path) return false
  }
  try {
    await platform.writeText(path, serializeProject(project.value))
    filePath.value = path
    fileIsArchive.value = false
    dirty.value = false
    rememberRecent(path)
    notify('Gespeichert', 'ok')
    return true
  } catch (error) {
    notify(`Speichern fehlgeschlagen: ${error}`, 'error')
    return false
  }
}

const megabytes = (bytes: number) => `${(bytes / 1e6).toFixed(1).replace('.', ',')} MB`
export const lastArchive = signal<import('../platform').ArchiveReport | null>(null)

/**
 * The project with everything derived from its sources, as one .veilmap file for another device.
 * `pick`: ask for a target even when the open file already is an archive.
 */
export async function saveArchive(pick = true) {
  const p = project.value
  let path = filePath.value
  if (pick || !path || !fileIsArchive.value) {
    path = await platform.pickSavePath('Als Archiv speichern', `${p.name || 'karte'}.veilmap`, ARCHIVE_FILTER)
    if (!path) return false
  }
  const options = p.archive
  try {
    const report = await withBusy('Archiv schreiben', () =>
      platform.saveArchive(
        path,
        {
          project: serializeProject(p),
          terrainId: terrain.value ? (p.terrain?.id ?? null) : null,
          koppenId: options.koppen && koppenData.value ? (p.koppen?.id ?? null) : null,
          satelliteId: options.satellite && satelliteData.value ? (p.satellite?.id ?? null) : null,
          imageIds: options.images ? p.imageLayers.map(l => l.id).filter(id => imageLayerData.value.has(id)) : [],
        },
        options,
      ),
    )
    lastArchive.value = report
    filePath.value = path
    fileIsArchive.value = true
    dirty.value = false
    rememberRecent(path)
    notify(`Archiv gespeichert: ${megabytes(report.bytes)} (${report.tiles} Kacheln ${megabytes(report.tileBytes)}${report.heightsBytes ? `, Höhen ${megabytes(report.heightsBytes)}` : ''})`, 'ok')
    return true
  } catch (error) {
    notify(`Archiv speichern fehlgeschlagen: ${error}`, 'error')
    return false
  }
}

export const recentFiles = signal<string[]>(readRecent())
function readRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem('veil.recent') ?? '[]')
  } catch {
    return []
  }
}
function rememberRecent(path: string) {
  if (path.startsWith('upload:') || path.startsWith('download:')) return
  recentFiles.value = [path, ...recentFiles.value.filter(p => p !== path)].slice(0, 8)
  try {
    localStorage.setItem('veil.recent', JSON.stringify(recentFiles.value))
  } catch {
    /* storage blocked */
  }
}

async function withBusy<T>(stage: string, run: () => Promise<T>): Promise<T> {
  busy.value = { stage, fraction: 0 }
  const stop = platform.onProgress(progress => { busy.value = progress })
  try {
    return await run()
  } finally {
    stop()
    busy.value = null
  }
}

// ---------------------------------------------------------------------------------------------
// imports

export async function importTerrain(path: string, cropSquare: boolean) {
  const p = project.value
  let report: ImportReport
  try {
    report = await withBusy('Heightmap prüfen', () => platform.importTerrain({ path, cropSquare, controlPoints: p.controlPoints }, p.planetRadius))
  } catch (error) {
    notify(`Import fehlgeschlagen: ${error}`, 'error')
    return null
  }
  lastReport.value = report
  if (!report.ok || !report.meta) {
    notify('Import abgebrochen – die Prüfung hat Fehler gefunden.', 'error')
    return report
  }
  const reimport = !!p.terrain
  patchProject({
    terrain: { source: path, id: report.meta.id, hash: report.meta.hash, cropSquare, importedAt: Date.now(), checks: report.checks },
  })
  await loadTerrainData(report.meta)
  const found = await findConflicts()
  if (reimport) notify(found.length ? `Neues Gelände geladen – ${found.length} Konflikte gefunden.` : 'Neues Gelände geladen, keine Konflikte.', found.length ? 'error' : 'ok')
  else notify('Heightmap importiert.', 'ok')
  return report
}

export async function importSatellite(path: string, cropSquare: boolean) {
  try {
    const meta = await withBusy('Satellitenbild kacheln', () => platform.importSatellite({ path, cropSquare }))
    patchProject({ satellite: { source: path, id: meta.id, hash: meta.hash, cropSquare, importedAt: Date.now() } })
    satelliteData.value = meta
    const p = project.value
    // a fresh import is meant to be seen
    if (!p.layers.find(l => l.id === 'satellite')?.visible) patchProject({ layers: p.layers.map(l => (l.id === 'satellite' ? { ...l, visible: true } : l)) })
    notify('Satellitenbild importiert.', 'ok')
    return meta
  } catch (error) {
    notify(`Satellitenbild: ${error}`, 'error')
    return null
  }
}

/**
 * Adds a picture of the whole planet as its own layer, e.g. a pre-rendered map style. It goes in
 * above the satellite picture and the other image layers and is switched on.
 */
export async function importImageLayer(path: string, cropSquare: boolean, name: string) {
  try {
    const meta = await withBusy('Bildebene kacheln', () => platform.importSatellite({ path, cropSquare }))
    const p = project.value
    const id: `img:${string}` = `img:${meta.id}`
    const label = name.trim() || path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') || 'Bildebene'
    const known = p.imageLayers.some(l => l.id === meta.id)
    const imageLayers = known
      ? p.imageLayers.map(l => (l.id === meta.id ? { ...l, name: label, source: path } : l))
      : [...p.imageLayers, { id: meta.id, name: label, source: path, hash: meta.hash, cropSquare, importedAt: Date.now() }]
    let layers = p.layers.filter(l => l.id !== id)
    const below = layers.reduce((last, l, i) => (l.id === 'satellite' || l.id.startsWith('img:') ? i : last), layers.findIndex(l => l.id === 'relief'))
    layers = [...layers.slice(0, below + 1), { id, visible: true, opacity: 1 }, ...layers.slice(below + 1)]
    commit({ ...p, imageLayers, layers })
    await loadImageLayerData(meta.id)
    notify(known ? `Bildebene „${label}“ neu eingelesen.` : `Bildebene „${label}“ hinzugefügt.`, 'ok')
    return meta
  } catch (error) {
    notify(`Bildebene: ${error}`, 'error')
    return null
  }
}

/**
 * Takes the layer out of the project. Its tiles stay loaded (an undo brings it straight back) and
 * its cache stays for a later import of the same file.
 */
export function removeImageLayer(cacheId: string) {
  const p = project.value
  const id = `img:${cacheId}`
  const layerFilters = { ...p.display.layerFilters }
  delete layerFilters[id as `img:${string}`]
  commit({
    ...p,
    imageLayers: p.imageLayers.filter(l => l.id !== cacheId),
    layers: p.layers.filter(l => l.id !== id),
    display: { ...p.display, layerFilters },
    globe: p.globe.source === id ? { ...p.globe, source: 'map' } : p.globe,
  })
}

export function koppenPalette(p: Project): KoppenMatch[] {
  const out: KoppenMatch[] = []
  for (const c of p.koppenClasses) {
    for (const hex of c.match) {
      const value = parseInt(hex.replace('#', ''), 16)
      if (Number.isFinite(value)) out.push({ code: c.code, rgb: [(value >> 16) & 255, (value >> 8) & 255, value & 255] })
    }
  }
  return out
}

export async function importKoppen(path: string, cropSquare: boolean, tolerance: number) {
  const p = project.value
  const classes = p.koppenClasses.length ? p.koppenClasses : defaultKoppenClasses()
  const palette = koppenPalette({ ...p, koppenClasses: classes })
  try {
    const meta = await withBusy('Klimakarte einlesen', () => platform.importKoppen({ path, palette, tolerance, cropSquare }))
    // the raster holds indices into the palette list; map them onto class codes
    patchProject({
      koppen: { source: path, id: meta.id, cropSquare, tolerance, importedAt: Date.now(), unmatched: meta.unmatched, unmatchedColors: meta.unmatchedColors },
    })
    await loadKoppenData(meta.id)
    notify(meta.unmatched > 0.001 ? `Klimakarte importiert – ${(meta.unmatched * 100).toFixed(1)} % der Pixel ohne Zuordnung.` : 'Klimakarte importiert.', meta.unmatched > 0.01 ? 'error' : 'ok')
    return meta
  } catch (error) {
    notify(`Klimakarte: ${error}`, 'error')
    return null
  }
}

/** distance of a point to a polyline, in km */
function pointLineKm(point: LonLat, line: LonLat[], radius: number) {
  let best = Infinity
  const k = Math.cos((point[1] * Math.PI) / 180)
  for (let i = 1; i < line.length; i++) {
    const [ax, ay] = line[i - 1]
    const [bx, by] = line[i]
    const dx = (bx - ax) * k
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    const t = len2 ? Math.max(0, Math.min(1, (((point[0] - ax) * k) * dx + (point[1] - ay) * dy) / len2)) : 0
    const projected: LonLat = [ax + t * (bx - ax), ay + t * (by - ay)]
    best = Math.min(best, distanceM(point, projected, radius) / 1000)
  }
  return best
}

export const riverOrphans = signal<River[]>([])

export async function importRivers(options: { path: string; threshold: number; minLengthKm: number; simplifyPx: number; cropSquare: boolean }) {
  const p = project.value
  let result
  try {
    result = await withBusy('Flüsse vektorisieren', () => platform.importRivers(options, p.planetRadius))
  } catch (error) {
    notify(`Flüsse: ${error}`, 'error')
    return null
  }
  // names, notes and descriptions move over to the new line that runs where the old one ran
  const radius = p.planetRadius
  const cared = p.rivers.filter(r => r.name || r.description || r.note)
  const taken = new Set<string>()
  const ids = result.rivers.map(() => newId('river'))
  const carried = new Map<number, River>()
  const candidates: { index: number; old: River; score: number }[] = []
  result.rivers.forEach((line, index) => {
    const step = Math.max(1, Math.floor(line.coords.length / 10))
    const samples = line.coords.filter((_, i) => i % step === 0) as LonLat[]
    for (const old of cared) {
      const mean = samples.reduce((s, pt) => s + pointLineKm(pt, old.geometry.coordinates, radius), 0) / samples.length
      if (mean < 25) candidates.push({ index, old, score: mean })
    }
  })
  candidates.sort((a, b) => a.score - b.score)
  for (const c of candidates) {
    if (taken.has(c.old.id) || carried.has(c.index)) continue
    taken.add(c.old.id)
    carried.set(c.index, c.old)
  }
  const rivers: River[] = result.rivers.map((line, index) => {
    const old = carried.get(index)
    return {
      id: old?.id ?? ids[index],
      name: old?.name ?? '',
      description: old?.description ?? '',
      note: old?.note ?? '',
      type: old?.type ?? (line.upstreamKm > 1500 ? 'Strom' : line.lengthKm < 80 ? 'Bach' : 'Fluss'),
      geometry: { type: 'LineString', coordinates: line.coords as LonLat[] },
      parentId: '',
      lengthKm: Math.round(line.lengthKm),
      upstreamKm: Math.round(line.upstreamKm),
      flow: line.flow,
    }
  })
  result.rivers.forEach((line, index) => {
    if (line.parent != null) rivers[index].parentId = rivers[line.parent].id
  })
  const orphans = cared.filter(r => !taken.has(r.id))
  riverOrphans.value = orphans
  commit({
    ...project.value,
    rivers: [...rivers, ...orphans],
    riverImport: { source: options.path, threshold: options.threshold, minLengthKm: options.minLengthKm, simplifyPx: options.simplifyPx, cropSquare: options.cropSquare, importedAt: Date.now() },
  })
  notify(`${rivers.length} Flüsse übernommen${carried.size ? `, ${carried.size} mit Namen erhalten` : ''}${orphans.length ? `, ${orphans.length} benannte Flüsse ohne Gegenstück` : ''}.`, orphans.length ? 'error' : 'ok')
  await findConflicts()
  return result
}

// ---------------------------------------------------------------------------------------------
// conflicts: what the terrain now says against the data

export async function findConflicts(): Promise<Conflict[]> {
  const p = project.value
  const out: Conflict[] = []
  if (terrain.value) {
    const points: { kind: EntityKind; id: string; name: string; at: LonLat; wantLand: boolean }[] = []
    for (const c of p.cities) points.push({ kind: 'city', id: c.id, name: c.name, at: c.geometry.coordinates, wantLand: true })
    for (const m of p.markers) {
      const type = p.catalog.markerTypes.find(t => t.id === m.type)
      if (type?.land) points.push({ kind: 'marker', id: m.id, name: m.name, at: m.geometry.coordinates, wantLand: true })
    }
    for (const r of p.regiments) points.push({ kind: 'regiment', id: r.id, name: r.name, at: r.geometry.coordinates, wantLand: !r.naval })
    const heights = await platform.heights(points.map(x => x.at))
    points.forEach((point, i) => {
      const h = heights[i]
      if (h == null) return
      if (point.wantLand && h <= 0) out.push({ kind: point.kind, id: point.id, at: point.at, text: `„${point.name}“ liegt jetzt im Meer (${Math.round(h)} m)` })
      if (!point.wantLand && h > 0) out.push({ kind: point.kind, id: point.id, at: point.at, text: `„${point.name}“ (Flotte) liegt an Land (${Math.round(h)} m)` })
    })
    // land routes: the share of their line that runs through the sea
    for (const route of p.routes) {
      const type = p.catalog.routeTypes.find(t => t.id === route.type)
      if (!type || type.kind === 'air') continue
      const samples = densify(route.geometry.coordinates, 40)
      const hs = await platform.heights(samples)
      const wet = hs.filter(h => h != null && h <= 0).length / Math.max(1, hs.length)
      if (type.kind === 'land' && wet > 0.08) out.push({ kind: 'route', id: route.id, at: route.geometry.coordinates[0], text: `Route „${route.name}“ verläuft zu ${Math.round(wet * 100)} % durch Wasser` })
      if (type.kind === 'sea' && 1 - wet > 0.35) out.push({ kind: 'route', id: route.id, at: route.geometry.coordinates[0], text: `Seeweg „${route.name}“ verläuft zu ${Math.round((1 - wet) * 100)} % über Land` })
    }
  }
  for (const river of riverOrphans.value) {
    if (p.rivers.some(r => r.id === river.id)) out.push({ kind: 'river', id: river.id, at: river.geometry.coordinates[0], text: `Fluss „${river.name || 'ohne Namen'}“ passt zu keiner Linie der neuen Flussmaske` })
  }
  conflicts.value = out
  return out
}

function densify(line: LonLat[], count: number): LonLat[] {
  if (line.length < 2) return line
  const out: LonLat[] = []
  const per = Math.max(1, Math.ceil(count / (line.length - 1)))
  for (let i = 1; i < line.length; i++) {
    const [ax, ay] = line[i - 1]
    const [bx, by] = line[i]
    for (let k = 0; k < per; k++) out.push([ax + ((bx - ax) * k) / per, ay + ((by - ay) * k) / per])
  }
  out.push(line[line.length - 1])
  return out
}

// ---------------------------------------------------------------------------------------------
// drawing on the map

const toMulti = (g: AreaGeometry | null): PcMulti => (g ? (g.coordinates as unknown as PcMulti) : [])
const fromMulti = (coords: PcMulti): AreaGeometry | null => (coords.length ? { type: 'MultiPolygon', coordinates: coords as unknown as LonLat[][][] } : null)

/**
 * How a drawn shape meets the elements of its kind next to it: it cuts them back, it is cut back
 * to them (clean shared borders), or both keep overlapping. Remembered per kind and machine.
 */
export type BorderMode = 'cut' | 'fit' | 'overlap'
const BORDER_DEFAULTS: Record<AreaKind, BorderMode> = { state: 'cut', province: 'cut', culture: 'overlap', religion: 'overlap', zone: 'overlap' }
export const borderModes = signal<Record<AreaKind, BorderMode>>(readBorderModes())
function readBorderModes(): Record<AreaKind, BorderMode> {
  try {
    return { ...BORDER_DEFAULTS, ...JSON.parse(localStorage.getItem('veil.borders') ?? '{}') }
  } catch {
    return { ...BORDER_DEFAULTS }
  }
}
borderModes.subscribe(value => {
  try {
    localStorage.setItem('veil.borders', JSON.stringify(value))
  } catch {
    /* storage blocked */
  }
})

/** the neighbours a shape of this kind must not overlap: the same kind; provinces only within their state */
function rivalsOf(p: Project, kind: AreaKind, id: string, stateId: string): AreaBase[] {
  if (kind === 'province') return p.provinces.filter(x => x.id !== id && x.stateId === stateId)
  return (p[collectionOf(kind)] as AreaBase[]).filter(x => x.id !== id)
}

function subtractFromRivals(p: Project, kind: AreaKind, id: string, stateId: string, shape: PcMulti): Project {
  const rivals = rivalsOf(p, kind, id, stateId)
  if (!rivals.length) return p
  const box = bboxOf(shape as unknown as LonLat[][][])
  const changed = new Map<string, AreaGeometry | null>()
  for (const rival of rivals) {
    if (!rival.geometry || !bboxHit(bboxOf(rival.geometry.coordinates), box)) continue
    changed.set(rival.id, fromMulti(polygonClipping.difference(toMulti(rival.geometry), shape)))
  }
  if (!changed.size) return p
  const key = collectionOf(kind)
  return { ...p, [key]: (p[key] as AreaBase[]).map(item => (changed.has(item.id) ? { ...item, geometry: changed.get(item.id)! } : item)) }
}

/** the shape without what the neighbours already hold; a province also stays inside its state */
function fitToRivals(p: Project, kind: AreaKind, id: string, stateId: string, shape: PcMulti): PcMulti {
  const box = bboxOf(shape as unknown as LonLat[][][])
  const taken = rivalsOf(p, kind, id, stateId)
    .filter(r => r.geometry && bboxHit(bboxOf(r.geometry.coordinates), box))
    .map(r => toMulti(r.geometry))
  let out = taken.length ? polygonClipping.difference(shape, ...taken) : shape
  const state = kind === 'province' ? p.states.find(s => s.id === stateId) : undefined
  if (state?.geometry && out.length) out = polygonClipping.intersection(out, toMulti(state.geometry))
  return out
}

/** the drawn shape after the border rule; null when nothing of it is left */
function applyBorders(p: Project, kind: AreaKind, id: string, stateId: string, shape: PcMulti): { shape: PcMulti; next: (q: Project) => Project } | null {
  const mode = borderModes.value[kind]
  if (mode === 'fit') {
    const fitted = fitToRivals(p, kind, id, stateId, shape)
    if (!fitted.length) {
      notify('Die gezeichnete Fläche liegt ganz in Nachbarflächen – nichts übernommen.')
      return null
    }
    return { shape: fitted, next: q => q }
  }
  if (mode === 'cut') return { shape, next: q => subtractFromRivals(q, kind, id, stateId, shape) }
  return { shape, next: q => q }
}

export function handleArea(t: Tool, polygon: LonLat[][], at: LonLat) {
  const p = project.value
  if (t.id === 'area-new') {
    const entity = t.kind === 'province' ? create.province(p, selectionState()) : create[t.kind](p)
    const stateId = (entity as { stateId?: string }).stateId ?? ''
    const ruled = applyBorders(p, t.kind, entity.id, stateId, [polygon] as unknown as PcMulti)
    if (!ruled) return
    entity.geometry = fromMulti(ruled.shape)
    const next: Project = ruled.next({ ...p, [collectionOf(t.kind)]: [...(p[collectionOf(t.kind)] as AreaBase[]), entity] })
    commit(next)
    selection.value = { kind: t.kind, id: entity.id }
    tool.value = { id: 'area-add', kind: t.kind, entityId: entity.id }
    return
  }
  if (t.id !== 'area-add' && t.id !== 'area-subtract' && t.id !== 'area-island') return
  const entity = findEntity(t.kind, t.entityId) as AreaBase | undefined
  if (!entity) return
  let shape: PcMulti
  if (t.id === 'area-island') {
    const island = islandAt(at)
    if (!island) {
      notify('Hier ist kein Land.')
      return
    }
    shape = [island] as unknown as PcMulti
  } else shape = [polygon] as unknown as PcMulti
  const key = collectionOf(t.kind)
  if (t.id === 'area-subtract') {
    const geometry = fromMulti(polygonClipping.difference(toMulti(entity.geometry), shape))
    commit({ ...p, [key]: (p[key] as AreaBase[]).map(item => (item.id === entity.id ? { ...item, geometry } : item)) })
    return
  }
  const ruled = applyBorders(p, t.kind, entity.id, (entity as { stateId?: string }).stateId ?? '', shape)
  if (!ruled) return
  const geometry = fromMulti(polygonClipping.union(toMulti(entity.geometry), ruled.shape))
  commit(ruled.next({ ...p, [key]: (p[key] as AreaBase[]).map(item => (item.id === entity.id ? { ...item, geometry } : item)) }))
}

/** cuts a province to the drawn outline of its state */
export function fitProvinceToState(id: string) {
  const p = project.value
  const province = p.provinces.find(x => x.id === id)
  const state = p.states.find(s => s.id === province?.stateId)
  if (!province?.geometry || !state?.geometry) return
  updateEntity('province', id, { geometry: fromMulti(polygonClipping.intersection(toMulti(province.geometry), toMulti(state.geometry))) })
}

function selectionState() {
  const s = selection.value
  if (s?.kind === 'state') return s.id
  if (s?.kind === 'province') return findEntity('province', s.id)?.stateId ?? ''
  return ''
}

const collectionOf = (kind: AreaKind) => ({ state: 'states', province: 'provinces', culture: 'cultures', religion: 'religions', zone: 'zones' } as const)[kind]

/** screen pixels within which a route end snaps onto a city */
const SNAP_PX = 12

/** snapping onto cities, and for sea routes the way around the land; `px` is degrees per pixel */
function finishRoute(line: LonLat[], typeId: string, px: number): LonLat[] {
  const p = project.value
  let out = snapCities.value ? snapEnds(line, p.cities, px * SNAP_PX) : line
  const type = p.catalog.routeTypes.find(t => t.id === typeId)
  if (type?.kind === 'sea' && terrain.value) {
    const result = avoidLand(out, terrain.value.land, px * 2)
    if (result.failed) notify('Ein Stück des Seewegs findet keinen Weg um das Land herum und bleibt wie gezeichnet.', 'error')
    out = result.line
  }
  return out
}

/**
 * Puts a route's new line into the project: the routes docked onto it follow, and its ends dock
 * onto other routes (a branch, a join) when snapping is on. `before`: the old line, if any.
 */
function placeRoute(p: Project, route: Route, before: LonLat[] | null, px: number): Project {
  let routes = p.routes.some(r => r.id === route.id) ? p.routes.map(r => (r.id === route.id ? route : r)) : [...p.routes, route]
  routes = settleJunctions(routes, route.id, before, p.cities)
  if (snapCities.value && px > 0) routes = dockEnds(routes, route.id, p.cities, px * SNAP_PX)
  return { ...p, routes }
}

/** a changed line for an existing route, with everything docked onto it */
function changeRouteLine(id: string, coordinates: LonLat[], px = 0) {
  const p = project.value
  const route = p.routes.find(r => r.id === id)
  if (!route) return
  commit(placeRoute(p, { ...route, geometry: { type: 'LineString', coordinates } }, route.geometry.coordinates, px))
}

/** a stroke drawn onto a route replaces the section it spans, or extends the route */
export function reshapeRoute(id: string, stroke: LonLat[], px: number) {
  const route = findEntity('route', id)
  if (!route) return
  const line = reshapeLine(route.geometry.coordinates, stroke, px * 15)
  if (!line) {
    notify('Der Strich muss an der Route beginnen oder enden.')
    return
  }
  changeRouteLine(id, finishRoute(line, route.type, px), px)
}

/** fewer points, so single ones can be dragged; `px` is degrees per pixel */
export function simplifyRoute(id: string, px: number) {
  const route = findEntity('route', id)
  if (!route) return
  const before = route.geometry.coordinates.length
  const coordinates = simplifyLine(route.geometry.coordinates, px * 1.5)
  if (coordinates.length === before) {
    notify('Bei diesem Zoom lässt sich nichts weiter vereinfachen – zum Vereinfachen weiter herauszoomen.')
    return
  }
  changeRouteLine(id, coordinates)
  notify(`${before} → ${coordinates.length} Stützpunkte.`, 'ok')
}

/** leads an existing sea route around the land */
export function routeAroundLand(id: string, px: number) {
  const route = findEntity('route', id)
  if (!route || !terrain.value) return
  const result = avoidLand(route.geometry.coordinates, terrain.value.land, px * 2)
  if (result.changed) changeRouteLine(id, result.line)
  notify(result.failed ? 'Nicht jedes Stück fand einen Weg um das Land herum.' : result.changed ? 'Der Seeweg führt jetzt um das Land herum.' : 'Der Seeweg kreuzt kein Land.', result.failed ? 'error' : 'ok')
}

export function handleCreate(t: Tool, geometry: PointGeometry | LineGeometry, px = 0) {
  const p = project.value
  if (t.id === 'place' && geometry.type === 'Point') {
    const at = geometry.coordinates
    if (t.kind === 'city') {
      const city = create.city(p, at)
      city.type = placeType.value.city ?? 'town'
      addEntity('city', city)
    } else if (t.kind === 'marker') addEntity('marker', create.marker(p, at, placeType.value.marker ?? 'poi'))
    else if (t.kind === 'regiment') {
      const state = p.states.find(s => s.geometry && inAreaQuick(s.geometry, at))
      addEntity('regiment', create.regiment(p, at, state?.id ?? ''))
    } else addEntity('label', create.label(p, geometry))
    return
  }
  if (t.id === 'draw-line' && geometry.type === 'LineString') {
    if (t.kind === 'route') {
      const type = placeType.value.route ?? 'road'
      const route = create.route(p, finishRoute(geometry.coordinates, type, px), type)
      commit(placeRoute(p, route, null, px))
      selection.value = { kind: 'route', id: route.id }
    }
    else addEntity('label', create.label(p, geometry))
  }
}

function inAreaQuick(g: AreaGeometry, [x, y]: LonLat) {
  return g.coordinates.some(poly => {
    const ring = poly[0]
    let inside = false
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]
      const [xj, yj] = ring[j]
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
    }
    return inside
  })
}

export function editGeometry(kind: EntityKind, id: string, geometry: unknown) {
  if (kind === 'route') {
    // a dragged point: docked routes follow, the own ends dock again where they were snapped
    changeRouteLine(id, (geometry as LineGeometry).coordinates)
    return
  }
  const city = kind === 'city' ? findEntity('city', id) : undefined
  if (city) {
    // routes snapped onto the city move with it
    const p = project.value
    const at = (geometry as PointGeometry).coordinates
    commit({ ...p, cities: p.cities.map(c => (c.id === id ? { ...c, geometry: geometry as PointGeometry } : c)), routes: followPoint(p.routes, city.geometry.coordinates, at) })
    return
  }
  updateEntity(kind, id, { geometry } as never)
}

export const isArea = (kind: EntityKind): kind is AreaKind => (AREA_KINDS as readonly string[]).includes(kind)

export { list }
