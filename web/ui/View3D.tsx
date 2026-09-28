// Floating 3D window: the imported terrain with the current map draped over it, or the globe.
import { useEffect, useRef, useState } from 'preact/hooks'
import { notify, project } from '../model/store'
import { gridHeight, terrain } from '../model/terrain'
import { Viewer, type TerrainPatch } from '../view3d/viewer'
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

export function View3D({ onClose }: { onClose: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const viewer = useRef<Viewer | null>(null)
  const [mode, setMode] = useState<'terrain' | 'globe'>('terrain')
  const [exaggeration, setExaggeration] = useState(12)
  const [position, setPosition] = useState({ x: 80, y: 80 })
  useEffect(() => {
    if (!canvas.current) return
    try {
      viewer.current = new Viewer(canvas.current, {
        terrain: patchFromView,
        world: () => mapView.current!.renderWorld(4096),
      })
      viewer.current.exaggeration = exaggeration
      viewer.current.resize()
      viewer.current.update().catch(error => notify(`3D-Ansicht: ${error}`, 'error'))
    } catch (error) {
      notify(String(error), 'error')
    }
    const observer = new ResizeObserver(() => viewer.current?.resize())
    observer.observe(canvas.current)
    return () => observer.disconnect()
  }, [])
  const drag = (event: PointerEvent) => {
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
    <div class="view3d" style={{ left: `${position.x}px`, top: `${position.y}px` }}>
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
        <button class="small" onClick={() => viewer.current?.update().catch(error => notify(`3D-Ansicht: ${error}`, 'error'))} title="Aktuellen Kartenausschnitt übernehmen">
          ⟳ Aktualisieren
        </button>
        <button class="icon" onClick={onClose} aria-label="Schließen">
          ✕
        </button>
      </header>
      {!terrain.value && mode === 'terrain' && <p class="overlay-hint">Erst eine Heightmap importieren.</p>}
      <canvas ref={canvas} />
      <footer class="muted">Linke Maustaste drehen · rechte verschieben · Mausrad zoomen. Gezeigt wird der aktuelle Kartenausschnitt.</footer>
    </div>
  )
}
