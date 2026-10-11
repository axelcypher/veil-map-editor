// The project: everything hangs on geographic coordinates in degrees (EPSG:4326), never on raster
// cells, so a new heightmap import cannot lose data.
export type LonLat = [number, number]
export interface PointGeometry { type: 'Point'; coordinates: LonLat }
export interface LineGeometry { type: 'LineString'; coordinates: LonLat[] }
export interface AreaGeometry { type: 'MultiPolygon'; coordinates: LonLat[][][] }

export type EntityKind =
  | 'state' | 'province' | 'culture' | 'religion' | 'zone' | 'institution'
  | 'city' | 'route' | 'river' | 'label' | 'marker' | 'regiment'

export const AREA_KINDS = ['state', 'province', 'culture', 'religion', 'zone', 'institution'] as const
export type AreaKind = (typeof AREA_KINDS)[number]

/**
 * Whether an entry of a parent strand shows in a derived strand. In a strand that takes over only
 * what is released, `show` releases it; in one that inherits everything, `show: false` hides it.
 * `from` and `until` (milestone ids) limit that to a stretch of milestones.
 */
export interface Visibility {
  show: boolean
  from?: string
  until?: string
}

/** what every entry of the timeline carries: the strand it belongs to and how it shows below it */
export interface Owned {
  /** the strand the entry belongs to; absent: the base strand */
  strand?: string
  /** per derived strand: released or hidden there */
  visibility?: Record<string, Visibility>
}

/**
 * A dated change of an element: from `year` on, the fields in `set` hold, until a later change
 * sets them again. A field set to null was emptied. A change of a derived strand on an element
 * of another strand is a deviation (it overrides in that strand and below it).
 */
export interface Change extends Owned {
  year: number
  set: Record<string, unknown>
  /** why it changed, free text */
  note?: string
  /** id of the event the change belongs to */
  event?: string
  /** the change holds from this milestone on (id) */
  from?: string
  /** and until this milestone (id); e.g. a falsification until it is corrected */
  until?: string
}

export interface Base extends Owned {
  id: string
  name: string
  /** free text attached to the element */
  description: string
  /** vault-relative path of the linked Obsidian note, '' when none */
  note: string
  /** first year the element exists; absent: since the start of the timeline */
  begin?: number
  /** first year it no longer exists; absent: it still does */
  end?: number
  /** its changes, oldest first; the fields of the element itself hold before the first one */
  history?: Change[]
  /** another begin and end in a derived strand (and below it); null: open */
  life?: Record<string, { begin: number | null; end: number | null }>
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

/** a guild, order, trading house, church, academy …: may have an area of influence */
export interface Institution extends AreaBase {
  type: string
  /** the city it sits in */
  seatId: string
  /** the state it belongs to or serves */
  stateId: string
  religionId: string
  cultureId: string
  /** who leads it */
  leader: string
  /** members, null: unknown */
  members: number | null
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
  institution: Institution
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
  institution: 'institutions',
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
export interface EventType extends NamedType { color: string }

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
  institutionTypes: NamedType[]
  eventTypes: EventType[]
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
  | 'relief' | 'satellite' | 'shade' | 'coast' | 'koppen' | 'rivers' | 'cultures' | 'religions' | 'states' | 'provinces' | 'zones' | 'institutions'
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

/** a named stretch of the world's history, from its start year (in the strand's own years) to the start of the next */
export interface Era {
  id: string
  name: string
  start: number
  color: string
}

/**
 * A view of the world. Exactly one strand is the base (no parent); every other one derives from a
 * parent: it shows the parent's world (all of it, or only what is released) plus its own entries.
 * Years are stored in the base strand's reckoning; each strand shows them in its own.
 */
export interface Strand {
  id: string
  name: string
  color: string
  parent: string | null
  /** 'all': what the parent shows shows here too; 'released': only what is released here */
  inherit: 'all' | 'released'
  /** the base year that is year 0 here; null: as the parent (the base strand: 0) */
  zero: number | null
  /** shown after a year, e.g. "n. Ü."; null: as the parent */
  unit: string | null
  /** the stretch shown, in the strand's own years; null: as the parent */
  start: number | null
  end: number | null
  /** none: those of the parent */
  eras: Era[]
}

/** a point in the telling of the story, e.g. a release; a list in order */
export interface Milestone {
  id: string
  name: string
  description: string
}

/** years are whole numbers */
export interface Timeline {
  strands: Strand[]
  milestones: Milestone[]
  /** the milestone reached now: what a view shows unless it picks another; null: all */
  current: string | null
}

export interface EntityRef {
  kind: EntityKind
  id: string
}

/** something that happened: a war, a treaty, a founding; may last several years */
export interface WorldEvent extends Owned {
  id: string
  name: string
  year: number
  /** last year of a lasting event; null: a single year */
  until: number | null
  type: string
  description: string
  note: string
  /** the elements it concerns */
  refs: EntityRef[]
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
  institutions: Institution[]
  cities: City[]
  routes: Route[]
  rivers: River[]
  labels: Label[]
  markers: Marker[]
  regiments: Regiment[]
  /** "a>b" → relation id, a's view of b */
  diplomacy: Record<string, string>
  /** dated changes of the diplomacy; '' in `set` removes a relation */
  diplomacyHistory: Change[]
  /** null: the project has no timeline, everything is timeless */
  timeline: Timeline | null
  events: WorldEvent[]
  catalog: Catalog
  style: Record<BuiltinLayerId, LayerStyle>
  layers: LayerSetting[]
  layerPresets: LayerPreset[]
  stylePresets: StylePreset[]
  display: Display
  archive: ArchiveOptions
  globe: GlobeOptions
  /** per device: where the map looks, which strand, year (base years) and milestone it shows */
  view: { center: LonLat; zoom: number; year?: number; strand?: string; milestone?: string | null }
}
