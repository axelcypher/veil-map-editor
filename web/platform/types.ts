// The adapter layer from the vault note: all editing logic lives in the page; file access and the
// heavy raster work go through this interface. Desktop uses Tauri/Rust, a web build can use uploads,
// downloads and the Obsidian "Local REST API" plugin.
import type { ArchiveOptions, ControlPoint, KoppenMatch } from '../model/types'

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
  /** 'png' from an import, 'webp' when unpacked from an archive */
  tileExt: string
  /** false: only the ≈10 km grid came along in an archive */
  fullHeights: boolean
}

export interface SatelliteMeta {
  id: string
  source: string
  hash: string
  width: number
  height: number
  cropSquare: boolean
  maxZoom: number
  tileSize: number
  tileExt: string
  /** the tiles carry transparency */
  alpha?: boolean
  createdAt: number
}

export interface ArchiveReport {
  bytes: number
  tiles: number
  tileBytes: number
  heightsBytes: number
  fullHeights: boolean
}

export interface OpenedProject {
  /** the .veil JSON */
  project: string
  /** it came from a .veilmap archive, whose rasters are now in the cache */
  archive: boolean
  unpacked: string[]
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
  /** Android (or iOS): no raster imports on the device, the terrain comes from an archive */
  mobile: boolean
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
  importSatellite(options: { path: string; cropSquare: boolean }): Promise<SatelliteMeta>
  /** reads a .veil, or unpacks a .veilmap into the cache */
  openProject(path: string): Promise<OpenedProject>
  saveArchive(
    path: string,
    content: { project: string; terrainId: string | null; koppenId: string | null; satelliteId: string | null; imageIds: string[] },
    options: ArchiveOptions,
  ): Promise<ArchiveReport>
  /** writes binary data the page made (globe images and animations) */
  writeBinary(path: string, data: Uint8Array): Promise<void>

  vaultList(root: string): Promise<VaultNote[]>
  vaultRead(root: string, path: string): Promise<string>

  onProgress(handler: (progress: Progress) => void): () => void

  /** the app's own title bar replaces the system one on the desktop; absent elsewhere */
  window?: WindowControls
  /** in-app update from the GitHub release (desktop builds made with the update key) */
  updater?: Updater
}

export interface Updater {
  /** false in builds without the update key; those point to the release page instead */
  ready(): Promise<boolean>
  /** downloads, checks the signature and installs; resolves false when there was nothing newer */
  install(onProgress: (fraction: number | null) => void): Promise<boolean>
  relaunch(): Promise<void>
}

export interface WindowControls {
  minimize(): Promise<void>
  toggleMaximize(): Promise<void>
  close(): Promise<void>
  isMaximized(): Promise<boolean>
  /** calls back after every resize; returns the unsubscribe */
  onResized(handler: () => void): () => void
}
