// The timeline: the world in a year, and edits written back as dated changes.
// Run with `npm test` (Node 22 runs the TypeScript directly).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveWorld, record, removeFromProject, changeYears, happeningsIn, moveChange, entityAt } from '../web/model/timeline.ts'

test('timeline: resolve, record, remove', () => {
const empty = { states: [], provinces: [], cultures: [], religions: [], zones: [], institutions: [], cities: [], routes: [], rivers: [], labels: [], markers: [], regiments: [], diplomacy: {}, diplomacyHistory: [], events: [], view: { center: [0, 0], zoom: 1 } } as any
const state = (id: string, extra = {}) => ({ id, name: id, description: '', note: '', color: '#000', geometry: null, clip: true, fullName: '', form: '', capitalId: '', ruralDensity: 10, cultureId: '', religionId: '', ...extra })
const prov = (id: string, stateId: string, extra = {}) => ({ id, name: id, description: '', note: '', color: '#000', geometry: null, clip: true, stateId, form: '', capitalId: '', ruralDensity: null, ...extra })

let raw: any = { ...empty, timeline: { start: 1000, end: 1500, unit: '', eras: [] }, states: [state('A'), state('B', { begin: 1100, end: 1300 })], provinces: [prov('p1', 'A')] }

// no timeline: the project is its own world, edits pass through
const plain = { ...raw, timeline: null }
assert.equal(resolveWorld(plain, 1200), plain)
assert.equal(record(plain, plain, { ...plain, name: 'x' }, 1200).name, 'x')

// existence
let w = resolveWorld(raw, 1050)
assert.deepEqual(w.states.map((s: any) => s.id), ['A'])
w = resolveWorld(raw, 1100)
assert.deepEqual(w.states.map((s: any) => s.id), ['A', 'B'])
assert.deepEqual(resolveWorld(raw, 1300).states.map((s: any) => s.id), ['A'])

// edit in 1200: province changes owner → a change in 1200, base untouched
w = resolveWorld(raw, 1200)
let next = { ...w, provinces: w.provinces.map((p: any) => ({ ...p, stateId: 'B' })) }
raw = record(raw, w, next, 1200)
assert.equal(raw.provinces[0].stateId, 'A')
assert.deepEqual(raw.provinces[0].history, [{ year: 1200, set: { stateId: 'B' } }])
assert.equal(resolveWorld(raw, 1199).provinces[0].stateId, 'A')
assert.equal(resolveWorld(raw, 1200).provinces[0].stateId, 'B')
assert.equal(resolveWorld(raw, 1450).provinces[0].stateId, 'B')

// edit in 1300: back to A → second change
w = resolveWorld(raw, 1300)
raw = record(raw, w, { ...w, provinces: w.provinces.map((p: any) => ({ ...p, stateId: 'A' })) }, 1300)
assert.equal(raw.provinces[0].history.length, 2)
assert.equal(resolveWorld(raw, 1350).provinces[0].stateId, 'A')

// editing 1200 back to the earlier value removes that change (pruning); 1300 stays
w = resolveWorld(raw, 1200)
raw = record(raw, w, { ...w, provinces: w.provinces.map((p: any) => ({ ...p, stateId: 'A' })) }, 1200)
assert.deepEqual(raw.provinces[0].history.map((c: any) => c.year), [1300])
assert.deepEqual(raw.provinces[0].history[0].set, { stateId: 'A' })

// edit at the start year goes into the base, and drops earlier changes of that field
w = resolveWorld(raw, 1000)
raw = record(raw, w, { ...w, provinces: w.provinces.map((p: any) => ({ ...p, name: 'Nordmark' })) }, 1000)
assert.equal(raw.provinces[0].name, 'Nordmark')
assert.deepEqual(raw.provinces[0].history.map((c: any) => c.year), [1300])

// an element shown in 1200 but begun in 1100: editing in 1100 writes its base
w = resolveWorld(raw, 1100)
raw = record(raw, w, { ...w, states: w.states.map((s: any) => (s.id === 'B' ? { ...s, color: '#fff' } : s)) }, 1100)
assert.equal(raw.states[1].color, '#fff')
assert.equal(raw.states[1].history, undefined)

// unchanged elements keep their object across years and edits elsewhere
const a1 = resolveWorld(raw, 1150).states[0]
const a2 = resolveWorld(raw, 1250).states[0]
assert.equal(a1, a2)
const p1 = resolveWorld(raw, 1310).provinces[0]
const p2 = resolveWorld(raw, 1400).provinces[0]
assert.equal(p1, p2)

// a new element added in 1250 begins there
w = resolveWorld(raw, 1250)
raw = record(raw, w, { ...w, states: [...w.states, state('C')] }, 1250)
assert.equal(raw.states[2].begin, 1250)
assert.equal(resolveWorld(raw, 1249).states.some((s: any) => s.id === 'C'), false)

// begin/end are written as they are, never as a change
w = resolveWorld(raw, 1250)
raw = record(raw, w, { ...w, states: w.states.map((s: any) => (s.id === 'C' ? { ...s, end: 1400 } : s)) }, 1250)
assert.equal(raw.states[2].end, 1400)
assert.equal(raw.states[2].history, undefined)
w = resolveWorld(raw, 1250)
raw = record(raw, w, { ...w, states: w.states.map((s: any) => (s.id === 'C' ? (({ end, ...rest }) => rest)(s) : s)) }, 1250)
assert.equal('end' in raw.states[2], false)

// removing in a world removes for good
w = resolveWorld(raw, 1250)
raw = record(raw, w, { ...w, states: w.states.filter((s: any) => s.id !== 'C') }, 1250)
assert.equal(raw.states.length, 2)

// diplomacy over time
w = resolveWorld(raw, 1000)
raw = record(raw, w, { ...w, diplomacy: { 'A>B': 'ally', 'B>A': 'ally' } }, 1000)
assert.deepEqual(raw.diplomacy, { 'A>B': 'ally', 'B>A': 'ally' })
w = resolveWorld(raw, 1250)
raw = record(raw, w, { ...w, diplomacy: { 'A>B': 'war', 'B>A': 'war' } }, 1250)
assert.deepEqual(raw.diplomacy, { 'A>B': 'ally', 'B>A': 'ally' })
assert.deepEqual(raw.diplomacyHistory, [{ year: 1250, set: { 'A>B': 'war', 'B>A': 'war' } }])
assert.equal(resolveWorld(raw, 1249).diplomacy['A>B'], 'ally')
assert.equal(resolveWorld(raw, 1260).diplomacy['A>B'], 'war')
w = resolveWorld(raw, 1280)
raw = record(raw, w, { ...w, diplomacy: {} }, 1280)
assert.deepEqual(resolveWorld(raw, 1290).diplomacy, {})
assert.deepEqual(raw.diplomacyHistory[1], { year: 1280, set: { 'A>B': '', 'B>A': '' } })

// removal of a state scrubs references in base, history and diplomacy
raw = removeFromProject(raw, 'state', 'B')
assert.deepEqual(raw.states.map((s: any) => s.id), ['A'])
assert.deepEqual(raw.diplomacy, {})
assert.deepEqual(raw.diplomacyHistory, [])
assert.equal(raw.provinces[0].stateId, 'A')

// city removal clears capital references inside changes
raw = { ...raw, cities: [{ id: 'c1', name: 'c1', geometry: { type: 'Point', coordinates: [0, 0] } }], states: [{ ...raw.states[0], history: [{ year: 1200, set: { capitalId: 'c1' } }] }] }
raw = removeFromProject(raw, 'city', 'c1')
assert.equal(raw.states[0].history[0].set.capitalId, '')

// route junctions: an element drops the field, a change keeps it emptied
raw = { ...raw, routes: [{ id: 'r1' }, { id: 'r2', junctions: { start: 'r1' }, history: [{ year: 1200, set: { junctions: { end: 'r1' } } }] }] }
raw = removeFromProject(raw, 'route', 'r1')
assert.equal(raw.routes[0].junctions, undefined)
assert.equal(raw.routes[0].history[0].set.junctions, null)

// moving and listing changes
const moved = moveChange({ id: 'x', history: [{ year: 1100, set: { a: 1 } }, { year: 1200, set: { b: 2 } }] } as any, 1100, 1300)
assert.deepEqual(moved.history.map((c: any) => c.year), [1200, 1300])
const merged = moveChange({ id: 'x', history: [{ year: 1100, set: { a: 1 } }, { year: 1200, set: { b: 2 } }] } as any, 1100, 1200)
assert.deepEqual(merged.history, [{ year: 1200, set: { b: 2, a: 1 } }])
assert.equal(entityAt({ id: 'x', a: 0, history: [{ year: 5, set: { a: 1 } }] } as any, 6).a, 1)
assert.deepEqual(changeYears(raw), [1200, 1300])
assert.equal(happeningsIn(raw, 1200).length, 2)
})
