import { effect } from '@preact/signals'
import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { CultureIcon, GlobeIcon, PathMeasureIcon, PinIcon, RegimentIcon, RulerIcon, SaveIcon } from './icons'
import logoUrl from '../assets/logo.svg'
import { platform } from '../platform'
import { autoCheck, checkAtStartup, checkForUpdate } from '../model/update'
import { confirmDialog, confirmRequest, editGeometry, handleArea, handleCreate, offerRecovery, reshapeRoute, startRecovery, newFile, openFile, recentFiles, saveArchive, saveFile } from '../model/actions'
import { MapView } from '../map/MapView'
import { canRedo, canUndo, commit, projectLoaded, dirty, notices, notify, picked, project, redo, removeEntity, selection, tool, undo, type Tool } from '../model/store'
import { clipVersion, imageLayerData, koppen, satellite, terrain } from '../model/terrain'
import { refreshVault } from '../model/obsidian'
import type { LonLat } from '../model/types'
import { Inspector } from './Inspector'
import { LayersPanel } from './LayersPanel'
import { Compass, measurement, ScaleBar, ToolOptions, viewInfo } from './MapChrome'
import { mapView } from './mapRef'
import { Overviews, type OverviewId } from './Overviews'
import { ProjectPanel } from './ProjectPanel'
import { StylePanel } from './StylePanel'
import { StateDialogs } from './StateDialogs'
import { Tooltip } from './Tooltip'
import { hover, PointInfo, StatusBar } from './StatusBar'
import { View3D } from './View3D'
import { Modal } from './components'

type Panel = 'layers' | 'data' | 'style' | 'project'

interface ToolButton {
  icon: ComponentChildren
  name: string
  tool: Tool
  key?: string
}
const TOOL_GROUPS: ToolButton[][] = [
  [{ icon: '➤', name: 'Auswählen und verschieben', tool: { id: 'select' }, key: 'v' }],
  [
    { icon: '●', name: 'Stadt setzen', tool: { id: 'place', kind: 'city' }, key: 'c' },
    { icon: <PinIcon />, name: 'Marker setzen', tool: { id: 'place', kind: 'marker' }, key: 'm' },
    { icon: '⤳', name: 'Route zeichnen', tool: { id: 'draw-line', kind: 'route' }, key: 'r' },
    { icon: <RegimentIcon />, name: 'Regiment setzen', tool: { id: 'place', kind: 'regiment' } },
  ],
  [
    { icon: '♛', name: 'Neuer Staat (Umriss zeichnen)', tool: { id: 'area-new', kind: 'state' } },
    { icon: '▦', name: 'Neue Provinz', tool: { id: 'area-new', kind: 'province' } },
    { icon: <CultureIcon />, name: 'Neue Kultur', tool: { id: 'area-new', kind: 'culture' } },
    { icon: '☩', name: 'Neue Religion', tool: { id: 'area-new', kind: 'religion' } },
    { icon: '▨', name: 'Neue Zone', tool: { id: 'area-new', kind: 'zone' } },
  ],
  [
    { icon: 'A', name: 'Beschriftung setzen', tool: { id: 'place', kind: 'label' }, key: 't' },
    { icon: '〰', name: 'Beschriftung entlang einer Linie', tool: { id: 'draw-line', kind: 'label' } },
  ],
  [
    { icon: <RulerIcon />, name: 'Lineal (Großkreis)', tool: { id: 'measure', mode: 'ruler' } },
    { icon: <PathMeasureIcon />, name: 'Opisometer (Weglänge)', tool: { id: 'measure', mode: 'path' } },
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

function FileMenu({ onClose, at }: { onClose: () => void; at: { left: number; top: number } }) {
  const box = useRef<HTMLDivElement>(null)
  // a tap or click anywhere else closes it (touch screens have no mouse leaving)
  useEffect(() => {
    const away = (event: PointerEvent) => {
      const target = event.target as Node
      if (!box.current?.contains(target) && !(target as Element).closest?.('.brand')) onClose()
    }
    window.addEventListener('pointerdown', away)
    return () => window.removeEventListener('pointerdown', away)
  }, [])
  return (
    <div class="menu file-menu" ref={box} style={{ left: `${at.left}px`, top: `${at.top}px` }} onMouseLeave={onClose}>
      <button onClick={() => { onClose(); newFile() }}>Neues Projekt</button>
      <button onClick={() => { onClose(); openFile() }}>Öffnen …</button>
      <button onClick={() => { onClose(); saveFile() }}>Speichern</button>
      <button onClick={() => { onClose(); saveFile(true) }}>Speichern unter …</button>
      <button onClick={() => { onClose(); saveArchive() }} title="Projekt mit Gelände, Klima und Satellitenbild in einer Datei, z. B. für das Tablet">
        Als Archiv speichern (.veilmap) …
      </button>
      <hr />
      <button onClick={() => { onClose(); checkForUpdate(true) }}>Nach Updates suchen …</button>
      <button onClick={() => (autoCheck.value = !autoCheck.value)} title="Beim Start höchstens einmal am Tag auf GitHub nachsehen">
        {autoCheck.value ? '✓' : '\u2003'} Automatisch nach Updates suchen
      </button>
      {recentFiles.value.length > 0 && <hr />}
      {recentFiles.value.map(path => (
        <button key={path} class="recent" title={path} onClick={() => { onClose(); openFile(path) }}>
          {path.split(/[\\/]/).pop()}
        </button>
      ))}
    </div>
  )
}

/** touch screens and narrow windows: sidebar and inspector become drawers over the map */
function useCompact() {
  const query = '(max-width: 1100px), (pointer: coarse)'
  const [compact, setCompact] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const media = window.matchMedia(query)
    const change = () => setCompact(media.matches)
    media.addEventListener('change', change)
    return () => media.removeEventListener('change', change)
  }, [])
  return compact
}

const PANELS: [Panel, string][] = [
  ['layers', 'Ebenen'],
  ['style', 'Stil'],
  ['data', 'Daten'],
  ['project', 'Projekt'],
]

/** minimise, maximise and close for the app's own title bar (desktop only) */
function WindowControls() {
  const controls = platform.window
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    if (!controls) return
    const read = () => controls.isMaximized().then(setMaximized).catch(() => {})
    read()
    return controls.onResized(read)
  }, [])
  if (!controls) return null
  const close = async () => {
    if (dirty.value) {
      if (!(await confirmDialog('Ungespeicherte Änderungen verwerfen und beenden?'))) return
      // discarded on purpose: nothing to offer at the next start
      await platform.recovery.clear().catch(() => {})
    }
    controls.close()
  }
  return (
    <div class="window-controls">
      <button class="icon" title="Minimieren" aria-label="Minimieren" onClick={() => controls.minimize()}>
        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6.5h8" /></svg>
      </button>
      <button class="icon" title={maximized ? 'Wiederherstellen' : 'Maximieren'} aria-label={maximized ? 'Wiederherstellen' : 'Maximieren'} onClick={() => controls.toggleMaximize()}>
        <svg viewBox="0 0 12 12" aria-hidden="true">
          {maximized ? <path d="M3.5 4.5h4v4h-4zM5 4.5V3h4v4H7.5" /> : <path d="M2.5 2.5h7v7h-7z" />}
        </svg>
      </button>
      <button class="icon close" title="Schließen" aria-label="Schließen" onClick={close}>
        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" /></svg>
      </button>
    </div>
  )
}

/**
 * The title bar: logo and the panel tabs above the sidebar they switch, file actions on the right.
 * On the desktop it replaces the system title bar; its empty parts move the window.
 */
function Header({ panel, setPanel, show3d, tabsWidth }: { panel: Panel | null; setPanel: (p: Panel) => void; show3d: () => void; tabsWidth: number | null }) {
  const [menu, setMenu] = useState<{ left: number; top: number } | null>(null)
  return (
    <header class="app-header" data-tauri-drag-region>
      <div class="header-left" style={tabsWidth ? { width: `${tabsWidth}px` } : undefined} data-tauri-drag-region>
        <button
          class={`brand${menu ? ' open' : ''}`}
          title="Datei"
          aria-haspopup="menu"
          aria-expanded={!!menu}
          onClick={event => {
            const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
            setMenu(menu ? null : { left: rect.left, top: rect.bottom + 4 })
          }}
        >
          <span class="logo" style={{ maskImage: `url(${logoUrl})`, WebkitMaskImage: `url(${logoUrl})` }} aria-hidden="true" />
          <span class="wordmark" aria-label="VEIL Editor">
            <span class="wordmark-veil">VEIL</span>
            <span class="wordmark-editor">EDITOR</span>
          </span>
          <span class="brand-caret" aria-hidden="true">
            ▾
          </span>
        </button>
        {menu && <FileMenu at={menu} onClose={() => setMenu(null)} />}
        <nav class="panel-tabs" aria-label="Seitenleiste">
          {PANELS.map(([id, name]) => (
            <button key={id} class={panel === id ? 'active' : ''} onClick={() => setPanel(id)}>
              {name}
            </button>
          ))}
        </nav>
      </div>
      <span class="project-name" data-tauri-drag-region>
        {project.value.name}
        {dirty.value ? ' •' : ''}
      </span>
      <span class="spacer" data-tauri-drag-region />
      <div class="header-actions">
        <button class="icon" onClick={() => saveFile()} title="Speichern (Strg+S)" disabled={!dirty.value}>
          <SaveIcon />
        </button>
        <button class="icon" onClick={undo} disabled={!canUndo.value} title="Rückgängig (Strg+Z)">
          ↶
        </button>
        <button class="icon" onClick={redo} disabled={!canRedo.value} title="Wiederholen (Strg+Y)">
          ↷
        </button>
        <button onClick={show3d} title="3D-Gelände und Globus">
          <GlobeIcon /> 3D
        </button>
      </div>
      <WindowControls />
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
      title={request.title ?? 'Bitte bestätigen'}
      onClose={() => answer(false)}
      footer={
        <>
          <button onClick={() => answer(false)}>{request.no ?? 'Abbrechen'}</button>
          <button class="primary" onClick={() => answer(true)}>
            {request.yes ?? 'Ja'}
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
      create: (t, geometry, px) => handleCreate(t, geometry, px),
      reshape: (id, stroke, px) => reshapeRoute(id, stroke, px),
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
      effect(() => view.setSatellite(satellite.value)),
      // only the layers the project has (after an undo the tiles may still be loaded)
      effect(() => {
        const ids = new Set(project.value.imageLayers.map(l => l.id))
        view.setImageLayers(new Map([...imageLayerData.value].filter(([id]) => ids.has(id))))
      }),
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
  const compact = useCompact()
  const [drawer, setDrawer] = useState(false)
  // in a drawer, the tab of the open panel closes it again
  const choosePanel = (next: Panel) => {
    if (compact) setDrawer(!(drawer && next === panel))
    setPanel(next)
  }
  const [overview, setOverview] = useState<OverviewId>('states')
  const [show3d, setShow3d] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(() => Number(localStorage.getItem('veil.sidebar') ?? 420))
  useMap(container)
  usePicks()
  useShortcuts()
  useEffect(() => {
    refreshVault(project.value)
    checkAtStartup()
    // the copy of a crashed session is offered before anything new can replace it
    let stopRecovery: (() => void) | null = null
    let unmounted = false
    offerRecovery().finally(() => {
      if (!unmounted) stopRecovery = startRecovery()
    })
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty.value) event.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => {
      unmounted = true
      stopRecovery?.()
      window.removeEventListener('beforeunload', warn)
    }
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
    <div class={`app${compact ? ' compact' : ''}${compact && drawer ? ' drawer-open' : ''}`}>
      <Header panel={compact && !drawer ? null : panel} setPanel={choosePanel} show3d={() => setShow3d(!show3d)} tabsWidth={compact ? null : sidebarWidth} />
      <div class="workspace">
        {compact && drawer && <div class="drawer-scrim" onClick={() => setDrawer(false)} />}
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
              <button class="primary" onClick={() => choosePanel('project')}>
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
      <StateDialogs />
      <ConfirmDialog />
      <Tooltip />
    </div>
  )
}
