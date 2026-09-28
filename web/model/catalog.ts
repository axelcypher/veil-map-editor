// Defaults for a new project: type lists, the Köppen legend, styles and presets.
import type { BuiltinLayerId, Catalog, Display, Filter, KoppenClass, LayerId, LayerPreset, LayerSetting, LayerStyle, Project, StylePreset } from './types'

const lighten = (hex: string, amount = 0.45) => {
  const value = parseInt(hex.slice(1), 16)
  const channel = (shift: number) => {
    const c = (value >> shift) & 255
    return Math.round(c + (255 - c) * amount).toString(16).padStart(2, '0')
  }
  return `#${channel(16)}${channel(8)}${channel(0)}`
}

/** World Orogen's palette, plus the colours its climate export was seen to use */
const KOPPEN: [string, string, string, string[]][] = [
  ['Af', 'Tropischer Regenwald', '#0000ff', []],
  ['Am', 'Tropisches Monsunklima', '#0077ff', ['#00b6ff']],
  ['Aw', 'Tropische Savanne', '#46aafa', ['#8ed6fd']],
  ['BWh', 'Heiße Wüste', '#ff0000', []],
  ['BWk', 'Kalte Wüste', '#ff9696', ['#ffcaca']],
  ['BSh', 'Heiße Steppe', '#f5a500', ['#fbd300']],
  ['BSk', 'Kalte Steppe', '#ffdb63', ['#ffeea7']],
  ['Csa', 'Mittelmeerklima, heißer Sommer', '#ffff00', []],
  ['Csb', 'Mittelmeerklima, warmer Sommer', '#c8c800', ['#e5e500']],
  ['Csc', 'Mittelmeerklima, kühler Sommer', '#969600', []],
  ['Cwa', 'Subtropisch, wintertrocken', '#96ff96', ['#caffca']],
  ['Cwb', 'Subtropisches Hochland', '#63c764', ['#a7e5a7']],
  ['Cwc', 'Kaltes subtropisches Hochland', '#329633', ['#7cca7c']],
  ['Cfa', 'Feuchtes Subtropenklima', '#c8ff50', ['#e5ff97']],
  ['Cfb', 'Ozeanisches Klima', '#64ff50', ['#a7ff97']],
  ['Cfc', 'Subpolares Ozeanklima', '#32c800', ['#7ce500']],
  ['Dfa', 'Feucht-kontinental, heißer Sommer', '#00ffff', []],
  ['Dfb', 'Feucht-kontinental, warmer Sommer', '#37c8ff', ['#81e5ff']],
  ['Dfc', 'Subarktisch', '#007d7d', ['#00baba']],
  ['Dfd', 'Subarktisch, extrem kalter Winter', '#00465f', []],
  ['Dsa', 'Kontinental sommertrocken, heiß', '#e680ff', ['#da9fee']],
  ['Dsb', 'Kontinental sommertrocken, warm', '#b359d9', ['#bc7cd3']],
  ['Dsc', 'Subarktisch sommertrocken', '#8033a6', []],
  ['Dsd', 'Subarktisch sommertrocken, extrem kalt', '#591a73', []],
  ['Dwa', 'Kontinental wintertrocken, heiß', '#abb1ff', []],
  ['Dwb', 'Kontinental wintertrocken, warm', '#6e77c8', ['#9397e5']],
  ['Dwc', 'Subarktisch wintertrocken', '#4a50c8', []],
  ['Dwd', 'Subarktisch wintertrocken, extrem kalt', '#320087', []],
  ['ET', 'Tundra', '#b2b2b2', ['#dadada']],
  ['EF', 'Eiswüste', '#686868', ['#acacac']],
  ['W', 'Wasser (Seen)', '#4a6fa5', ['#93b1d3']],
]

export const defaultKoppenClasses = (): KoppenClass[] =>
  KOPPEN.map(([code, name, color, seen]) => ({
    code,
    name,
    color,
    match: [...new Set([color, lighten(color), ...seen])],
    description: '',
  }))

export const defaultCatalog = (): Catalog => ({
  cityTypes: [
    { id: 'metropolis', name: 'Metropole', size: 8, shape: 'circle' },
    { id: 'city', name: 'Großstadt', size: 6.5, shape: 'circle' },
    { id: 'town', name: 'Stadt', size: 5, shape: 'circle' },
    { id: 'smalltown', name: 'Kleinstadt', size: 4, shape: 'circle' },
    { id: 'village', name: 'Dorf', size: 3, shape: 'circle' },
    { id: 'fortress', name: 'Festung', size: 5, shape: 'square' },
    { id: 'outpost', name: 'Außenposten', size: 3.5, shape: 'diamond' },
  ],
  markerTypes: [
    { id: 'volcano', name: 'Vulkan', icon: '🌋', color: '#b83a1e', land: true },
    { id: 'ruin', name: 'Ruine', icon: '🏛️', color: '#7a6a55', land: true },
    { id: 'mine', name: 'Mine', icon: '⛏️', color: '#5a5048', land: true },
    { id: 'cave', name: 'Höhle', icon: '🕳️', color: '#3b3632', land: true },
    { id: 'shrine', name: 'Heiligtum', icon: '⛩️', color: '#a3432c', land: true },
    { id: 'battle', name: 'Schlachtfeld', icon: '⚔️', color: '#8a1c1c', land: true },
    { id: 'castle', name: 'Burg', icon: '🏰', color: '#5b4a3a', land: true },
    { id: 'tower', name: 'Turm', icon: '🗼', color: '#4f4a6a', land: true },
    { id: 'bridge', name: 'Brücke', icon: '🌉', color: '#6b5a44', land: true },
    { id: 'harbor', name: 'Hafen', icon: '⚓', color: '#1f4e79', land: false },
    { id: 'lighthouse', name: 'Leuchtturm', icon: '🗼', color: '#c9a227', land: true },
    { id: 'monster', name: 'Monster', icon: '🐉', color: '#2f6b2f', land: false },
    { id: 'treasure', name: 'Schatz', icon: '💎', color: '#2a7fa8', land: false },
    { id: 'spring', name: 'Quelle', icon: '💧', color: '#2b6cb0', land: true },
    { id: 'portal', name: 'Portal', icon: '🌀', color: '#6b46c1', land: false },
    { id: 'camp', name: 'Lager', icon: '⛺', color: '#7b5e3b', land: true },
    { id: 'grave', name: 'Grab', icon: '🪦', color: '#555555', land: true },
    { id: 'wreck', name: 'Wrack', icon: '⛵', color: '#3d5a73', land: false },
    { id: 'poi', name: 'Ort von Interesse', icon: '📍', color: '#b0302c', land: false },
  ],
  routeTypes: [
    { id: 'royal', name: 'Königsstraße', color: '#6b3a1f', width: 2.6, dash: '', kind: 'land' },
    { id: 'road', name: 'Straße', color: '#8b5a2b', width: 1.8, dash: '', kind: 'land' },
    { id: 'trail', name: 'Pfad', color: '#8b6b4b', width: 1.2, dash: '4 3', kind: 'land' },
    { id: 'sea', name: 'Seeweg', color: '#1f4e79', width: 1.4, dash: '8 5', kind: 'sea' },
    { id: 'river', name: 'Flussweg', color: '#2b6cb0', width: 1.4, dash: '2 3', kind: 'sea' },
    { id: 'air', name: 'Luftweg', color: '#6b46c1', width: 1.2, dash: '1 4', kind: 'air' },
  ],
  zoneTypes: [
    { id: 'conflict', name: 'Konflikt', color: '#b22222', pattern: 'hatch' },
    { id: 'invasion', name: 'Invasion', color: '#8b0000', pattern: 'cross' },
    { id: 'rebellion', name: 'Aufstand', color: '#d2691e', pattern: 'hatch' },
    { id: 'plague', name: 'Seuche', color: '#6b8e23', pattern: 'dots' },
    { id: 'disaster', name: 'Katastrophe', color: '#8b4513', pattern: 'cross' },
    { id: 'flood', name: 'Überschwemmung', color: '#1e90ff', pattern: 'hatch' },
    { id: 'magic', name: 'Magie', color: '#8a2be2', pattern: 'dots' },
    { id: 'region', name: 'Region', color: '#4682b4', pattern: 'fill' },
    { id: 'trade', name: 'Handelsgebiet', color: '#daa520', pattern: 'hatch' },
    { id: 'forbidden', name: 'Sperrgebiet', color: '#2f2f2f', pattern: 'cross' },
  ],
  cultureTypes: [
    { id: 'generic', name: 'Allgemein' },
    { id: 'river', name: 'Flusskultur' },
    { id: 'lake', name: 'Seenkultur' },
    { id: 'naval', name: 'Seefahrer' },
    { id: 'nomadic', name: 'Nomaden' },
    { id: 'hunting', name: 'Jäger' },
    { id: 'highland', name: 'Hochland' },
  ],
  religionTypes: [
    { id: 'folk', name: 'Volksglaube' },
    { id: 'organized', name: 'Organisierte Religion' },
    { id: 'cult', name: 'Kult' },
    { id: 'heresy', name: 'Häresie' },
  ],
  stateForms: [
    { id: 'kingdom', name: 'Königreich' },
    { id: 'empire', name: 'Kaiserreich' },
    { id: 'principality', name: 'Fürstentum' },
    { id: 'duchy', name: 'Herzogtum' },
    { id: 'republic', name: 'Republik' },
    { id: 'citystate', name: 'Stadtstaat' },
    { id: 'theocracy', name: 'Theokratie' },
    { id: 'league', name: 'Bund' },
    { id: 'tribal', name: 'Stammesgebiet' },
    { id: 'horde', name: 'Horde' },
  ],
  labelCategories: [
    { id: 'state', name: 'Staat', size: 18, color: '#3b2f2f', italic: false, uppercase: true, spacing: 4, font: 'Georgia, serif' },
    { id: 'region', name: 'Region', size: 14, color: '#4a3b30', italic: false, uppercase: true, spacing: 3, font: 'Georgia, serif' },
    { id: 'ocean', name: 'Ozean', size: 22, color: '#1f3f66', italic: true, uppercase: true, spacing: 8, font: 'Georgia, serif' },
    { id: 'sea', name: 'Meer', size: 15, color: '#24507a', italic: true, uppercase: false, spacing: 2, font: 'Georgia, serif' },
    { id: 'mountains', name: 'Gebirge', size: 13, color: '#5b4632', italic: false, uppercase: true, spacing: 3, font: 'Georgia, serif' },
    { id: 'forest', name: 'Wald', size: 12, color: '#2f5130', italic: true, uppercase: false, spacing: 1, font: 'Georgia, serif' },
    { id: 'desert', name: 'Wüste', size: 13, color: '#7a5a2a', italic: true, uppercase: false, spacing: 2, font: 'Georgia, serif' },
    { id: 'island', name: 'Insel', size: 12, color: '#3b3b3b', italic: false, uppercase: false, spacing: 1, font: 'Georgia, serif' },
    { id: 'other', name: 'Sonstiges', size: 12, color: '#2b2b2b', italic: false, uppercase: false, spacing: 0, font: '"Segoe UI", sans-serif' },
  ],
  unitTypes: [
    { id: 'infantry', name: 'Infanterie', symbol: '⚔', naval: false },
    { id: 'archers', name: 'Bogenschützen', symbol: '🏹', naval: false },
    { id: 'cavalry', name: 'Kavallerie', symbol: '🐎', naval: false },
    { id: 'artillery', name: 'Belagerung', symbol: '💣', naval: false },
    { id: 'fleet', name: 'Schiffe', symbol: '⛵', naval: true },
  ],
  relations: [
    { id: 'ally', name: 'Verbündet', color: '#2e8b57', mirror: 'ally' },
    { id: 'friendly', name: 'Freundlich', color: '#8fbc8f', mirror: 'friendly' },
    { id: 'neutral', name: 'Neutral', color: '#c8c2b0', mirror: 'neutral' },
    { id: 'suspicion', name: 'Misstrauisch', color: '#e0b04a', mirror: 'suspicion' },
    { id: 'rival', name: 'Rivale', color: '#e07b39', mirror: 'rival' },
    { id: 'enemy', name: 'Feindlich', color: '#c0392b', mirror: 'enemy' },
    { id: 'war', name: 'Krieg', color: '#7b1010', mirror: 'war' },
    { id: 'vassal', name: 'Vasall von', color: '#6a5acd', mirror: 'suzerain' },
    { id: 'suzerain', name: 'Lehnsherr von', color: '#483d8b', mirror: 'vassal' },
    { id: 'unknown', name: 'Unbekannt', color: '#9e9e9e', mirror: 'unknown' },
  ],
})

const style = (partial: Partial<LayerStyle>): LayerStyle => ({
  stroke: '',
  strokeWidth: 1,
  dash: '',
  fill: '',
  fillOpacity: 0.3,
  showLabels: true,
  labelFont: 'Georgia, serif',
  labelSize: 13,
  labelColor: '#2b2118',
  halo: '#f6f0e1',
  haloWidth: 3,
  symbolScale: 1,
  ...partial,
})

export const defaultStyle = (): Record<BuiltinLayerId, LayerStyle> => ({
  relief: style({}),
  satellite: style({}),
  shade: style({}),
  coast: style({ stroke: '#3d4b52', strokeWidth: 0.8, fill: '#efe6cf', fillOpacity: 1, showLabels: false }),
  koppen: style({ showLabels: false }),
  rivers: style({ stroke: '#3f7fbf', strokeWidth: 1.2, labelColor: '#1f4e79', labelSize: 11, showLabels: false }),
  cultures: style({ fillOpacity: 0.25, strokeWidth: 1, dash: '6 3', labelSize: 14 }),
  religions: style({ fillOpacity: 0.25, strokeWidth: 1, dash: '2 3', labelSize: 14 }),
  states: style({ fillOpacity: 0.28, strokeWidth: 2, labelSize: 16, labelColor: '#3b2f2f' }),
  provinces: style({ fillOpacity: 0, strokeWidth: 0.8, dash: '4 3', labelSize: 11, labelColor: '#4a3b30', showLabels: false }),
  zones: style({ fillOpacity: 0.35, strokeWidth: 1.2, labelSize: 12 }),
  routes: style({ labelSize: 10, showLabels: false }),
  cities: style({ stroke: '#1b2329', fill: '#f4efe4', labelSize: 12, labelFont: '"Segoe UI", sans-serif' }),
  markers: style({ symbolScale: 1, labelSize: 11, labelFont: '"Segoe UI", sans-serif', showLabels: false }),
  regiments: style({ symbolScale: 1, labelSize: 10, labelFont: '"Segoe UI", sans-serif' }),
  labels: style({}),
  graticule: style({ stroke: '#2b3a44', strokeWidth: 0.5, labelColor: '#2b3a44', labelSize: 10 }),
  texture: style({}),
})

/** bottom to top */
export const LAYER_NAMES: Record<BuiltinLayerId, string> = {
  relief: 'Relief (Höhenfarben)',
  satellite: 'Satellitenbild (Gaea)',
  coast: 'Landfläche und Küste',
  shade: 'Schummerung',
  koppen: 'Klima (Köppen)',
  rivers: 'Flüsse',
  cultures: 'Kulturen',
  religions: 'Religionen',
  states: 'Staaten',
  provinces: 'Provinzen',
  zones: 'Zonen',
  routes: 'Routen',
  cities: 'Städte',
  markers: 'Marker',
  regiments: 'Regimenter',
  labels: 'Beschriftungen',
  graticule: 'Gitter und Koordinaten',
  texture: 'Textur',
}

export const isImageLayer = (id: LayerId): id is `img:${string}` => id.startsWith('img:')

/** display name of a layer; own image layers carry their own */
export function layerName(p: Project, id: LayerId) {
  if (isImageLayer(id)) return p.imageLayers.find(l => `img:${l.id}` === id)?.name || 'Bildebene'
  return LAYER_NAMES[id]
}

export const defaultLayers = (): LayerSetting[] => [
  { id: 'relief', visible: true, opacity: 1 },
  { id: 'satellite', visible: false, opacity: 1 },
  { id: 'coast', visible: false, opacity: 1 },
  { id: 'shade', visible: false, opacity: 0.6 },
  { id: 'koppen', visible: false, opacity: 0.7 },
  { id: 'rivers', visible: true, opacity: 1 },
  { id: 'cultures', visible: false, opacity: 1 },
  { id: 'religions', visible: false, opacity: 1 },
  { id: 'states', visible: true, opacity: 1 },
  { id: 'provinces', visible: true, opacity: 1 },
  { id: 'zones', visible: true, opacity: 1 },
  { id: 'routes', visible: true, opacity: 1 },
  { id: 'cities', visible: true, opacity: 1 },
  { id: 'markers', visible: true, opacity: 1 },
  { id: 'regiments', visible: false, opacity: 1 },
  { id: 'labels', visible: true, opacity: 1 },
  { id: 'graticule', visible: false, opacity: 0.6 },
  { id: 'texture', visible: false, opacity: 0.5 },
]

const visibleSet = (ids: LayerId[]) => defaultLayers().map(l => ({ id: l.id, visible: ids.includes(l.id) }))

export const BUILTIN_LAYER_PRESETS: LayerPreset[] = [
  { id: 'political', name: 'Politisch', layers: visibleSet(['relief', 'rivers', 'states', 'provinces', 'routes', 'cities', 'labels']) },
  { id: 'physical', name: 'Physisch', layers: visibleSet(['relief', 'rivers', 'labels', 'graticule']) },
  { id: 'satellite', name: 'Satellit', layers: visibleSet(['satellite', 'rivers', 'labels']) },
  { id: 'climate', name: 'Klima', layers: visibleSet(['shade', 'koppen', 'rivers', 'labels']) },
  { id: 'cultural', name: 'Kulturen und Religionen', layers: visibleSet(['coast', 'rivers', 'cultures', 'religions', 'cities', 'labels']) },
  { id: 'military', name: 'Militär', layers: visibleSet(['relief', 'rivers', 'states', 'routes', 'cities', 'regiments', 'labels']) },
  { id: 'atlas', name: 'Atlas', layers: visibleSet(['coast', 'shade', 'rivers', 'states', 'routes', 'cities', 'markers', 'labels', 'graticule', 'texture']) },
  { id: 'all', name: 'Alles', layers: defaultLayers().map(l => ({ id: l.id, visible: l.id !== 'texture' && l.id !== 'shade' && l.id !== 'satellite' })) },
]

export const neutralFilter = (): Filter => ({ grayscale: 0, sepia: 0, saturate: 1, brightness: 1, contrast: 1, hue: 0, blur: 0, invert: 0 })

export const defaultDisplay = (): Display => ({
  background: '#9fc3dc',
  graticule: { step: 0, color: '#2b3a44', width: 0.5, labels: true },
  compass: { show: false, size: 90, position: 'tr' },
  scaleBar: { show: true },
  coordinates: { show: true },
  texture: { kind: 'paper', image: '', blend: 'multiply', scale: 1 },
  mapFilter: neutralFilter(),
  layerFilters: {},
  diplomacyFocus: '',
  hiddenMarkerTypes: [],
})

const restyle = (changes: Partial<Record<BuiltinLayerId, Partial<LayerStyle>>>) => {
  const base = defaultStyle()
  for (const [id, partial] of Object.entries(changes)) Object.assign(base[id as BuiltinLayerId], partial)
  return base
}

export const BUILTIN_STYLE_PRESETS: StylePreset[] = [
  {
    id: 'standard',
    name: 'Standard',
    style: defaultStyle(),
    display: { background: '#9fc3dc', mapFilter: neutralFilter(), layerFilters: {}, texture: defaultDisplay().texture, graticule: defaultDisplay().graticule },
  },
  {
    id: 'parchment',
    name: 'Pergament',
    style: restyle({
      coast: { fill: '#eadcb8', stroke: '#6b4f2f', strokeWidth: 1.2 },
      states: { fillOpacity: 0.12, strokeWidth: 2.2, labelColor: '#4a2f1a', labelFont: 'Georgia, serif' },
      rivers: { stroke: '#5b7f95' },
      cities: { stroke: '#3b2a1a', fill: '#eadcb8', labelColor: '#3b2a1a', labelFont: 'Georgia, serif' },
    }),
    display: {
      background: '#cdbf9c',
      mapFilter: { ...neutralFilter(), sepia: 0.35, saturate: 0.8 },
      layerFilters: {},
      texture: { kind: 'paper', image: '', blend: 'multiply', scale: 1 },
      graticule: { step: 15, color: '#6b4f2f', width: 0.4, labels: true },
    },
  },
  {
    id: 'atlas',
    name: 'Atlas',
    style: restyle({
      coast: { fill: '#f3efe3', stroke: '#1f4e79', strokeWidth: 0.9 },
      states: { fillOpacity: 0.4, strokeWidth: 1.4, stroke: '#ffffff', labelColor: '#222222', labelFont: '"Segoe UI", sans-serif' },
      provinces: { stroke: '#ffffff', strokeWidth: 0.6 },
      rivers: { stroke: '#2f78c4', strokeWidth: 1 },
    }),
    display: {
      background: '#bcd9ee',
      mapFilter: neutralFilter(),
      layerFilters: {},
      texture: { kind: 'grain', image: '', blend: 'multiply', scale: 1 },
      graticule: { step: 10, color: '#6f8fa8', width: 0.4, labels: true },
    },
  },
  {
    id: 'night',
    name: 'Dunkel',
    style: restyle({
      coast: { fill: '#2a2f36', stroke: '#8fb3c9', strokeWidth: 0.8 },
      states: { fillOpacity: 0.3, strokeWidth: 1.6, labelColor: '#f0e6d0', halo: '#15191e' },
      provinces: { labelColor: '#d8ccb0', halo: '#15191e' },
      cities: { stroke: '#f0e6d0', fill: '#1d2227', labelColor: '#f0e6d0', halo: '#15191e' },
      rivers: { stroke: '#5fa8d3' },
      labels: { halo: '#15191e' },
    }),
    display: {
      background: '#101820',
      mapFilter: { ...neutralFilter(), brightness: 0.85 },
      layerFilters: { relief: { ...neutralFilter(), brightness: 0.55, saturate: 0.7 } },
      texture: { kind: 'grain', image: '', blend: 'overlay', scale: 1 },
      graticule: { step: 15, color: '#8fb3c9', width: 0.4, labels: true },
    },
  },
]
