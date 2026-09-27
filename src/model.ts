import { DEFAULT_CLIMATE, type ClimateSettings } from './terrain/climate'
import { DEFAULT_COAST, type CoastOverride, type CoastSettings } from './terrain/coastline'
import { DEFAULT_HYDROLOGY, type HydrologySettings } from './terrain/hydrology'
import { createSeed } from './terrain/rng'

export { createSeed }

export type Position = [number, number]

export interface PlanetSettings {
  name: string
  equatorialDiameterKm: number
  polarDiameterKm: number
  axialTiltDeg: number
  minimumElevationM: number
  maximumElevationM: number
  seaLevelM: number
}

export interface MapSettings {
  mode: 'global' | 'region'
  projection: 'equirectangular'
  centerLongitude: number
  centerLatitude: number
  widthKm: number
  heightKm: number
}

/** The cell points come from the seed, the base cell count and the map proportions; every layer adds its split blocks. */
export interface HeightMesh {
  seed: string
  /** cell count of the base resolution: with fine cells everywhere this is the resolution of the map */
  desiredCells: number
  /** refine the mesh under the brush when zoomed in, off by default */
  autoRefine: boolean
}

export interface ReferenceImage {
  name: string
  dataUrl: string
  opacity: number
  terrainOpacity: number
}

export type LayerId = 'surface' | 'underground' | 'sky'
/** the deepest a cave may be, and where the islands of the sky start; the surface uses the sea level of the planet */
export const LAYER_LEVELS: Record<LayerId, number> = { surface: 0, underground: -800, sky: 0 }

export const LAYERS: { id: LayerId; label: string }[] = [
  { id: 'surface', label: 'Oberfläche' },
  { id: 'underground', label: 'Unterirdisch' },
  { id: 'sky', label: 'Luft' },
]

/** an area with borders and a name, every cell belongs to at most one */
export interface Territory {
  id: number
  name: string
  color: string
  /** 1 to 5, scales the label */
  labelSize: number
  showLabel: boolean
}

/** an overlay area (danger, magic, flood ...), zones may overlap */
export interface Zone {
  id: number
  name: string
  kind: string
  color: string
  pattern: 'solid' | 'hatch' | 'cross' | 'dots'
  opacity: number
  visible: boolean
}

export type MarkerKind = 'capital' | 'city' | 'town' | 'village' | 'fort' | 'temple' | 'port' | 'mine' | 'ruin' | 'dungeon' | 'landmark' | 'poi'
export type LabelSide = 'right' | 'left' | 'top' | 'bottom'

export interface Marker {
  id: number
  x: number
  y: number
  kind: MarkerKind
  name: string
  /** 1 to 5 */
  size: number
  showLabel: boolean
  labelSide: LabelSide
  color: string
  note: string
}

export type RouteKind = 'sea' | 'road' | 'trail' | 'air' | 'river' | 'custom'

export interface Route {
  id: number
  kind: RouteKind
  name: string
  /** the course as drawn, smoothed on screen */
  points: Position[]
  /** the points that were clicked; the course between them is straight or searched across the terrain */
  waypoints: Position[]
  auto: boolean
  color: string
  /** screen pixels */
  width: number
  dash: 'solid' | 'dashed' | 'dotted'
  showLabel: boolean
}

/** what one layer stores; per-cell values follow the depth-first order of its leaves, as runs of value and length */
export interface SavedLayer {
  /** height that separates land from water (floor from rock, island from sky); the surface uses the planet's sea level */
  levelM: number
  splits: number[]
  elevationsM: number[]
  territoryRuns: number[]
  zoneRuns: { id: number; runs: number[] }[]
  territories: Territory[]
  zones: Zone[]
  markers: Marker[]
  routes: Route[]
  coastOverrides: CoastOverride[]
}

export interface VeilMetadata {
  formatVersion: 5
  planet: PlanetSettings
  map: MapSettings
  mesh: HeightMesh
  climate: ClimateSettings
  coast: CoastSettings
  hydrology: HydrologySettings
  /** show the river network; it is the costly part of the water and can be switched off */
  rivers: boolean
  layers: { surface: SavedLayer } & Partial<Record<LayerId, SavedLayer>>
  reference?: ReferenceImage
}

export interface VeilProject {
  type: 'FeatureCollection'
  features: []
  veil: VeilMetadata
}

interface Envelope<Version extends number, Extra> {
  type: 'FeatureCollection'
  features: []
  veil: Omit<VeilMetadata, 'formatVersion' | 'mesh' | 'layers' | keyof Extra> & { formatVersion: Version } & Extra
}

/** format 4: one surface, the mesh held its own splits and heights */
export type FourProject = Envelope<4, { mesh: Omit<HeightMesh, 'autoRefine'> & { splits: number[]; elevationsM: number[] }; climate: ClimateSettings; coast: CoastSettings }>
/** format 3 had one uniform resolution and no split blocks */
export type UniformVeilProject = Envelope<3, { mesh: { seed: string; desiredCells: number; elevationsM: number[] }; climate: ClimateSettings; coast: CoastSettings }>
/** format 2 stored the jittered cell points themselves */
export type LegacyVeilProject = Envelope<2, { mesh: { seed: string; desiredCells: number; elevationsM: number[]; points: Position[] } }>

export function createLayer(levelM = 0): SavedLayer {
  return { levelM, splits: [], elevationsM: [], territoryRuns: [], zoneRuns: [], territories: [], zones: [], markers: [], routes: [], coastOverrides: [] }
}

export function createProject(): VeilProject {
  return {
    type: 'FeatureCollection',
    features: [],
    veil: {
      formatVersion: 5,
      planet: {
        name: 'Unbenannte Welt',
        equatorialDiameterKm: 12742,
        polarDiameterKm: 12714,
        axialTiltDeg: 23.44,
        minimumElevationM: -11000,
        maximumElevationM: 9000,
        seaLevelM: 0,
      },
      map: {
        mode: 'region',
        projection: 'equirectangular',
        centerLongitude: 0,
        centerLatitude: 0,
        widthKm: 6000,
        heightKm: 4000,
      },
      mesh: { seed: createSeed(), desiredCells: 50000, autoRefine: false },
      climate: { ...DEFAULT_CLIMATE, winds: [...DEFAULT_CLIMATE.winds] },
      coast: { ...DEFAULT_COAST },
      hydrology: { ...DEFAULT_HYDROLOGY },
      rivers: true,
      layers: { surface: createLayer() },
    },
  }
}

function hasCommonParts(value: unknown) {
  if (!value || typeof value !== 'object') return undefined
  const project = value as { type?: unknown; features?: unknown; veil?: { planet?: unknown; map?: unknown } }
  const veil = project.veil
  if (project.type !== 'FeatureCollection' || !Array.isArray(project.features) || !veil?.planet || !veil.map) return undefined
  return veil as { formatVersion?: unknown; mesh?: { points?: unknown; elevationsM?: unknown[]; splits?: unknown }; layers?: { surface?: unknown } }
}

export function isVeilProject(value: unknown): value is VeilProject {
  const veil = hasCommonParts(value)
  return !!veil && veil.formatVersion === 5 && !!veil.layers?.surface
}

export function isFourProject(value: unknown): value is FourProject {
  const veil = hasCommonParts(value)
  return !!veil && veil.formatVersion === 4 && Array.isArray(veil.mesh?.elevationsM) && Array.isArray(veil.mesh?.splits)
}

export function isUniformProject(value: unknown): value is UniformVeilProject {
  const veil = hasCommonParts(value)
  return !!veil && veil.formatVersion === 3 && Array.isArray(veil.mesh?.elevationsM)
}

export function isLegacyProject(value: unknown): value is LegacyVeilProject {
  const veil = hasCommonParts(value)
  return !!veil && veil.formatVersion === 2 && Array.isArray(veil.mesh?.points) && veil.mesh.points.length === veil.mesh.elevationsM?.length
}

/** settings a loaded file may lack, filled from the defaults */
export function withDefaults(project: VeilProject): VeilProject {
  const veil = project.veil
  veil.climate = { ...DEFAULT_CLIMATE, ...veil.climate }
  veil.coast = { ...DEFAULT_COAST, ...veil.coast }
  veil.hydrology = { ...DEFAULT_HYDROLOGY, ...veil.hydrology }
  veil.rivers = veil.rivers ?? true
  veil.mesh = { ...veil.mesh, autoRefine: veil.mesh.autoRefine ?? false }
  for (const layer of Object.values(veil.layers)) {
    Object.assign(layer, { ...createLayer(layer.levelM), ...layer })
    for (const route of layer.routes as Partial<Route>[]) {
      route.waypoints ??= route.points
      route.auto ??= false
    }
  }
  return project
}
