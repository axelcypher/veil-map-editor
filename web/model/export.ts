// Exports. GeoJSON in degrees (−180…180, −90…90) goes straight into GPlates, where "Assign Plate IDs"
// gives every element the plate of its block. The JSON export carries all data plus derived values.
import { platform } from '../platform'
import { cityMembership, cultureStats, provinceStats, religionStats, stateStats } from './derive'
import { areaKm2, lineLengthM } from './geo'
import { readFrontmatter } from './obsidian'
import { notify, project } from './store'
import { clippedGeometry } from './terrain'
import type { AreaBase, Entity, EntityKind, Project } from './types'

export interface GeoJsonOptions {
  layers: EntityKind[]
  clipToLand: boolean
  frontmatter: boolean
  perLayer: boolean
}

export const EXPORT_LAYERS: EntityKind[] = ['city', 'route', 'river', 'marker', 'label', 'state', 'province', 'culture', 'religion', 'zone', 'regiment']

const nameOf = (p: Project, kind: 'states' | 'cultures' | 'religions' | 'provinces' | 'cities', id: string) => (p[kind] as { id: string; name: string }[]).find(x => x.id === id)?.name ?? ''
const typeName = (list: { id: string; name: string }[], id: string) => list.find(t => t.id === id)?.name ?? id

async function properties(p: Project, kind: EntityKind, entity: Entity, withFrontmatter: boolean): Promise<Record<string, unknown>> {
  const base: Record<string, unknown> = { layer: kind, id: entity.id, name: entity.name, description: entity.description || undefined, note: entity.note || undefined }
  const c = p.catalog
  const members = cityMembership.value
  switch (kind) {
    case 'state': {
      const s = entity as Project['states'][number]
      const stats = stateStats.value.get(s.id)
      Object.assign(base, {
        fullName: s.fullName || undefined,
        form: typeName(c.stateForms, s.form),
        color: s.color,
        capital: nameOf(p, 'cities', s.capitalId) || undefined,
        culture: nameOf(p, 'cultures', s.cultureId) || undefined,
        religion: nameOf(p, 'religions', s.religionId) || undefined,
        areaKm2: stats ? Math.round(stats.areaKm2) : undefined,
        urbanPopulation: stats ? Math.round(stats.urban) : undefined,
        ruralPopulation: stats ? Math.round(stats.rural) : undefined,
      })
      break
    }
    case 'province': {
      const x = entity as Project['provinces'][number]
      const stats = provinceStats.value.get(x.id)
      Object.assign(base, { state: nameOf(p, 'states', x.stateId), form: x.form, color: x.color, capital: nameOf(p, 'cities', x.capitalId) || undefined, areaKm2: stats ? Math.round(stats.areaKm2) : undefined, ruralPopulation: stats ? Math.round(stats.rural) : undefined })
      break
    }
    case 'culture': {
      const x = entity as Project['cultures'][number]
      Object.assign(base, { type: typeName(c.cultureTypes, x.type), color: x.color, origins: x.origins.map(o => nameOf(p, 'cultures', o)), areaKm2: Math.round(cultureStats.value.get(x.id)?.areaKm2 ?? 0) })
      break
    }
    case 'religion': {
      const x = entity as Project['religions'][number]
      Object.assign(base, { type: typeName(c.religionTypes, x.type), form: x.form || undefined, deity: x.deity || undefined, color: x.color, origins: x.origins.map(o => nameOf(p, 'religions', o)), areaKm2: Math.round(religionStats.value.get(x.id)?.areaKm2 ?? 0) })
      break
    }
    case 'zone': {
      const x = entity as Project['zones'][number]
      Object.assign(base, { type: typeName(c.zoneTypes, x.type), color: x.color })
      break
    }
    case 'city': {
      const x = entity as Project['cities'][number]
      const m = members.get(x.id)
      Object.assign(base, {
        type: typeName(c.cityTypes, x.type),
        population: x.population,
        ...Object.fromEntries(Object.entries(x.features).filter(([, v]) => v)),
        state: m ? nameOf(p, 'states', m.state) || undefined : undefined,
        province: m ? nameOf(p, 'provinces', m.province) || undefined : undefined,
        culture: m ? nameOf(p, 'cultures', m.culture) || undefined : undefined,
        religion: m ? nameOf(p, 'religions', m.religion) || undefined : undefined,
        group: x.group || undefined,
        plan: x.plan || undefined,
      })
      break
    }
    case 'route': {
      const x = entity as Project['routes'][number]
      Object.assign(base, { type: typeName(c.routeTypes, x.type), lengthKm: Math.round(lineLengthM(x.geometry.coordinates, p.planetRadius) / 1000) })
      break
    }
    case 'river': {
      const x = entity as Project['rivers'][number]
      Object.assign(base, { type: x.type, lengthKm: x.lengthKm, upstreamKm: x.upstreamKm, parent: p.rivers.find(r => r.id === x.parentId)?.name || x.parentId || undefined })
      break
    }
    case 'marker': {
      const x = entity as Project['markers'][number]
      Object.assign(base, { type: typeName(c.markerTypes, x.type) })
      break
    }
    case 'label': {
      const x = entity as Project['labels'][number]
      Object.assign(base, { category: typeName(c.labelCategories, x.category) })
      break
    }
    case 'regiment': {
      const x = entity as Project['regiments'][number]
      Object.assign(base, { state: nameOf(p, 'states', x.stateId), commander: x.commander || undefined, naval: x.naval, units: Object.fromEntries(Object.entries(x.units).map(([k, v]) => [typeName(c.unitTypes, k), v])) })
      break
    }
  }
  if (withFrontmatter && entity.note && p.obsidian.vaultPath) {
    try {
      const data = await readFrontmatter(p, entity.note)
      if (data) base.frontmatter = data
    } catch {
      /* note gone: export without it */
    }
  }
  return Object.fromEntries(Object.entries(base).filter(([, v]) => v !== undefined))
}

const COLLECTION: Record<EntityKind, keyof Project> = {
  state: 'states', province: 'provinces', culture: 'cultures', religion: 'religions', zone: 'zones',
  city: 'cities', route: 'routes', river: 'rivers', label: 'labels', marker: 'markers', regiment: 'regiments',
}

async function featuresOf(p: Project, kind: EntityKind, options: GeoJsonOptions) {
  const entities = p[COLLECTION[kind]] as unknown as Entity[]
  const out = []
  for (const entity of entities) {
    let geometry = entity.geometry as unknown
    if ('clip' in entity) {
      const area = entity as AreaBase
      geometry = options.clipToLand ? await clippedGeometry(area.geometry, area.clip) : area.geometry
    }
    if (!geometry) continue
    out.push({ type: 'Feature', id: entity.id, geometry, properties: await properties(p, kind, entity, options.frontmatter) })
  }
  return out
}

function collection(p: Project, features: unknown[], name: string) {
  return {
    type: 'FeatureCollection',
    name,
    // degrees on the planet sphere; the same definition QGIS knows as "Thessari - geo"
    crs: { type: 'name', properties: { name: `+proj=longlat +R=${p.planetRadius} +no_defs` } },
    features,
  }
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'karte'
const LAYER_FILE: Record<EntityKind, string> = {
  state: 'staaten', province: 'provinzen', culture: 'kulturen', religion: 'religionen', zone: 'zonen',
  city: 'staedte', route: 'routen', river: 'fluesse', label: 'beschriftungen', marker: 'marker', regiment: 'regimenter',
}

/** `target` (a folder or a file) skips the dialog */
export async function exportGeoJson(options: GeoJsonOptions, target?: string) {
  const p = project.value
  const base = slug(p.name)
  if (options.perLayer && platform.kind === 'desktop') {
    const folder = target ?? (await platform.pickFolder('Ordner für die GeoJSON-Dateien'))
    if (!folder) return
    let count = 0
    for (const kind of options.layers) {
      const features = await featuresOf(p, kind, options)
      if (!features.length) continue
      await platform.writeText(`${folder}/${base}_${LAYER_FILE[kind]}.geojson`, JSON.stringify(collection(p, features, LAYER_FILE[kind])))
      count++
    }
    notify(`${count} GeoJSON-Dateien geschrieben.`, 'ok')
    return
  }
  const path = target ?? (await platform.pickSavePath('GeoJSON exportieren', `${base}.geojson`, [{ name: 'GeoJSON', extensions: ['geojson', 'json'] }]))
  if (!path) return
  const features = []
  for (const kind of options.layers) features.push(...(await featuresOf(p, kind, options)))
  await platform.writeText(path, JSON.stringify(collection(p, features, base)))
  notify(`GeoJSON mit ${features.length} Elementen exportiert.`, 'ok')
}

/** all map data as plain JSON, with names resolved and derived values filled in */
export async function exportJson(target?: string) {
  const p = project.value
  const path = target ?? await platform.pickSavePath('Kartendaten als JSON', `${slug(p.name)}_daten.json`, [{ name: 'JSON', extensions: ['json'] }])
  if (!path) return
  const layers: Record<string, unknown[]> = {}
  for (const kind of EXPORT_LAYERS) {
    const entities = p[COLLECTION[kind]] as unknown as Entity[]
    layers[COLLECTION[kind] as string] = await Promise.all(
      entities.map(async entity => ({
        ...(await properties(p, kind, entity, false)),
        geometry: entity.geometry,
        ...('clip' in entity ? { drawnAreaKm2: Math.round(areaKm2((entity as AreaBase).geometry, p.planetRadius)) } : {}),
      })),
    )
  }
  const data = {
    name: p.name,
    exportedAt: new Date().toISOString(),
    planet: { radiusM: p.planetRadius, crs: `+proj=longlat +R=${p.planetRadius} +no_defs` },
    terrain: p.terrain ? { source: p.terrain.source, hash: p.terrain.hash, importedAt: new Date(p.terrain.importedAt).toISOString() } : null,
    ...layers,
    diplomacy: Object.entries(p.diplomacy).map(([key, relation]) => {
      const [a, b] = key.split('>')
      return { from: nameOf(p, 'states', a), to: nameOf(p, 'states', b), relation: typeName(p.catalog.relations, relation) }
    }),
    catalog: p.catalog,
    koppenClasses: p.koppenClasses.map(({ code, name, color, description }) => ({ code, name, color, description })),
  }
  await platform.writeText(path, JSON.stringify(data, null, 1))
  notify('Kartendaten als JSON exportiert.', 'ok')
}
