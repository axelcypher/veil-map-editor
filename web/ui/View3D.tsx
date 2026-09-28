// Floating 3D window: the imported terrain with the current map draped over it, or the globe with
// its settings and the picture and animation exports.
import { useEffect, useRef, useState } from 'preact/hooks'
import { busy, notify, patchProject, project } from '../model/store'
import { gridHeight, imageLayerData, satellite, terrain, type TerrainState } from '../model/terrain'
import type { GlobeOptions } from '../model/types'
import { platform } from '../platform'
import { slopeTexture } from '../view3d/globe'
import { globeGif, globePng, globeWebm, webmSupported, type GlobeScene } from '../view3d/globeExport'
import { Viewer, type TerrainPatch } from '../view3d/viewer'
import { Check, Color, Field, Num, Range, Select } from './components'
import { mapView } from './mapRef'

function patchFromView(): TerrainPatch | null {
  const view = mapView.current
  const t = terrain.value
  if (!view || !t) return null
  const [west, south, east, north] = view.viewExtent().map((v, i) => (i % 2 ? Math.max(-90, Math.min(90, v)) : Math.max(-180, Math.min(180, v))))
  const aspect = (east - west) / Math.max(1e-6, north - south)
  // not finer than the grid itself, not more than 512 samples across
  const gridStep = 360 / t.meta.gridWidth
  const width = Math.max(32, Math.min(512, Math.round((east - west) / gridStep)))
  const height = Math.max(16, Math.round(width / aspect))
  const heights = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    const lat = north - ((y + 0.5) / height) * (north - south)
    for (let x = 0; x < width; x++) {
      const lon = west + ((x + 0.5) / width) * (east - west)
      heights[y * width + x] = gridHeight([lon, lat]) ?? 0
    }
  }
  // colours: what the map shows, cut to the same box
  const snapshot = view.snapshot()
  const size = view.map.getSize() ?? [1, 1]
  const full = view.viewExtent()
  const sx = ((west - full[0]) / (full[2] - full[0])) * size[0]
  const sy = ((full[3] - north) / (full[3] - full[1])) * size[1]
  const sw = ((east - west) / (full[2] - full[0])) * size[0]
  const sh = ((north - south) / (full[3] - full[1])) * size[1]
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(snapshot, sx, sy, sw, sh, 0, 0, width, height)
  const colors = new Uint8Array(ctx.getImageData(0, 0, width, height).data.buffer)
  const radiusKm = project.value.planetRadius / 1000
  const midLat = ((north + south) / 2) * (Math.PI / 180)
  return {
    width,
    height,
    heights,
    colors,
    widthKm: (((east - west) * Math.PI) / 180) * radiusKm * Math.cos(midLat),
    heightKm: (((north - south) * Math.PI) / 180) * radiusKm,
  }
}

const slopes = new WeakMap<TerrainState, ReturnType<typeof slopeTexture>>()
function slopeFromTerrain() {
  const t = terrain.value
  if (!t) return null
  let slope = slopes.get(t)
  if (!slope) {
    slope = slopeTexture(t.grid, t.meta.gridWidth, t.meta.gridHeight, project.value.planetRadius)
    slopes.set(t, slope)
  }
  return slope
}

async function worldPicture(source: GlobeOptions['source']) {
  const view = mapView.current!
  if (source.startsWith('img:')) {
    if (imageLayerData.value.has(source.slice(4))) return view.renderWorld(4096, [source as `img:${string}`])
    notify('Diese Bildebene ist nicht geladen – der Globus zeigt die Karte.')
    return view.renderWorld(4096)
  }
  if (source === 'satellite' && !satellite.value) {
    notify('Kein Satellitenbild importiert – der Globus zeigt die Karte.')
    return view.renderWorld(4096)
  }
  if (source === 'relief' && !terrain.value) return view.renderWorld(4096)
  return view.renderWorld(4096, source === 'map' ? undefined : [source])
}

const SOURCES = [
  { id: 'map' as const, name: 'Karte wie angezeigt' },
  { id: 'satellite' as const, name: 'Satellitenbild' },
  { id: 'relief' as const, name: 'Relief (Höhenfarben)' },
]
const BACKGROUNDS = [
  { id: 'stars' as const, name: 'Sternenhimmel' },
  { id: 'color' as const, name: 'Farbe' },
  { id: 'transparent' as const, name: 'Transparent' },
]
const STEPS = ['5', '10', '15', '20', '30'].map(v => ({ id: v, name: `${v}°` }))

function GlobeSettings({ viewer }: { viewer: Viewer | null }) {
  const g = project.value.globe
  const set = (patch: Partial<GlobeOptions>) => patchProject({ globe: { ...g, ...patch } }, 'globe')
  const part = <K extends 'sun' | 'atmosphere' | 'graticule' | 'clouds' | 'background' | 'export'>(key: K, patch: Partial<GlobeOptions[K]>) =>
    set({ [key]: { ...g[key], ...patch } } as Partial<GlobeOptions>)
  const scene = (): GlobeScene | null => {
    if (!viewer?.world) {
      notify('Der Globus ist noch nicht geladen.', 'error')
      return null
    }
    return { world: viewer.world, slope: viewer.slope, options: g, frame: viewer.globeFrame() }
  }
  const name = project.value.name || 'globus'
  const save = async (kind: 'png' | 'gif' | 'webm') => {
    const s = scene()
    if (!s || busy.value) return
    const labels = { png: 'PNG-Bild', gif: 'GIF-Animation', webm: 'WebM-Video' }
    const path = await platform.pickSavePath(`Globus als ${labels[kind]}`, `${name}-globus.${kind}`, [{ name: labels[kind], extensions: [kind] }])
    if (!path) return
    busy.value = { stage: `${labels[kind]} rendern`, fraction: 0 }
    const progress = (fraction: number) => (busy.value = { stage: `${labels[kind]} rendern`, fraction })
    try {
      const bytes =
        kind === 'png' ? await globePng(s, g.export.width, g.export.height) : kind === 'gif' ? await globeGif(s, progress) : await globeWebm(s, progress)
      busy.value = { stage: 'Speichern', fraction: 1 }
      await platform.writeBinary(path, bytes)
      notify(`${labels[kind]} gespeichert (${(bytes.length / 1e6).toFixed(1).replace('.', ',')} MB).`, 'ok')
    } catch (error) {
      notify(`Export fehlgeschlagen: ${error instanceof Error ? error.message : error}`, 'error')
    } finally {
      busy.value = null
    }
  }
  const e = g.export
  return (
    <div class="globe-settings">
      <h4>Bild</h4>
      <Field label="Oberfläche">
        <Select
          value={g.source}
          onChange={v => set({ source: v })}
          options={[...SOURCES, ...project.value.imageLayers.map(l => ({ id: `img:${l.id}` as const, name: `Bildebene: ${l.name}` }))]}
        />
      </Field>
      <Field label="Relief">
        <Range value={g.relief} min={0} max={4} step={0.1} onChange={v => set({ relief: v })} />
      </Field>
      <Field label="Blickwinkel (°)">
        <Range value={g.fov} min={10} max={70} step={1} onChange={v => set({ fov: v })} />
      </Field>

      <h4>Drehung</h4>
      <Check checked={g.rotate} onChange={v => set({ rotate: v })} label="Drehen" />
      <Field label="Tempo (°/s)" hint="negativ: andere Richtung">
        <Range value={g.speed} min={-90} max={90} step={1} onChange={v => set({ speed: v })} />
      </Field>
      <Field label="Achsneigung (°)">
        <Range value={g.tilt} min={-45} max={45} step={0.5} onChange={v => set({ tilt: v })} />
      </Field>

      <h4>
        <Check checked={g.sun.on} onChange={v => part('sun', { on: v })} label="Sonne und Nacht" />
      </h4>
      {g.sun.on && (
        <>
          <Field label="Richtung (°)">
            <Range value={g.sun.azimuth} min={-180} max={180} step={1} onChange={v => part('sun', { azimuth: v })} />
          </Field>
          <Field label="Höhe (°)">
            <Range value={g.sun.elevation} min={-80} max={80} step={1} onChange={v => part('sun', { elevation: v })} />
          </Field>
          <Field label="Nachthelligkeit">
            <Range value={g.sun.night} min={0} max={0.6} step={0.01} onChange={v => part('sun', { night: v })} />
          </Field>
          <Field label="Dämmerung">
            <Range value={g.sun.softness} min={0.02} max={0.6} step={0.01} onChange={v => part('sun', { softness: v })} />
          </Field>
        </>
      )}

      <h4>
        <Check checked={g.atmosphere.on} onChange={v => part('atmosphere', { on: v })} label="Atmosphäre" />
      </h4>
      {g.atmosphere.on && (
        <>
          <Field label="Farbe">
            <Color value={g.atmosphere.color} onChange={v => part('atmosphere', { color: v })} />
          </Field>
          <Field label="Stärke">
            <Range value={g.atmosphere.strength} min={0} max={2} step={0.05} onChange={v => part('atmosphere', { strength: v })} />
          </Field>
          <Field label="Dicke">
            <Range value={g.atmosphere.thickness} min={0.01} max={0.3} step={0.01} onChange={v => part('atmosphere', { thickness: v })} />
          </Field>
        </>
      )}

      <h4>
        <Check checked={g.clouds.on} onChange={v => part('clouds', { on: v })} label="Wolken" />
      </h4>
      {g.clouds.on && (
        <>
          <Field label="Bedeckung">
            <Range value={g.clouds.cover} min={0} max={1} step={0.01} onChange={v => part('clouds', { cover: v })} />
          </Field>
          <Field label="Deckkraft">
            <Range value={g.clouds.opacity} min={0} max={1} step={0.05} onChange={v => part('clouds', { opacity: v })} />
          </Field>
          <Field label="Größe">
            <Range value={g.clouds.scale} min={1} max={10} step={0.1} onChange={v => part('clouds', { scale: v })} />
          </Field>
          <Field label="Muster">
            <Num value={g.clouds.seed} min={0} step={1} onChange={v => part('clouds', { seed: v })} />
          </Field>
          <Field label="Zug" hint="Extra-Umläufe je Umdrehung; ganze Zahlen loopen nahtlos">
            <Range value={g.clouds.turns} min={-2} max={2} step={1} onChange={v => part('clouds', { turns: v })} />
          </Field>
        </>
      )}

      <h4>
        <Check checked={g.graticule.on} onChange={v => part('graticule', { on: v })} label="Gradnetz" />
      </h4>
      {g.graticule.on && (
        <>
          <Field label="Abstand">
            <Select value={String(g.graticule.step)} onChange={v => part('graticule', { step: Number(v) })} options={STEPS} />
          </Field>
          <Field label="Farbe">
            <Color value={g.graticule.color} onChange={v => part('graticule', { color: v })} />
          </Field>
          <Field label="Deckkraft">
            <Range value={g.graticule.opacity} min={0.05} max={1} step={0.05} onChange={v => part('graticule', { opacity: v })} />
          </Field>
        </>
      )}

      <h4>Hintergrund</h4>
      <Field label="Art">
        <Select value={g.background.kind} onChange={v => part('background', { kind: v })} options={BACKGROUNDS} />
      </Field>
      {g.background.kind !== 'transparent' && (
        <Field label="Farbe">
          <Color value={g.background.color} onChange={v => part('background', { color: v })} />
        </Field>
      )}

      <h4>Export</h4>
      <Field label="Größe (px)">
        <span class="inline">
          <Num value={e.width} min={64} max={8192} step={10} onChange={v => part('export', { width: Math.round(v) })} />
          <span>×</span>
          <Num value={e.height} min={64} max={8192} step={10} onChange={v => part('export', { height: Math.round(v) })} />
        </span>
      </Field>
      <Field label="Bilder je Umdrehung" hint={`eine Umdrehung dauert ${(e.frames / e.fps).toFixed(1).replace('.', ',')} s`}>
        <Num value={e.frames} min={8} max={720} step={1} onChange={v => part('export', { frames: Math.round(v) })} />
      </Field>
      <Field label="Bilder je Sekunde">
        <Num value={e.fps} min={1} max={60} step={1} onChange={v => part('export', { fps: Math.round(v) })} />
      </Field>
      <div class="button-row">
        <button disabled={!!busy.value} onClick={() => save('png')}>
          Bild (PNG)
        </button>
        <button disabled={!!busy.value} onClick={() => save('gif')}>
          GIF
        </button>
        {webmSupported() && (
          <button disabled={!!busy.value} onClick={() => save('webm')}>
            Video (WebM)
          </button>
        )}
      </div>
      <p class="hint">
        Animationen zeigen eine ganze Umdrehung ab der aktuellen Ansicht und laufen nahtlos im Kreis. GIF hat höchstens 256 Farben je Bild; ~500 px halten die Datei klein. Transparenz: PNG voll, GIF nur an/aus.
      </p>
    </div>
  )
}

export function View3D({ onClose }: { onClose: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const viewer = useRef<Viewer | null>(null)
  const [mode, setMode] = useState<'terrain' | 'globe'>('terrain')
  const [settings, setSettings] = useState(true)
  const [exaggeration, setExaggeration] = useState(12)
  const [position, setPosition] = useState({ x: 80, y: 80 })
  const globe = project.value.globe
  useEffect(() => {
    if (!canvas.current) return
    try {
      viewer.current = new Viewer(
        canvas.current,
        { terrain: patchFromView, world: worldPicture, slope: slopeFromTerrain },
        project.peek().globe,
      )
      viewer.current.exaggeration = exaggeration
      viewer.current.resize()
      viewer.current.update().catch(error => notify(`3D-Ansicht: ${error}`, 'error'))
    } catch (error) {
      notify(String(error), 'error')
    }
    const observer = new ResizeObserver(() => viewer.current?.resize())
    observer.observe(canvas.current)
    return () => {
      observer.disconnect()
      viewer.current?.dispose()
    }
  }, [])
  useEffect(() => {
    viewer.current?.setGlobeOptions(globe)
  }, [globe])
  const drag = (event: PointerEvent) => {
    if ((event.target as HTMLElement).closest('button, input, select, label')) return
    const start = { x: event.clientX - position.x, y: event.clientY - position.y }
    const move = (e: PointerEvent) => setPosition({ x: e.clientX - start.x, y: e.clientY - start.y })
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return (
    <div class={`view3d${mode === 'globe' && settings ? ' with-settings' : ''}`} style={{ left: `${position.x}px`, top: `${position.y}px` }}>
      <header onPointerDown={drag}>
        <strong>3D-Ansicht</strong>
        <span class="seg">
          <button class={mode === 'terrain' ? 'active' : ''} onClick={() => { setMode('terrain'); viewer.current?.setMode('terrain') }}>
            Gelände
          </button>
          <button
            class={mode === 'globe' ? 'active' : ''}
            onClick={() => {
              setMode('globe')
              const [lon, lat] = (mapView.current?.map.getView().getCenter() ?? [0, 20]) as number[]
              viewer.current?.setMode('globe')
              viewer.current?.centerGlobe(lon, lat)
            }}
          >
            Globus
          </button>
        </span>
        {mode === 'terrain' && (
          <label title="Überhöhung">
            ↕ <input type="range" min={1} max={60} value={exaggeration} onInput={e => {
              const v = Number((e.target as HTMLInputElement).value)
              setExaggeration(v)
              if (viewer.current) {
                viewer.current.exaggeration = v
                viewer.current.draw()
              }
            }} /> {exaggeration}×
          </label>
        )}
        {mode === 'globe' && (
          <button class={`small${settings ? ' active' : ''}`} onClick={() => setSettings(!settings)} title="Globus-Einstellungen und Export">
            ⚙
          </button>
        )}
        <button class="small" onClick={() => viewer.current?.update().catch(error => notify(`3D-Ansicht: ${error}`, 'error'))} title="Aktuelle Karte übernehmen">
          ⟳
        </button>
        <button class="icon" onClick={onClose} aria-label="Schließen">
          ✕
        </button>
      </header>
      <div class="view3d-body">
        {!terrain.value && mode === 'terrain' && <p class="overlay-hint">Erst eine Heightmap importieren.</p>}
        <canvas ref={canvas} class={mode === 'globe' && globe.background.kind === 'transparent' ? 'checker' : ''} />
        {mode === 'globe' && settings && <GlobeSettings viewer={viewer.current} />}
      </div>
      <footer class="muted">
        {mode === 'globe' ? 'Ziehen dreht · Mausrad/zwei Finger zoomen.' : 'Linke Maustaste drehen · rechte verschieben · Mausrad zoomen. Gezeigt wird der aktuelle Kartenausschnitt.'}
      </footer>
    </div>
  )
}
