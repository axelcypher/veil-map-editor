import { effect } from '@preact/signals'
import { useEffect, useRef, useState } from 'preact/hooks'
import { confirmRequest, editGeometry, handleArea, handleCreate, newFile, openFile, recentFiles, saveFile } from '../model/actions'
import { MapView } from '../map/MapView'
import { canRedo, canUndo, commit, projectLoaded, dirty, notices, notify, picked, project, redo, removeEntity, selection, tool, undo, type Tool } from '../model/store'
import { clipVersion, koppen, terrain } from '../model/terrain'
import { refreshVault } from '../model/obsidian'
import type { LonLat } from '../model/types'
import { Inspector } from './Inspector'
import { LayersPanel } from './LayersPanel'
import { Compass, measurement, ScaleBar, ToolOptions, viewInfo } from './MapChrome'
import { mapView } from './mapRef'
import { Overviews, type OverviewId } from './Overviews'
import { ProjectPanel } from './ProjectPanel'
import { StylePanel } from './StylePanel'
import { hover, PointInfo, StatusBar } from './StatusBar'
import { View3D } from './View3D'
import { Modal } from './components'

type Panel = 'layers' | 'data' | 'style' | 'project'

interface ToolButton {
  icon: string
  name: string
  tool: Tool
  key?: string
}
const TOOL_GROUPS: ToolButton[][] = [
  [{ icon: '➤', name: 'Auswählen und verschieben', tool: { id: 'select' }, key: 'v' }],
  [
    { icon: '●', name: 'Stadt setzen', tool: { id: 'place', kind: 'city' }, key: 'c' },
    { icon: '📍', name: 'Marker setzen', tool: { id: 'place', kind: 'marker' }, key: 'm' },
    { icon: 'A', name: 'Beschriftung setzen', tool: { id: 'place', kind: 'label' }, key: 't' },
    { icon: '〰', name: 'Beschriftung entlang einer Linie', tool: { id: 'draw-line', kind: 'label' } },
    { icon: '⤳', name: 'Route zeichnen', tool: { id: 'draw-line', kind: 'route' }, key: 'r' },
    { icon: '⚑', name: 'Regiment setzen', tool: { id: 'place', kind: 'regiment' } },
  ],
  [
    { icon: '♛', name: 'Neuer Staat (Umriss zeichnen)', tool: { id: 'area-new', kind: 'state' } },
    { icon: '▦', name: 'Neue Provinz', tool: { id: 'area-new', kind: 'province' } },
    { icon: '♫', name: 'Neue Kultur', tool: { id: 'area-new', kind: 'culture' } },
    { icon: '☩', name: 'Neue Religion', tool: { id: 'area-new', kind: 'religion' } },
    { icon: '▨', name: 'Neue Zone', tool: { id: 'area-new', kind: 'zone' } },
  ],
  [
    { icon: '📏', name: 'Lineal (Großkreis)', tool: { id: 'measure', mode: 'ruler' } },
    { icon: '➰', name: 'Opisometer (Weglänge)', tool: { id: 'measure', mode: 'path' } },
    { icon: '⬠', name: 'Planimeter (Fläche)', tool: { id: 'measure', mode: 'area' } },
  ],
]

const sameTool = (a: Tool, b: Tool) => JSON.stringify(a) === JSON.stringify(b)

function Toolbar() {
  const current = tool.value
  return (
    <nav class="toolbar" aria-label="Werkzeuge">
      {TOOL_GROUPS.map((group, i) => (
        <div class="tool-group" key={i}>
          {group.map(button => (
            <button
              key={button.name}
              class={sameTool(current, button.tool) ? 'active' : ''}
              title={`${button.name}${button.key ? ` (${button.key.toUpperCase()})` : ''}`}
              onClick={() => (tool.value = sameTool(current, button.tool) ? { id: 'select' } : button.tool)}
            >
              {button.icon}
            </button>
          ))}
        </div>
      ))}
    </nav>
  )
}

function FileMenu({ onClose }: { onClose: () => void }) {
  return (
    <div class="menu" onMouseLeave={onClose}>
      <button onClick={() => { onClose(); newFile() }}>Neues Projekt</button>
      <button onClick={() => { onClose(); openFile() }}>Öffnen …</button>
      <button onClick={() => { onClose(); saveFile() }}>Speichern</button>
      <button onClick={() => { onClose(); saveFile(true) }}>Speichern unter …</button>
      {recentFiles.value.length > 0 && <hr />}
      {recentFiles.value.map(path => (
        <button key={path} class="recent" title={path} onClick={() => { onClose(); openFile(path) }}>
          {path.split(/[\\/]/).pop()}
        </button>
      ))}
    </div>
  )
}

function Header({ panel, setPanel, show3d }: { panel: Panel; setPanel: (p: Panel) => void; show3d: () => void }) {
  const [menu, setMenu] = useState(false)
  return (
    <header class="app-header">
      <div class="brand">Veil</div>
      <div class="menu-anchor">
        <button onClick={() => setMenu(!menu)}>Datei ▾</button>
        {menu && <FileMenu onClose={() => setMenu(false)} />}
      </div>
      <button onClick={() => saveFile()} title="Speichern (Strg+S)" disabled={!dirty.value}>
        💾
      </button>
      <button onClick={undo} disabled={!canUndo.value} title="Rückgängig (Strg+Z)">
        ↶
      </button>
      <button onClick={redo} disabled={!canRedo.value} title="Wiederholen (Strg+Y)">
        ↷
      </button>
      <span class="project-name">{project.value.name}</span>
      <span class="spacer" />
      <nav class="panel-tabs">
        {([
          ['layers', 'Ebenen'],
          ['data', 'Daten'],
          ['style', 'Stil'],
          ['project', 'Projekt'],
        ] as [Panel, string][]).map(([id, name]) => (
          <button key={id} class={panel === id ? 'active' : ''} onClick={() => setPanel(id)}>
            {name}
          </button>
        ))}
      </nav>
      <button onClick={show3d} title="3D-Gelände und Globus">
        🌐 3D
      </button>
    </header>
  )
}

function Notices() {
  return (
    <div class="notices" aria-live="polite">
      {notices.value.map(n => (
        <div key={n.id} class={`notice ${n.kind}`}>
          {n.text}
        </div>
      ))}
    </div>
  )
}

function ConfirmDialog() {
  const request = confirmRequest.value
  if (!request) return null
  const answer = (ok: boolean) => {
    confirmRequest.value = null
    request.resolve(ok)
  }
  return (
    <Modal
      title="Bitte bestätigen"
      onClose={() => answer(false)}
      footer={
        <>
          <button onClick={() => answer(false)}>Abbrechen</button>
          <button class="primary" onClick={() => answer(true)}>
            Ja
          </button>
        </>
      }
    >
      <p>{request.text}</p>
    </Modal>
  )
}

function useMap(container: { current: HTMLDivElement | null }) {
  useEffect(() => {
    if (!container.current) return
    const view = new MapView(container.current, project.value, {
      select: (kind, id) => (selection.value = kind && id ? { kind, id } : null),
      create: (t, geometry) => handleCreate(t, geometry),
      editGeometry: (kind, id, geometry) => editGeometry(kind, id, geometry),
      area: (t, polygon, at) => handleArea(t, polygon, at),
      pick: (purpose, at) => {
        picked.value = { purpose, lonLat: at }
        tool.value = { id: 'select' }
      },
      hover: at => (hover.value = at),
      measure: result => (measurement.value = result),
      view: (center: LonLat, zoom: number) => {
        // saved with the project, but neither an undo step nor a reason to redraw
        project.peek().view = { center, zoom }
      },
    })
    mapView.current = view
    const updateInfo = () => {
      const v = view.map.getView()
      viewInfo.value = { resolution: v.getResolution() ?? 1, centerLat: (v.getCenter() ?? [0, 0])[1], rotation: v.getRotation() }
    }
    view.map.on('postrender', updateInfo)
    const stops = [
      effect(() => view.applyProject(project.value)),
      effect(() => {
        if (projectLoaded.value) view.fitWorldIfDefault(project.peek())
      }),
      effect(() => view.setSelection(selection.value)),
      effect(() => view.setTool(tool.value)),
      effect(() => {
        const t = terrain.value
        view.setTerrain(t?.meta ?? null)
        view.setLand(t?.land ?? null)
      }),
      effect(() => view.setKoppen(koppen.value, project.value.koppenClasses)),
      effect(() => {
        void clipVersion.value
        view.refreshAreas()
      }),
    ]
    return () => stops.forEach(stop => stop())
  }, [])
}

/** control points picked on the map */
function usePicks() {
  useEffect(
    () =>
      effect(() => {
        const pick = picked.value
        if (!pick) return
        picked.value = null
        if (pick.purpose.startsWith('cp:')) {
          const id = pick.purpose.slice(3)
          const p = project.peek()
          const [lon, lat] = pick.lonLat
          commit({ ...p, controlPoints: p.controlPoints.map(c => (c.id === id ? { ...c, lon: Math.round(lon * 1e4) / 1e4, lat: Math.round(lat * 1e4) / 1e4 } : c)) })
          notify('Kontrollpunkt gesetzt.', 'ok')
        }
      }),
    [],
  )
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT'
      const ctrl = event.ctrlKey || event.metaKey
      if (ctrl && event.key.toLowerCase() === 's') {
        event.preventDefault()
        saveFile(event.shiftKey)
        return
      }
      if (ctrl && event.key.toLowerCase() === 'o') {
        event.preventDefault()
        openFile()
        return
      }
      if (typing) return
      if (ctrl && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        event.shiftKey ? redo() : undo()
      } else if (ctrl && event.key.toLowerCase() === 'y') {
        event.preventDefault()
        redo()
      } else if (event.key === 'Escape') {
        if (tool.value.id !== 'select') tool.value = { id: 'select' }
        else selection.value = null
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && selection.value) {
        removeEntity(selection.value.kind, selection.value.id)
      } else if (!ctrl && !event.altKey) {
        const button = TOOL_GROUPS.flat().find(b => b.key === event.key.toLowerCase())
        if (button) tool.value = button.tool
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

export function App() {
  const container = useRef<HTMLDivElement>(null)
  const [panel, setPanel] = useState<Panel>('data')
  const [overview, setOverview] = useState<OverviewId>('states')
  const [show3d, setShow3d] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(() => Number(localStorage.getItem('veil.sidebar') ?? 420))
  useMap(container)
  usePicks()
  useShortcuts()
  useEffect(() => {
    refreshVault(project.value)
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty.value) event.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])
  useEffect(() => {
    mapView.current?.map.updateSize()
  }, [sidebarWidth])
  const resize = (event: PointerEvent) => {
    const startX = event.clientX
    const start = sidebarWidth
    const move = (e: PointerEvent) => setSidebarWidth(Math.max(300, Math.min(900, start + e.clientX - startX)))
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      try {
        localStorage.setItem('veil.sidebar', String(sidebarWidth))
      } catch {
        /* storage blocked */
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return (
    <div class="app">
      <Header panel={panel} setPanel={setPanel} show3d={() => setShow3d(!show3d)} />
      <div class="workspace">
        <aside class="sidebar" style={{ width: `${sidebarWidth}px` }}>
          {panel === 'layers' && <LayersPanel />}
          {panel === 'data' && <Overviews active={overview} onChange={setOverview} />}
          {panel === 'style' && <StylePanel />}
          {panel === 'project' && <ProjectPanel />}
        </aside>
        <div class="sidebar-resize" onPointerDown={resize} onDblClick={() => setSidebarWidth(420)} />
        <Toolbar />
        <main class="map-area">
          <div ref={container} class="map" />
          <ToolOptions />
          <Compass />
          <ScaleBar />
          <PointInfo />
          {!terrain.value && (
            <div class="empty-map">
              <p>Noch kein Gelände geladen.</p>
              <button class="primary" onClick={() => setPanel('project')}>
                Heightmap importieren
              </button>
            </div>
          )}
        </main>
        <Inspector />
      </div>
      <StatusBar />
      {show3d && <View3D onClose={() => setShow3d(false)} />}
      <Notices />
      <ConfirmDialog />
    </div>
  )
}
