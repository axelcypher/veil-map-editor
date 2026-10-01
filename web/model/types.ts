// The project: everything hangs on geographic coordinates in degrees (EPSG:4326), never on raster
// cells, so a new heightmap import cannot lose data.
export type LonLat = [number, number]
export interface PointGeometry { type: 'Point'; coordinates: LonLat }
export interface LineGeometry { type: 'LineString'; coordinates: LonLat[] }
export interface AreaGeometry { type: 'MultiPolygon'; coordinates: LonLat[][][] }

export type EntityKind =
  | 'state' | 'province' | 'culture' | 'religion' | 'zone'
  | 'city' | 'route' | 'river' | 'label' | 'marker' | 'regiment'

export const AREA_KINDS = ['state', 'province', 'culture', 'religion', 'zone'] as const
export type AreaKind = (typeof AREA_KINDS)[number]

export interface Base {
  id: string
  name: string
  /** free text attached to the element */
  description: string
  /** vault-relative path of the linked Obsidian note, '' when none */
  note: string
}

export interface AreaBase extends Base {
  color: string
  /** as drawn; may reach into the sea. What is shown and exported is cut to the land when `clip` is set */
  geometry: AreaGeometry | null
  clip: boolean
}

export interface State extends AreaBase {
  fullName: string
  form: string
  capitalId: string
  /** people per km² outside the cities */
  ruralDensity: number
  cultureId: string
  religionId: string
}

export interface Province extends AreaBase {
  stateId: string
  form: string
  capitalId: string
  /** null: take the state's value */
  ruralDensity: number | null
}

export interface Culture extends AreaBase {
  type: string
  origins: string[]
}

export interface Religion extends AreaBase {
  type: string
  form: string
  deity: string
  origins: string[]
}

export type ZonePattern = 'fill' | 'hatch' | 'cross' | 'dots'

export interface Zone extends AreaBase {
  type: string
  pattern: ZonePattern
  opacity: number
}

export interface CityFeatures {
  capital: boolean
  port: boolean
  citadel: boolean
  walls: boolean
  plaza: boolean
  temple: boolean
  shanty: boolean
}

export interface City extends Base {
  geometry: PointGeometry
  type: string
  population: number
  features: CityFeatures
  group: string
  /** a city plan: a file path, a URL or a vault note */
  plan: string
}

export interface Route extends Base {
  geometry: LineGeometry
  type: string
  /** docked onto other routes: branches off one at its start, joins one at its end */
  junctions?: { start?: string; end?: string }
}

export interface River extends Base {
  geometry: LineGeometry
  type: string
  parentId: string
  lengthKm: number
  upstreamKm: number
  flow: number
}

export interface Label extends Base {
  /** a point, or a line the text follows */
  geometry: PointGeometry | LineGeometry
  category: string
  /** null: from the category */
  size: number | null
  color: string | null
  italic: boolean | null
  uppercase: boolean | null
  spacing: number | null
  rotation: number
}

export interface Marker extends Base {
  geometry: PointGeometry
  type: string
  size: number
}

export interface Regiment extends Base {
  geometry: PointGeometry
  stateId: string
  units: Record<string, number>
  commander: string
  naval: boolean
}

export interface EntityMap {
  state: State
  province: Province
  culture: Culture
  religion: Religion
  zone: Zone
  city: City
  route: Route
  river: River
  label: Label
  marker: Marker
  regiment: Regiment
}
export type Entity = EntityMap[EntityKind]

export const COLLECTION = {
  state: 'states',
  province: 'provinces',
  culture: 'cultures',
  religion: 'religions',
  zone: 'zones',
  city: 'cities',
  route: 'routes',
  river: 'rivers',
  label: 'labels',
  marker: 'markers',
  regiment: 'regiments',
} as const satisfies Record<EntityKind, string>

export interface ControlPoint {
  id: string
  name: string
  lon: number
  lat: number
  kind: 'height' | 'sea' | 'land'
  expected: number
  tolerance: number
}

export interface KoppenClass {
  code: string
  name: string
  /** display colour */
  color: string
  /** colours in the source map that mean this class */
  match: string[]
  description: string
}

export interface KoppenMatch {
  code: string
  rgb: [number, number, number]
}

export interface CheckResult {
  label: string
  status: 'ok' | 'warn' | 'error'
  detail: string
}

export interface TerrainRef {
  source: string
  id: string
  hash: string
  cropSquare: boolean
  importedAt: number
  checks: CheckResult[]
}

/** the colour render of the terrain from Gaea, shown as a map style */
export interface SatelliteRef {
  source: string
  id: string
  hash: string
  cropSquare: boolean
  importedAt: number
}

/** how a .veilmap archive is written */
export interface ArchiveOptions {
  /** WebP quality of the tiles, 1–100 */
  quality: number
  lossless: boolean
  /** exact heights for the point info and conflict checks; the ≈10 km grid always comes along */
  heights: 'none' | 'half' | 'full'
  satellite: boolean
  koppen: boolean
  /** own image layers */
  images: boolean
}

/** the globe in the 3D window and its picture and animation exports */
export interface GlobeOptions {
  /** what the globe wears: the map as shown, or one raster alone */
  source: 'map' | 'satellite' | 'relief' | ImageLayerId
  /** degrees per second; the sign is the direction */
  speed: number
  rotate: boolean
  /** axial tilt as seen by the viewer, degrees */
  tilt: number
  /** height relief on the surface, 0 = smooth ball */
  relief: number
  sun: { on: boolean; azimuth: number; elevation: number; night: number; softness: number }
  atmosphere: { on: boolean; color: string; strength: number; thickness: number }
  graticule: { on: boolean; step: number; color: string; opacity: number }
  clouds: { on: boolean; cover: number; opacity: number; scale: number; seed: number; turns: number }
  background: { kind: 'transparent' | 'color' | 'stars'; color: string }
  /** field of view, degrees */
  fov: number
  export: { width: number; height: number; frames: number; fps: number }
}

export interface KoppenRef {
  source: string
  id: string
  cropSquare: boolean
  tolerance: number
  importedAt: number
  unmatched: number
  unmatchedColors: [string, number][]
}

export interface RiverImportRef {
  source: string
  threshold: number
  minLengthKm: number
  simplifyPx: number
  cropSquare: boolean
  importedAt: number
}

export interface NamedType {
  id: string
  name: string
}
export interface CityType extends NamedType { size: number; shape: 'circle' | 'square' | 'diamond' }
export interface MarkerType extends NamedType { icon: string; color: string; land: boolean }
export interface RouteType extends NamedType { color: string; width: number; dash: string; kind: 'land' | 'sea' | 'air' }
export interface ZoneType extends NamedType { color: string; pattern: ZonePattern }
export interface LabelCategory extends NamedType { size: number; color: string; italic: boolean; uppercase: boolean; spacing: number; font: string }
export interface UnitType extends NamedType { symbol: string; naval: boolean }
export interface Relation extends NamedType { color: string; mirror: string }

export interface Catalog {
  cityTypes: CityType[]
  markerTypes: MarkerType[]
  routeTypes: RouteType[]
  zoneTypes: ZoneType[]
  cultureTypes: NamedType[]
  religionTypes: NamedType[]
  stateForms: NamedType[]
  labelCategories: LabelCategory[]
  unitTypes: UnitType[]
  relations: Relation[]
}

export interface LayerStyle {
  /** '' = derived from the element colour */
  stroke: string
  strokeWidth: number
  dash: string
  fill: string
  fillOpacity: number
  showLabels: boolean
  labelFont: string
  labelSize: number
  labelColor: string
  halo: string
  haloWidth: number
  symbolScale: number
}

export type BuiltinLayerId =
  | 'relief' | 'satellite' | 'shade' | 'coast' | 'koppen' | 'rivers' | 'cultures' | 'religions' | 'states' | 'provinces' | 'zones'
  | 'routes' | 'cities' | 'markers' | 'regiments' | 'labels' | 'graticule' | 'texture'
/** an own image layer: "img:" and the id of its tile cache */
export type ImageLayerId = `img:${string}`
export type LayerId = BuiltinLayerId | ImageLayerId

export interface LayerSetting {
  id: LayerId
  visible: boolean
  opacity: number
}

export interface Filter {
  grayscale: number
  sepia: number
  saturate: number
  brightness: number
  contrast: number
  hue: number
  blur: number
  invert: number
}

export interface Display {
  background: string
  graticule: { step: number; color: string; width: number; labels: boolean }
  compass: { show: boolean; size: number; position: 'tl' | 'tr' | 'bl' | 'br' }
  scaleBar: { show: boolean }
  coordinates: { show: boolean }
  texture: { kind: 'paper' | 'linen' | 'grain' | 'custom'; image: string; blend: string; scale: number }
  mapFilter: Filter
  layerFilters: Partial<Record<LayerId, Filter>>
  /** colour the states by their relation to this state */
  diplomacyFocus: string
  hiddenMarkerTypes: string[]
}

export interface LayerPreset {
  id: string
  name: string
  layers: { id: LayerId; visible: boolean }[]
}

export interface StylePreset {
  id: string
  name: string
  style: Record<BuiltinLayerId, LayerStyle>
  display: Pick<Display, 'background' | 'mapFilter' | 'layerFilters' | 'texture' | 'graticule'>
}

/** a picture of the whole planet shown as a layer, e.g. a pre-rendered map style */
export interface ImageLayerRef {
  /** id of the tile cache; the layer is "img:<id>" */
  id: string
  name: string
  source: string
  hash: string
  cropSquare: boolean
  importedAt: number
}

export interface Project {
  format: 'veil-project'
  version: 1
  name: string
  /** the item on the sync server this project is kept in step with; null: not synced */
  sync: { item: string } | null
  /** metres; the planet is a sphere */
  planetRadius: number
  terrain: TerrainRef | null
  satellite: SatelliteRef | null
  imageLayers: ImageLayerRef[]
  koppen: KoppenRef | null
  riverImport: RiverImportRef | null
  controlPoints: ControlPoint[]
  koppenClasses: KoppenClass[]
  states: State[]
  provinces: Province[]
  cultures: Culture[]
  religions: Religion[]
  zones: Zone[]
  cities: City[]
  routes: Route[]
  rivers: River[]
  labels: Label[]
  markers: Marker[]
  regiments: Regiment[]
  /** "a>b" → relation id, a's view of b */
  diplomacy: Record<string, string>
  catalog: Catalog
  style: Record<BuiltinLayerId, LayerStyle>
  layers: LayerSetting[]
  layerPresets: LayerPreset[]
  stylePresets: StylePreset[]
  display: Display
  obsidian: { vaultPath: string; vaultName: string }
  archive: ArchiveOptions
  globe: GlobeOptions
  view: { center: LonLat; zoom: number }
}
