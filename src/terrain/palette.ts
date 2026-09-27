// Cell colours for the three display modes, as RGBA bytes ready for the colour texture.
import { BIOMES, GRASSLAND_BIOME } from './biomes'
import type { TerrainAnalysis } from './analysis'
import type { GridGraph } from './graph'
import type { HeightScale } from './height-scale'
import type { LayerId } from '../model'

export type DisplayMode = 'height' | 'land' | 'biome' | 'temperature' | 'precipitation'
export type Rgba = [number, number, number, number]

export const OCEAN_COLOR = '#4b7fa8'
export const LAKE_COLOR = '#79aed2'
export const COAST_COLOR = '#2f4f63'
/** temperature and rain are drawn on a fixed scale so that different maps compare */
export const TEMPERATURE_RANGE: [number, number] = [-30, 35]
export const PRECIPITATION_RANGE: [number, number] = [0, 80]
const TEMPERATURE_STOPS = ['#3b4cc0', '#6a9bd8', '#a8d5c2', '#f2e28b', '#f39b4a', '#c0392b']
const PRECIPITATION_STOPS = ['#e9d8a6', '#c9d98a', '#7fc38f', '#3b9ac4', '#23508c']
export const TEMPERATURE_GRADIENT = `linear-gradient(90deg, ${TEMPERATURE_STOPS.join(', ')})`
export const PRECIPITATION_GRADIENT = `linear-gradient(90deg, ${PRECIPITATION_STOPS.join(', ')})`
/** the two colours of the plain land/water view: the sea of the surface is rock underground and sky above */
const FLATS: Record<LayerId, { land: string; water: string }> = {
  surface: { land: '#fffdf7', water: '#4b7fa8' },
  underground: { land: '#d2bf9a', water: '#3a322c' },
  sky: { land: '#fbfaf5', water: '#7db6e0' },
}

export function hexToRgba(hex: string): Rgba {
  const value = Number.parseInt(hex.slice(1), 16)
  return [value >> 16 & 255, value >> 8 & 255, value & 255, 255]
}

function hslToRgba(hue: number, saturation: number, lightness: number): Rgba {
  const s = saturation / 100
  const l = lightness / 100
  const a = s * Math.min(l, 1 - l)
  const channel = (n: number) => {
    const k = (n + hue / 30) % 12
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
  }
  return [channel(0), channel(8), channel(4), 255]
}

const WATER_BANDS = 14
const LAND_BANDS = 16
const waterPalette = Array.from({ length: WATER_BANDS + 1 }, (_, index) => {
  const band = index / WATER_BANDS
  return hslToRgba(205 - band * 6, 48, 22 + band * 30)
})
const landPalette = Array.from({ length: LAND_BANDS + 1 }, (_, index) => {
  const band = index / LAND_BANDS
  if (band < 0.18) return hslToRgba(74, 30, 88 - band * 42)
  if (band < 0.55) return hslToRgba(62 - band * 38, 28 - band * 8, 78 - band * 30)
  return hslToRgba(25, 8, 48 + (band - 0.55) * 70)
})

function heightColor(elevation: number, scale: HeightScale): Rgba {
  if (elevation < scale.seaM) {
    const value = Math.max(0, Math.min(1, (elevation - scale.minM) / Math.max(1, scale.seaM - scale.minM)))
    return waterPalette[Math.round(value * WATER_BANDS)]
  }
  const value = Math.max(0, Math.min(1, (elevation - scale.seaM) / Math.max(1, scale.maxM - scale.seaM)))
  return landPalette[Math.round(value * LAND_BANDS)]
}

function rampColor(stops: Rgba[], value: number): Rgba {
  const position = Math.min(1, Math.max(0, value)) * (stops.length - 1)
  const index = Math.min(stops.length - 2, Math.floor(position))
  const share = position - index
  const [a, b] = [stops[index], stops[index + 1]]
  return [0, 1, 2].map(channel => Math.round(a[channel] + (b[channel] - a[channel]) * share)).concat(255) as Rgba
}

const temperaturePalette = TEMPERATURE_STOPS.map(hexToRgba)
const precipitationPalette = PRECIPITATION_STOPS.map(hexToRgba)
const biomePalette = BIOMES.map(biome => hexToRgba(biome.color))
const oceanRgba = hexToRgba(OCEAN_COLOR)
const lakeRgba = hexToRgba(LAKE_COLOR)

interface ColorInput {
  graph: GridGraph
  elevations: Float32Array
  scale: HeightScale
  mode: DisplayMode
  analysis: TerrainAnalysis | null
  layer?: LayerId
  /** how many rings of shore water take the colour of the land next to them, so the smoothed coast, which reaches beyond the cells, reveals no gap */
  shoreRings?: number
  /** territory ids per cell and the colour of each id, blended over the land */
  tint?: { ids: Uint16Array; colors: Rgba[] }
}

/** fills the RGBA byte array with one colour per cell */
export function colorCells(target: Uint8Array, input: ColorInput) {
  paintCells(target, input)
  const { tint, graph, elevations, scale, analysis } = input
  if (!tint) return
  for (let cell = 0; cell < graph.cellCount; cell += 1) {
    const color = tint.colors[tint.ids[cell]]
    if (!color || elevations[cell] < scale.seaM || (analysis && analysis.lakeDepth[cell] > 0)) continue
    for (let channel = 0; channel < 3; channel += 1) target[cell * 4 + channel] = Math.round(target[cell * 4 + channel] * 0.58 + color[channel] * 0.42)
  }
}

/** for every cell within some rings of the land, the land cell it borrows its colour from; -1 elsewhere */
function shoreSources(graph: GridGraph, isLand: (cell: number) => boolean, rings: number): Int32Array {
  const source = new Int32Array(graph.cellCount).fill(-1)
  let frontier: number[] = []
  for (let cell = 0; cell < graph.cellCount; cell += 1) {
    if (!isLand(cell)) continue
    source[cell] = cell
    if (graph.neighbors[cell].some(neighbor => !isLand(neighbor))) frontier.push(cell)
  }
  for (let ring = 0; ring < rings; ring += 1) {
    const next: number[] = []
    for (const cell of frontier) {
      for (const neighbor of graph.neighbors[cell]) {
        if (source[neighbor] >= 0) continue
        source[neighbor] = source[cell]
        next.push(neighbor)
      }
    }
    frontier = next
  }
  return source
}

function paintCells(target: Uint8Array, { graph, elevations, scale, mode, analysis, layer = 'surface', shoreRings = 0 }: ColorInput) {
  const flats = FLATS[layer]
  const put = (cell: number, [r, g, b, a]: Rgba) => {
    target[cell * 4] = r
    target[cell * 4 + 1] = g
    target[cell * 4 + 2] = b
    target[cell * 4 + 3] = a
  }

  // lakes in basins are water although the terrain there is above the sea
  const isLake = (cell: number) => !!analysis && analysis.lakeDepth[cell] > 0 && elevations[cell] >= scale.seaM
  const isLand = (cell: number) => elevations[cell] >= scale.seaM && !isLake(cell)

  if (mode === 'height') {
    for (let cell = 0; cell < graph.cellCount; cell += 1) put(cell, isLake(cell) ? lakeRgba : heightColor(elevations[cell], scale))
    return
  }
  if ((mode === 'temperature' || mode === 'precipitation') && analysis) {
    const temperature = mode === 'temperature'
    const [low, high] = temperature ? TEMPERATURE_RANGE : PRECIPITATION_RANGE
    const stops = temperature ? temperaturePalette : precipitationPalette
    const values = temperature ? analysis.temperature : analysis.precipitation
    const water = hexToRgba(flats.water)
    for (let cell = 0; cell < graph.cellCount; cell += 1) {
      put(cell, !isLand(cell) ? water : rampColor(stops, (values[cell] - low) / (high - low)))
    }
    return
  }
  if (mode === 'land' || mode === 'temperature' || mode === 'precipitation') {
    const land = hexToRgba(flats.land)
    const water = hexToRgba(flats.water)
    const source = shoreRings ? shoreSources(graph, isLand, shoreRings) : null
    for (let cell = 0; cell < graph.cellCount; cell += 1) put(cell, (source ? source[cell] >= 0 : isLand(cell)) ? land : water)
    return
  }

  // biome map: land takes its biome, shore water borrows the neighbouring land so the smoothed coast reveals no gap
  const biomeColor = (cell: number) => biomePalette[analysis?.biomes[cell] || GRASSLAND_BIOME]
  const featureIds = analysis?.features.ids
  const source = shoreSources(graph, isLand, Math.max(1, shoreRings))
  for (let cell = 0; cell < graph.cellCount; cell += 1) {
    if (source[cell] >= 0) put(cell, biomeColor(source[cell]))
    else put(cell, featureIds && analysis?.features.features[featureIds[cell]]?.type === 'lake' ? lakeRgba : oceanRgba)
  }
}
