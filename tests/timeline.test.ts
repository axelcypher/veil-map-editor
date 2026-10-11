// The timeline: the world in a year and strand, and edits written back as dated changes.
// Run with `npm test` (Node 22 runs the TypeScript directly).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  changeToStrand, changeYears, compareViews, copyElement, elementToStrand, entityAt, happeningsIn, migrateTimeline, moveChange, reckoningOf, record,
  removeFromProject, removeStrandFromProject, resolveWorld, setVisibility, GHOSTS,
} from '../web/model/timeline.ts'

const empty = { states: [], provinces: [], cultures: [], religions: [], zones: [], institutions: [], cities: [], routes: [], rivers: [], labels: [], markers: [], regiments: [], diplomacy: {}, diplomacyHistory: [], events: [], view: { center: [0, 0], zoom: 1 } } as any
const state = (id: string, extra = {}) => ({ id, name: id, description: '', note: '', color: '#000', geometry: null, clip: true, fullName: '', form: '', capitalId: '', ruralDensity: 10, cultureId: '', religionId: '', ...extra })
const prov = (id: string, stateId: string, extra = {}) => ({ id, name: id, description: '', note: '', color: '#000', geometry: null, clip: true, stateId, form: '', capitalId: '', ruralDensity: null, ...extra })
const single = (start: number, end: number) => ({ strands: [{ id: 'main', name: 'Haupt', color: '', parent: null, inherit: 'all', zero: 0, unit: '', start, end, eras: [] }], milestones: [], current: null })
const ids = (list: any[]) => list.map(x => x.id)

test('one strand: resolve, record, remove', () => {
  let raw: any = { ...empty, timeline: single(1000, 1500), states: [state('A'), state('B', { begin: 1100, end: 1300 })], provinces: [prov('p1', 'A')] }

  // no timeline: the project is its own world, edits pass through
  const plain = { ...raw, timeline: null }
  assert.equal(resolveWorld(plain, 1200), plain)
  assert.equal(record(plain, plain, { ...plain, name: 'x' }, 1200).name, 'x')

  // existence
  assert.deepEqual(ids(resolveWorld(raw, 1050).states), ['A'])
  assert.deepEqual(ids(resolveWorld(raw, 1100).states), ['A', 'B'])
  assert.deepEqual(ids(resolveWorld(raw, 1300).states), ['A'])

  // edit in 1200: province changes owner → a change in 1200, base untouched
  let w = resolveWorld(raw, 1200)
  raw = record(raw, w, { ...w, provinces: w.provinces.map((p: any) => ({ ...p, stateId: 'B' })) }, 1200)
  assert.equal(raw.provinces[0].stateId, 'A')
  assert.deepEqual(raw.provinces[0].history, [{ year: 1200, set: { stateId: 'B' } }])
  assert.equal(resolveWorld(raw, 1199).provinces[0].stateId, 'A')
  assert.equal(resolveWorld(raw, 1450).provinces[0].stateId, 'B')

  // edit in 1300: back to A → second change
  w = resolveWorld(raw, 1300)
  raw = record(raw, w, { ...w, provinces: w.provinces.map((p: any) => ({ ...p, stateId: 'A' })) }, 1300)
  assert.equal(raw.provinces[0].history.length, 2)

  // editing 1200 back to the earlier value removes that change (pruning); 1300 stays
  w = resolveWorld(raw, 1200)
  raw = record(raw, w, { ...w, provinces: w.provinces.map((p: any) => ({ ...p, stateId: 'A' })) }, 1200)
  assert.deepEqual(raw.provinces[0].history.map((c: any) => c.year), [1300])

  // edit at the start year goes into the base
  w = resolveWorld(raw, 1000)
  raw = record(raw, w, { ...w, provinces: w.provinces.map((p: any) => ({ ...p, name: 'Nordmark' })) }, 1000)
  assert.equal(raw.provinces[0].name, 'Nordmark')

  // an element begun in 1100: editing in 1100 writes its base
  w = resolveWorld(raw, 1100)
  raw = record(raw, w, { ...w, states: w.states.map((s: any) => (s.id === 'B' ? { ...s, color: '#fff' } : s)) }, 1100)
  assert.equal(raw.states[1].color, '#fff')
  assert.equal(raw.states[1].history, undefined)

  // unchanged elements keep their object across years
  assert.equal(resolveWorld(raw, 1150).states[0], resolveWorld(raw, 1250).states[0])
  assert.equal(resolveWorld(raw, 1310).provinces[0], resolveWorld(raw, 1400).provinces[0])

  // a new element added in 1250 begins there; begin/end are written as they are
  w = resolveWorld(raw, 1250)
  raw = record(raw, w, { ...w, states: [...w.states, state('C')] }, 1250)
  assert.equal(raw.states[2].begin, 1250)
  w = resolveWorld(raw, 1250)
  raw = record(raw, w, { ...w, states: w.states.map((s: any) => (s.id === 'C' ? { ...s, end: 1400 } : s)) }, 1250)
  assert.equal(raw.states[2].end, 1400)
  assert.equal(raw.states[2].history, undefined)

  // removing in a world removes an own element for good
  w = resolveWorld(raw, 1250)
  raw = record(raw, w, { ...w, states: w.states.filter((s: any) => s.id !== 'C') }, 1250)
  assert.equal(raw.states.length, 2)

  // diplomacy over time
  w = resolveWorld(raw, 1000)
  raw = record(raw, w, { ...w, diplomacy: { 'A>B': 'ally', 'B>A': 'ally' } }, 1000)
  assert.deepEqual(raw.diplomacy, { 'A>B': 'ally', 'B>A': 'ally' })
  w = resolveWorld(raw, 1250)
  raw = record(raw, w, { ...w, diplomacy: { 'A>B': 'war', 'B>A': 'war' } }, 1250)
  assert.deepEqual(raw.diplomacyHistory, [{ year: 1250, set: { 'A>B': 'war', 'B>A': 'war' } }])
  assert.equal(resolveWorld(raw, 1260).diplomacy['A>B'], 'war')
  w = resolveWorld(raw, 1280)
  raw = record(raw, w, { ...w, diplomacy: {} }, 1280)
  assert.deepEqual(resolveWorld(raw, 1290).diplomacy, {})

  // removal of a state scrubs references in base, history and diplomacy
  raw = removeFromProject(raw, 'state', 'B')
  assert.deepEqual(raw.diplomacy, {})
  assert.deepEqual(raw.diplomacyHistory, [])

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
  const moved = moveChange({ id: 'x', history: [{ year: 1100, set: { a: 1 } }, { year: 1200, set: { b: 2 } }] } as any, { year: 1100 }, 1300)
  assert.deepEqual(moved.history.map((c: any) => c.year), [1200, 1300])
  const merged = moveChange({ id: 'x', history: [{ year: 1100, set: { a: 1 } }, { year: 1200, set: { b: 2 } }] } as any, { year: 1100 }, 1200)
  assert.deepEqual(merged.history, [{ year: 1200, set: { b: 2, a: 1 } }])
  assert.equal(entityAt({ id: 'x', a: 0, history: [{ year: 5, set: { a: 1 } }] } as any, 6).a, 1)
  assert.deepEqual(changeYears(raw), [1200, 1300])
  assert.equal(happeningsIn(raw, 1200).length, 2)
})

test('an old timeline becomes one base strand', () => {
  const t = migrateTimeline({ start: 0, end: 900, unit: 'n. Ü.', eras: [{ id: 'e', name: 'E', start: 10, color: '#fff' }] })!
  assert.equal(t.strands.length, 1)
  assert.equal(t.strands[0].parent, null)
  assert.equal(t.strands[0].end, 900)
  assert.equal(t.strands[0].unit, 'n. Ü.')
  assert.equal(migrateTimeline(null), null)
  // a timeline with strands stays as it is
  assert.equal(migrateTimeline(t)!.strands, t.strands)
})

// Hauptkanon (base) → Leserkanon (released only, year 0 = base −30000) → Parallelkanon (inherits all)
const strands = () => ({
  strands: [
    { id: 'haupt', name: 'Hauptkanon', color: '', parent: null, inherit: 'all', zero: 0, unit: 'n. P.', start: -40000, end: 1000, eras: [{ id: 'e1', name: 'Alt', start: -40000, color: '' }] },
    { id: 'leser', name: 'Leserkanon', color: '', parent: 'haupt', inherit: 'released', zero: -30000, unit: 'n. B.', start: 0, end: 30500, eras: [] },
    { id: 'para', name: 'Parallelkanon', color: '', parent: 'leser', inherit: 'all', zero: null, unit: null, start: null, end: null, eras: [] },
  ],
  milestones: [{ id: 'm1', name: 'Folge 1', description: '' }, { id: 'm2', name: 'Folge 2', description: '' }],
  current: null,
})
const H = { strand: 'haupt' }
const L = { strand: 'leser' }
const P = { strand: 'para' }

test('strands: reckoning', () => {
  const t = strands() as any
  const r = reckoningOf(t, 'leser')
  assert.equal(r.zero, -30000)
  assert.equal(r.start, -30000)
  assert.equal(r.end, 500)
  assert.equal(r.unit, 'n. B.')
  // the parallel strand counts like the reader's
  const p = reckoningOf(t, 'para')
  assert.equal(p.zero, -30000)
  assert.equal(p.end, 500)
  // inherited eras keep their place in time
  assert.equal(r.eras[0].start, -10000)
})

test('strands: release, deviate, hide, own entries', () => {
  let raw: any = { ...empty, timeline: strands(), states: [state('A'), state('B')], provinces: [prov('p1', 'A')] }
  const Y = -29000

  // the reader's strand shows only what is released; the parallel one inherits from it
  assert.deepEqual(ids(resolveWorld(raw, Y, H).states), ['A', 'B'])
  assert.deepEqual(ids(resolveWorld(raw, Y, L).states), [])
  assert.deepEqual(ids(resolveWorld(raw, Y, P).states), [])
  raw = { ...raw, states: raw.states.map((s: any) => (s.id === 'A' ? setVisibility(s, 'leser', { show: true }) : s)) }
  assert.deepEqual(ids(resolveWorld(raw, Y, L).states), ['A'])
  assert.deepEqual(ids(resolveWorld(raw, Y, P).states), ['A'])

  // a change in the truth shows below only once it is released itself
  let w = resolveWorld(raw, -28000, H)
  raw = record(raw, w, { ...w, states: w.states.map((s: any) => (s.id === 'A' ? { ...s, name: 'Wahres Reich' } : s)) }, -28000, H)
  assert.equal(resolveWorld(raw, -27000, H).states[0].name, 'Wahres Reich')
  assert.equal(resolveWorld(raw, -27000, L).states[0].name, 'A')
  raw = { ...raw, states: raw.states.map((s: any) => (s.id === 'A' ? { ...s, history: s.history.map((c: any) => setVisibility(c, 'leser', { show: true })) } : s)) }
  assert.equal(resolveWorld(raw, -27000, L).states[0].name, 'Wahres Reich')
  assert.equal(resolveWorld(raw, -27000, P).states[0].name, 'Wahres Reich')

  // an edit in the reader's strand is a deviation there (and below), the truth stays
  w = resolveWorld(raw, -27000, L)
  raw = record(raw, w, { ...w, states: w.states.map((s: any) => ({ ...s, name: 'Offizielles Reich' })) }, -27000, L)
  const a = raw.states.find((s: any) => s.id === 'A')
  assert.deepEqual(a.history.at(-1), { year: -27000, set: { name: 'Offizielles Reich' }, strand: 'leser' })
  assert.equal(resolveWorld(raw, -26000, H).states[0].name, 'Wahres Reich')
  assert.equal(resolveWorld(raw, -26000, L).states[0].name, 'Offizielles Reich')
  assert.equal(resolveWorld(raw, -26000, P).states[0].name, 'Offizielles Reich')
  // in the same year as a truth change, the deviation wins
  w = resolveWorld(raw, -28000, L)
  raw = record(raw, w, { ...w, states: w.states.map((s: any) => ({ ...s, name: 'Gleichjahr' })) }, -28000, L)
  assert.equal(resolveWorld(raw, -28000, L).states[0].name, 'Gleichjahr')
  assert.equal(resolveWorld(raw, -28000, H).states[0].name, 'Wahres Reich')

  // own elements of the parallel strand: not in the reader's strand nor the truth
  w = resolveWorld(raw, -26000, P)
  raw = record(raw, w, { ...w, states: [...w.states, state('S')] }, -26000, P)
  const s = raw.states.find((x: any) => x.id === 'S')
  assert.equal(s.strand, 'para')
  assert.equal(s.begin, -26000)
  assert.ok(ids(resolveWorld(raw, -25000, P).states).includes('S'))
  assert.ok(!ids(resolveWorld(raw, -25000, L).states).includes('S'))
  assert.ok(!ids(resolveWorld(raw, -25000, H).states).includes('S'))

  // removing an inherited element in the parallel strand hides it there only
  w = resolveWorld(raw, -25000, P)
  raw = record(raw, w, { ...w, states: w.states.filter((x: any) => x.id !== 'A') }, -25000, P)
  assert.ok(raw.states.some((x: any) => x.id === 'A'))
  assert.ok(!ids(resolveWorld(raw, -25000, P).states).includes('A'))
  assert.ok(ids(resolveWorld(raw, -25000, L).states).includes('A'))

  // a deviating begin in the reader's strand
  w = resolveWorld(raw, -25000, L)
  raw = record(raw, w, { ...w, states: w.states.map((x: any) => (x.id === 'A' ? { ...x, begin: -26500 } : x)) }, -25000, L)
  assert.deepEqual(raw.states.find((x: any) => x.id === 'A').life, { leser: { begin: -26500, end: null } })
  assert.ok(!ids(resolveWorld(raw, -27000, L).states).includes('A'))
  assert.ok(ids(resolveWorld(raw, -27000, H).states).includes('A'))

  // what the reader's strand holds back shows as ghost when asked
  const ghosts = (resolveWorld(raw, -25000, L, true) as any)[GHOSTS]
  assert.deepEqual(ids(ghosts.states), ['B'])

  // diplomacy: the first relations follow their states, deviations stay in their strand
  raw = { ...raw, states: raw.states.map((x: any) => (x.id === 'B' ? setVisibility(x, 'leser', { show: true }) : x)), diplomacy: { 'A>B': 'ally', 'B>A': 'ally' } }
  w = resolveWorld(raw, -24000, L)
  assert.equal(w.diplomacy['A>B'], 'ally')
  raw = record(raw, w, { ...w, diplomacy: { 'A>B': 'war', 'B>A': 'war' } }, -24000, L)
  assert.equal(resolveWorld(raw, -23000, L).diplomacy['A>B'], 'war')
  assert.equal(resolveWorld(raw, -23000, H).diplomacy['A>B'], 'ally')

  // comparing the truth with the reader's strand
  const diff = compareViews(raw, -26000, H, L)
  assert.ok(diff.some(d => d.id === 'A' && d.what === 'changed' && d.fields.includes('name')))
  assert.ok(!diff.some(d => d.id === 'B'))

  // a strand goes with its own entries and what was said about it
  raw = removeStrandFromProject(raw, 'para')
  assert.ok(!raw.states.some((x: any) => x.id === 'S'))
  assert.ok(!raw.states.some((x: any) => x.visibility?.para))
  assert.equal(raw.timeline.strands.length, 2)
  // the reader's strand has a child no more, but the base cannot go
  assert.equal(removeStrandFromProject(raw, 'haupt'), raw)
})

test('strands: milestones', () => {
  const base: any = { ...empty, timeline: strands(), states: [setVisibility(state('A'), 'leser', { show: true, from: 'm2' })] }
  // released from milestone 2 on
  assert.deepEqual(ids(resolveWorld(base, -29000, { strand: 'leser', milestone: 'm1' }).states), [])
  assert.deepEqual(ids(resolveWorld(base, -29000, { strand: 'leser', milestone: 'm2' }).states), ['A'])
  // a falsification until milestone 2: corrected afterwards
  const raw = { ...base, states: [{ ...base.states[0], history: [{ year: -29000, set: { name: 'Lüge' }, strand: 'leser', until: 'm2' }] }] }
  assert.equal(resolveWorld(raw, -28000, { strand: 'leser', milestone: 'm2' }).states[0].name, 'A')
  const early = { ...raw, states: [setVisibility(raw.states[0], 'leser', { show: true })] }
  assert.equal(resolveWorld(early, -28000, { strand: 'leser', milestone: 'm1' }).states[0].name, 'Lüge')
  assert.equal(resolveWorld(early, -28000, { strand: 'leser', milestone: 'm2' }).states[0].name, 'A')
  // the timeline's current milestone is the default
  const now = { ...early, timeline: { ...early.timeline, current: 'm1' } }
  assert.equal(resolveWorld(now, -28000, { strand: 'leser' }).states[0].name, 'Lüge')
})

test('strands: moving and copying entries', () => {
  const t = strands() as any
  const element = { ...state('X', { strand: 'para' }), history: [{ year: 5, set: { name: 'Y' }, strand: 'para' }, { year: 6, set: { name: 'Z' }, strand: 'leser' }] } as any
  const moved = elementToStrand(t, element, 'haupt')
  assert.equal(moved.strand, undefined)
  assert.deepEqual(moved.history.map((c: any) => c.strand), [undefined, 'leser'])
  const copy = copyElement(t, element, 'leser', 'X2')
  assert.equal(copy.id, 'X2')
  assert.equal(copy.strand, 'leser')
  assert.deepEqual(copy.history, [{ year: 5, set: { name: 'Y' }, strand: 'leser' }])
  const change = changeToStrand(t, element, { year: 5, strand: 'para' }, 'haupt', false)
  assert.deepEqual(change.history.map((c: any) => [c.year, c.strand]), [[5, undefined], [6, 'leser']])
  const copied = changeToStrand(t, element, { year: 5, strand: 'para' }, 'haupt', true)
  assert.equal(copied.history.length, 3)
  // the strand's own change in that year takes it in
  const into = changeToStrand(t, element, { year: 6, strand: 'leser' }, 'para', false)
  assert.equal(into.history.length, 2)
})

test('strands: releasing', async () => {
  const { heldIn, releaseElement, releaseEvent, releaseYear, holdEntry, showEntry } = await import('../web/model/timeline.ts')
  let raw: any = {
    ...empty,
    timeline: strands(),
    states: [state('A', { history: [{ year: -28000, set: { name: 'A2' }, event: 'ev' }, { year: -27000, set: { name: 'A3' } }] }), state('B', { begin: -26000 })],
    diplomacyHistory: [{ year: -26000, set: { 'A>B': 'war' } }],
    events: [{ id: 'ev', name: 'Krieg', year: -28000, until: null, type: '', description: '', note: '', refs: [] }],
  }
  // the reader's strand holds everything back
  assert.deepEqual(heldIn(raw, L, -26000).map(h => h.type).sort(), ['element', 'relation'])
  // an element with its history up to a year
  raw = releaseElement(raw, L, 'A', -27500)
  let w = resolveWorld(raw, -26500, L)
  assert.equal(w.states[0].name, 'A2')
  // the event with its changes
  raw = releaseEvent(raw, L, 'ev')
  assert.equal(resolveWorld(raw, -28000, L).events.length, 1)
  // a whole year
  raw = releaseYear(raw, L, -26000)
  w = resolveWorld(raw, -26000, L)
  assert.deepEqual(ids(w.states), ['A', 'B'])
  assert.equal(w.diplomacy['A>B'], 'war')
  assert.equal(w.states[0].name, 'A2')
  assert.equal(heldIn(raw, L, -26000).length, 0)
  // the parallel strand sees what the reader's sees; holding back there hides
  assert.deepEqual(ids(resolveWorld(raw, -26000, P).states), ['A', 'B'])
  const t = raw.timeline
  const hidden = holdEntry(t, raw.states[1], 'para')
  assert.deepEqual(hidden.visibility.para, { show: false })
  assert.equal(showEntry(t, hidden, 'para').visibility?.para, undefined)
  assert.equal(holdEntry(t, raw.states[1], 'leser').visibility?.leser, undefined)
})
