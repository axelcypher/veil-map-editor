// Values that follow from the data and are never stored: which state a city lies in, areas,
// populations, armies.
import { computed } from '@preact/signals'
import { areaKm2, inArea } from './geo'
import { project } from './store'
import { clipVersion, shownGeometry } from './terrain'
import type { AreaBase, City, LonLat, Project, Province, Regiment, State } from './types'

export interface Membership {
  state: string
  province: string
  culture: string
  religion: string
  zones: string[]
}

function firstContaining<T extends AreaBase>(items: T[], point: LonLat) {
  return items.find(item => inArea(item.geometry, point))?.id ?? ''
}

export function membershipAt(p: Project, point: LonLat): Membership {
  return {
    state: firstContaining(p.states, point),
    province: firstContaining(p.provinces, point),
    culture: firstContaining(p.cultures, point),
    religion: firstContaining(p.religions, point),
    zones: p.zones.filter(z => inArea(z.geometry, point)).map(z => z.id),
  }
}

/** per city, recomputed only when cities or areas change */
export const cityMembership = computed(() => {
  const p = project.value
  const out = new Map<string, Membership>()
  for (const city of p.cities) out.set(city.id, membershipAt(p, city.geometry.coordinates))
  return out
})

export const regimentState = (r: Regiment) => r.stateId

/** land area of an element in km², cut to the coast when the element wants that */
export function landAreaKm2(entity: AreaBase, radius: number) {
  return areaKm2(shownGeometry(entity.geometry, entity.clip), radius)
}

export interface AreaStats {
  areaKm2: number
  cities: City[]
  urban: number
  rural: number
}

function statsFor(entity: AreaBase, density: number, cities: City[], radius: number): AreaStats {
  const area = landAreaKm2(entity, radius)
  const urban = cities.reduce((s, c) => s + c.population, 0)
  return { areaKm2: area, cities, urban, rural: area * density }
}

export const stateStats = computed(() => {
  void clipVersion.value
  const p = project.value
  const members = cityMembership.value
  const out = new Map<string, AreaStats>()
  for (const state of p.states) {
    const cities = p.cities.filter(c => members.get(c.id)?.state === state.id)
    out.set(state.id, statsFor(state, state.ruralDensity, cities, p.planetRadius))
  }
  return out
})

export const provinceStats = computed(() => {
  void clipVersion.value
  const p = project.value
  const members = cityMembership.value
  const out = new Map<string, AreaStats>()
  for (const province of p.provinces) {
    const cities = p.cities.filter(c => members.get(c.id)?.province === province.id)
    const density = province.ruralDensity ?? p.states.find(s => s.id === province.stateId)?.ruralDensity ?? 0
    out.set(province.id, statsFor(province, density, cities, p.planetRadius))
  }
  return out
})

/** cultures and religions: area plus the people of the cities and the countryside inside them */
export function groupStats(kind: 'culture' | 'religion') {
  return computed(() => {
    void clipVersion.value
    const p = project.value
    const members = cityMembership.value
    const list = kind === 'culture' ? p.cultures : p.religions
    const out = new Map<string, AreaStats>()
    const meanDensity = p.states.length ? p.states.reduce((s, x) => s + x.ruralDensity, 0) / p.states.length : 0
    for (const item of list) {
      const cities = p.cities.filter(c => members.get(c.id)?.[kind] === item.id)
      out.set(item.id, statsFor(item, meanDensity, cities, p.planetRadius))
    }
    return out
  })
}
export const cultureStats = groupStats('culture')
export const religionStats = groupStats('religion')

export const provincesOf = (p: Project, state: State): Province[] => p.provinces.filter(x => x.stateId === state.id)

/** strength per state and unit type */
export const militaryTotals = computed(() => {
  const p = project.value
  const out = new Map<string, Record<string, number>>()
  for (const regiment of p.regiments) {
    const key = regiment.stateId || ''
    const totals = out.get(key) ?? {}
    for (const [unit, count] of Object.entries(regiment.units)) totals[unit] = (totals[unit] ?? 0) + (count || 0)
    out.set(key, totals)
  }
  return out
})
