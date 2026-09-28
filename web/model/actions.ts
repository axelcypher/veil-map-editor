// Operations the UI triggers: files, imports, drawing areas, conflicts after a new terrain.
import { signal } from '@preact/signals'
import polygonClipping, { type MultiPolygon as PcMulti } from 'polygon-clipping'
import { platform, type ImportReport } from '../platform'
import { defaultKoppenClasses } from './catalog'
import { bboxHit, bboxOf, distanceM } from './geo'
import { create, newId, newProject, parseProject, serializeProject } from './project'
import {
  addEntity, busy, commit, dirty, filePath, findEntity, list, notify, patchProject, placeType, project, resetProject, selection, tool,
  updateEntity, type Tool,
} from './store'
import { clearTerrain, islandAt, loadKoppenData, loadTerrainData, koppen as koppenData, terrain } from './terrain'
import {
  AREA_KINDS, type AreaBase, type AreaGeometry, type AreaKind, type EntityKind, type KoppenMatch, type LineGeometry, type LonLat,
  type PointGeometry, type Project, type River,
} from './types'

export const PROJECT_FILTER = [{ name: 'Veil-Projekt', extensions: ['veil'] }]
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
  clearTerrain()
  koppenData.value = null
  conflicts.value = []
  resetProject(newProject(), null)
}

export const confirmRequest = signal<{ text: string; resolve: (ok: boolean) => void } | null>(null)
export const confirmDialog = (text: string) => new Promise<boolean>(resolve => { confirmRequest.value = { text, resolve } })
const confirmDiscard = () => confirmDialog('Ungespeicherte Änderungen verwerfen?')

export async function openFile(path?: string) {
  if (dirty.value && !(await confirmDiscard())) return
  const chosen = path ?? (await platform.pickFile('Projekt öffnen', PROJECT_FILTER))
  if (!chosen) return
  try {
    const next = parseProject(await platform.readText(chosen))
    await platform.closeTerrain()
    clearTerrain()
    koppenData.value = null
    conflicts.value = []
    resetProject(next, chosen)
    rememberRecent(chosen)
    await restoreRasters(next)
  } catch (error) {
    notify(`Öffnen fehlgeschlagen: ${error instanceof Error ? error.message : error}`, 'error')
  }
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
}

export async function saveFile(saveAs = false) {
  let path = filePath.value
  if (!path || saveAs || path.startsWith('upload:')) {
    path = await platform.pickSavePath('Projekt speichern', `${project.value.name || 'karte'}.veil`, PROJECT_FILTER)
    if (!path) return false
  }
  try {
    await platform.writeText(path, serializeProject(project.value))
    filePath.value = path
    dirty.value = false
    rememberRecent(path)
    notify('Gespeichert', 'ok')
    return true
  } catch (error) {
    notify(`Speichern fehlgeschlagen: ${error}`, 'error')
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

/** states cannot overlap, and provinces of one state cannot either */
function exclusiveRivals(p: Project, kind: AreaKind, id: string): AreaBase[] {
  if (kind === 'state') return p.states.filter(s => s.id !== id)
  if (kind === 'province') {
    const own = p.provinces.find(x => x.id === id)
    return p.provinces.filter(x => x.id !== id && x.stateId === own?.stateId)
  }
  return []
}

function subtractFromRivals(p: Project, kind: AreaKind, id: string, shape: PcMulti): Project {
  const rivals = exclusiveRivals(p, kind, id)
  if (!rivals.length) return p
  const box = bboxOf(shape as unknown as LonLat[][][])
  const changed = new Map<string, AreaGeometry | null>()
  for (const rival of rivals) {
    if (!rival.geometry || !bboxHit(bboxOf(rival.geometry.coordinates), box)) continue
    changed.set(rival.id, fromMulti(polygonClipping.difference(toMulti(rival.geometry), shape)))
  }
  if (!changed.size) return p
  const key = kind === 'state' ? 'states' : 'provinces'
  return { ...p, [key]: (p[key] as AreaBase[]).map(item => (changed.has(item.id) ? { ...item, geometry: changed.get(item.id)! } : item)) }
}

export const exclusiveAreas = signal(true)

export function handleArea(t: Tool, polygon: LonLat[][], at: LonLat) {
  const p = project.value
  if (t.id === 'area-new') {
    const entity = t.kind === 'province' ? create.province(p, selectionState()) : create[t.kind](p)
    entity.geometry = { type: 'MultiPolygon', coordinates: [polygon] }
    let next: Project = { ...p, [collectionOf(t.kind)]: [...(p[collectionOf(t.kind)] as AreaBase[]), entity] }
    if (exclusiveAreas.value) next = subtractFromRivals(next, t.kind, entity.id, [polygon] as unknown as PcMulti)
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
  const geometry =
    t.id === 'area-subtract' ? fromMulti(polygonClipping.difference(toMulti(entity.geometry), shape)) : fromMulti(polygonClipping.union(toMulti(entity.geometry), shape))
  const key = collectionOf(t.kind)
  let next: Project = { ...p, [key]: (p[key] as AreaBase[]).map(item => (item.id === entity.id ? { ...item, geometry } : item)) }
  if (t.id !== 'area-subtract' && exclusiveAreas.value) next = subtractFromRivals(next, t.kind, entity.id, shape)
  commit(next)
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

export function handleCreate(t: Tool, geometry: PointGeometry | LineGeometry) {
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
    if (t.kind === 'route') addEntity('route', create.route(p, geometry.coordinates, placeType.value.route ?? 'road'))
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
  updateEntity(kind, id, { geometry } as never)
}

export const isArea = (kind: EntityKind): kind is AreaKind => (AREA_KINDS as readonly string[]).includes(kind)

export { list }
