// Style editor per layer, style presets, and the type lists (city, marker, route, zone types …).
import { useState } from 'preact/hooks'
import { BUILTIN_STYLE_PRESETS, LAYER_NAMES } from '../model/catalog'
import { newId } from '../model/project'
import { patchProject, project } from '../model/store'
import type { Catalog, LayerId, LayerStyle, StylePreset } from '../model/types'
import { Check, Color, Field, Num, Section, Select, Text } from './components'

const STYLED: LayerId[] = ['coast', 'states', 'provinces', 'cultures', 'religions', 'zones', 'rivers', 'routes', 'cities', 'markers', 'regiments', 'labels']
const FONTS = [
  { id: 'Georgia, serif', name: 'Georgia (Serif)' },
  { id: '"Palatino Linotype", "Book Antiqua", serif', name: 'Palatino' },
  { id: '"Times New Roman", serif', name: 'Times' },
  { id: '"Segoe UI", sans-serif', name: 'Segoe UI' },
  { id: 'Verdana, sans-serif', name: 'Verdana' },
  { id: '"Trebuchet MS", sans-serif', name: 'Trebuchet' },
  { id: '"Courier New", monospace', name: 'Courier' },
  { id: '"Lucida Calligraphy", "Segoe Script", cursive', name: 'Kalligrafie' },
]

function LayerStyleEditor({ id }: { id: LayerId }) {
  const p = project.value
  const s = p.style[id]
  const set = (patch: Partial<LayerStyle>, key: string) => patchProject({ style: { ...p.style, [id]: { ...s, ...patch } } }, `style-${id}-${key}`)
  const lines = id !== 'cities' && id !== 'markers' && id !== 'regiments' && id !== 'labels'
  const fills = id === 'coast' || id === 'states' || id === 'provinces' || id === 'cultures' || id === 'religions' || id === 'zones' || id === 'cities'
  const symbols = id === 'cities' || id === 'markers' || id === 'regiments' || id === 'labels' || id === 'routes'
  return (
    <div class="style-editor">
      {lines && (
        <>
          <Field label="Linienfarbe" hint={id === 'coast' || id === 'rivers' ? undefined : 'leer = aus der Elementfarbe'}>
            <span class="inline">
              <Color value={s.stroke || '#555555'} onChange={v => set({ stroke: v }, 'stroke')} />
              {s.stroke && <button class="small" onClick={() => set({ stroke: '' }, 'stroke')}>automatisch</button>}
            </span>
          </Field>
          <Field label="Linienbreite">
            <Num value={s.strokeWidth} min={0} max={12} step={0.1} onChange={v => set({ strokeWidth: v }, 'width')} />
          </Field>
          <Field label="Strichelung" hint="z. B. „6 3“, leer = durchgezogen">
            <Text value={s.dash} onInput={v => set({ dash: v }, 'dash')} />
          </Field>
        </>
      )}
      {fills && (
        <>
          <Field label="Füllfarbe" hint={id === 'coast' || id === 'cities' ? undefined : 'leer = Elementfarbe'}>
            <span class="inline">
              <Color value={s.fill || '#cccccc'} onChange={v => set({ fill: v }, 'fill')} />
              {s.fill && id !== 'coast' && <button class="small" onClick={() => set({ fill: '' }, 'fill')}>automatisch</button>}
            </span>
          </Field>
          {id !== 'cities' && (
            <Field label="Fülldeckkraft">
              <Num value={s.fillOpacity} min={0} max={1} step={0.05} onChange={v => set({ fillOpacity: v }, 'fillOpacity')} />
            </Field>
          )}
        </>
      )}
      {symbols && (
        <Field label="Symbolgröße">
          <Num value={s.symbolScale} min={0.2} max={4} step={0.1} onChange={v => set({ symbolScale: v }, 'symbol')} />
        </Field>
      )}
      {id !== 'coast' && (
        <>
          {id !== 'labels' && <Check checked={s.showLabels} onChange={v => set({ showLabels: v }, 'labels')} label="Namen anzeigen" />}
          <Field label="Schrift">
            <Select value={s.labelFont} onChange={v => set({ labelFont: v }, 'font')} options={FONTS} />
          </Field>
          {id !== 'labels' && (
            <>
              <Field label="Schriftgröße">
                <Num value={s.labelSize} min={6} max={60} onChange={v => set({ labelSize: v }, 'size')} />
              </Field>
              <Field label="Schriftfarbe">
                <Color value={s.labelColor} onChange={v => set({ labelColor: v }, 'labelColor')} />
              </Field>
            </>
          )}
          <Field label="Hof um die Schrift">
            <span class="inline">
              <Color value={s.halo} onChange={v => set({ halo: v }, 'halo')} />
              <Num value={s.haloWidth} min={0} max={10} step={0.5} onChange={v => set({ haloWidth: v }, 'haloWidth')} />
            </span>
          </Field>
        </>
      )}
    </div>
  )
}

function StylePresets() {
  const p = project.value
  const [name, setName] = useState('')
  const apply = (preset: StylePreset) =>
    patchProject({ style: structuredClone(preset.style), display: { ...p.display, ...structuredClone(preset.display) } })
  return (
    <>
      <div class="preset-row">
        {BUILTIN_STYLE_PRESETS.map(preset => (
          <button key={preset.id} onClick={() => apply(preset)}>
            {preset.name}
          </button>
        ))}
      </div>
      {p.stylePresets.length > 0 && (
        <div class="preset-row own">
          {p.stylePresets.map(preset => (
            <span key={preset.id} class="own-preset">
              <button onClick={() => apply(preset)}>{preset.name}</button>
              <button class="small" title="Löschen" onClick={() => patchProject({ stylePresets: p.stylePresets.filter(x => x.id !== preset.id) })}>
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      <div class="inline">
        <input type="text" placeholder="Name für eigenen Stil" value={name} onInput={e => setName((e.target as HTMLInputElement).value)} />
        <button
          disabled={!name.trim()}
          onClick={() => {
            const { background, mapFilter, layerFilters, texture, graticule } = p.display
            patchProject({ stylePresets: [...p.stylePresets, { id: newId('sp'), name: name.trim(), style: structuredClone(p.style), display: structuredClone({ background, mapFilter, layerFilters, texture, graticule }) }] })
            setName('')
          }}
        >
          Aktuellen Stil speichern
        </button>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------------------------
// type lists

type ListKey = keyof Catalog
interface ColumnDef {
  key: string
  name: string
  kind: 'text' | 'number' | 'color' | 'bool' | 'select'
  options?: { id: string; name: string }[]
}

const LISTS: { key: ListKey; name: string; columns: ColumnDef[]; blank: () => Record<string, unknown> }[] = [
  {
    key: 'cityTypes',
    name: 'Stadttypen',
    columns: [
      { key: 'name', name: 'Name', kind: 'text' },
      { key: 'size', name: 'Größe', kind: 'number' },
      { key: 'shape', name: 'Form', kind: 'select', options: [{ id: 'circle', name: 'Kreis' }, { id: 'square', name: 'Quadrat' }, { id: 'diamond', name: 'Raute' }] },
    ],
    blank: () => ({ name: 'Neuer Typ', size: 4, shape: 'circle' }),
  },
  {
    key: 'markerTypes',
    name: 'Markertypen',
    columns: [
      { key: 'icon', name: 'Symbol', kind: 'text' },
      { key: 'name', name: 'Name', kind: 'text' },
      { key: 'color', name: 'Farbe', kind: 'color' },
      { key: 'land', name: 'nur Land', kind: 'bool' },
    ],
    blank: () => ({ name: 'Neuer Marker', icon: '📍', color: '#b0302c', land: false }),
  },
  {
    key: 'routeTypes',
    name: 'Routentypen',
    columns: [
      { key: 'name', name: 'Name', kind: 'text' },
      { key: 'color', name: 'Farbe', kind: 'color' },
      { key: 'width', name: 'Breite', kind: 'number' },
      { key: 'dash', name: 'Strich', kind: 'text' },
      { key: 'kind', name: 'Art', kind: 'select', options: [{ id: 'land', name: 'Land' }, { id: 'sea', name: 'See' }, { id: 'air', name: 'Luft' }] },
    ],
    blank: () => ({ name: 'Neue Route', color: '#8b5a2b', width: 1.5, dash: '', kind: 'land' }),
  },
  {
    key: 'zoneTypes',
    name: 'Zonentypen',
    columns: [
      { key: 'name', name: 'Name', kind: 'text' },
      { key: 'color', name: 'Farbe', kind: 'color' },
      { key: 'pattern', name: 'Muster', kind: 'select', options: [{ id: 'hatch', name: 'Schraffur' }, { id: 'cross', name: 'Kreuz' }, { id: 'dots', name: 'Punkte' }, { id: 'fill', name: 'Fläche' }] },
    ],
    blank: () => ({ name: 'Neue Zone', color: '#4682b4', pattern: 'hatch' }),
  },
  {
    key: 'labelCategories',
    name: 'Beschriftungskategorien',
    columns: [
      { key: 'name', name: 'Name', kind: 'text' },
      { key: 'size', name: 'Größe', kind: 'number' },
      { key: 'color', name: 'Farbe', kind: 'color' },
      { key: 'italic', name: 'kursiv', kind: 'bool' },
      { key: 'uppercase', name: 'VERSAL', kind: 'bool' },
      { key: 'spacing', name: 'Sperrung', kind: 'number' },
      { key: 'font', name: 'Schrift', kind: 'select', options: FONTS },
    ],
    blank: () => ({ name: 'Neue Kategorie', size: 12, color: '#222222', italic: false, uppercase: false, spacing: 0, font: 'Georgia, serif' }),
  },
  {
    key: 'unitTypes',
    name: 'Truppengattungen',
    columns: [
      { key: 'symbol', name: 'Symbol', kind: 'text' },
      { key: 'name', name: 'Name', kind: 'text' },
      { key: 'naval', name: 'See', kind: 'bool' },
    ],
    blank: () => ({ name: 'Neue Gattung', symbol: '⚔', naval: false }),
  },
  { key: 'stateForms', name: 'Staatsformen', columns: [{ key: 'name', name: 'Name', kind: 'text' }], blank: () => ({ name: 'Neue Staatsform' }) },
  { key: 'cultureTypes', name: 'Kulturtypen', columns: [{ key: 'name', name: 'Name', kind: 'text' }], blank: () => ({ name: 'Neuer Typ' }) },
  { key: 'religionTypes', name: 'Religionstypen', columns: [{ key: 'name', name: 'Name', kind: 'text' }], blank: () => ({ name: 'Neuer Typ' }) },
  {
    key: 'relations',
    name: 'Diplomatische Beziehungen',
    columns: [
      { key: 'name', name: 'Name', kind: 'text' },
      { key: 'color', name: 'Farbe', kind: 'color' },
    ],
    blank: () => ({ name: 'Neue Beziehung', color: '#999999', mirror: '' }),
  },
]

function ListEditor({ def }: { def: (typeof LISTS)[number] }) {
  const p = project.value
  const items = p.catalog[def.key] as unknown as Record<string, unknown>[]
  const save = (next: Record<string, unknown>[], merge?: string) => patchProject({ catalog: { ...p.catalog, [def.key]: next } }, merge)
  const setField = (index: number, key: string, value: unknown) => save(items.map((item, i) => (i === index ? { ...item, [key]: value } : item)), `${def.key}-${index}-${key}`)
  return (
    <div class="table-scroll">
      <table class="list-editor">
        <thead>
          <tr>
            {def.columns.map(c => (
              <th key={c.key}>{c.name}</th>
            ))}
            <th />
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => (
            <tr key={String(item.id)}>
              {def.columns.map(c => (
                <td key={c.key} class={c.kind === 'text' && c.key !== 'name' ? 'narrow' : ''}>
                  {c.kind === 'text' && <input type="text" value={String(item[c.key] ?? '')} onInput={e => setField(index, c.key, (e.target as HTMLInputElement).value)} />}
                  {c.kind === 'number' && <input type="number" step="any" value={Number(item[c.key] ?? 0)} onInput={e => setField(index, c.key, Number((e.target as HTMLInputElement).value))} />}
                  {c.kind === 'color' && <Color value={String(item[c.key] ?? '#888888')} onChange={v => setField(index, c.key, v)} />}
                  {c.kind === 'bool' && <input type="checkbox" checked={!!item[c.key]} onChange={e => setField(index, c.key, (e.target as HTMLInputElement).checked)} />}
                  {c.kind === 'select' && (
                    <select value={String(item[c.key] ?? '')} onChange={e => setField(index, c.key, (e.target as HTMLSelectElement).value)}>
                      {c.options!.map(o => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                    </select>
                  )}
                </td>
              ))}
              <td>
                <button class="small" title="Entfernen" disabled={items.length <= 1} onClick={() => save(items.filter((_, i) => i !== index))}>
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button class="small" onClick={() => save([...items, { id: newId('t'), ...def.blank() }])}>
        ＋ Eintrag
      </button>
    </div>
  )
}

export function StylePanel() {
  const [layer, setLayer] = useState<LayerId>('states')
  const [listKey, setListKey] = useState<ListKey>('cityTypes')
  const def = LISTS.find(l => l.key === listKey)!
  return (
    <div class="panel">
      <Section title="Stil-Presets">
        <StylePresets />
      </Section>
      <Section title="Stil je Ebene">
        <Field label="Ebene">
          <Select value={layer} onChange={setLayer} options={STYLED.map(id => ({ id, name: LAYER_NAMES[id] }))} />
        </Field>
        <LayerStyleEditor id={layer} />
      </Section>
      <Section title="Typen und Kategorien" open={false}>
        <Field label="Liste">
          <Select value={listKey} onChange={setListKey} options={LISTS.map(l => ({ id: l.key, name: l.name }))} />
        </Field>
        <ListEditor def={def} />
      </Section>
    </div>
  )
}
