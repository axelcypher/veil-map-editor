// The adapter layer from the vault note: all editing logic lives in the page; file access and the
// heavy raster work go through this interface. Desktop uses Tauri/Rust, a web build can use uploads,
// downloads and the Obsidian "Local REST API" plugin.
import type { ControlPoint, KoppenMatch } from '../model/types'

export interface Check {
  label: string
  status: 'ok' | 'warn' | 'error'
  detail: string
}

export interface SourceInfo {
  format: string
  width: number
  height: number
  bitDepth: number
  channels: number
  float: boolean
}

export interface TerrainMeta {
  id: string
  source: string
  hash: string
  width: number
  height: number
  cropSquare: boolean
  maxZoom: number
  tileSize: number
  gridWidth: number
  gridHeight: number
  minM: number
  maxM: number
  seaFraction: number
  createdAt: number
}

export interface ImportReport {
  ok: boolean
  source: SourceInfo | null
  checks: Check[]
  meta: TerrainMeta | null
}

export interface RiverLine {
  index: number
  parent: number | null
  coords: [number, number][]
  lengthKm: number
  upstreamKm: number
  flow: number
}

export interface RiverResult {
  rivers: RiverLine[]
  pixels: number
  width: number
  height: number
}

export interface KoppenMeta {
  id: string
  source: string
  hash: string
  width: number
  height: number
  codes: string[]
  shares: Record<string, number>
  unmatched: number
  unmatchedColors: [string, number][]
}

export interface VaultNote {
  path: string
  modified: number
}

export interface FileFilter {
  name: string
  extensions: string[]
}

export interface Progress {
  stage: string
  fraction: number
}

export interface Platform {
  kind: 'desktop' | 'web'
  pickFile(title: string, filters: FileFilter[]): Promise<string | null>
  pickSavePath(title: string, suggested: string, filters: FileFilter[]): Promise<string | null>
  pickFolder(title: string): Promise<string | null>
  readText(path: string): Promise<string>
  writeText(path: string, content: string): Promise<void>
  fileExists(path: string): Promise<boolean>
  /** a URL the page can load a picked file from (images for textures and city plans) */
  fileUrl(path: string): Promise<string>
  openExternal(url: string): Promise<void>
  openFile(path: string): Promise<void>

  importTerrain(options: { path: string; cropSquare: boolean; controlPoints: ControlPoint[] }, radiusM: number): Promise<ImportReport>
  openTerrain(id: string): Promise<TerrainMeta>
  closeTerrain(): Promise<void>
  heights(points: [number, number][]): Promise<(number | null)[]>
  /** base URL of derived data (tiles, grids) for a cache path like "terrain/<id>/grid.i16" */
  cacheUrl(path: string): string
  importRivers(options: { path: string; threshold: number; minLengthKm: number; simplifyPx: number; cropSquare: boolean }, radiusM: number): Promise<RiverResult>
  importKoppen(options: { path: string; palette: KoppenMatch[]; tolerance: number; cropSquare: boolean }): Promise<KoppenMeta>
  koppenHistogram(path: string): Promise<[string, number][]>

  vaultList(root: string): Promise<VaultNote[]>
  vaultRead(root: string, path: string): Promise<string>

  onProgress(handler: (progress: Progress) => void): () => void
}
