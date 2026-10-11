// Creating, reading and writing projects, and new elements with sensible defaults.
import { defaultCatalog, defaultDisplay, defaultKoppenClasses, defaultLayers, defaultStyle } from './catalog'
import { migrateTimeline } from './timeline'
import { adoptLegacyVault } from './vault'
import type { City, Culture, EntityKind, EntityMap, Institution, Label, LonLat, Marker, Project, Province, Regiment, Religion, Route, State, Strand, Timeline, WorldEvent, Zone } from './types'

export const PLANET_RADIUS = 6_606_727

export const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

export function newProject(): Project {
  return {
    format: 'veil-project',
    version: 1,
    name: 'Thessari',
    sync: null,
    planetRadius: PLANET_RADIUS,
    terrain: null,
    satellite: null,
    imageLayers: [],
    koppen: null,
    riverImport: null,
    controlPoints: [],
    koppenClasses: defaultKoppenClasses(),
    states: [],
    provinces: [],
    cultures: [],
    religions: [],
    zones: [],
    institutions: [],
    cities: [],
    routes: [],
    rivers: [],
    labels: [],
    markers: [],
    regiments: [],
    diplomacy: {},
    diplomacyHistory: [],
    timeline: null,
    events: [],
    catalog: defaultCatalog(),
    style: defaultStyle(),
    layers: defaultLayers(),
    layerPresets: [],
    stylePresets: [],
    display: defaultDisplay(),
    archive: defaultArchiveOptions(),
    globe: defaultGlobe(),
    view: { center: [0, 0], zoom: 1 },
  }
}

export const defaultArchiveOptions = (): Project['archive'] => ({ quality: 85, lossless: false, heights: 'none', satellite: true, koppen: true, images: true })

export const defaultGlobe = (): Project['globe'] => ({
  source: 'map',
  speed: 12,
  rotate: true,
  tilt: 0,
  relief: 1,
  sun: { on: false, azimuth: -40, elevation: 15, night: 0.12, softness: 0.25 },
  atmosphere: { on: true, color: '#6fa8ff', strength: 1, thickness: 0.08 },
  graticule: { on: false, step: 15, color: '#ffffff', opacity: 0.35 },
  clouds: { on: false, cover: 0.55, opacity: 0.8, scale: 3, seed: 1, turns: 0 },
  background: { kind: 'stars', color: '#0b1220' },
  fov: 30,
  export: { width: 600, height: 600, frames: 72, fps: 24 },
})

const PALETTE = ['#c0504d', '#4f81bd', '#9bbb59', '#8064a2', '#f79646', '#4bacc6', '#d4a017', '#a0522d', '#2e8b57', '#b03060', '#5f9ea0', '#cd853f', '#6a5acd', '#708090']
export const nextColor = (used: number) => PALETTE[used % PALETTE.length]

const base = (prefix: string, name: string) => ({ id: newId(prefix), name, description: '', note: '' })

export const create = {
  state: (p: Project): State => ({
    ...base('state', `Staat ${p.states.length + 1}`),
    color: nextColor(p.states.length),
    geometry: null,
    clip: true,
    fullName: '',
    form: p.catalog.stateForms[0]?.id ?? '',
    capitalId: '',
    ruralDensity: 10,
    cultureId: '',
    religionId: '',
  }),
  province: (p: Project, stateId = ''): Province => ({
    ...base('prov', `Provinz ${p.provinces.length + 1}`),
    color: p.states.find(s => s.id === stateId)?.color ?? nextColor(p.provinces.length + 3),
    geometry: null,
    clip: true,
    stateId,
    form: 'Provinz',
    capitalId: '',
    ruralDensity: null,
  }),
  culture: (p: Project): Culture => ({
    ...base('cult', `Kultur ${p.cultures.length + 1}`),
    color: nextColor(p.cultures.length + 5),
    geometry: null,
    clip: true,
    type: p.catalog.cultureTypes[0]?.id ?? '',
    origins: [],
  }),
  religion: (p: Project): Religion => ({
    ...base('rel', `Religion ${p.religions.length + 1}`),
    color: nextColor(p.religions.length + 8),
    geometry: null,
    clip: true,
    type: p.catalog.religionTypes[0]?.id ?? '',
    form: '',
    deity: '',
    origins: [],
  }),
  zone: (p: Project): Zone => {
    const type = p.catalog.zoneTypes[0]
    return {
      ...base('zone', `Zone ${p.zones.length + 1}`),
      color: type?.color ?? '#b22222',
      geometry: null,
      clip: false,
      type: type?.id ?? '',
      pattern: type?.pattern ?? 'hatch',
      opacity: 0.35,
    }
  },
  institution: (p: Project): Institution => ({
    ...base('inst', `Institution ${p.institutions.length + 1}`),
    color: nextColor(p.institutions.length + 11),
    geometry: null,
    clip: false,
    type: p.catalog.institutionTypes[0]?.id ?? '',
    seatId: '',
    stateId: '',
    religionId: '',
    cultureId: '',
    leader: '',
    members: null,
  }),
  city: (p: Project, at: LonLat): City => ({
    ...base('city', `Stadt ${p.cities.length + 1}`),
    geometry: { type: 'Point', coordinates: at },
    type: 'town',
    population: 5000,
    features: { capital: false, port: false, citadel: false, walls: true, plaza: true, temple: false, shanty: false },
    group: '',
    plan: '',
  }),
  route: (p: Project, line: LonLat[], type = 'road'): Route => ({
    ...base('route', `Route ${p.routes.length + 1}`),
    geometry: { type: 'LineString', coordinates: line },
    type,
  }),
  label: (_p: Project, geometry: Label['geometry']): Label => ({
    ...base('label', 'Beschriftung'),
    geometry,
    category: geometry.type === 'LineString' ? 'mountains' : 'region',
    size: null,
    color: null,
    italic: null,
    uppercase: null,
    spacing: null,
    rotation: 0,
  }),
  marker: (p: Project, at: LonLat, type = 'poi'): Marker => ({
    ...base('marker', `${p.catalog.markerTypes.find(t => t.id === type)?.name ?? 'Marker'} ${p.markers.length + 1}`),
    geometry: { type: 'Point', coordinates: at },
    type,
    size: 1,
  }),
  regiment: (p: Project, at: LonLat, stateId = ''): Regiment => ({
    ...base('reg', `${p.regiments.length + 1}. Regiment`),
    geometry: { type: 'Point', coordinates: at },
    stateId,
    units: { infantry: 1000 },
    commander: '',
    naval: false,
  }),
}

export const KIND_NAMES: Record<EntityKind, [string, string]> = {
  state: ['Staat', 'Staaten'],
  province: ['Provinz', 'Provinzen'],
  culture: ['Kultur', 'Kulturen'],
  religion: ['Religion', 'Religionen'],
  zone: ['Zone', 'Zonen'],
  institution: ['Institution', 'Institutionen'],
  city: ['Stadt', 'Städte'],
  route: ['Route', 'Routen'],
  river: ['Fluss', 'Flüsse'],
  label: ['Beschriftung', 'Beschriftungen'],
  marker: ['Marker', 'Marker'],
  regiment: ['Regiment', 'Regimenter'],
}

/** a timeline with one base strand */
export const newTimeline = (start: number, end: number, unit = '', name = 'Hauptstrang'): Timeline => ({
  strands: [{ id: newId('strand'), name, color: '#8f7aa4', parent: null, inherit: 'all', zero: 0, unit, start, end: Math.max(start + 1, end), eras: [] }],
  milestones: [],
  current: null,
})

/** a strand derived from `parent`, counting and showing like it */
export const newStrand = (parent: Strand, name: string, color = '#c3cad4'): Strand => ({
  id: newId('strand'),
  name,
  color,
  parent: parent.id,
  inherit: 'all',
  zero: null,
  unit: null,
  start: null,
  end: null,
  eras: [],
})

export const newEvent = (p: Project, year: number, strand?: string): WorldEvent => ({
  id: newId('event'),
  ...(strand ? { strand } : {}),
  name: `Ereignis ${p.events.length + 1}`,
  year,
  until: null,
  type: p.catalog.eventTypes[0]?.id ?? '',
  description: '',
  note: '',
  refs: [],
})

/** fills in everything a file from an older or hand-edited version lacks */
export function parseProject(text: string): Project {
  const { obsidian, ...data } = JSON.parse(text) as Partial<Project> & { format?: string; obsidian?: { vaultPath?: string; vaultName?: string } }
  if (data.format !== 'veil-project') throw new Error('Keine VEIL-Projektdatei.')
  // the vault belongs to the device now (vault.ts)
  adoptLegacyVault(obsidian)
  const fresh = newProject()
  const merged = { ...fresh, ...data } as Project
  merged.catalog = { ...fresh.catalog, ...data.catalog }
  merged.style = { ...fresh.style, ...data.style }
  for (const id of Object.keys(fresh.style) as (keyof Project['style'])[]) merged.style[id] = { ...fresh.style[id], ...data.style?.[id] }
  merged.display = { ...fresh.display, ...data.display }
  // a timeline of an earlier version (one range) becomes a single base strand
  merged.timeline = migrateTimeline(data.timeline)
  merged.archive = { ...fresh.archive, ...data.archive }
  merged.globe = { ...fresh.globe, ...data.globe }
  for (const key of ['sun', 'atmosphere', 'graticule', 'clouds', 'background', 'export'] as const) merged.globe[key] = { ...fresh.globe[key], ...data.globe?.[key] } as never
  // layers a newer version added go in at their default place, above the default layer below them
  const layers = [...(data.layers ?? [])]
  fresh.layers.forEach((layer, index) => {
    if (layers.some(l => l.id === layer.id)) return
    const below = fresh.layers.slice(0, index).reverse().find(l => layers.some(x => x.id === l.id))
    layers.splice(below ? layers.findIndex(l => l.id === below.id) + 1 : 0, 0, layer)
  })
  // every image layer has its place in the stack, even in a hand-edited file
  for (const image of merged.imageLayers) {
    if (!layers.some(l => l.id === `img:${image.id}`)) layers.splice(layers.findIndex(l => l.id === 'satellite') + 1, 0, { id: `img:${image.id}`, visible: false, opacity: 1 })
  }
  merged.layers = layers
  return merged
}

export const serializeProject = (project: Project) => JSON.stringify(project, null, 1)

export type Collection<K extends EntityKind> = EntityMap[K][]
