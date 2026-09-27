// Everything derived from the elevations: water, features, climate, biomes and coastlines.
import { computeBiomes } from './biomes'
import { buildCoastlines, type CoastOverride, type CoastSettings, type CoastShape } from './coastline'
import { computeGridTemperature, computePrecipitation, computeTemperature, type ClimateSettings, type LatitudeRange } from './climate'
import { markupFeatures, type FeatureMap } from './features'
import { findCell, type GridGraph } from './graph'
import { elevationsToFmg, type HeightScale } from './height-scale'
import { computeHydrology, type HydrologySettings, type RiverPath } from './hydrology'

export interface AnalysisInput {
  graph: GridGraph
  elevations: Float32Array
  scale: HeightScale
  latitude: LatitudeRange
  climate: ClimateSettings
  coast: CoastSettings
  coastOverrides: CoastOverride[]
  hydrology: HydrologySettings
  /** false skips the river network, which is the expensive part of the water */
  rivers: boolean
  /** underground and sky have no weather: no climate, biomes or rivers */
  surface: boolean
  seed: string
}

export interface TerrainAnalysis {
  features: FeatureMap
  /** 1 for dry land, lakes are water */
  landMask: Uint8Array
  lakeDepth: Float32Array
  rivers: RiverPath[]
  minFlux: number
  temperature: Int8Array
  precipitation: Uint8Array
  biomes: Uint8Array
  coast: CoastShape[]
  /** feature id of the coast overrides that still find their island or lake, by the id */
  overriddenFeatures: Map<number, Partial<CoastSettings>>
  /** share of the map area that is land, cells of a finer level weigh less */
  landShare: number
  islands: number
  lakes: number
}

/** index of the base block a cell descends from */
export const baseBlockOf = (graph: GridGraph, cell: number) => (graph.iy[cell] >> graph.level[cell]) * graph.cellsX + (graph.ix[cell] >> graph.level[cell])

/** mean elevation of every base block, weighted by the area of the leaves in it */
function averageToBase(graph: GridGraph, elevations: Float32Array): Float32Array {
  const sums = new Float64Array(graph.cellsX * graph.cellsY)
  const areas = new Float64Array(sums.length)
  for (let cell = 0; cell < graph.cellCount; cell += 1) {
    const block = baseBlockOf(graph, cell)
    const area = 0.25 ** graph.level[cell]
    sums[block] += elevations[cell] * area
    areas[block] += area
  }
  return Float32Array.from(sums, (sum, block) => sum / areas[block])
}

export function analyzeTerrain(input: AnalysisInput): TerrainAnalysis {
  const { graph, elevations, scale, latitude, climate, coast, hydrology, seed } = input
  const fmgHeights = elevationsToFmg(elevations, scale)
  const temperature = input.surface ? computeTemperature(graph.y, graph.height, elevations, scale.seaM, latitude, climate) : new Int8Array(graph.cellCount)

  // the wind blows over the base grid; every finer cell inherits the rain of its block
  let precipitation = new Uint8Array(graph.cellCount)
  if (input.surface) {
    const blockElevations = averageToBase(graph, elevations)
    const blockPrecipitation = computePrecipitation(
      { cellsX: graph.cellsX, cellsY: graph.cellsY, cellCount: blockElevations.length },
      elevationsToFmg(blockElevations, scale), computeGridTemperature(graph, blockElevations, scale.seaM, latitude, climate), latitude, climate, seed,
    )
    precipitation = Uint8Array.from({ length: graph.cellCount }, (_, cell) => blockPrecipitation[baseBlockOf(graph, cell)])
  }

  const water = input.surface && (hydrology.lakes || input.rivers)
    ? computeHydrology(graph, elevations, scale.seaM, precipitation, hydrology, input.rivers)
    : null
  const landMask = water?.land ?? Uint8Array.from(elevations, height => height >= scale.seaM ? 1 : 0)
  const lakeDepth = water?.lakeDepth ?? new Float32Array(graph.cellCount)
  if (water) for (let cell = 0; cell < graph.cellCount; cell += 1) if (!landMask[cell]) fmgHeights[cell] = Math.min(fmgHeights[cell], 19)

  const features = markupFeatures(graph, landMask)
  const biomes = input.surface ? computeBiomes(graph, fmgHeights, temperature, precipitation) : new Uint8Array(graph.cellCount)

  let landArea = 0
  let totalArea = 0
  for (let cell = 0; cell < graph.cellCount; cell += 1) {
    const area = 0.25 ** graph.level[cell]
    totalArea += area
    if (landMask[cell]) landArea += area
  }
  const count = (type: string) => features.features.filter(feature => feature?.type === type).length

  const overriddenFeatures = new Map<number, Partial<CoastSettings>>()
  for (const override of input.coastOverrides) {
    const id = features.ids[findCell(graph, override.x, override.y)]
    if (features.features[id]?.type !== 'ocean') overriddenFeatures.set(id, override.settings)
  }

  return {
    features,
    landMask,
    lakeDepth,
    rivers: water?.rivers ?? [],
    minFlux: water?.minFlux ?? Infinity,
    temperature,
    precipitation,
    biomes,
    coast: buildCoastlines(graph, features, coast, seed, overriddenFeatures),
    overriddenFeatures,
    landShare: landArea / totalArea,
    islands: count('island'),
    lakes: count('lake'),
  }
}
