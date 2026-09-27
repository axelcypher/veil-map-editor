import type { MapSettings, PlanetSettings, Position } from './model'
import type { LatitudeRange } from './terrain/climate'

export function getMapAspect(map: MapSettings): number {
  return map.mode === 'global' ? 2 : map.widthKm / map.heightKm
}

/** size of the map in the units the cell graph works in: the longer side is 1800 */
export function getCanvasSize(map: MapSettings) {
  const aspect = getMapAspect(map)
  return aspect >= 1
    ? { width: 1800, height: Math.max(300, Math.round(1800 / aspect)) }
    : { width: Math.max(300, Math.round(1800 * aspect)), height: 1800 }
}

export function normalizedToGeo([x, y]: Position, map: MapSettings, planet: PlanetSettings): Position {
  if (map.mode === 'global') return [x * 360 - 180, 90 - y * 180]
  const latitudeKmPerDegree = Math.PI * planet.polarDiameterKm / 360
  const longitudeKmPerDegree = Math.PI * planet.equatorialDiameterKm * Math.max(0.01, Math.cos(map.centerLatitude * Math.PI / 180)) / 360
  return [
    map.centerLongitude + (x - 0.5) * map.widthKm / longitudeKmPerDegree,
    map.centerLatitude - (y - 0.5) * map.heightKm / latitudeKmPerDegree,
  ]
}

export function projectedMapSize(map: MapSettings, planet: PlanetSettings) {
  if (map.mode === 'region') return { widthKm: map.widthKm, heightKm: map.heightKm }
  return {
    widthKm: Math.PI * planet.equatorialDiameterKm,
    heightKm: Math.PI * planet.polarDiameterKm / 2,
  }
}

/** latitudes at the top and the bottom edge, which drive the climate */
export function latitudeRange(map: MapSettings, planet: PlanetSettings): LatitudeRange {
  return {
    north: Math.min(90, normalizedToGeo([0.5, 0], map, planet)[1]),
    south: Math.max(-90, normalizedToGeo([0.5, 1], map, planet)[1]),
  }
}
