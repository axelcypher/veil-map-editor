// Temperature and precipitation of every cell, ported from Azgaar's Fantasy Map Generator (MIT, Copyright 2017-2024 Max Haniyeu).
import { FMG_SEA_LEVEL } from './height-scale'
import { createRandom, randomInt, clamp, type Random } from './rng'

export interface ClimateSettings {
  equatorC: number
  northPoleC: number
  southPoleC: number
  /** percent, 100 is the reference amount */
  precipitationPercent: number
  /** wind direction in degrees for each 30 degree latitude tier, north to south */
  winds: number[]
}

/** the cell grid the wind simulation runs over: rows and columns are all it needs */
export interface WindGrid {
  cellsX: number
  cellsY: number
  cellCount: number
}

export const DEFAULT_CLIMATE: Readonly<ClimateSettings> = {
  equatorC: 27,
  northPoleC: -30,
  southPoleC: -15,
  precipitationPercent: 100,
  winds: [225, 45, 225, 315, 135, 315],
}

/** latitude at the top and bottom edge of the map */
export interface LatitudeRange {
  north: number
  south: number
}

const TROPICS = [16, -20]
const TROPICAL_GRADIENT = 0.15
/** temperature falls this much per kilometre of altitude */
const LAPSE_RATE_PER_KM = 6.5
const MAX_PASSABLE_ELEVATION = 85

// precipitation modifier per 5 degree latitude band, wettest at the equator and the 50s, driest at the poles and the 20s
const LATITUDE_MODIFIER = [4, 2, 2, 2, 1, 1, 2, 2, 2, 2, 3, 3, 2, 2, 1, 1, 1, 0.5]

const rowLatitude = (grid: WindGrid, row: number, latitude: LatitudeRange) =>
  latitude.north - row / grid.cellsY * (latitude.north - latitude.south)

/** degrees Celsius from a latitude and a height above the sea */
function createTemperatureModel(settings: ClimateSettings) {
  const northTropic = settings.equatorC - TROPICS[0] * TROPICAL_GRADIENT
  const northGradient = (northTropic - settings.northPoleC) / (90 - TROPICS[0])
  const southTropic = settings.equatorC + TROPICS[1] * TROPICAL_GRADIENT
  const southGradient = (southTropic - settings.southPoleC) / (90 + TROPICS[1])

  const seaLevelTemperature = (degrees: number) => {
    if (degrees <= TROPICS[0] && degrees >= TROPICS[1]) return settings.equatorC - Math.abs(degrees) * TROPICAL_GRADIENT
    return degrees > 0
      ? northTropic - (degrees - TROPICS[0]) * northGradient
      : southTropic + (degrees - TROPICS[1]) * southGradient
  }
  return (degrees: number, elevation: number, seaM: number) => {
    const drop = elevation < seaM ? 0 : (elevation - seaM) / 1000 * LAPSE_RATE_PER_KM
    return clamp(Math.round(seaLevelTemperature(degrees) - drop), -128, 127)
  }
}

/** temperature of every cell from its own latitude and height, so fine cells in the mountains are colder than their surroundings */
export function computeTemperature(y: Float64Array, mapHeight: number, elevations: ArrayLike<number>, seaM: number, latitude: LatitudeRange, settings: ClimateSettings): Int8Array {
  const temperature = new Int8Array(y.length)
  const model = createTemperatureModel(settings)
  for (let cell = 0; cell < y.length; cell += 1) {
    temperature[cell] = model(latitude.north - y[cell] / mapHeight * (latitude.north - latitude.south), elevations[cell], seaM)
  }
  return temperature
}

/** temperature of the base grid blocks, row by row */
export function computeGridTemperature(grid: WindGrid, elevations: ArrayLike<number>, seaM: number, latitude: LatitudeRange, settings: ClimateSettings): Int8Array {
  const temperature = new Int8Array(grid.cellCount)
  const model = createTemperatureModel(settings)
  for (let row = 0; row < grid.cellsY; row += 1) {
    const degrees = rowLatitude(grid, row + 0.5, latitude)
    for (let cell = row * grid.cellsX; cell < (row + 1) * grid.cellsX; cell += 1) temperature[cell] = model(degrees, elevations[cell], seaM)
  }
  return temperature
}

type WindBand = [number, number]

/** rows and columns the prevailing winds enter the map through */
function getWinds(grid: WindGrid, latitude: LatitudeRange, settings: ClimateSettings) {
  const westerly: WindBand[] = []
  const easterly: WindBand[] = []
  let northerly = 0
  let southerly = 0

  for (let row = 0; row < grid.cellsY; row += 1) {
    const degrees = rowLatitude(grid, row, latitude)
    const modifier = LATITUDE_MODIFIER[Math.min(17, (Math.abs(degrees) - 1) / 5 | 0)]
    const tier = Math.min(5, Math.abs(degrees - 89) / 30 | 0)
    const angle = settings.winds[tier]
    const firstCell = row * grid.cellsX

    if (angle > 40 && angle < 140) westerly.push([firstCell, modifier])
    if (angle > 220 && angle < 320) easterly.push([firstCell + grid.cellsX - 1, modifier])
    if (angle > 100 && angle < 260) northerly += 1
    if (angle > 280 || angle < 80) southerly += 1
  }
  return { westerly, easterly, northerly, southerly }
}

/** winds enter the map from each side and drop their humidity as they pass, faster over mountains */
export function computePrecipitation(grid: WindGrid, fmgHeights: Uint8Array, temperature: Int8Array, latitude: LatitudeRange, settings: ClimateSettings, seed: string): Uint8Array {
  const random: Random = createRandom(`${seed}:wind`)
  const { cellsX, cellsY, cellCount } = grid
  const precipitation = new Uint8Array(cellCount)
  const modifier = (cellCount / 10000) ** 0.25 * settings.precipitationPercent / 100

  const getPrecipitation = (humidity: number, cell: number, next: number) => {
    const normalLoss = Math.max(humidity / (10 * modifier), 1)
    const difference = Math.max(fmgHeights[cell + next] - fmgHeights[cell], 0)
    const mountains = (fmgHeights[cell + next] / 70) ** 2
    return clamp(normalLoss + difference * mountains, 1, humidity)
  }

  const passWind = (sources: (number | WindBand)[], initialMaxPrecipitation: number, next: number, steps: number) => {
    let maxPrecipitation = initialMaxPrecipitation
    for (const source of sources) {
      let first: number
      if (Array.isArray(source)) {
        if (!source[0]) continue // a band starting at cell 0 is skipped, as in the original
        maxPrecipitation = Math.min(initialMaxPrecipitation * source[1], 255)
        first = source[0]
      } else first = source

      let humidity = maxPrecipitation - fmgHeights[first]
      if (humidity <= 0) continue

      for (let step = 0, current = first; step < steps; step += 1, current += next) {
        if (temperature[current] < -5) continue // no flux in permafrost

        if (fmgHeights[current] < FMG_SEA_LEVEL) {
          if (fmgHeights[current + next] >= FMG_SEA_LEVEL) {
            precipitation[current + next] += Math.max(humidity / randomInt(random, 10, 20), 1) // coastal rain
          } else {
            humidity = Math.min(humidity + 5 * modifier, maxPrecipitation)
            precipitation[current] += 5 * modifier
          }
          continue
        }

        const passable = fmgHeights[current + next] <= MAX_PASSABLE_ELEVATION
        const dropped = passable ? getPrecipitation(humidity, current, next) : humidity
        precipitation[current] += dropped
        const evaporation = dropped > 1.5 ? 1 : 0
        humidity = passable ? clamp(humidity - dropped + evaporation, 0, maxPrecipitation) : 0
      }
    }
  }

  const { westerly, easterly, northerly, southerly } = getWinds(grid, latitude, settings)
  if (westerly.length) passWind(westerly, 120 * modifier, 1, cellsX)
  if (easterly.length) passWind(easterly, 120 * modifier, -1, cellsX)

  const meanModifier = LATITUDE_MODIFIER.reduce((sum, value) => sum + value, 0) / LATITUDE_MODIFIER.length
  const latitudeSpan = latitude.north - latitude.south
  const verticalTotal = northerly + southerly
  const bandModifier = (degrees: number) => latitudeSpan > 60 ? meanModifier : LATITUDE_MODIFIER[Math.min(17, (Math.abs(degrees) - 1) / 5 | 0)]
  if (northerly) {
    const columns = Array.from({ length: cellsX }, (_, column) => column)
    passWind(columns, northerly / verticalTotal * 60 * modifier * bandModifier(latitude.north), cellsX, cellsY)
  }
  if (southerly) {
    const columns = Array.from({ length: cellsX }, (_, column) => cellCount - cellsX + column)
    passWind(columns, southerly / verticalTotal * 60 * modifier * bandModifier(latitude.south), -cellsX, cellsY)
  }
  return precipitation
}
