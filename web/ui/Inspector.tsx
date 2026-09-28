// Properties of the selected element.
import { useEffect, useState } from 'preact/hooks'
import { exclusiveAreas, fitProvinceToState, isArea } from '../model/actions'
import { cityMembership, cultureStats, provinceStats, religionStats, stateStats, type AreaStats } from '../model/derive'
import { formatInt, formatKm, formatKm2, formatLonLat, lineLengthM } from '../model/geo'
import { KIND_NAMES } from '../model/project'
import { notify, patchProject, project, removeEntity, selectedEntity, selection, tool, updateEntity } from '../model/store'
import { koppenAt } from '../model/terrain'
import type { AreaBase, City, Culture, Entity, EntityKind, Label, Marker, Province, Regiment, Religion, River, Route, State, Zone, ZonePattern } from '../model/types'
import { platform } from '../platform'
import { regimentTotal } from '../map/styles'
import { mapView } from './mapRef'
import { NoteLink, NotePicker } from './NoteLink'
import { obsidianUrl } from '../model/obsidian'
import { Check, Color, Field, Num, Section, Select, Text } from './components'

function useUpdate<K extends EntityKind>(kind: K, id: string) {
  return (patch: Partial<Entity>, merge?: string) => updateEntity(kind, id, patch as never, merge)
}

function StatsBlock({ stats }: { stats: AreaStats | undefined }) {
  if (!stats) return null
  return (
    <dl class="stats">
      <dt>Landfläche</dt>
      <dd>{formatKm2(stats.areaKm2)}</dd>
      <dt>Städte</dt>
      <dd>{stats.cities.length}</dd>
      <dt>Stadtbevölkerung</dt>
      <dd>{formatInt(stats.urban)}</dd>
      <dt>Landbevölkerung</dt>
      <dd>{formatInt(stats.rural)}</dd>
      <dt>Gesamt</dt>
      <dd>
        <strong>{formatInt(stats.urban + stats.rural)}</strong>
      </dd>
    </dl>
  )
}

function AreaTools({ kind, entity }: { kind: EntityKind; entity: AreaBase }) {
  if (!isArea(kind)) return null
  const t = tool.value
  const active = (id: string) => ('entityId' in t && t.entityId === entity.id && t.id === id ? 'active' : '')
  const set = (id: 'area-add' | 'area-subtract' | 'area-island') => (tool.value = t.id === id && 'entityId' in t && t.entityId === entity.id ? { id: 'select' } : { id, kind, entityId: entity.id })
  return (
    <Section title="Fläche">
      <div class="button-grid">
        <button class={active('area-add')} onClick={() => set('area-add')} title="Polygon zeichnen und hinzufügen; Umschalt gedrückt halten zum Freihandzeichnen">
          ＋ Fläche zeichnen
        </button>
        <button class={active('area-subtract')} onClick={() => set('area-subtract')} title="Polygon zeichnen und abziehen">
          − Fläche abziehen
        </button>
        <button class={active('area-island')} onClick={() => set('area-island')} title="Auf eine Insel klicken, um sie ganz hinzuzufügen">
          ⛰ Insel hinzufügen
        </button>
        <button class={t.id === 'vertices' ? 'active' : ''} onClick={() => (tool.value = t.id === 'vertices' ? { id: 'select' } : { id: 'vertices' })} title="Stützpunkte ziehen; Alt+Klick löscht einen Punkt">
          ✎ Stützpunkte
        </button>
      </div>
      <p class="hint">Zeichnen: Klicks setzen Punkte, Doppelklick schließt. Mit gedrückter Umschalttaste freihand.</p>
      <Check checked={entity.clip} onChange={clip => updateEntity(kind, entity.id, { clip } as never)} label="An der Küste zuschneiden" />
      {(kind === 'state' || kind === 'province') && <Check checked={exclusiveAreas.value} onChange={v => (exclusiveAreas.value = v)} label={kind === 'state' ? 'Nachbarstaaten ausschneiden' : 'Nachbarprovinzen ausschneiden'} />}
      {kind === 'province' && <button onClick={() => fitProvinceToState(entity.id)}>An Staatsgebiet anpassen</button>}
      {entity.geometry && <button onClick={() => updateEntity(kind, entity.id, { geometry: null } as never)}>Fläche leeren</button>}
    </Section>
  )
}

const typeOptions = (list: { id: string; name: string }[]) => list.map(t => ({ id: t.id, name: t.name }))

function StateFields({ s }: { s: State }) {
  const p = project.value
  const up = useUpdate('state', s.id)
  const stats = stateStats.value.get(s.id)
  const members = cityMembership.value
  const cities = p.cities.filter(c => members.get(c.id)?.state === s.id)
  return (
    <>
      <Field label="Voller Name">
        <Text value={s.fullName} onInput={v => up({ fullName: v } as Partial<State>, 'fullName')} placeholder="z. B. Königreich von …" />
      </Field>
      <Field label="Staatsform">
        <Select value={s.form} onChange={v => up({ form: v } as Partial<State>)} options={typeOptions(p.catalog.stateForms)} empty="—" />
      </Field>
      <Field label="Hauptstadt">
        <Select value={s.capitalId} onChange={v => up({ capitalId: v } as Partial<State>)} options={cities.map(c => ({ id: c.id, name: c.name }))} empty="—" />
      </Field>
      <Field label="Kultur">
        <Select value={s.cultureId} onChange={v => up({ cultureId: v } as Partial<State>)} options={typeOptions(p.cultures)} empty="—" />
      </Field>
      <Field label="Religion">
        <Select value={s.religionId} onChange={v => up({ religionId: v } as Partial<State>)} options={typeOptions(p.religions)} empty="—" />
      </Field>
      <Field label="Landbevölkerung" hint="Einwohner je km² außerhalb der Städte">
        <Num value={s.ruralDensity} min={0} onChange={v => up({ ruralDensity: v } as Partial<State>, 'density')} />
      </Field>
      <StatsBlock stats={stats} />
      <button
        onClick={() => patchProject({ display: { ...p.display, diplomacyFocus: p.display.diplomacyFocus === s.id ? '' : s.id } })}
        class={p.display.diplomacyFocus === s.id ? 'active' : ''}
      >
        Diplomatie aus Sicht dieses Staates
      </button>
    </>
  )
}

function ProvinceFields({ x }: { x: Province }) {
  const p = project.value
  const up = useUpdate('province', x.id)
  const members = cityMembership.value
  return (
    <>
      <Field label="Staat">
        <Select value={x.stateId} onChange={v => up({ stateId: v } as Partial<Province>)} options={typeOptions(p.states)} empty="—" />
      </Field>
      <Field label="Bezeichnung">
        <Text value={x.form} onInput={v => up({ form: v } as Partial<Province>, 'form')} placeholder="Provinz, Grafschaft, Mark …" />
      </Field>
      <Field label="Hauptort">
        <Select value={x.capitalId} onChange={v => up({ capitalId: v } as Partial<Province>)} options={p.cities.filter(c => members.get(c.id)?.province === x.id).map(c => ({ id: c.id, name: c.name }))} empty="—" />
      </Field>
      <Field label="Landbevölkerung" hint="Einwohner je km²; leer = Wert des Staates">
        <Num value={x.ruralDensity} min={0} onChange={v => up({ ruralDensity: v } as Partial<Province>, 'density')} placeholder="wie Staat" />
      </Field>
      <StatsBlock stats={provinceStats.value.get(x.id)} />
    </>
  )
}

function Origins({ value, options, onChange }: { value: string[]; options: { id: string; name: string }[]; onChange: (v: string[]) => void }) {
  if (!options.length) return <span class="muted">keine anderen vorhanden</span>
  return (
    <div class="chips">
      {options.map(o => (
        <label key={o.id} class={`chip${value.includes(o.id) ? ' on' : ''}`}>
          <input type="checkbox" checked={value.includes(o.id)} onChange={e => onChange((e.target as HTMLInputElement).checked ? [...value, o.id] : value.filter(v => v !== o.id))} />
          {o.name}
        </label>
      ))}
    </div>
  )
}

function CultureFields({ x }: { x: Culture }) {
  const p = project.value
  const up = useUpdate('culture', x.id)
  return (
    <>
      <Field label="Typ">
        <Select value={x.type} onChange={v => up({ type: v } as Partial<Culture>)} options={typeOptions(p.catalog.cultureTypes)} />
      </Field>
      <Field label="Herkunft" wide>
        <Origins value={x.origins} options={p.cultures.filter(c => c.id !== x.id)} onChange={v => up({ origins: v } as Partial<Culture>)} />
      </Field>
      <StatsBlock stats={cultureStats.value.get(x.id)} />
    </>
  )
}

function ReligionFields({ x }: { x: Religion }) {
  const p = project.value
  const up = useUpdate('religion', x.id)
  return (
    <>
      <Field label="Typ">
        <Select value={x.type} onChange={v => up({ type: v } as Partial<Religion>)} options={typeOptions(p.catalog.religionTypes)} />
      </Field>
      <Field label="Form">
        <Text value={x.form} onInput={v => up({ form: v } as Partial<Religion>, 'form')} placeholder="Monotheismus, Ahnenkult …" />
      </Field>
      <Field label="Gottheit">
        <Text value={x.deity} onInput={v => up({ deity: v } as Partial<Religion>, 'deity')} />
      </Field>
      <Field label="Herkunft" wide>
        <Origins value={x.origins} options={p.religions.filter(c => c.id !== x.id)} onChange={v => up({ origins: v } as Partial<Religion>)} />
      </Field>
      <StatsBlock stats={religionStats.value.get(x.id)} />
    </>
  )
}

function ZoneFields({ x }: { x: Zone }) {
  const p = project.value
  const up = useUpdate('zone', x.id)
  const patterns: { id: ZonePattern; name: string }[] = [
    { id: 'hatch', name: 'Schraffur' },
    { id: 'cross', name: 'Kreuzschraffur' },
    { id: 'dots', name: 'Punkte' },
    { id: 'fill', name: 'Fläche' },
  ]
  return (
    <>
      <Field label="Typ">
        <Select
          value={x.type}
          onChange={v => {
            const type = p.catalog.zoneTypes.find(t => t.id === v)
            up({ type: v, ...(type ? { color: type.color, pattern: type.pattern } : {}) } as Partial<Zone>)
          }}
          options={typeOptions(p.catalog.zoneTypes)}
        />
      </Field>
      <Field label="Muster">
        <Select value={x.pattern} onChange={v => up({ pattern: v } as Partial<Zone>)} options={patterns} />
      </Field>
      <Field label="Deckkraft">
        <Num value={x.opacity} min={0} max={1} step={0.05} onChange={v => up({ opacity: v } as Partial<Zone>, 'opacity')} />
      </Field>
    </>
  )
}

function hashSeed(text: string) {
  let h = 2166136261
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
  return Math.abs(h) % 1_000_000_000
}

/** the city plan generator by watabou, with the city's features as parameters */
function planGeneratorUrl(city: City) {
  const f = city.features
  const seed = hashSeed(city.id)
  if (city.population < 2500) return `https://watabou.github.io/village-generator/?pop=${city.population}&name=${encodeURIComponent(city.name)}&seed=${seed}&tags=${f.port ? 'coast' : ''}`
  const size = Math.max(6, Math.min(65, Math.ceil(2.13 * Math.pow(city.population / 1000, 0.385))))
  const on = (v: boolean) => (v ? 1 : 0)
  return `https://watabou.github.io/city-generator/?size=${size}&seed=${seed}&name=${encodeURIComponent(city.name)}&population=${city.population}&citadel=${on(f.citadel)}&urban_castle=${on(f.citadel && f.capital)}&plaza=${on(f.plaza)}&temple=${on(f.temple)}&walls=${on(f.walls)}&shantytown=${on(f.shanty)}&coast=${on(f.port)}&river=0&gates=-1&greens=1`
}

function CityPlan({ city }: { city: City }) {
  const up = useUpdate('city', city.id)
  const [preview, setPreview] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const plan = city.plan
  const isUrl = /^https?:\/\//.test(plan)
  const isNote = plan.toLowerCase().endsWith('.md')
  const isImage = /\.(png|jpe?g|webp|svg)$/i.test(plan)
  useEffect(() => {
    setPreview(null)
    if (plan && isImage && !isUrl) platform.fileUrl(plan).then(setPreview).catch(() => setPreview(null))
  }, [plan])
  const open = () => {
    if (isUrl) platform.openExternal(plan)
    else if (isNote) platform.openExternal(obsidianUrl(project.value, plan))
    else platform.openFile(plan).catch(e => notify(String(e), 'error'))
  }
  return (
    <Section title="Stadtplan" open={!!plan}>
      <Field label="Verknüpfung" hint="Bilddatei, PDF, Webadresse oder Vault-Note">
        <Text value={plan} onInput={v => up({ plan: v } as Partial<City>, 'plan')} placeholder="C:\…\plan.png oder https://…" />
      </Field>
      <div class="button-row">
        <button
          onClick={async () => {
            const file = await platform.pickFile('Stadtplan wählen', [{ name: 'Stadtplan', extensions: ['png', 'jpg', 'jpeg', 'webp', 'svg', 'pdf', 'html'] }])
            if (file) up({ plan: file } as Partial<City>)
          }}
        >
          Datei …
        </button>
        <button onClick={() => setPicking(true)}>Note …</button>
        {plan && <button onClick={open}>Öffnen</button>}
        <button onClick={() => platform.openExternal(planGeneratorUrl(city))} title="Öffnet den Stadtplan-Generator von watabou mit den Merkmalen dieser Stadt">
          Plan erzeugen ↗
        </button>
      </div>
      {preview && <img class="plan-preview" src={preview} alt={`Stadtplan ${city.name}`} onClick={open} />}
      {picking && (
        <NotePicker
          suggestion={city.name}
          onClose={() => setPicking(false)}
          onPick={path => {
            up({ plan: path } as Partial<City>)
            setPicking(false)
          }}
        />
      )}
    </Section>
  )
}

const FEATURE_NAMES: [keyof City['features'], string][] = [
  ['capital', 'Hauptstadt'],
  ['port', 'Hafen'],
  ['citadel', 'Zitadelle'],
  ['walls', 'Stadtmauer'],
  ['plaza', 'Marktplatz'],
  ['temple', 'Tempel'],
  ['shanty', 'Elendsviertel'],
]

function CityFields({ c }: { c: City }) {
  const p = project.value
  const up = useUpdate('city', c.id)
  const m = cityMembership.value.get(c.id)
  const nameOf = (list: { id: string; name: string }[], id?: string) => list.find(x => x.id === id)?.name ?? '—'
  return (
    <>
      <Field label="Typ">
        <Select value={c.type} onChange={v => up({ type: v } as Partial<City>)} options={typeOptions(p.catalog.cityTypes)} />
      </Field>
      <Field label="Einwohner">
        <Num value={c.population} min={0} step={100} onChange={v => up({ population: Math.round(v) } as Partial<City>, 'population')} />
      </Field>
      <Field label="Gruppe" hint="frei, z. B. Handelsbund oder Region">
        <Text value={c.group} onInput={v => up({ group: v } as Partial<City>, 'group')} />
      </Field>
      <Field label="Merkmale" wide>
        <div class="chips">
          {FEATURE_NAMES.map(([key, name]) => (
            <label key={key} class={`chip${c.features[key] ? ' on' : ''}`}>
              <input type="checkbox" checked={c.features[key]} onChange={e => up({ features: { ...c.features, [key]: (e.target as HTMLInputElement).checked } } as Partial<City>)} />
              {name}
            </label>
          ))}
        </div>
      </Field>
      <dl class="stats">
        <dt>Staat</dt>
        <dd>{nameOf(p.states, m?.state)}</dd>
        <dt>Provinz</dt>
        <dd>{nameOf(p.provinces, m?.province)}</dd>
        <dt>Kultur</dt>
        <dd>{nameOf(p.cultures, m?.culture)}</dd>
        <dt>Religion</dt>
        <dd>{nameOf(p.religions, m?.religion)}</dd>
      </dl>
      <CityPlan city={c} />
    </>
  )
}

function RouteFields({ r }: { r: Route }) {
  const p = project.value
  const up = useUpdate('route', r.id)
  return (
    <>
      <Field label="Typ">
        <Select value={r.type} onChange={v => up({ type: v } as Partial<Route>)} options={typeOptions(p.catalog.routeTypes)} />
      </Field>
      <dl class="stats">
        <dt>Länge</dt>
        <dd>{formatKm(lineLengthM(r.geometry.coordinates, p.planetRadius))}</dd>
        <dt>Stützpunkte</dt>
        <dd>{r.geometry.coordinates.length}</dd>
      </dl>
      <p class="hint">Punkte ziehen zum Verschieben, auf der Linie ziehen fügt einen Punkt ein, Alt+Klick löscht einen.</p>
    </>
  )
}

function RiverFields({ r }: { r: River }) {
  const p = project.value
  const up = useUpdate('river', r.id)
  const parent = p.rivers.find(x => x.id === r.parentId)
  const tributaries = p.rivers.filter(x => x.parentId === r.id)
  return (
    <>
      <Field label="Art">
        <Select value={r.type} onChange={v => up({ type: v } as Partial<River>)} options={['Strom', 'Fluss', 'Bach', 'Kanal'].map(x => ({ id: x, name: x }))} />
      </Field>
      <dl class="stats">
        <dt>Länge</dt>
        <dd>{formatInt(r.lengthKm)} km</dd>
        <dt>Flussnetz oberhalb</dt>
        <dd>{formatInt(r.upstreamKm)} km</dd>
        <dt>Mündet in</dt>
        <dd>{parent ? <a onClick={() => (selection.value = { kind: 'river', id: parent.id })}>{parent.name || 'Fluss ohne Namen'}</a> : 'Meer / Senke'}</dd>
        <dt>Nebenflüsse</dt>
        <dd>{tributaries.length}</dd>
      </dl>
      <p class="hint">Der Verlauf kommt aus der Gaea-Flussmaske und wird hier nicht verschoben.</p>
    </>
  )
}

function LabelFields({ l }: { l: Label }) {
  const p = project.value
  const up = useUpdate('label', l.id)
  const category = p.catalog.labelCategories.find(c => c.id === l.category)
  return (
    <>
      <Field label="Kategorie">
        <Select value={l.category} onChange={v => up({ category: v } as Partial<Label>)} options={typeOptions(p.catalog.labelCategories)} />
      </Field>
      <Field label="Schriftgröße" hint={`leer = ${category?.size ?? 13} px aus der Kategorie`}>
        <Num value={l.size} min={4} max={120} onChange={v => up({ size: v } as Partial<Label>, 'size')} placeholder={String(category?.size ?? '')} />
      </Field>
      <Field label="Farbe">
        <span class="inline">
          <Color value={l.color ?? category?.color ?? '#222222'} onChange={v => up({ color: v } as Partial<Label>, 'color')} />
          {l.color && <button class="small" onClick={() => up({ color: null } as Partial<Label>)}>wie Kategorie</button>}
        </span>
      </Field>
      <Field label="Sperrung" hint="Abstand zwischen den Buchstaben">
        <Num value={l.spacing} min={0} max={30} onChange={v => up({ spacing: v } as Partial<Label>, 'spacing')} placeholder={String(category?.spacing ?? 0)} />
      </Field>
      {l.geometry.type === 'Point' && (
        <Field label="Drehung (°)">
          <Num value={l.rotation} min={-180} max={180} onChange={v => up({ rotation: v } as Partial<Label>, 'rotation')} />
        </Field>
      )}
      <Check checked={l.italic ?? category?.italic ?? false} onChange={v => up({ italic: v } as Partial<Label>)} label="Kursiv" />
      <Check checked={l.uppercase ?? category?.uppercase ?? false} onChange={v => up({ uppercase: v } as Partial<Label>)} label="Großbuchstaben" />
      {l.geometry.type === 'LineString' && <p class="hint">Der Text folgt der Linie; ihre Punkte lassen sich ziehen.</p>}
    </>
  )
}

function MarkerFields({ m }: { m: Marker }) {
  const p = project.value
  const up = useUpdate('marker', m.id)
  return (
    <>
      <Field label="Typ">
        <Select value={m.type} onChange={v => up({ type: v } as Partial<Marker>)} options={p.catalog.markerTypes.map(t => ({ id: t.id, name: `${t.icon} ${t.name}` }))} />
      </Field>
      <Field label="Größe">
        <Num value={m.size} min={0.3} max={4} step={0.1} onChange={v => up({ size: v } as Partial<Marker>, 'size')} />
      </Field>
    </>
  )
}

function RegimentFields({ r }: { r: Regiment }) {
  const p = project.value
  const up = useUpdate('regiment', r.id)
  return (
    <>
      <Field label="Staat">
        <Select value={r.stateId} onChange={v => up({ stateId: v } as Partial<Regiment>)} options={typeOptions(p.states)} empty="—" />
      </Field>
      <Field label="Befehlshaber">
        <Text value={r.commander} onInput={v => up({ commander: v } as Partial<Regiment>, 'commander')} />
      </Field>
      <Check checked={r.naval} onChange={v => up({ naval: v } as Partial<Regiment>)} label="Flotte (auf See)" />
      <Section title="Zusammensetzung">
        {p.catalog.unitTypes
          .filter(u => u.naval === r.naval || r.units[u.id])
          .map(u => (
            <Field key={u.id} label={`${u.symbol} ${u.name}`}>
              <Num value={r.units[u.id] ?? 0} min={0} step={10} onChange={v => up({ units: { ...r.units, [u.id]: Math.round(v) } } as Partial<Regiment>, `unit-${u.id}`)} />
            </Field>
          ))}
        <dl class="stats">
          <dt>Gesamt</dt>
          <dd>
            <strong>{formatInt(regimentTotal(r))}</strong>
          </dd>
        </dl>
      </Section>
    </>
  )
}

function Position({ entity }: { entity: Entity }) {
  const [height, setHeight] = useState<number | null>(null)
  const point = entity.geometry?.type === 'Point' ? entity.geometry.coordinates : null
  useEffect(() => {
    setHeight(null)
    if (point) platform.heights([point]).then(([h]) => setHeight(h))
  }, [point?.[0], point?.[1]])
  if (!point) return null
  const climate = koppenAt(point)
  const klass = project.value.koppenClasses.find(c => c.code === climate)
  return (
    <p class="position">
      {formatLonLat(point)}
      {height != null && <> · {Math.round(height).toLocaleString('de-DE')} m</>}
      {klass && <> · {klass.code} {klass.name}</>}
      {height != null && height <= 0 && <span class="warn-text"> · liegt im Meer</span>}
    </p>
  )
}

export function Inspector() {
  const entity = selectedEntity.value
  const s = selection.value
  if (!entity || !s) return null
  const kind = s.kind
  const up = (patch: Partial<Entity>, merge?: string) => updateEntity(kind, entity.id, patch as never, merge)
  const hasColor = 'color' in entity && isArea(kind)
  return (
    <aside class="inspector">
      <header>
        <span class="kind">{KIND_NAMES[kind][0]}</span>
        <div class="header-actions">
          <button class="icon" title="Auf der Karte zeigen" onClick={() => mapView.current?.focus(kind, entity.id)}>
            ⌖
          </button>
          <button class="icon danger" title="Löschen (Entf)" onClick={() => removeEntity(kind, entity.id)}>
            🗑
          </button>
          <button class="icon" title="Schließen" onClick={() => (selection.value = null)}>
            ✕
          </button>
        </div>
      </header>
      <div class="inspector-body">
        <Field label={kind === 'label' ? 'Text' : 'Name'}>
          <Text value={entity.name} onInput={v => up({ name: v }, 'name')} />
        </Field>
        {hasColor && (
          <Field label="Farbe">
            <Color value={(entity as AreaBase).color} onChange={v => up({ color: v } as Partial<AreaBase>, 'color')} />
          </Field>
        )}
        <Position entity={entity} />
        {kind === 'state' && <StateFields s={entity as State} />}
        {kind === 'province' && <ProvinceFields x={entity as Province} />}
        {kind === 'culture' && <CultureFields x={entity as Culture} />}
        {kind === 'religion' && <ReligionFields x={entity as Religion} />}
        {kind === 'zone' && <ZoneFields x={entity as Zone} />}
        {kind === 'city' && <CityFields c={entity as City} />}
        {kind === 'route' && <RouteFields r={entity as Route} />}
        {kind === 'river' && <RiverFields r={entity as River} />}
        {kind === 'label' && <LabelFields l={entity as Label} />}
        {kind === 'marker' && <MarkerFields m={entity as Marker} />}
        {kind === 'regiment' && <RegimentFields r={entity as Regiment} />}
        {isArea(kind) && <AreaTools kind={kind} entity={entity as AreaBase} />}
        <Section title="Notiz">
          <Text multiline value={entity.description} onInput={v => up({ description: v }, 'description')} placeholder="Beschreibung, Geschichte, Besonderheiten …" />
        </Section>
        <Section title="Obsidian">
          <NoteLink note={entity.note} name={entity.name} onChange={note => up({ note })} />
        </Section>
      </div>
    </aside>
  )
}

