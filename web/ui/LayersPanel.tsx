// Layers (visibility, order, opacity), layer presets and the map frame: grid, compass, scale bar,
// texture and colour filters.
import { useState } from 'preact/hooks'
import { BUILTIN_LAYER_PRESETS, layerName, neutralFilter } from '../model/catalog'
import { newId } from '../model/project'
import { patchProject, project } from '../model/store'
import type { Display, Filter, LayerId, LayerPreset } from '../model/types'
import { platform } from '../platform'
import { Check, Color, Field, Num, PresetPicker, Range, Section, Select } from './components'

function LayerList() {
  const p = project.value
  const [dragging, setDragging] = useState<number | null>(null)
  // shown top layer first, like image editors
  const rows = p.layers.map((layer, index) => ({ layer, index })).reverse()
  const move = (from: number, to: number) => {
    if (from === to || to < 0 || to >= p.layers.length) return
    const layers = [...p.layers]
    const [item] = layers.splice(from, 1)
    layers.splice(to, 0, item)
    patchProject({ layers })
  }
  const setLayer = (id: LayerId, patch: Partial<(typeof p.layers)[number]>, merge?: string) =>
    patchProject({ layers: p.layers.map(l => (l.id === id ? { ...l, ...patch } : l)) }, merge)
  return (
    <ul class="layer-list">
      {rows.map(({ layer, index }) => (
        <li
          key={layer.id}
          draggable
          class={dragging === index ? 'dragging' : ''}
          onDragStart={() => setDragging(index)}
          onDragOver={e => e.preventDefault()}
          onDrop={() => {
            if (dragging != null) move(dragging, index)
            setDragging(null)
          }}
          onDragEnd={() => setDragging(null)}
        >
          <span class="grip" title="Ziehen zum Umsortieren">⋮⋮</span>
          <input type="checkbox" checked={layer.visible} onChange={e => setLayer(layer.id, { visible: (e.target as HTMLInputElement).checked })} />
          <span class="layer-name">{layerName(p, layer.id)}</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={layer.opacity}
            title={`Deckkraft ${Math.round(layer.opacity * 100)} %`}
            onInput={e => setLayer(layer.id, { opacity: Number((e.target as HTMLInputElement).value) }, `opacity-${layer.id}`)}
          />
          <span class="updown">
            <button class="small" title="nach oben" onClick={() => move(index, index + 1)}>
              ▲
            </button>
            <button class="small" title="nach unten" onClick={() => move(index, index - 1)}>
              ▼
            </button>
          </span>
        </li>
      ))}
    </ul>
  )
}

function applyPreset(preset: LayerPreset) {
  const p = project.value
  const visible = new Map(preset.layers.map(l => [l.id, l.visible]))
  patchProject({ layers: p.layers.map(l => ({ ...l, visible: visible.get(l.id) ?? l.visible })) })
}

function LayerPresets() {
  const p = project.value
  return (
    <PresetPicker
      builtin={BUILTIN_LAYER_PRESETS}
      own={p.layerPresets}
      apply={applyPreset}
      remove={id => patchProject({ layerPresets: p.layerPresets.filter(x => x.id !== id) })}
      save={name => patchProject({ layerPresets: [...p.layerPresets, { id: newId('lp'), name, layers: p.layers.map(l => ({ id: l.id, visible: l.visible })) }] })}
      placeholder="Name für eigenes Preset"
    />
  )
}

export function FilterEditor({ filter, onChange }: { filter: Filter; onChange: (f: Filter) => void }) {
  const set = (key: keyof Filter) => (value: number) => onChange({ ...filter, [key]: value })
  return (
    <div class="filter-editor">
      <Field label="Graustufen"><Range value={filter.grayscale} min={0} max={1} step={0.05} onChange={set('grayscale')} /></Field>
      <Field label="Sepia"><Range value={filter.sepia} min={0} max={1} step={0.05} onChange={set('sepia')} /></Field>
      <Field label="Sättigung"><Range value={filter.saturate} min={0} max={3} step={0.05} onChange={set('saturate')} /></Field>
      <Field label="Helligkeit"><Range value={filter.brightness} min={0.2} max={2} step={0.05} onChange={set('brightness')} /></Field>
      <Field label="Kontrast"><Range value={filter.contrast} min={0.2} max={2} step={0.05} onChange={set('contrast')} /></Field>
      <Field label="Farbton (°)"><Range value={filter.hue} min={-180} max={180} step={1} onChange={set('hue')} /></Field>
      <Field label="Unschärfe (px)"><Range value={filter.blur} min={0} max={6} step={0.25} onChange={set('blur')} /></Field>
      <Field label="Invertieren"><Range value={filter.invert} min={0} max={1} step={0.05} onChange={set('invert')} /></Field>
      <button class="small" onClick={() => onChange(neutralFilter())}>Zurücksetzen</button>
    </div>
  )
}

const FILTER_PRESETS: { name: string; filter: Partial<Filter> }[] = [
  { name: 'Keiner', filter: {} },
  { name: 'Sepia', filter: { sepia: 0.7, saturate: 0.8 } },
  { name: 'Graustufen', filter: { grayscale: 1 } },
  { name: 'Verblasst', filter: { saturate: 0.55, brightness: 1.08, contrast: 0.85 } },
  { name: 'Kräftig', filter: { saturate: 1.5, contrast: 1.1 } },
  { name: 'Alt', filter: { sepia: 0.45, saturate: 0.7, contrast: 0.9, brightness: 0.97 } },
]

function Filters() {
  const p = project.value
  const [target, setTarget] = useState<'map' | LayerId>('map')
  const display = p.display
  const current = target === 'map' ? display.mapFilter : (display.layerFilters[target] ?? neutralFilter())
  const set = (filter: Filter) => {
    const next: Display = target === 'map' ? { ...display, mapFilter: filter } : { ...display, layerFilters: { ...display.layerFilters, [target]: filter } }
    patchProject({ display: next }, `filter-${target}`)
  }
  return (
    <>
      <Field label="Anwenden auf">
        <Select value={target} onChange={v => setTarget(v)} options={[{ id: 'map' as const, name: 'ganze Karte' }, ...p.layers.map(l => ({ id: l.id, name: layerName(p, l.id) }))]} />
      </Field>
      <Field label="Vorlage">
        <select
          value=""
          onChange={e => {
            const f = FILTER_PRESETS.find(x => x.name === (e.target as HTMLSelectElement).value)
            if (f) set({ ...neutralFilter(), ...f.filter })
          }}
        >
          <option value="" disabled>
            Filter wählen …
          </option>
          {FILTER_PRESETS.map(f => (
            <option key={f.name} value={f.name}>
              {f.name}
            </option>
          ))}
        </select>
      </Field>
      <FilterEditor filter={current} onChange={set} />
    </>
  )
}

function Frame() {
  const p = project.value
  const d = p.display
  const set = (patch: Partial<Display>, merge?: string) => patchProject({ display: { ...d, ...patch } }, merge)
  const grid = p.layers.find(l => l.id === 'graticule')
  const texture = p.layers.find(l => l.id === 'texture')
  const toggleLayer = (id: LayerId, visible: boolean) => patchProject({ layers: p.layers.map(l => (l.id === id ? { ...l, visible } : l)) })
  return (
    <>
      <Field label="Meer / Hintergrund">
        <Color value={d.background} onChange={v => set({ background: v }, 'background')} />
      </Field>
      <h4>Gitter und Koordinaten</h4>
      <Check checked={!!grid?.visible} onChange={v => toggleLayer('graticule', v)} label="Gitternetz anzeigen" />
      <Field label="Abstand (°)" hint="0 = passt sich dem Zoom an">
        <Num value={d.graticule.step} min={0} max={90} onChange={v => set({ graticule: { ...d.graticule, step: v } }, 'grid-step')} />
      </Field>
      <Field label="Farbe">
        <Color value={d.graticule.color} onChange={v => set({ graticule: { ...d.graticule, color: v } }, 'grid-color')} />
      </Field>
      <Field label="Linienbreite">
        <Num value={d.graticule.width} min={0.1} max={4} step={0.1} onChange={v => set({ graticule: { ...d.graticule, width: v } }, 'grid-width')} />
      </Field>
      <Check checked={d.graticule.labels} onChange={v => set({ graticule: { ...d.graticule, labels: v } })} label="Gradzahlen am Rand" />
      <Check checked={d.coordinates.show} onChange={v => set({ coordinates: { show: v } })} label="Mauskoordinaten in der Statusleiste" />
      <h4>Kompass und Maßstab</h4>
      <Check checked={d.compass.show} onChange={v => set({ compass: { ...d.compass, show: v } })} label="Kompassrose" />
      <Field label="Größe (px)">
        <Num value={d.compass.size} min={40} max={260} onChange={v => set({ compass: { ...d.compass, size: v } }, 'compass-size')} />
      </Field>
      <Field label="Position">
        <Select
          value={d.compass.position}
          onChange={v => set({ compass: { ...d.compass, position: v } })}
          options={[
            { id: 'tl' as const, name: 'oben links' },
            { id: 'tr' as const, name: 'oben rechts' },
            { id: 'bl' as const, name: 'unten links' },
            { id: 'br' as const, name: 'unten rechts' },
          ]}
        />
      </Field>
      <Check checked={d.scaleBar.show} onChange={v => set({ scaleBar: { show: v } })} label="Maßstabsleiste" />
      <h4>Textur</h4>
      <Check checked={!!texture?.visible} onChange={v => toggleLayer('texture', v)} label="Textur anzeigen" />
      <Field label="Art">
        <Select
          value={d.texture.kind}
          onChange={v => set({ texture: { ...d.texture, kind: v } })}
          options={[
            { id: 'paper' as const, name: 'Papier' },
            { id: 'linen' as const, name: 'Leinen' },
            { id: 'grain' as const, name: 'Körnung' },
            { id: 'custom' as const, name: 'Eigenes Bild' },
          ]}
        />
      </Field>
      {d.texture.kind === 'custom' && (
        <Field label="Bild">
          <span class="inline">
            <span class="path" title={d.texture.image}>{d.texture.image.split(/[\\/]/).pop() || '—'}</span>
            <button
              class="small"
              onClick={async () => {
                const file = await platform.pickFile('Texturbild', [{ name: 'Bild', extensions: ['png', 'jpg', 'jpeg', 'webp'] }])
                if (file) set({ texture: { ...d.texture, image: file } })
              }}
            >
              Wählen …
            </button>
          </span>
        </Field>
      )}
      <Field label="Mischmodus">
        <Select
          value={d.texture.blend}
          onChange={v => set({ texture: { ...d.texture, blend: v } })}
          options={['multiply', 'overlay', 'soft-light', 'color-burn', 'normal'].map(x => ({ id: x, name: x }))}
        />
      </Field>
      <Field label="Maßstab">
        <Num value={d.texture.scale} min={0.25} max={4} step={0.25} onChange={v => set({ texture: { ...d.texture, scale: v } }, 'texture-scale')} />
      </Field>
      <p class="hint">Deckkraft der Textur über die Ebenenliste.</p>
    </>
  )
}

export function LayersPanel() {
  return (
    <div class="panel">
      <Section title="Ebenen">
        <LayerList />
      </Section>
      <Section title="Ebenen-Presets">
        <LayerPresets />
      </Section>
      <Section title="Kartenrahmen" open={false}>
        <Frame />
      </Section>
      <Section title="Farbfilter" open={false}>
        <Filters />
      </Section>
    </div>
  )
}
