// Biomes from moisture and temperature, ported from Azgaar's Fantasy Map Generator (MIT, Copyright 2017-2024 Max Haniyeu).
import type { GridGraph } from './graph'
import { FMG_SEA_LEVEL } from './height-scale'

export interface Biome {
  name: string
  color: string
}

export const BIOMES: readonly Biome[] = [
  { name: 'Meer', color: '#466eab' },
  { name: 'Heiße Wüste', color: '#fbe79f' },
  { name: 'Kalte Wüste', color: '#b5b887' },
  { name: 'Savanne', color: '#d2d082' },
  { name: 'Grasland', color: '#c8d68f' },
  { name: 'Tropischer Saisonwald', color: '#b6d95d' },
  { name: 'Laubwald', color: '#29bc56' },
  { name: 'Tropischer Regenwald', color: '#7dcb35' },
  { name: 'Gemäßigter Regenwald', color: '#409c43' },
  { name: 'Taiga', color: '#4b6b32' },
  { name: 'Tundra', color: '#96784b' },
  { name: 'Gletscher', color: '#d5e7eb' },
  { name: 'Feuchtgebiet', color: '#0b9131' },
]

export const MARINE_BIOME = 0
export const GRASSLAND_BIOME = 4

// hot to cold across [above 19 C ... below -4 C], dry to wet down the rows
const MATRIX = [
  [1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 10],
  [3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 9, 9, 9, 9, 10, 10, 10],
  [5, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 9, 9, 9, 9, 9, 10, 10, 10],
  [5, 6, 6, 6, 6, 6, 6, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 9, 9, 9, 9, 9, 9, 10, 10, 10],
  [7, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 9, 9, 9, 9, 9, 9, 9, 10, 10],
]

function isWetland(moisture: number, temperature: number, height: number): boolean {
  if (temperature <= -2) return false
  if (moisture > 40 && height < 25) return true // near the coast
  return moisture > 24 && height > 24 && height < 60 // inland
}

export function getBiomeId(moisture: number, temperature: number, height: number): number {
  if (height < FMG_SEA_LEVEL) return MARINE_BIOME
  if (temperature < -5) return 11
  if (temperature >= 25 && moisture < 8) return 1
  if (isWetland(moisture, temperature, height)) return 12
  const moistureBand = Math.min(moisture / 5 | 0, 4)
  const temperatureBand = Math.min(Math.max(20 - temperature, 0), 25)
  return MATRIX[moistureBand][temperatureBand]
}

/** biome per cell, wetter where the neighbouring land gets rain too */
export function computeBiomes(graph: GridGraph, fmgHeights: Uint8Array, temperature: Int8Array, precipitation: Uint8Array): Uint8Array {
  const biomes = new Uint8Array(graph.cellCount)
  for (let cell = 0; cell < graph.cellCount; cell += 1) {
    const height = fmgHeights[cell]
    let moisture = 0
    if (height >= FMG_SEA_LEVEL) {
      let sum = precipitation[cell]
      let count = 1
      for (const neighbor of graph.neighbors[cell]) {
        if (fmgHeights[neighbor] < FMG_SEA_LEVEL) continue
        sum += precipitation[neighbor]
        count += 1
      }
      moisture = Math.round(4 + sum / count)
    }
    biomes[cell] = getBiomeId(moisture, temperature[cell], height)
  }
  return biomes
}
