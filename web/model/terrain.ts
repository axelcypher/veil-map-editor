// What the page knows about the imported terrain: meta data, a coarse height grid, the coast
// polygons and the climate classes. The terrain is read-only; nothing here writes back.
import { signal } from '@preact/signals'
import { platform, type KoppenMeta, type SatelliteMeta, type TerrainMeta } from '../platform'
import type { AreaGeometry, LonLat } from './types'

export interface TerrainState {
  meta: TerrainMeta
  grid: Int16Array
  land: AreaGeometry
}

export const terrain = signal<TerrainState | null>(null)
export const koppen = signal<{ meta: KoppenMeta; classes: Uint8Array } | null>(null)
export const satellite = signal<SatelliteMeta | null>(null)
/** own image layers that are in the cache, by cache id */
export const imageLayerData = signal<Map<string, SatelliteMeta>>(new Map())

async function fetchBinary(path: string) {
  const response = await fetch(platform.cacheUrl(path))
  if (!response.ok) throw new Error(`Cache-Datei fehlt: ${path}`)
  return response.arrayBuffer()
}

export async function loadTerrainData(meta: TerrainMeta) {
  const [grid, landText] = await Promise.all([
    fetchBinary(`terrain/${meta.id}/grid.i16`),
    fetch(platform.cacheUrl(`terrain/${meta.id}/land.json`)).then(r => r.text()),
  ])
  const land = JSON.parse(landText) as AreaGeometry
  terrain.value = { meta, grid: new Int16Array(grid), land }
  setLand(land)
}

/** the raster holds indices into the palette used at import time, so its own meta file is read */
export async function loadKoppenData(id: string) {
  const meta = (await (await fetch(platform.cacheUrl(`koppen/${id}/meta.json`))).json()) as KoppenMeta
  const classes = new Uint8Array(await fetchBinary(`koppen/${meta.id}/classes.u8`))
  koppen.value = { meta, classes }
}

async function pictureMeta(id: string) {
  const response = await fetch(platform.cacheUrl(`satellite/${id}/meta.json`))
  if (!response.ok) throw new Error('Kein Cache für dieses Bild vorhanden.')
  return (await response.json()) as SatelliteMeta
}

export async function loadSatelliteData(id: string) {
  satellite.value = await pictureMeta(id)
}

export async function loadImageLayerData(id: string) {
  const meta = await pictureMeta(id)
  imageLayerData.value = new Map(imageLayerData.value).set(id, meta)
}


export function clearTerrain() {
  terrain.value = null
  setLand(null)
}

/** nearest grid height in metres (≈10 km cells); exact values come from platform.heights */
export function gridHeight([lon, lat]: LonLat): number | null {
  const t = terrain.value
  if (!t) return null
  const { gridWidth: w, gridHeight: h } = t.meta
  const x = Math.min(w - 1, Math.max(0, Math.floor(((lon + 180) / 360) * w)))
  const y = Math.min(h - 1, Math.max(0, Math.floor(((90 - lat) / 180) * h)))
  return t.grid[y * w + x]
}

export function koppenAt([lon, lat]: LonLat): string | null {
  const k = koppen.value
  if (!k) return null
  const { width: w, height: h, codes } = k.meta
  const x = Math.min(w - 1, Math.max(0, Math.floor(((lon + 180) / 360) * w)))
  const y = Math.min(h - 1, Math.max(0, Math.floor(((90 - lat) / 180) * h)))
  const value = k.classes[y * w + x]
  return value ? codes[value - 1] : null
}

// ---------------------------------------------------------------------------------------------
// cutting areas to the land, in a worker

const worker = new Worker(new URL('./clip.worker.ts', import.meta.url), { type: 'module' })
const pending = new Map<number, (result: AreaGeometry | null) => void>()
let requestId = 0
/** bumps whenever a clipped shape arrives, so the map redraws */
export const clipVersion = signal(0)
export const landVersion = signal(0)
const clipped = new WeakMap<AreaGeometry, { land: number; result: AreaGeometry | null; waiting: boolean }>()

worker.onmessage = event => {
  const { id, coordinates, error } = event.data as { id: number; coordinates?: LonLat[][][]; error?: string }
  const resolve = pending.get(id)
  pending.delete(id)
  if (error) console.warn('Zuschneiden fehlgeschlagen', error)
  resolve?.(coordinates ? { type: 'MultiPolygon', coordinates } : null)
}

function setLand(land: AreaGeometry | null) {
  worker.postMessage({ type: 'land', coordinates: land?.coordinates ?? [] })
  landVersion.value++
}

/**
 * The area as shown and exported: cut to the land when there is terrain and the element wants it.
 * Returns the drawn shape until the worker has answered.
 */
export function shownGeometry(geometry: AreaGeometry | null, clip: boolean): AreaGeometry | null {
  if (!geometry || !clip || !terrain.value) return geometry
  const land = landVersion.value
  const entry = clipped.get(geometry)
  if (entry && entry.land === land) return entry.waiting ? geometry : entry.result
  clipped.set(geometry, { land, result: null, waiting: true })
  const id = ++requestId
  pending.set(id, result => {
    clipped.set(geometry, { land, result, waiting: false })
    clipVersion.value++
  })
  worker.postMessage({ type: 'clip', id, coordinates: geometry.coordinates })
  return geometry
}

/** waits for the land-cut shape, for exports and area sums */
export function clippedGeometry(geometry: AreaGeometry | null, clip: boolean): Promise<AreaGeometry | null> {
  if (!geometry || !clip || !terrain.value) return Promise.resolve(geometry)
  const land = landVersion.value
  const entry = clipped.get(geometry)
  if (entry && entry.land === land && !entry.waiting) return Promise.resolve(entry.result)
  return new Promise(resolve => {
    const id = ++requestId
    pending.set(id, result => {
      clipped.set(geometry, { land, result, waiting: false })
      clipVersion.value++
      resolve(result)
    })
    worker.postMessage({ type: 'clip', id, coordinates: geometry.coordinates })
  })
}

/** the land polygon (island) under a point */
export function islandAt(point: LonLat): LonLat[][] | null {
  const t = terrain.value
  if (!t) return null
  const [x, y] = point
  for (const poly of t.land.coordinates) {
    const ring = poly[0]
    let inside = false
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]
      const [xj, yj] = ring[j]
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
    }
    if (inside) return [ring]
  }
  return null
}
