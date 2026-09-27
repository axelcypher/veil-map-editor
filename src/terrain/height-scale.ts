// Conversion between Veil elevations (metres) and the 0-100 scale of the FMG generators, where 20 is the lowest land.
import { clamp } from './rng'

export const FMG_SEA_LEVEL = 20

export interface HeightScale {
  minM: number
  maxM: number
  seaM: number
}

/** land starts this far above the sea level, so float rounding never turns a template's shore into water */
const LAND_BASE_M = 1
/** the flat ocean floor of a fresh template sits halfway between sea level and the deepest point */
const ABYSS_SHARE = 0.5
const WATER_EXPONENT = 1.5
const LAND_EXPONENT = 1.8

export function fmgToMeters(height: number, scale: HeightScale): number {
  if (height < FMG_SEA_LEVEL) {
    const abyss = scale.seaM - (scale.seaM - scale.minM) * ABYSS_SHARE
    return scale.seaM - (scale.seaM - abyss) * ((FMG_SEA_LEVEL - height) / FMG_SEA_LEVEL) ** WATER_EXPONENT
  }
  const range = Math.max(1, scale.maxM - scale.seaM - LAND_BASE_M)
  return scale.seaM + LAND_BASE_M + range * ((height - FMG_SEA_LEVEL) / (100 - FMG_SEA_LEVEL)) ** LAND_EXPONENT
}

/** metres to the FMG scale; water stays below 20 and land stays at 20 or above */
export function metersToFmg(elevation: number, scale: HeightScale): number {
  if (elevation < scale.seaM) {
    const abyss = scale.seaM - (scale.seaM - scale.minM) * ABYSS_SHARE
    const depth = clamp((scale.seaM - elevation) / Math.max(1, scale.seaM - abyss), 0, 1)
    return Math.min(FMG_SEA_LEVEL - 1, Math.round(FMG_SEA_LEVEL - FMG_SEA_LEVEL * depth ** (1 / WATER_EXPONENT)))
  }
  const range = Math.max(1, scale.maxM - scale.seaM - LAND_BASE_M)
  const share = clamp((elevation - scale.seaM - LAND_BASE_M) / range, 0, 1)
  return Math.max(FMG_SEA_LEVEL, Math.round(FMG_SEA_LEVEL + (100 - FMG_SEA_LEVEL) * share ** (1 / LAND_EXPONENT)))
}

export function elevationsToFmg(elevations: ArrayLike<number>, scale: HeightScale): Uint8Array {
  return Uint8Array.from({ length: elevations.length }, (_, cell) => metersToFmg(elevations[cell], scale))
}

/** metres per FMG height unit near the sea, used to turn a brush height into generator units */
export function metersPerFmgUnit(scale: HeightScale): number {
  return Math.max(1, scale.maxM - scale.seaM) / (100 - FMG_SEA_LEVEL)
}
