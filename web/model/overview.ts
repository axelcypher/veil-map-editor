// The map overview note ("Kartenstand"): states, cities and the other named places, with what the
// map says about each spot (climate, height, distance to the coast, which state and culture it lies
// in), written as Markdown into the vault. Meant to be read in Obsidian, e.g. by Claude, when names
// are made up. Off unless switched on, per device and project; only the device that has it on
// writes, and only when the text really changed.
//
// With a timeline it shows the present: the base strand in its last year, whatever year and
// strand the map shows, so moving through time does not rewrite the note.
import { effect, signal } from '@preact/signals'
import { platform } from '../platform'
import { membershipAt, type Membership } from './derive'
import { areaKm2, distanceM, formatInt, formatKm2, inArea } from './geo'
import { filePath, source } from './store'
import { clippedGeometry, gridHeight, islandAt, koppen, koppenAt, terrain } from './terrain'
import { baseStrand, reckoningOf, resolveWorld, toOwnYear } from './timeline'
import { LEVEL_NAMES } from './project'
import type { AreaBase, AreaGeometry, City, LonLat, NamedType, Project, WorldLevel } from './types'
import { patchVault, vaultSettings, type OverviewSettings } from './vault'

/** after the last change, so a burst of edits makes one write */
const WRITE_DELAY = 15_000

/** settings are kept per project; a project that is neither saved nor synced has no key yet */
export function projectKey(p: Project, path = filePath.peek()) {
  if (p.sync) return `sync:${p.sync.item}`
  return path ? `file:${path}` : null
}

export const defaultOverviewNote = (p: Project) => `Kartenstand ${p.name.replace(/[\\/:*?"<>|#^[\]]+/g, ' ').trim() || 'Projekt'}.md`

export function overviewSettings(p: Project, key: string | null): OverviewSettings {
  const stored = key ? vaultSettings.value.overviews[key] : undefined
  return { on: false, note: defaultOverviewNote(p), ...stored }
}

export function setOverviewSettings(key: string, patch: Partial<OverviewSettings>) {
  const current = overviewSettings(source.peek(), key)
  patchVault({ overviews: { ...vaultSettings.peek().overviews, [key]: { ...current, ...patch } } })
}

export const overviewStatus = signal<{ at: number; text: string; error: boolean } | null>(null)

// ---------------------------------------------------------------------------------------------
// what the map says about a spot

const FEATURES: [keyof City['features'], string][] = [
  ['capital', 'Hauptstadt'],
  ['port', 'Hafen'],
  ['citadel', 'Zitadelle'],
  ['walls', 'Stadtmauer'],
  ['plaza', 'Marktplatz'],
  ['temple', 'Tempel'],
  ['shanty', 'Elendsviertel'],
]

/** metres to the nearest point of the coast of the land the spot is on; null without terrain or at sea */
function coastDistance(point: LonLat, radius: number) {
  const ring = islandAt(point)?.[0]
  if (!ring) return null
  let best = Infinity
  for (const vertex of ring) best = Math.min(best, distanceM(point, vertex, radius))
  return best
}

interface AreaSample {
  climate: [string, number][]
  medianM: number | null
  maxM: number | null
}

/**
 * the climate of a spot on land; a city on the shore may sit on a water pixel of the climate map,
 * then the most common land class within about 30 km counts
 */
function climateAt([lon, lat]: LonLat): string | null {
  const here = koppenAt([lon, lat])
  if (here !== 'W' && here != null) return here
  const k = koppen.peek()
  if (!k) return here
  const dx = 360 / k.meta.width
  const dy = 180 / k.meta.height
  const counts = new Map<string, number>()
  for (let j = -3; j <= 3; j++) for (let i = -3; i <= 3; i++) {
    const code = koppenAt([lon + i * dx, lat + j * dy])
    if (code && code !== 'W') counts.set(code, (counts.get(code) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? here
}

/** climate shares and heights inside an area, from a lattice of about 800 points weighted by latitude */
function sampleArea(geometry: AreaGeometry | null): AreaSample | null {
  if (!geometry?.coordinates.length) return null
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const poly of geometry.coordinates) for (const [x, y] of poly[0] ?? []) {
    w = Math.min(w, x)
    s = Math.min(s, y)
    e = Math.max(e, x)
    n = Math.max(n, y)
  }
  const step = Math.max(0.02, Math.sqrt(((e - w) * (n - s)) / 800))
  const climate = new Map<string, number>()
  const heights: number[] = []
  let total = 0
  for (let y = s + step / 2; y < n; y += step) {
    const weight = Math.cos((y * Math.PI) / 180)
    for (let x = w + step / 2; x < e; x += step) {
      if (!inArea(geometry, [x, y])) continue
      // an area drawn into the sea and not cut to the coast: only its land counts
      const h = gridHeight([x, y])
      if (h != null && h <= 0) continue
      if (h != null) heights.push(h)
      const code = koppenAt([x, y])
      if (code && code !== 'W') {
        climate.set(code, (climate.get(code) ?? 0) + weight)
        total += weight
      }
    }
  }
  heights.sort((a, b) => a - b)
  return {
    climate: [...climate].map(([code, v]) => [code, v / total] as [string, number]).sort((a, b) => b[1] - a[1]),
    medianM: heights.length ? heights[Math.floor(heights.length / 2)] : null,
    maxM: heights.length ? heights[heights.length - 1] : null,
  }
}

// ---------------------------------------------------------------------------------------------
// Markdown

const cell = (text: string) => text.replace(/\r?\n+/g, ' ').replace(/\|/g, '\\|').trim()
const line = (text: string) => text.replace(/\r?\n+/g, ' ').trim()
const link = (note: string) => `[[${note.replace(/\.md$/i, '')}]]`
const linkCell = (note: string) => (note ? cell(link(note)) : '')
const metres = (m: number | null) => (m == null ? '' : `${formatInt(Math.round(m / 10) * 10)} m`)
const km = (m: number | null) => (m == null ? '' : m < 1000 ? '< 1 km' : `${formatInt(m / 1000)} km`)
const percent = (share: number) => `${Math.round(share * 100)} %`
const lonLat = ([lon, lat]: LonLat) =>
  `${Math.abs(lat).toFixed(1).replace('.', ',')}° ${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(1).replace('.', ',')}° ${lon >= 0 ? 'O' : 'W'}`

/** empty on the surface, so the column only shows when something lies elsewhere */
const levelCell = (x: { level?: WorldLevel }) => (x.level && x.level !== 'surface' ? LEVEL_NAMES[x.level] : '')
const typeName = (types: NamedType[], id: string) => types.find(t => t.id === id)?.name ?? id

function table(head: string[], rows: string[][]) {
  // columns nobody filled in are left out
  const used = head.map((_, i) => i === 0 || rows.some(r => r[i]))
  const pick = (r: string[]) => `| ${r.filter((_, i) => used[i]).join(' | ')} |`
  return [pick(head), pick(head.map(() => '---')), ...rows.map(pick)].join('\n')
}

/** "Name (Typ) · a · b" with the empty parts left out */
const facts = (parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' · ')

interface CityFacts {
  city: City
  height: number | null
  coast: number | null
  climate: string | null
}

async function cityFacts(p: Project): Promise<CityFacts[]> {
  const points = p.cities.map(c => c.geometry.coordinates)
  let heights: (number | null)[] = points.map(gridHeight)
  if (terrain.peek() && points.length) {
    try {
      heights = await platform.heights(points)
    } catch {
      /* the ≈10 km grid has to do */
    }
  }
  return p.cities.map((city, i) => ({
    city,
    height: heights[i] ?? gridHeight(points[i]),
    coast: coastDistance(points[i], p.planetRadius),
    climate: climateAt(points[i]),
  }))
}

/** the present of the world: the base strand in its last year (the project itself without a timeline) */
export function presentWorld(raw: Project): { world: Project; when: string | null } {
  const t = raw.timeline
  if (!t) return { world: raw, when: null }
  const base = baseStrand(t)
  const r = reckoningOf(t, base.id)
  return { world: resolveWorld(raw, r.end, { strand: base.id }), when: `Jahr ${toOwnYear(r, r.end)}${r.unit ? ` ${r.unit}` : ''} im Strang „${base.name}“` }
}

/** the note without its frontmatter; equal text means nothing to write */
export async function overviewBody(p: Project, when: string | null = null): Promise<string> {
  const members = new Map<string, Membership>(p.cities.map(c => [c.id, membershipAt(p, c.geometry.coordinates)]))
  const citiesIn = (key: 'state' | 'province' | 'culture' | 'religion', id: string) => p.cities.filter(c => members.get(c.id)?.[key] === id)
  const facts_ = await cityFacts(p)
  const nameOf = <T extends { id: string; name: string }>(list: T[], id: string) => list.find(x => x.id === id)?.name ?? ''
  const climateName = (code: string | null) => (code ? p.koppenClasses.find(k => k.code === code)?.name ?? code : '')
  const usedClimates = new Set<string>()
  const climateMix = (sample: AreaSample | null) => {
    const parts = (sample?.climate ?? []).filter(([, share]) => share >= 0.05).slice(0, 5)
    parts.forEach(([code]) => usedClimates.add(code))
    return parts.map(([code, share]) => `${code} ${percent(share)}`).join(', ')
  }
  const shapes = new Map<string, { sample: AreaSample | null; km2: number }>()
  const shape = async (area: AreaBase) => {
    let hit = shapes.get(area.id)
    if (!hit) {
      const land = await clippedGeometry(area.geometry, area.clip)
      shapes.set(area.id, (hit = { sample: sampleArea(land), km2: areaKm2(land, p.planetRadius) }))
    }
    return hit
  }
  const sampled = async (area: AreaBase) => (await shape(area)).sample

  const cityRow = (f: CityFacts, withState: boolean) => {
    const m = members.get(f.city.id)
    if (f.climate) usedClimates.add(f.climate)
    const features = FEATURES.filter(([key]) => f.city.features[key]).map(([, name]) => name)
    return [
      cell(f.city.name),
      cell(typeName(p.catalog.cityTypes, f.city.type)),
      levelCell(f.city),
      formatInt(f.city.population),
      f.climate ?? '',
      metres(f.height),
      km(f.coast),
      lonLat(f.city.geometry.coordinates),
      withState ? cell(nameOf(p.states, m?.state ?? '')) : '',
      cell(nameOf(p.provinces, m?.province ?? '')),
      cell(nameOf(p.cultures, m?.culture ?? '')),
      cell(nameOf(p.religions, m?.religion ?? '')),
      cell((m?.zones ?? []).map(id => nameOf(p.zones, id)).join(', ')),
      cell(f.city.group),
      features.join(', '),
      linkCell(f.city.note),
      cell(f.city.description),
    ]
  }
  const CITY_HEAD = ['Stadt', 'Typ', 'Ebene', 'Einw.', 'Klima', 'Höhe', 'Küste', 'Lage', 'Staat', 'Provinz', 'Kultur', 'Religion', 'Zonen', 'Gruppe', 'Merkmale', 'Notiz', 'Beschreibung']
  const byPopulation = (a: CityFacts, b: CityFacts) => b.city.population - a.city.population

  const out: string[] = []
  out.push(`# Kartenstand: ${line(p.name)}`)
  out.push(
    'Automatisch geschrieben vom VEIL Map Editor. Änderungen in dieser Note werden beim nächsten Abgleich überschrieben.\n\n' +
      (when ? `Die Welt im ${when} – der Gegenwart der Zeitleiste. ` : '') +
      'Werte am Ort jeder Stadt: Klima nach Köppen, Höhe über dem Meer, Entfernung zur Küste, Lage. ' +
      'Staat, Provinz, Kultur, Religion und Zonen ergeben sich aus der Lage auf der Karte. ' +
      'Klima und Höhe der Gebiete sind über ihre Landfläche gemittelt. ' +
      `„Ebene“ leer heißt Oberfläche; der Himmel beginnt in ${formatInt(p.levels.skyAltitude)} m Höhe.`,
  )

  // states with their cities
  out.push('## Staaten')
  for (const state of [...p.states].sort((a, b) => a.name.localeCompare(b.name, 'de'))) {
    const { sample, km2 } = await shape(state)
    const urban = citiesIn('state', state.id).reduce((sum, c) => sum + c.population, 0)
    const provinces = p.provinces.filter(x => x.stateId === state.id).map(x => x.name)
    out.push(`### ${line(state.name)}`)
    out.push(
      facts([
        state.fullName && `Amtlich: ${line(state.fullName)}`,
        state.form && `Staatsform: ${typeName(p.catalog.stateForms, state.form)}`,
        state.cultureId && `Kultur: ${nameOf(p.cultures, state.cultureId)}`,
        state.religionId && `Religion: ${nameOf(p.religions, state.religionId)}`,
        state.capitalId && `Hauptstadt: ${nameOf(p.cities, state.capitalId)}`,
        km2 > 0 && `Fläche: ${formatKm2(km2)}`,
        `Einwohner: ${formatInt(urban + km2 * state.ruralDensity)} (Städte ${formatInt(urban)})`,
      ]),
    )
    out.push(
      facts([
        sample && climateMix(sample) && `Klima: ${climateMix(sample)}`,
        sample?.medianM != null && `Höhe: Mittel ${metres(sample.medianM)}, höchster Punkt ${metres(sample.maxM)}`,
        provinces.length > 0 && `Provinzen: ${provinces.map(line).join(', ')}`,
        state.note && `Notiz: ${link(state.note)}`,
      ]),
    )
    if (state.description) out.push(line(state.description))
    const cities = facts_.filter(f => members.get(f.city.id)?.state === state.id).sort(byPopulation)
    if (cities.length) out.push(table(CITY_HEAD, cities.map(f => cityRow(f, false))))
  }
  const stateless = facts_.filter(f => !members.get(f.city.id)?.state).sort(byPopulation)
  if (stateless.length) {
    out.push('### Städte ohne Staat')
    out.push(table(CITY_HEAD, stateless.map(f => cityRow(f, true))))
  }

  // the other areas
  if (p.provinces.length) {
    out.push('## Provinzen')
    const rows: string[][] = []
    for (const x of p.provinces) {
      const sample = await sampled(x)
      rows.push([
        cell(x.name),
        cell(nameOf(p.states, x.stateId)),
        cell(nameOf(p.cities, x.capitalId)),
        String(citiesIn('province', x.id).length),
        climateMix(sample),
        metres(sample?.medianM ?? null),
        linkCell(x.note),
        cell(x.description),
      ])
    }
    out.push(table(['Provinz', 'Staat', 'Hauptstadt', 'Städte', 'Klima', 'Höhe (Mittel)', 'Notiz', 'Beschreibung'], rows))
  }
  for (const [kind, key, list, types] of [
    ['Kulturen', 'culture', p.cultures, p.catalog.cultureTypes],
    ['Religionen', 'religion', p.religions, p.catalog.religionTypes],
  ] as const) {
    if (!list.length) continue
    out.push(`## ${kind}`)
    for (const x of list) {
      const sample = await sampled(x)
      const states = p.states.filter(s => s.cultureId === x.id || s.religionId === x.id).map(s => s.name)
      const extra = 'deity' in x ? [x.deity && `Gottheit: ${line(x.deity)}`, x.form && `Form: ${line(x.form)}`] : []
      out.push(
        `- **${line(x.name)}** · ` +
          facts([
            x.type && typeName(types, x.type),
            ...extra,
            x.origins.length > 0 && `Ursprung: ${x.origins.map(id => nameOf(list as AreaBase[], id) || id).join(', ')}`,
            states.length > 0 && `Staatskultur in: ${states.map(line).join(', ')}`,
            `Städte: ${citiesIn(key, x.id).length}`,
            climateMix(sample) && `Klima: ${climateMix(sample)}`,
            x.note && `Notiz: ${link(x.note)}`,
            x.description && line(x.description),
          ]),
      )
    }
  }
  if (p.zones.length) {
    out.push('## Zonen')
    for (const x of p.zones) {
      const cities = p.cities.filter(c => members.get(c.id)?.zones.includes(x.id)).length
      out.push(
        `- **${line(x.name)}** · ` +
          facts([x.type && typeName(p.catalog.zoneTypes, x.type), x.level && LEVEL_NAMES[x.level], `Städte: ${cities}`, x.note && `Notiz: ${link(x.note)}`, x.description && line(x.description)]),
      )
    }
  }

  if (p.institutions.length) {
    out.push('## Institutionen')
    for (const x of p.institutions) {
      out.push(
        `- **${line(x.name)}** · ` +
          facts([
            x.type && typeName(p.catalog.institutionTypes, x.type),
            x.seatId && `Sitz: ${nameOf(p.cities, x.seatId)}`,
            x.stateId && `Staat: ${nameOf(p.states, x.stateId)}`,
            x.cultureId && `Kultur: ${nameOf(p.cultures, x.cultureId)}`,
            x.religionId && `Religion: ${nameOf(p.religions, x.religionId)}`,
            x.leader && `Leitung: ${line(x.leader)}`,
            x.members != null && `Mitglieder: ${formatInt(x.members)}`,
            x.note && `Notiz: ${link(x.note)}`,
            x.description && line(x.description),
          ]),
      )
    }
  }

  // named points and lines
  if (p.markers.length) {
    out.push('## Marker')
    const rows = p.markers.map(x => {
      const point = x.geometry.coordinates
      const code = climateAt(point)
      if (code) usedClimates.add(code)
      const state = p.states.find(s => inArea(s.geometry, point))?.name ?? ''
      return [cell(x.name), cell(typeName(p.catalog.markerTypes, x.type)), levelCell(x), code ?? '', metres(gridHeight(point)), lonLat(point), cell(state), linkCell(x.note), cell(x.description)]
    })
    out.push(table(['Marker', 'Typ', 'Ebene', 'Klima', 'Höhe', 'Lage', 'Staat', 'Notiz', 'Beschreibung'], rows))
  }
  const rivers = p.rivers.filter(r => r.name)
  if (rivers.length) {
    out.push('## Flüsse')
    out.push(
      table(
        ['Fluss', 'Länge', 'Mündet in', 'Notiz', 'Beschreibung'],
        rivers.map(r => [cell(r.name), `${formatInt(r.lengthKm)} km`, cell(nameOf(p.rivers, r.parentId)), linkCell(r.note), cell(r.description)]),
      ),
    )
  }
  // "Route 12" is what a new route is called; only names given by hand say something
  const routes = p.routes.filter(r => r.name && !/^Route \d+$/.test(r.name))
  if (routes.length) {
    out.push('## Benannte Routen')
    out.push(table(['Route', 'Typ', 'Notiz', 'Beschreibung'], routes.map(r => [cell(r.name), cell(typeName(p.catalog.routeTypes, r.type)), linkCell(r.note), cell(r.description)])))
  }
  const labels = p.labels.filter(l => l.name)
  if (labels.length) {
    out.push('## Beschriftungen')
    out.push(table(['Text', 'Kategorie', 'Notiz'], labels.map(l => [cell(l.name), cell(typeName(p.catalog.labelCategories, l.category)), linkCell(l.note)])))
  }

  // the climate classes that occur, so the codes can be read
  if (usedClimates.size) {
    out.push('## Klimaklassen')
    out.push(table(['Code', 'Klima'], [...usedClimates].sort().map(code => [code, cell(climateName(code))])))
  }
  return out.join('\n\n') + '\n'
}

const stripFrontmatter = (text: string) => text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, '')

/** the map says what it can: a terrain or climate map the project has but this device has not loaded yet would leave gaps */
function rastersReady(p: Project) {
  return (!p.terrain || terrain.peek() != null) && (!p.koppen || koppen.peek() != null)
}

let running = false
let again = false

/** writes the note when its text changed; `manual` reports also when nothing had to be written */
export async function writeOverview(manual = false) {
  const raw = source.peek()
  const key = projectKey(raw)
  const root = vaultSettings.peek().path
  if (!root || !key) return
  if (running) {
    again = true
    return
  }
  const { note } = overviewSettings(raw, key)
  const { world: p, when } = presentWorld(raw)
  const report = (text: string, error = false) => (overviewStatus.value = { at: Date.now(), text, error })
  if (!rastersReady(p)) {
    report('Gelände oder Klima noch nicht geladen – Kartenstand wartet.')
    return
  }
  running = true
  try {
    const body = await overviewBody(p, when)
    let previous = ''
    try {
      previous = await platform.vaultRead(root, note)
    } catch {
      /* not there yet */
    }
    if (stripFrontmatter(previous).replace(/\r\n/g, '\n') === body) {
      if (manual) report('Kartenstand ist aktuell.')
      return
    }
    const stamp = new Date().toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' })
    const front = `---\nveil-kartenstand: ${JSON.stringify(p.name)}\nstand: ${stamp}\n---\n\n`
    await platform.vaultWrite(root, note, front + body)
    report(`Kartenstand geschrieben (${p.cities.length} Städte).`)
  } catch (error) {
    report(`Kartenstand nicht geschrieben: ${error}`, true)
  } finally {
    running = false
    if (again) {
      again = false
      void writeOverview()
    }
  }
}

/** keeps the note in step while it is switched on; returns the stop function */
export function startOverview() {
  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = effect(() => {
    // the stored project: another year or strand on the map changes nothing here
    const p = source.value
    const key = projectKey(p, filePath.value)
    const on = !!vaultSettings.value.path && !!key && overviewSettings(p, key).on
    // a raster that arrives late fills in what was missing
    void terrain.value
    void koppen.value
    clearTimeout(timer)
    if (on) timer = setTimeout(() => void writeOverview(), WRITE_DELAY)
  })
  return () => {
    clearTimeout(timer)
    stop()
  }
}
