// Project settings, the three imports (heightmap, rivers, climate), control points, the Obsidian
// vault and the exports.
import { useState } from 'preact/hooks'
import { IMAGE_FILTER, importImageLayer, importKoppen, importRivers, importSatellite, importTerrain, lastArchive, lastReport, removeImageLayer, saveArchive } from '../model/actions'
import { EXPORT_LAYERS, exportGeoJson, exportJson } from '../model/export'
import { formatInt, formatLonLat } from '../model/geo'
import { refreshVault, vaultError, vaultNotes } from '../model/obsidian'
import { KIND_NAMES, newId } from '../model/project'
import { busy, commit, patchProject, project, tool } from '../model/store'
import { imageLayerData, koppen, satellite, terrain } from '../model/terrain'
import type { ControlPoint, EntityKind, KoppenClass } from '../model/types'
import { platform } from '../platform'
import { Check, Field, Num, Section, Select, Text } from './components'

function PathPicker({ value, onChange, title, filters = IMAGE_FILTER }: { value: string; onChange: (v: string) => void; title: string; filters?: typeof IMAGE_FILTER }) {
  return (
    <span class="inline path-picker">
      <input type="text" value={value} placeholder="Datei wählen …" onInput={e => onChange((e.target as HTMLInputElement).value)} />
      <button
        class="small"
        onClick={async () => {
          const file = await platform.pickFile(title, filters)
          if (file) onChange(file)
        }}
      >
        …
      </button>
    </span>
  )
}

function Report() {
  const report = lastReport.value
  if (!report) return null
  return (
    <div class={`report ${report.ok ? 'ok' : 'failed'}`}>
      <strong>{report.ok ? 'Import erfolgreich' : 'Import abgebrochen'}</strong>
      <ul>
        {report.checks.map((c, i) => (
          <li key={i} class={c.status}>
            <span class="status">{c.status === 'ok' ? '✓' : c.status === 'warn' ? '!' : '✕'}</span>
            <span>
              <b>{c.label}:</b> {c.detail}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** on the device: what the archive brought along; importing happens on the PC */
function TerrainInfo() {
  const t = terrain.value
  return (
    <>
      <TerrainStats />
      {t && !t.meta.fullHeights && <p class="hint">Ohne exakte Höhen im Archiv: Punktinfo und Konfliktprüfung rechnen mit dem ≈10-km-Raster.</p>}
      {satellite.value && <p class="hint">Satellitenbild vorhanden (Ebene „Satellitenbild“).</p>}
      <p class="hint">
        Heightmap, Satellitenbild, Flüsse und Klima werden am PC importiert und kommen als Archiv (.veilmap) auf das Gerät: dort „Datei → Als Archiv speichern“, hier „Datei → Öffnen“.
      </p>
    </>
  )
}

function TerrainStats() {
  const p = project.value
  const t = terrain.value
  if (!t) return null
  return (
    <dl class="stats">
      <dt>Datei</dt>
      <dd title={t.meta.source}>{t.meta.source.split(/[\\/]/).pop()}</dd>
      <dt>Größe</dt>
      <dd>
        {formatInt(t.meta.width)} × {formatInt(t.meta.height)} px · {((Math.PI * 2 * p.planetRadius) / t.meta.width / 1000).toFixed(2).replace('.', ',')} km/px
      </dd>
      <dt>Höhen</dt>
      <dd>
        {formatInt(t.meta.minM)} … {formatInt(t.meta.maxM)} m
      </dd>
      <dt>Meer</dt>
      <dd>{(t.meta.seaFraction * 100).toFixed(1).replace('.', ',')} %</dd>
    </dl>
  )
}

function TerrainImport() {
  const p = project.value
  const [path, setPath] = useState(p.terrain?.source ?? '')
  const [crop, setCrop] = useState(p.terrain?.cropSquare ?? false)
  return (
    <>
      <TerrainStats />
      <Field label="Heightmap" hint="16 Bit, 2:1, unsere Höhenkodierung (Meeresspiegel = 50 % Grau)" wide>
        <PathPicker value={path} onChange={setPath} title="Heightmap aus Gaea/Photoshop" />
      </Field>
      <Check checked={crop} onChange={setCrop} label="Quadratischen Gaea-Export: Mitte 2:1 ausschneiden" />
      <div class="button-row">
        <button class="primary" disabled={!path || !!busy.value} onClick={() => importTerrain(path, crop)}>
          {p.terrain ? 'Neu importieren' : 'Importieren'}
        </button>
      </div>
      <p class="hint">
        Gelände ist im Editor schreibgeschützt. Relief ändern heißt: zurück nach Photoshop bzw. Gaea und neu importieren. Alle Inhalte hängen an Koordinaten und bleiben erhalten.
      </p>
      <Report />
    </>
  )
}

function SatelliteImport() {
  const p = project.value
  const [path, setPath] = useState(p.satellite?.source ?? '')
  const [crop, setCrop] = useState(p.satellite?.cropSquare ?? false)
  const s = satellite.value
  return (
    <>
      {s && (
        <dl class="stats">
          <dt>Datei</dt>
          <dd title={s.source}>{s.source.split(/[\\/]/).pop()}</dd>
          <dt>Größe</dt>
          <dd>
            {formatInt(s.width)} × {formatInt(s.height)} px
          </dd>
        </dl>
      )}
      <Field label="Farbbild" hint="Gaea-Farbexport (Satellit/Textur), 2:1, gleiche Ausdehnung wie die Heightmap" wide>
        <PathPicker value={path} onChange={setPath} title="Satellitenbild aus Gaea" />
      </Field>
      <Check checked={crop} onChange={setCrop} label="Quadratischen Gaea-Export: Mitte 2:1 ausschneiden" />
      <div class="button-row">
        <button class="primary" disabled={!path || !!busy.value} onClick={() => importSatellite(path, crop)}>
          {p.satellite ? 'Neu importieren' : 'Importieren'}
        </button>
      </div>
      <p class="hint">Erscheint als Ebene „Satellitenbild“ (Preset „Satellit“) und lässt sich auf den Globus legen. Nur Anzeige – das Gelände selbst kommt weiter aus der Heightmap.</p>
    </>
  )
}

/** own pictures of the planet as layers, e.g. pre-rendered map styles */
function ImageLayers() {
  const p = project.value
  const [path, setPath] = useState('')
  const [name, setName] = useState('')
  const [crop, setCrop] = useState(false)
  const rename = (id: string, value: string) =>
    patchProject({ imageLayers: p.imageLayers.map(l => (l.id === id ? { ...l, name: value } : l)) }, `image-name-${id}`)
  return (
    <>
      {p.imageLayers.length > 0 && (
        <ul class="image-layers">
          {p.imageLayers.map(layer => {
            const meta = imageLayerData.value.get(layer.id)
            return (
              <li key={layer.id}>
                <input type="text" value={layer.name} onInput={e => rename(layer.id, (e.target as HTMLInputElement).value)} />
                <span class="muted" title={layer.source}>
                  {meta ? `${formatInt(meta.width)} × ${formatInt(meta.height)} px${meta.alpha ? ' · transparent' : ''}` : 'nicht geladen'}
                </span>
                <button class="small" title="Bildebene entfernen" onClick={() => removeImageLayer(layer.id)}>
                  ✕
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {!platform.mobile && (
        <>
          <Field label="Bild" hint="2:1, gleiche Ausdehnung wie die Heightmap; PNG mit Transparenz bleibt durchsichtig" wide>
            <PathPicker value={path} onChange={setPath} title="Bildebene wählen" />
          </Field>
          <Field label="Name">
            <Text value={name} placeholder="aus dem Dateinamen" onInput={setName} />
          </Field>
          <Check checked={crop} onChange={setCrop} label="Quadratischen Export: Mitte 2:1 ausschneiden" />
          <div class="button-row">
            <button
              class="primary"
              disabled={!path || !!busy.value}
              onClick={async () => {
                if (await importImageLayer(path, crop, name)) {
                  setPath('')
                  setName('')
                }
              }}
            >
              Bildebene hinzufügen
            </button>
          </div>
        </>
      )}
      <p class="hint">
        Vorgerenderte Kartenstile oder andere Bilder der ganzen Welt als eigene Ebenen. Reihenfolge, Deckkraft und Filter unter „Ebenen“; auf dem Globus unter „Oberfläche“ wählbar.
      </p>
    </>
  )
}

const HEIGHT_OPTIONS = [
  { id: 'none' as const, name: 'nur Raster (≈10 km)' },
  { id: 'half' as const, name: 'halbe Auflösung' },
  { id: 'full' as const, name: 'volle Auflösung' },
]

function Archive() {
  const p = project.value
  const o = p.archive
  const set = (patch: Partial<typeof o>) => patchProject({ archive: { ...o, ...patch } }, 'archive')
  const report = lastArchive.value
  const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1).replace('.', ',')} MB`
  return (
    <>
      <p class="hint">
        Eine Datei mit Projekt und allem, was aus den Quelldateien abgeleitet wurde – zum Weitergeben, etwa an das Tablet. Importiert wird am PC; das Archiv braucht die Quelldateien nicht.
      </p>
      <Field label="Kachelqualität" hint="WebP; 85 ist vom Original kaum zu unterscheiden">
        <span class="inline">
          <input type="range" min={50} max={100} step={1} value={o.quality} disabled={o.lossless} onInput={e => set({ quality: Number((e.target as HTMLInputElement).value) })} />
          <span class="muted">{o.lossless ? 'verlustfrei' : o.quality}</span>
        </span>
      </Field>
      <Check checked={o.lossless} onChange={v => set({ lossless: v })} label="Kacheln verlustfrei (deutlich größer)" />
      <Field label="Exakte Höhen" hint="für Punktinfo und Konfliktprüfung; das Raster ist immer dabei">
        <Select value={o.heights} onChange={v => set({ heights: v })} options={HEIGHT_OPTIONS} />
      </Field>
      <Check checked={o.satellite} onChange={v => set({ satellite: v })} label="Satellitenbild mitnehmen" />
      <Check checked={o.koppen} onChange={v => set({ koppen: v })} label="Klimakarte mitnehmen" />
      <Check checked={o.images} onChange={v => set({ images: v })} label={`Bildebenen mitnehmen (${p.imageLayers.length})`} />
      <div class="button-row">
        <button class="primary" disabled={!!busy.value} onClick={() => saveArchive()}>
          Archiv speichern …
        </button>
      </div>
      {report && (
        <dl class="stats">
          <dt>Archiv</dt>
          <dd>{mb(report.bytes)}</dd>
          <dt>Kacheln</dt>
          <dd>
            {formatInt(report.tiles)} · {mb(report.tileBytes)}
          </dd>
          {report.heightsBytes > 0 && (
            <>
              <dt>Höhen</dt>
              <dd>{mb(report.heightsBytes)}</dd>
            </>
          )}
        </dl>
      )}
    </>
  )
}

function ControlPoints() {
  const p = project.value
  const set = (points: ControlPoint[], merge?: string) => commit({ ...p, controlPoints: points }, merge)
  const update = (id: string, patch: Partial<ControlPoint>, merge?: string) => set(p.controlPoints.map(c => (c.id === id ? { ...c, ...patch } : c)), merge ? `cp-${id}-${merge}` : undefined)
  return (
    <>
      <p class="hint">Bekannte Punkte, an denen jeder Import den Meeresspiegel prüft. Weicht einer ab, bricht der Import ab.</p>
      {p.controlPoints.map(cp => (
        <div class="control-point" key={cp.id}>
          <div class="inline">
            <input type="text" value={cp.name} onInput={e => update(cp.id, { name: (e.target as HTMLInputElement).value }, 'name')} />
            <button class="small" title="Auf der Karte wählen" onClick={() => (tool.value = { id: 'pick', purpose: `cp:${cp.id}` })}>
              ⌖
            </button>
            <button class="small" title="Entfernen" onClick={() => set(p.controlPoints.filter(c => c.id !== cp.id))}>
              ✕
            </button>
          </div>
          <div class="inline">
            <span class="muted">{formatLonLat([cp.lon, cp.lat])}</span>
          </div>
          <div class="inline">
            <Select
              value={cp.kind}
              onChange={v => update(cp.id, { kind: v })}
              options={[
                { id: 'height' as const, name: 'Höhe' },
                { id: 'sea' as const, name: 'Meer' },
                { id: 'land' as const, name: 'Land' },
              ]}
            />
            {cp.kind === 'height' && (
              <>
                <Num value={cp.expected} onChange={v => update(cp.id, { expected: v }, 'expected')} />
                <span>±</span>
                <Num value={cp.tolerance} min={1} onChange={v => update(cp.id, { tolerance: v }, 'tolerance')} />
                <span>m</span>
              </>
            )}
          </div>
        </div>
      ))}
      <button
        class="small"
        onClick={() => {
          const id = newId('cp')
          set([...p.controlPoints, { id, name: `Punkt ${p.controlPoints.length + 1}`, lon: 0, lat: 0, kind: 'height', expected: 0, tolerance: 100 }])
          tool.value = { id: 'pick', purpose: `cp:${id}` }
        }}
      >
        ＋ Kontrollpunkt (auf der Karte klicken)
      </button>
    </>
  )
}

function RiverImport() {
  const p = project.value
  const last = p.riverImport
  const [path, setPath] = useState(last?.source ?? '')
  const [threshold, setThreshold] = useState(last?.threshold ?? 0.5)
  const [minLength, setMinLength] = useState(last?.minLengthKm ?? 40)
  const [simplify, setSimplify] = useState(last?.simplifyPx ?? 0.8)
  const [crop, setCrop] = useState(last?.cropSquare ?? false)
  return (
    <>
      <Field label="Flow- oder Rivers-Maske" hint="Gaea-Export, gleiche 2:1-Ausdehnung wie der Master" wide>
        <PathPicker value={path} onChange={setPath} title="Flussmaske aus Gaea" />
      </Field>
      <Field label="Schwelle" hint="ab welcher Helligkeit ein Pixel Fluss ist (0–1)">
        <Num value={threshold} min={0.01} max={1} step={0.05} onChange={setThreshold} />
      </Field>
      <Field label="Mindestlänge (km)">
        <Num value={minLength} min={0} onChange={setMinLength} />
      </Field>
      <Field label="Vereinfachung (px)">
        <Num value={simplify} min={0} max={5} step={0.1} onChange={setSimplify} />
      </Field>
      <Check checked={crop} onChange={setCrop} label="Quadratischen Gaea-Export: Mitte 2:1 ausschneiden" />
      <div class="button-row">
        <button class="primary" disabled={!path || !!busy.value} onClick={() => importRivers({ path, threshold, minLengthKm: minLength, simplifyPx: simplify, cropSquare: crop })}>
          {p.rivers.length ? 'Flüsse neu ableiten' : 'Flüsse ableiten'}
        </button>
      </div>
      <p class="hint">Namen, Notizen und Notes bleiben beim Neuableiten an der Linie, die am selben Ort verläuft. {!terrain.value && 'Ohne Heightmap lässt sich die Fließrichtung nicht bestimmen.'}</p>
    </>
  )
}

function KoppenImport() {
  const p = project.value
  const last = p.koppen
  const [path, setPath] = useState(last?.source ?? '')
  const [crop, setCrop] = useState(last?.cropSquare ?? false)
  const [tolerance, setTolerance] = useState(last?.tolerance ?? 18)
  const [colors, setColors] = useState<[string, number][] | null>(null)
  const assign = (hex: string, code: string) => {
    const classes: KoppenClass[] = p.koppenClasses.map(c => ({ ...c, match: c.match.filter(m => m !== hex) }))
    const target = classes.find(c => c.code === code)
    if (target) target.match = [...target.match, hex]
    commit({ ...p, koppenClasses: classes })
  }
  const owner = (hex: string) => p.koppenClasses.find(c => c.match.includes(hex))?.code ?? ''
  const unmatched = last?.unmatchedColors ?? []
  return (
    <>
      <Field label="Köppen-Karte" hint="World Orogen, Klima-Export (2:1)" wide>
        <PathPicker value={path} onChange={setPath} title="Köppen-Karte aus World Orogen" />
      </Field>
      <Field label="Farbtoleranz" hint="größter RGB-Abstand, der noch als Treffer zählt">
        <Num value={tolerance} min={0} max={120} onChange={setTolerance} />
      </Field>
      <Check checked={crop} onChange={setCrop} label="Quadratisch: Mitte 2:1 ausschneiden" />
      <div class="button-row">
        <button class="primary" disabled={!path || !!busy.value} onClick={() => importKoppen(path, crop, tolerance)}>
          {koppen.value ? 'Neu einlesen' : 'Einlesen'}
        </button>
        <button disabled={!path} onClick={async () => setColors(await platform.koppenHistogram(path))}>
          Farben der Datei zeigen
        </button>
      </div>
      {last && last.unmatched > 0.0005 && (
        <p class="warn-text">
          {(last.unmatched * 100).toFixed(2).replace('.', ',')} % der Pixel ohne Klasse. Farben unten zuordnen und neu einlesen.
        </p>
      )}
      {(colors ?? unmatched).length > 0 && (
        <table class="color-assign">
          <thead>
            <tr>
              <th>Farbe</th>
              <th class="num">Anteil</th>
              <th>Klasse</th>
            </tr>
          </thead>
          <tbody>
            {(colors ?? unmatched).map(([hex, share]) => (
              <tr key={hex}>
                <td>
                  <span class="swatch" style={{ background: hex }} /> {hex}
                </td>
                <td class="num">{(share * 100).toFixed(2).replace('.', ',')} %</td>
                <td>
                  <select value={owner(hex)} onChange={e => assign(hex, (e.target as HTMLSelectElement).value)}>
                    <option value="">— keine —</option>
                    {p.koppenClasses.map(c => (
                      <option key={c.code} value={c.code}>
                        {c.code} {c.name}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}

function Obsidian() {
  const p = project.value
  const set = (patch: Partial<typeof p.obsidian>) => patchProject({ obsidian: { ...p.obsidian, ...patch } }, 'obsidian')
  return (
    <>
      <Field label="Vault-Ordner" hint={platform.kind === 'web' ? 'Web: „https://127.0.0.1:27124|API-Key“ des Plugins Local REST API' : 'Nur dieser Ordner wird gelesen.'} wide>
        <span class="inline path-picker">
          <input type="text" value={p.obsidian.vaultPath} onInput={e => set({ vaultPath: (e.target as HTMLInputElement).value })} />
          {platform.kind === 'desktop' && (
            <button
              class="small"
              onClick={async () => {
                const folder = await platform.pickFolder('Obsidian-Vault freigeben')
                if (folder) {
                  set({ vaultPath: folder })
                  refreshVault({ ...p, obsidian: { ...p.obsidian, vaultPath: folder } })
                }
              }}
            >
              …
            </button>
          )}
        </span>
      </Field>
      <Field label="Vault-Name" hint="für obsidian://-Links; leer = Ordnername">
        <Text value={p.obsidian.vaultName} onInput={v => set({ vaultName: v })} />
      </Field>
      <div class="button-row">
        <button onClick={() => refreshVault(p)} disabled={!p.obsidian.vaultPath}>
          Vault neu einlesen
        </button>
        {vaultNotes.value && <span class="muted">{vaultNotes.value.length} Notes</span>}
      </div>
      {vaultError.value && <p class="error-text">{vaultError.value}</p>}
      {vaultError.value && platform.mobile && <p class="hint">Android: In den App-Infos unter Berechtigungen „Zugriff auf alle Dateien“ erlauben, dann den Vault neu einlesen.</p>}
      <p class="hint">Lesbar ist nur echtes Frontmatter; Werte, die erst Dataview berechnet, stehen nicht in der Datei.</p>
    </>
  )
}

function Export() {
  const [layers, setLayers] = useState<EntityKind[]>(EXPORT_LAYERS.filter(k => k !== 'label' && k !== 'regiment'))
  const [clip, setClip] = useState(true)
  const [withFrontmatter, setWithFrontmatter] = useState(false)
  const [perLayer, setPerLayer] = useState(true)
  return (
    <>
      <h4>GeoJSON für GPlates</h4>
      <div class="chips">
        {EXPORT_LAYERS.map(kind => (
          <label key={kind} class={`chip${layers.includes(kind) ? ' on' : ''}`}>
            <input type="checkbox" checked={layers.includes(kind)} onChange={e => setLayers((e.target as HTMLInputElement).checked ? [...layers, kind] : layers.filter(k => k !== kind))} />
            {KIND_NAMES[kind][1]}
          </label>
        ))}
      </div>
      <Check checked={clip} onChange={setClip} label="Flächen an der Küste zuschneiden" />
      <Check checked={withFrontmatter} onChange={setWithFrontmatter} label="Frontmatter verknüpfter Notes mitnehmen" />
      {platform.kind === 'desktop' && <Check checked={perLayer} onChange={setPerLayer} label="Eine Datei je Ebene (in einen Ordner)" />}
      <div class="button-row">
        <button class="primary" disabled={!layers.length} onClick={() => exportGeoJson({ layers, clipToLand: clip, frontmatter: withFrontmatter, perLayer })}>
          GeoJSON exportieren
        </button>
      </div>
      <p class="hint">Koordinaten in Grad (−180…180, −90…90). In GPlates bekommen die Elemente über „Assign Plate IDs“ die Plate-ID ihres Blocks.</p>
      <h4>Kartendaten</h4>
      <div class="button-row">
        <button onClick={() => exportJson()}>JSON exportieren</button>
      </div>
    </>
  )
}

export function ProjectPanel() {
  const p = project.value
  return (
    <div class="panel">
      <Section title="Projekt">
        <Field label="Name">
          <Text value={p.name} onInput={v => patchProject({ name: v }, 'name')} />
        </Field>
        <Field label="Planetenradius (m)" hint="Kugel; nur für Entfernungen und Flächen – alle Daten liegen in Grad">
          <Num value={p.planetRadius} min={1000} onChange={v => patchProject({ planetRadius: v }, 'radius')} />
        </Field>
      </Section>
      {platform.mobile ? (
        <>
          <Section title="Gelände">
            <TerrainInfo />
          </Section>
          {p.imageLayers.length > 0 && (
            <Section title="Bildebenen">
              <ImageLayers />
            </Section>
          )}
        </>
      ) : (
        <>
          <Section title="Heightmap (Gaea)">
            <TerrainImport />
          </Section>
          <Section title="Satellitenbild (Gaea)" open={false}>
            <SatelliteImport />
          </Section>
          <Section title="Bildebenen" open={false}>
            <ImageLayers />
          </Section>
          <Section title="Kontrollpunkte" open={p.controlPoints.length === 0}>
            <ControlPoints />
          </Section>
          <Section title="Flüsse (Gaea-Maske)" open={false}>
            <RiverImport />
          </Section>
          <Section title="Klima (Köppen)" open={false}>
            <KoppenImport />
          </Section>
        </>
      )}
      <Section title="Obsidian" open={false}>
        <Obsidian />
      </Section>
      <Section title="Export" open={false}>
        <Export />
      </Section>
      <Section title="Archiv (.veilmap)" open={false}>
        <Archive />
      </Section>
    </div>
  )
}
