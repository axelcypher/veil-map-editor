import './style.css'
import { confirm, message, open, save as saveDialog } from '@tauri-apps/plugin-dialog'
import { readFile, readTextFile, writeFile, writeTextFile } from '@tauri-apps/plugin-fs'
import { getCanvasSize, getMapAspect, latitudeRange, normalizedToGeo, projectedMapSize } from './height-mesh'
import {
  LAYER_LEVELS, createLayer, createProject, createSeed, isFourProject, isLegacyProject, isUniformProject, isVeilProject, LAYERS, withDefaults,
  type LayerId, type MapSettings, type Marker, type MarkerKind, type Position, type Route, type RouteKind, type SavedLayer, type VeilProject,
} from './model'
import { analyzeTerrain, type TerrainAnalysis } from './terrain/analysis'
import { BIOMES, MARINE_BIOME } from './terrain/biomes'
import { applyBrushStamp, applyLine, CellSelector, createMetric, ridgePath, type BrushSettings, type BrushTool, type CellFilter, type Metric } from './terrain/brush'
import { drawMarkerLabel, drawMarkerSymbol, hitMarker, kindLabel, MARKER_KINDS } from './overlays/markers'
import { distanceToRoute, findRouteBetween, ROUTE_KINDS, routeKindLabel, routeLengthKm, routePath } from './overlays/routes'
import { CellRenderer, type View } from './terrain/cell-renderer'
import { Viewer } from './view3d/viewer'
import { generateLandscape } from './terrain/landscape'
import { DEFAULT_COAST } from './terrain/coastline'
import { DEFAULT_HYDROLOGY } from './terrain/hydrology'
import { DEFAULT_CLIMATE } from './terrain/climate'
import { createGraph, createLegacyGraph, findCell, type GridGraph } from './terrain/graph'
import { fmgToMeters, type HeightScale } from './terrain/height-scale'
import { HeightmapGenerator } from './terrain/heightmap-generator'
import { heightmapTemplates } from './terrain/heightmap-templates'
import { drawCoastOverlay, LAYER_STYLES, type AreaBorders, type OverlayOptions, type ZoneShape } from './terrain/overlay'
import { chaikin, computeLabels, decodeRuns, encodeRuns, traceBorders, type Border, type RegionLabel } from './terrain/regions'
import {
  colorCells, hexToRgba, PRECIPITATION_GRADIENT, PRECIPITATION_RANGE, TEMPERATURE_GRADIENT, TEMPERATURE_RANGE,
  type DisplayMode, type Rgba,
} from './terrain/palette'
import { balanceSplits, createBaseGrid, enumerateLeaves, flattenSplits, MAX_LEVEL, refineEllipse, unflattenSplits, type BaseGrid } from './terrain/quadtree'
import { interpolateHeight, remapHeights, remapValues, resampleHeights, resampleLegacyHeights, resampleValues, spreadBaseHeights } from './terrain/resample'
import { createRandom } from './terrain/rng'

const MAX_HISTORY = 24
const EXPORT_LONG_SIDE = 3600
const ANALYSIS_DELAY_MS = 220
const MIN_ZOOM = 0.05
/** painting refines the mesh where cells appear larger than this on screen */
const MAX_CELL_PX = 8
/** most cells one refinement may add around the brush before it settles for a coarser level */
const REFINE_CELL_BUDGET = 120000
/** how far around the brush a refinement reaches, in cells of the new level, so that a stroke does not trigger one at every step */
const REFINE_REACH_CELLS = 50

const TOOLS: { id: BrushTool; label: string; symbol: string; status: string }[] = [
  { id: 'raise', label: 'Anheben', symbol: '＋', status: 'Gelände anheben' },
  { id: 'lower', label: 'Absenken', symbol: '−', status: 'Gelände absenken' },
  { id: 'smooth', label: 'Glätten', symbol: '≈', status: 'Gelände glätten' },
  { id: 'set', label: 'Höhe setzen', symbol: '＝', status: 'Auf Zielhöhe angleichen' },
  { id: 'disrupt', label: 'Aufrauen', symbol: '∿', status: 'Gelände aufrauen' },
  { id: 'range', label: 'Gebirgszug', symbol: '▲', status: 'Gebirgszug: Start und Ende anklicken (Esc bricht ab)' },
  { id: 'trough', label: 'Graben', symbol: '▼', status: 'Graben: Start und Ende anklicken (Esc bricht ab)' },
]

type EditorMode = 'height' | 'climate' | 'water' | 'coast' | 'territory' | 'zone' | 'marker' | 'route' | 'project'

const icon = (path: string) => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>`

/** the tool palette: every mode has its own sidebar panels and a map view that suits it */
const MODES: { id: EditorMode; label: string; title: string; icon: string; view?: DisplayMode }[] = [
  { id: 'height', label: 'Höhen', title: 'Höhen modellieren', icon: icon('M3 19 9 8l4 6 3-4 5 9z'), view: 'height' },
  { id: 'climate', label: 'Klima', title: 'Klima und Biome', icon: icon('M5 19c0-8 5-13 14-14 0 9-5 14-14 14zM5 19l7-7'), view: 'biome' },
  { id: 'water', label: 'Wasser', title: 'Flüsse und Seen', icon: icon('M12 3c4 5 6 8 6 11a6 6 0 0 1-12 0c0-3 2-6 6-11z'), view: 'land' },
  { id: 'coast', label: 'Küste', title: 'Küstenlinien', icon: icon('M3 9c3-3 4 3 7 0s4 3 7 0 3 2 4 1M3 15c3-3 4 3 7 0s4 3 7 0 3 2 4 1'), view: 'land' },
  { id: 'territory', label: 'Gebiete', title: 'Gebiete mit Grenzen und Namen', icon: icon('M4 6l5-2 6 2 5-2v14l-5 2-6-2-5 2z'), view: 'land' },
  { id: 'zone', label: 'Zonen', title: 'Zonen', icon: icon('M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM6 18 18 6') },
  { id: 'marker', label: 'Marker', title: 'Marker für Städte und Orte', icon: icon('M12 21s7-6.2 7-11a7 7 0 0 0-14 0c0 4.8 7 11 7 11zM12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z') },
  { id: 'route', label: 'Routen', title: 'Routen und Wege', icon: icon('M4 19c3-9 6 2 9-6 1.5-4 4-4 7-8') },
  { id: 'project', label: 'Projekt', title: 'Projekt und Vorlage', icon: icon('M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4') },
]

const VIEWS: { id: DisplayMode; label: string }[] = [
  { id: 'height', label: 'Höhen' },
  { id: 'land', label: 'Land / Wasser' },
  { id: 'biome', label: 'Biome' },
  { id: 'temperature', label: 'Temperatur' },
  { id: 'precipitation', label: 'Regen' },
]

const slider = (id: string, label: string, min: number, max: number, step: number, value: number, unit: string, labelId = '') => /* html */ `
  <div class="control-heading"><label for="${id}"${labelId ? ` id="${labelId}"` : ''}>${label}</label><output id="${id}-output">${value.toLocaleString('de-DE')} ${unit}</output></div>
  <input id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${value}" />`

const templateOptions = Object.entries(heightmapTemplates).map(([id, template]) => `<option value="${id}">${template.name}</option>`).join('')

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <div class="app-shell">
    <header class="topbar">
      <div class="brand"><div class="brand-mark">V</div><div><strong>Veil</strong><span>Height Editor</span></div></div>
      <nav class="file-actions">
        <button id="new-project">Neu</button><button id="open-project">Öffnen</button>
        <button id="save-project">Speichern</button><button id="save-project-as">Speichern unter</button>
      </nav>
      <div class="document-actions">
        <button id="toggle-viewer" class="secondary-button" title="3D-Ansicht und Globus in einem eigenen Fenster">3D / Globus</button>
        <button id="load-reference" class="secondary-button">Vorlage laden</button>
        <button id="export" class="primary-button">PNG exportieren</button>
      </div>
    </header>

    <main class="workspace-layout">
      <nav class="rail" aria-label="Werkzeugpalette">
        ${MODES.map(mode => `<button class="rail-button${mode.id === 'height' ? ' active' : ''}" data-mode="${mode.id}" title="${mode.title}">${mode.icon}<span>${mode.label}</span></button>`).join('')}
      </nav>

      <aside class="toolbox">
        <section data-modes="height">
          <p class="eyebrow">Höhenpinsel</p>
          <div class="brush-tools">
            ${TOOLS.map((tool, index) => `<button class="tool${index === 0 ? ' active' : ''}" data-tool="${tool.id}"><span class="tool-symbol">${tool.symbol}</span><span>${tool.label}</span><kbd>${index + 1}</kbd></button>`).join('')}
          </div>
        </section>

        <section class="control-section" data-modes="height territory zone">
          ${slider('brush-radius', 'Radius', 0, 1000, 1, 800, 'km', 'radius-label')}
        </section>

        <section class="control-section" data-modes="height">
          ${slider('brush-strength', 'Stärke', 10, 2500, 10, 500, 'm', 'strength-label')}
          <div id="target-height-row" class="hidden">${slider('target-height', 'Zielhöhe', -11000, 9000, 10, 100, 'm')}</div>
          <div id="randomness-row" class="hidden">${slider('line-randomness', 'Windung', 0, 100, 5, 30, '%')}</div>
          <div class="control-heading"><label for="cell-filter">Betroffene Zellen</label></div>
          <select id="cell-filter"><option value="all">alle</option><option value="land">nur Land</option><option value="water">nur Wasser</option></select>
        </section>

        <section class="control-section" data-modes="height climate water coast">
          ${slider('sea-level', 'Meeresspiegel', -2000, 2000, 10, 0, 'm', 'sea-label')}
        </section>

        <details class="panel" open data-modes="height">
          <summary>Generator</summary>
          <select id="template-select">${templateOptions}</select>
          <button id="apply-template" class="secondary-wide">Vorlage anwenden</button>
          <button id="load-heightmap" class="secondary-wide">Graustufenbild als Höhen</button>
          <button id="smooth-all" class="secondary-wide">Alles glätten</button>
        </details>

        <details class="panel" open data-modes="height">
          <summary>Landschaft im Land</summary>
          <p class="tool-help">Erzeugt Hügel und Berge innerhalb der vorhandenen Landmasse. Das Meer und die Küste bleiben, Höhen ab der Schwelle unten bleiben stehen und bekommen Ausläufer.</p>
          ${slider('landscape-relief', 'Höchste Höhe', 100, 9000, 50, 2500, 'm')}
          ${slider('landscape-size', 'Strukturgröße', 10, 1000, 10, 250, 'km')}
          ${slider('landscape-rugged', 'Gebirgigkeit', 0, 100, 1, 55, '%')}
          ${slider('landscape-ramp', 'Anstieg von der Küste', 10, 1000, 10, 150, 'km')}
          ${slider('landscape-keep', 'Eigene Höhen behalten ab', 0, 5000, 50, 500, 'm')}
          ${slider('landscape-mix', 'Bestehendes einmischen', 0, 100, 1, 0, '%')}
          ${slider('landscape-drain', 'Senken auffüllen', 0, 100, 1, 85, '%')}
          <button id="generate-landscape" class="secondary-wide">Landschaft erzeugen</button>
        </details>

        <section class="control-section" data-modes="climate">
          <p class="eyebrow">Klima</p>
          ${slider('climate-equator', 'Temperatur Äquator', -10, 45, 1, DEFAULT_CLIMATE.equatorC, '°C')}
          ${slider('climate-north', 'Temperatur Nordpol', -60, 20, 1, DEFAULT_CLIMATE.northPoleC, '°C')}
          ${slider('climate-south', 'Temperatur Südpol', -60, 20, 1, DEFAULT_CLIMATE.southPoleC, '°C')}
          ${slider('climate-precipitation', 'Niederschlag', 10, 300, 5, DEFAULT_CLIMATE.precipitationPercent, '%')}
          <p class="tool-help">Die Kartenansicht (Biome, Temperatur, Niederschlag) schaltest du oben in der Karte um.</p>
        </section>

        <section class="control-section" data-modes="coast">
          <p class="eyebrow">Küste</p>
          <label class="check"><input id="coast-enabled" type="checkbox" checked /> Fraktale Küste</label>
          <label class="check"><input id="show-coast" type="checkbox" checked /> Küstenlinie zeigen</label>
          <label class="check"><input id="coast-pick" type="checkbox" /> Einzelne Insel oder einen See anklicken</label>
          <p class="tool-help" id="coast-target-info">Die Regler gelten für die ganze Karte.</p>
          <button id="coast-reset" class="secondary-wide" hidden>Auf die Karteneinstellung zurücksetzen</button>
          ${slider('coast-depth', 'Detail', 1, 5, 1, DEFAULT_COAST.maxDepth, '')}
          ${slider('coast-amplitude', 'Zerklüftung', 0, 8, 0.1, DEFAULT_COAST.baseAmplitude, '')}
          ${slider('coast-decay', 'Feindetails', 0.1, 1.3, 0.01, DEFAULT_COAST.amplitudeDecay, '')}
          ${slider('coast-minedge', 'Kleinste Kante', 0, 20, 0.1, DEFAULT_COAST.minEdge, '')}
          ${slider('coast-calm', 'Ruhige Küsten', 0, 0.9, 0.01, DEFAULT_COAST.smoothThreshold, '')}
          ${slider('coast-contrast', 'Kontrast', 0.1, 10, 0.1, DEFAULT_COAST.roughnessContrast, '')}
          ${slider('coast-stretch', 'Streckenlänge', 2, 600, 1, DEFAULT_COAST.roughnessScale, '')}
          ${slider('coast-lake', 'Seeufer ruhiger', 1, 4, 0.1, DEFAULT_COAST.lakeSmoothThreshMult, '×')}
          ${slider('coast-variant', 'Variante', 0, 99, 1, DEFAULT_COAST.variant, '')}
        </section>

        <section class="control-section" data-modes="water">
          <p class="eyebrow">Flüsse und Seen</p>
          <label class="check"><input id="rivers-enabled" type="checkbox" checked /> Flüsse berechnen und zeigen</label>
          ${slider('river-density', 'Flussdichte', 20, 300, 5, 100, '%')}
          <label class="check"><input id="lakes-enabled" type="checkbox" checked /> Senken zu Seen füllen</label>
          ${slider('lake-depth', 'Mindesttiefe eines Sees', 5, 400, 5, DEFAULT_HYDROLOGY.minLakeDepthM, 'm')}
          <button id="draw-river" class="secondary-wide">Fluss von Hand zeichnen</button>
          <p class="tool-help" id="water-info">Flüsse entstehen aus dem Regen und folgen dem Gefälle. Ein See füllt eine Senke bis zum Überlauf; was darüber hinausfließt, wird zum Fluss. Die Höhen bleiben dabei unverändert.</p>
        </section>

        <section class="control-section" data-modes="territory zone">
          <div class="segmented three" role="group" aria-label="Werkzeug">
            <button class="active" data-region-tool="paint">Malen</button><button data-region-tool="erase">Radieren</button><button data-region-tool="fill">Land füllen</button>
          </div>
          <p class="tool-help">Der Radius oben gilt hier auch. "Land füllen" färbt die ganze angeklickte Insel.</p>
        </section>

        <section class="control-section" data-modes="territory">
          <p class="eyebrow">Gebiete</p>
          <ul id="territory-list" class="entity-list"></ul>
          <button id="territory-add" class="secondary-wide">Neues Gebiet</button>
        </section>

        <section class="control-section" data-modes="zone">
          <p class="eyebrow">Zonen</p>
          <ul id="zone-list" class="entity-list"></ul>
          <button id="zone-add" class="secondary-wide">Neue Zone</button>
        </section>

        <section class="control-section" data-modes="marker">
          <p class="eyebrow">Marker</p>
          <div id="marker-kinds" class="kind-grid"></div>
          <p class="tool-help">Klick setzt einen Marker, Klick auf einen Marker wählt ihn. Ziehen verschiebt, Entf löscht.</p>
        </section>
        <section class="control-section" data-modes="marker" id="marker-editor">
          <label>Name<input id="marker-name" type="text" /></label>
          <div class="field-row"><label>Art<select id="marker-kind"></select></label><label>Beschriftung<select id="marker-side"><option value="right">rechts</option><option value="left">links</option><option value="top">oben</option><option value="bottom">unten</option></select></label></div>
          ${slider('marker-size', 'Größe', 1, 5, 1, 3, '')}
          <div class="field-row"><label class="check"><input id="marker-label" type="checkbox" /> Name zeigen</label><label class="check">Farbe <input id="marker-color" type="color" /></label></div>
          <label>Notiz<textarea id="marker-note" rows="3"></textarea></label>
          <button id="marker-delete" class="secondary-wide">Marker löschen</button>
        </section>
        <section class="control-section" data-modes="marker"><ul id="marker-list" class="entity-list"></ul></section>

        <section class="control-section" data-modes="route">
          <p class="eyebrow">Routen</p>
          <div id="route-kinds" class="kind-grid"></div>
          <label class="check"><input id="route-auto" type="checkbox" checked /> Weg über das Gelände suchen</label>
          <p class="tool-help">Wegpunkte anklicken. Doppelklick oder Eingabe beendet die Route, Esc bricht ab, Rücktaste nimmt den letzten Punkt zurück. Seewege bleiben im Wasser, Straßen und Pfade an Land. Bei einer gewählten Route kannst du die Punkte ziehen, auf die Linie klicken fügt einen Punkt ein, Alt und Klick auf einen Punkt entfernt ihn.</p>
        </section>
        <section class="control-section" data-modes="route" id="route-editor">
          <label>Name<input id="route-name" type="text" /></label>
          <div class="field-row"><label>Linie<select id="route-dash"><option value="solid">durchgezogen</option><option value="dashed">gestrichelt</option><option value="dotted">gepunktet</option></select></label><label class="check">Farbe <input id="route-color" type="color" /></label></div>
          ${slider('route-width', 'Breite', 1, 8, 0.2, 2.4, 'px')}
          <label class="check"><input id="route-label" type="checkbox" /> Name und Länge zeigen</label>
          <p class="tool-help" id="route-length"></p>
          <button id="route-delete" class="secondary-wide">Route löschen</button>
        </section>
        <section class="control-section" data-modes="route"><ul id="route-list" class="entity-list"></ul></section>

        <section class="info-card" data-modes="project">
          <div class="card-heading"><span>Projekt</span><button id="edit-settings">Bearbeiten</button></div>
          <strong id="planet-name">Unbenannte Welt</strong>
          <dl>
            <div><dt>Kartenbereich</dt><dd id="map-mode">Ausschnitt</dd></div>
            <div><dt>Ausdehnung</dt><dd id="map-size">6.000 × 4.000 km</dd></div>
            <div><dt>Mesh</dt><dd id="mesh-info">20.000 Zellen</dd></div>
            <div><dt>Zellabstand</dt><dd id="cell-scale">≈ 45 km</dd></div>
            <div><dt>Land</dt><dd id="land-info">—</dd></div>
            <div><dt>Inseln / Seen</dt><dd id="feature-info">—</dd></div>
          </dl>
        </section>

        <section class="reference-controls" data-modes="project">
          <div class="card-heading"><span>Vorlage</span><button id="toggle-reference" disabled>Aus</button></div>
          <label>Vorlage<input id="reference-opacity" type="range" min="0" max="100" value="55" disabled /></label>
          <label>Kartenfläche<input id="terrain-opacity" type="range" min="15" max="100" value="78" disabled /></label>
          <p id="reference-name">Keine Vorlage geladen</p>
        </section>
      </aside>

      <div id="sidebar-resizer" class="resizer" role="separator" aria-orientation="vertical" title="Breite ändern (Doppelklick setzt zurück)"></div>

      <section id="workspace" class="workspace">
        <canvas id="bg-canvas"></canvas>
        <canvas id="gl-canvas"></canvas>
        <canvas id="cover-canvas"></canvas>
        <canvas id="ui-canvas"></canvas>
        <div class="view-switch segmented" role="group" aria-label="Kartenansicht">
          ${VIEWS.map(view => `<button${view.id === 'height' ? ' class="active"' : ''} data-display="${view.id}">${view.label}</button>`).join('')}
        </div>
        <div class="layer-switch segmented" role="group" aria-label="Ebene">
          ${LAYERS.map(layer => `<button${layer.id === 'surface' ? ' class="active"' : ''} data-layer="${layer.id}">${layer.label}</button>`).join('')}
        </div>
        <div class="overlay-toggles" role="group" aria-label="Anzeigen">
          <label><input type="checkbox" data-overlay="rivers" checked /> Flüsse</label><label><input type="checkbox" data-overlay="territories" checked /> Gebiete</label><label><input type="checkbox" data-overlay="zones" checked /> Zonen</label><label><input type="checkbox" data-overlay="markers" checked /> Marker</label><label><input type="checkbox" data-overlay="routes" checked /> Routen</label><label><input type="checkbox" data-overlay="shadow" checked /> Schatten</label>
        </div>
        <div id="view-legend" class="view-legend hidden"></div>
        <div id="viewer" class="viewer" hidden>
          <div id="viewer-head" class="viewer-head">
            <div class="segmented"><button class="active" data-viewer="terrain">3D</button><button data-viewer="globe">Globus</button></div>
            <label id="viewer-exaggeration" title="Überhöhung der Höhen">Höhe <input id="viewer-exag" type="range" min="1" max="60" step="1" value="12" /></label>
            <button id="viewer-refresh" title="Neu einlesen">↻</button><button id="viewer-close" title="Schließen">×</button>
          </div>
          <canvas id="viewer-canvas"></canvas>
        </div>
        <div id="generating" class="generating" hidden><span></span><em id="generating-label">Mesh wird erzeugt …</em></div>
      </section>
    </main>

    <footer class="statusbar">
      <span id="status">Bereit zum Modellieren</span>
      <span id="cell-readout">Höhe — · 0,000° / 0,000°</span>
      <div class="status-right">
        <div class="zoom-controls">
          <button id="undo" title="Rückgängig (Strg+Z)" disabled>↶</button><button id="redo" title="Wiederholen (Strg+Y)" disabled>↷</button><i></i>
          <button id="zoom-out">−</button><span id="zoom-output">100%</span><button id="zoom-in">+</button><button id="zoom-fit" class="fit-button">Einpassen</button>
        </div>
        <span id="app-version" class="app-version" title="Version und Zeitpunkt des Builds"></span>
      </div>
    </footer>
  </div>

  <dialog id="settings-dialog">
    <form id="settings-form" method="dialog">
      <div class="dialog-header"><div><p class="eyebrow">Projektgrundlage</p><h2>Planet, Ausschnitt und Mesh</h2></div><button type="button" id="cancel-settings" class="close-button">×</button></div>
      <div class="settings-grid">
        <fieldset>
          <legend>Planet</legend>
          <label>Name<input name="planetName" type="text" required /></label>
          <div class="field-row"><label>Äquatordurchmesser <span>km</span><input name="equatorialDiameter" type="number" min="1" step="1" required /></label><label>Poldurchmesser <span>km</span><input name="polarDiameter" type="number" min="1" step="1" required /></label></div>
          <label>Axiale Neigung <span>Grad</span><input name="axialTilt" type="number" min="0" max="180" step="0.01" required /></label>
          <div class="field-row three"><label>Tiefster Punkt <span>m</span><input name="minimumElevation" type="number" step="1" required /></label><label>Meereshöhe <span>m</span><input name="seaLevel" type="number" step="1" required /></label><label>Höchster Punkt <span>m</span><input name="maximumElevation" type="number" step="1" required /></label></div>
        </fieldset>
        <fieldset>
          <legend>Kartenbereich</legend>
          <label>Darstellung<select name="mapMode"><option value="region">Freier Ausschnitt</option><option value="global">Gesamter Planet (2:1)</option></select></label>
          <div id="region-settings">
            <div class="field-row"><label>Mittelpunkt Länge <span>Grad</span><input name="centerLongitude" type="number" min="-180" max="180" step="0.01" required /></label><label>Mittelpunkt Breite <span>Grad</span><input name="centerLatitude" type="number" min="-89" max="89" step="0.01" required /></label></div>
            <div class="field-row"><label>Breite <span>km</span><input name="mapWidth" type="number" min="1" step="1" required /></label><label>Höhe <span>km</span><input name="mapHeight" type="number" min="1" step="1" required /></label></div>
          </div>
        </fieldset>
        <fieldset class="mesh-fieldset">
          <legend>Organisches Höhenmesh</legend>
          <div class="field-row"><label>Zellzahl<input name="desiredCells" type="number" min="1000" step="1000" required /></label><label>Zellgröße <span>km</span><input name="cellSizeKm" type="number" min="0.001" step="any" required /></label></div>
          <div class="field-row"><label>Seed<input name="meshSeed" type="text" required /></label><label class="check dialog-check"><input name="autoRefine" type="checkbox" /> Beim Malen in hineingezoomter Ansicht verfeinern</label></div>
          <p class="dialog-note" id="cells-hint"></p>
          <div class="mesh-actions"><button id="new-seed" type="button" class="secondary-button">Neuen Seed erzeugen</button></div>
          <p class="dialog-note">Zellzahl und Zellgröße legen die Auflösung der ganzen Karte fest; die eine ergibt sich aus der anderen. Für die volle Auflösung überall stellst du sie hier ein, ohne Obergrenze. Wer lieber grob beginnt, kann das automatische Verfeinern beim Hineinzoomen einschalten. Ein anderer Seed übernimmt die Höhen; eine andere Zellzahl oder ein anderes Seitenverhältnis verwirft verfeinerte Bereiche.</p>
        </fieldset>
      </div>
      <div class="dialog-actions"><button type="button" id="cancel-settings-bottom" class="secondary-button">Abbrechen</button><button type="submit" class="primary-button">Übernehmen</button></div>
    </form>
  </dialog>
`

const workspace = document.querySelector<HTMLElement>('#workspace')!
const backgroundCanvas = document.querySelector<HTMLCanvasElement>('#bg-canvas')!
const glCanvas = document.querySelector<HTMLCanvasElement>('#gl-canvas')!
const coverCanvas = document.querySelector<HTMLCanvasElement>('#cover-canvas')!
const uiCanvas = document.querySelector<HTMLCanvasElement>('#ui-canvas')!
const backgroundContext = backgroundCanvas.getContext('2d')!
const coverContext = coverCanvas.getContext('2d')!
const uiContext = uiCanvas.getContext('2d')!
const settingsDialog = document.querySelector<HTMLDialogElement>('#settings-dialog')!
const settingsForm = document.querySelector<HTMLFormElement>('#settings-form')!
const generatingIndicator = document.querySelector<HTMLElement>('#generating')!
const brushRadiusInput = document.querySelector<HTMLInputElement>('#brush-radius')!
const brushStrengthInput = document.querySelector<HTMLInputElement>('#brush-strength')!
const targetHeightInput = document.querySelector<HTMLInputElement>('#target-height')!
const randomnessInput = document.querySelector<HTMLInputElement>('#line-randomness')!
const seaLevelInput = document.querySelector<HTMLInputElement>('#sea-level')!
const cellFilterSelect = document.querySelector<HTMLSelectElement>('#cell-filter')!
const showCoastInput = document.querySelector<HTMLInputElement>('#show-coast')!
const referenceOpacity = document.querySelector<HTMLInputElement>('#reference-opacity')!
const terrainOpacity = document.querySelector<HTMLInputElement>('#terrain-opacity')!
const toggleReferenceButton = document.querySelector<HTMLButtonElement>('#toggle-reference')!
const undoButton = document.querySelector<HTMLButtonElement>('#undo')!
const redoButton = document.querySelector<HTMLButtonElement>('#redo')!
const statusOutput = document.querySelector<HTMLSpanElement>('#status')!
const cellReadout = document.querySelector<HTMLSpanElement>('#cell-readout')!
const zoomOutput = document.querySelector<HTMLSpanElement>('#zoom-output')!
const viewLegend = document.querySelector<HTMLDivElement>('#view-legend')!

let project = createProject()
let graph: GridGraph
let metric: Metric
let selector: CellSelector
let elevations: Float32Array = new Float32Array(0)
let analysis: TerrainAnalysis | null = null
let analysisStale = true
let analysisTimer: number | undefined
let colorBuffer = new Uint8Array(0)
const renderer = new CellRenderer(glCanvas)

let currentProjectPath: string | null = null
let referenceImage: HTMLImageElement | null = null
let referenceVisible = true
let activeTool: BrushTool = 'raise'
let displayMode: DisplayMode = 'height'
let activeMode: EditorMode = 'height'
let biomeLegendRows = ''
let brushRadiusKm = 250
let brushStrengthM = Number(brushStrengthInput.value)
let targetHeightM = Number(targetHeightInput.value)
let lineRandomness = Number(randomnessInput.value) / 100
let cellFilter: CellFilter = 'all'
let hoverPoint: Position | null = null
let lineStart: Position | null = null
let isDrawing = false
let panning: { x: number; y: number } | null = null
let spaceHeld = false
let lastStampPoint: Position | null = null
let view = { scale: 1, x: 0, y: 0 }
let devicePixelScale = 1
let dirty = false
type HistoryKind = 'height' | 'territory' | 'zone' | 'markers' | 'routes'

interface HistoryEntry {
  kind: HistoryKind
  /** the mesh the per-cell data belongs to, replaced (never changed) when the mesh is refined */
  splits: ReadonlySet<number>
  elevations?: Float32Array
  territoryIds?: Uint16Array
  zone?: { id: number; mask: Uint8Array | null }
  markers?: Marker[]
  routes?: Route[]
}

/** what a layer keeps in memory while another layer is shown */
interface LiveLayer {
  graph: GridGraph
  analysis: TerrainAnalysis | null
  splits: ReadonlySet<number>
  elevations: Float32Array
  territoryIds: Uint16Array
  zoneMasks: Map<number, Uint8Array>
  undo: HistoryEntry[]
  redo: HistoryEntry[]
}

const live: Partial<Record<LayerId, LiveLayer>> = {}
let activeLayer: LayerId = 'surface'
let undoStack: HistoryEntry[] = []
let redoStack: HistoryEntry[] = []
/** the territory of every cell, 0 for none */
let territoryIds: Uint16Array = new Uint16Array(0)
/** for every zone a 1 on the cells it covers */
let zoneMasks = new Map<number, Uint8Array>()
let splits: ReadonlySet<number> = new Set()
/** a mesh rebuild is running */
let busy = false
let strokeQueue: Position[] = []
let strokeRunning = false
const strokeRandom = createRandom(createSeed())

const pending = { colors: true, gl: true, background: true, cover: true, ui: true }
let renderQueued = false

function requestRender() {
  if (renderQueued) return
  renderQueued = true
  requestAnimationFrame(() => {
    renderQueued = false
    render()
  })
}

const layerData = (): SavedLayer => project.veil.layers[activeLayer] ?? (project.veil.layers[activeLayer] = createLayer(LAYER_LEVELS[activeLayer]))

/** the height that separates land from water: the sea of the surface, the floor of the caves, the rim of the sky islands */
const seaLevel = () => activeLayer === 'surface' ? project.veil.planet.seaLevelM : layerData().levelM

const heightScale = (): HeightScale => {
  const { minimumElevationM, maximumElevationM } = project.veil.planet
  return { minM: minimumElevationM, maxM: maximumElevationM, seaM: seaLevel() }
}

const deviceView = (): View => ({ scale: view.scale * devicePixelScale, x: view.x * devicePixelScale, y: view.y * devicePixelScale })

function markViewChanged() {
  Object.assign(pending, { gl: true, background: true, cover: true, ui: true })
  zoomOutput.textContent = `${Math.round(view.scale * 100)}%`
  requestRender()
}

function markColorsChanged() {
  pending.colors = true
  pending.cover = true
  requestRender()
}

const coversSea = (mode: DisplayMode) => mode === 'land' || mode === 'biome'
const showsCoverage = () => !analysisStale && analysis !== null && coversSea(displayMode)

/** which overlays are drawn, the chips above the map */
const overlayVisible = { rivers: true, territories: true, zones: true, markers: true, routes: true, shadow: true }

/** borders, zone shapes and label places of the areas, recomputed a moment after the last edit */
let regions: { borders: AreaBorders[]; zones: ZoneShape[]; labels: Map<number, RegionLabel>; deep: Border[] } = { borders: [], zones: [], labels: new Map(), deep: [] }
let regionTimer: number | undefined
/** the island or lake whose own coast settings are being edited */
let coastTarget: number | null = null

/** how far the smoothed coast can reach beyond the cells, in rings of cells */
function coastReach() {
  const amplitude = Math.max(project.veil.coast.baseAmplitude, ...layerData().coastOverrides.map(override => override.settings.baseAmplitude ?? 0))
  return Math.min(8, Math.max(2, Math.ceil(amplitude * 1.2) + 1))
}

function territoryTint() {
  if (!overlayVisible.territories || territoryIds.length !== graph.cellCount) return undefined
  const colors: Rgba[] = []
  for (const territory of layerData().territories) colors[territory.id] = hexToRgba(territory.color)
  return { ids: territoryIds, colors }
}

function coverOptions(): OverlayOptions {
  return {
    mapWidth: graph.width,
    mapHeight: graph.height,
    cover: showsCoverage(),
    coastLine: showCoastInput.checked,
    style: LAYER_STYLES[activeLayer],
    rivers: overlayVisible.rivers && project.veil.rivers && activeLayer === 'surface',
    riverUnit: graph.baseSpacing,
    areaBorders: overlayVisible.territories ? regions.borders : [],
    zones: overlayVisible.zones ? regions.zones : [],
    highlight: coastTarget ?? undefined,
    shadow: shadowOptions(),
  }
}

function render() {
  const timings: string[] = []
  const measure = <T>(label: string, work: () => T): T => {
    const started = performance.now()
    const result = work()
    if (import.meta.env.DEV) timings.push(`${label} ${(performance.now() - started).toFixed(1)}`)
    return result
  }
  if (pending.colors) {
    measure('colors', () => colorCells(colorBuffer, { graph, elevations, scale: heightScale(), mode: displayMode, analysis, layer: activeLayer, tint: territoryTint(), shoreRings: showsCoverage() ? coastReach() : 0 }))
    measure('upload', () => renderer.setColors(colorBuffer))
    pending.colors = false
    pending.gl = true
  }
  if (pending.gl) {
    measure('gl', () => renderer.draw(deviceView()))
    pending.gl = false
  }
  if (pending.background) {
    measure('background', drawBackground)
    pending.background = false
  }
  if (pending.cover) {
    measure('cover', () => {
      drawCoastOverlay(coverContext, analysisStale ? null : analysis, deviceView(), coverOptions())
      drawAnnotations(coverContext)
    })
    pending.cover = false
  }
  if (pending.ui) {
    measure('ui', drawUi)
    pending.ui = false
  }
  if (import.meta.env.DEV && timings.length) console.debug('render', timings.join(' | '))
}

function drawBackground() {
  const ctx = backgroundContext
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, backgroundCanvas.width, backgroundCanvas.height)
  const { scale, x, y } = deviceView()
  ctx.fillStyle = LAYER_STYLES[activeLayer].sea
  ctx.fillRect(x, y, graph.width * scale, graph.height * scale)

  if (referenceVisible && referenceImage) {
    const fit = Math.min(graph.width / referenceImage.width, graph.height / referenceImage.height)
    const width = referenceImage.width * fit
    const height = referenceImage.height * fit
    ctx.save()
    ctx.globalAlpha = project.veil.reference?.opacity ?? 0.55
    ctx.drawImage(referenceImage, x + (graph.width - width) / 2 * scale, y + (graph.height - height) / 2 * scale, width * scale, height * scale)
    ctx.restore()
  }
  ctx.strokeStyle = '#45677a'
  ctx.lineWidth = devicePixelScale
  ctx.strokeRect(x - 0.5, y - 0.5, graph.width * scale + 1, graph.height * scale + 1)
}

function applyTerrainOpacity() {
  const opacity = referenceImage && referenceVisible ? project.veil.reference?.terrainOpacity ?? 0.78 : 1
  glCanvas.style.opacity = String(opacity)
  coverCanvas.style.opacity = String(opacity)
}

/** 1, 2 or 5 times a power of ten, the largest that is not above the limit */
function niceLength(limit: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(limit))
  return [5, 2, 1].map(step => step * magnitude).find(length => length <= limit) ?? magnitude
}

/** a scale bar in kilometres for the middle of the visible map; on a global map the scale depends on the latitude */
function drawScaleBar(ctx: CanvasRenderingContext2D) {
  const screenHeight = uiCanvas.height / devicePixelScale
  const centerY = Math.min(graph.height, Math.max(0, (screenHeight / 2 - view.y) / view.scale))
  const kmPerPixel = metric.kmPerUnit(centerY)[0] / view.scale
  const length = niceLength(kmPerPixel * 160)
  const width = length / kmPerPixel
  const label = `${length.toLocaleString('de-DE')} km`
  const note = project.veil.map.mode === 'global'
    ? `bei ${Math.abs(normalizedToGeo([0.5, centerY / graph.height], project.veil.map, project.veil.planet)[1]).toFixed(0)}° Breite`
    : ''

  ctx.font = '11px "Segoe UI", sans-serif'
  const boxWidth = Math.max(width, ctx.measureText(`${label}  ${note}`).width) + 20
  const left = 16
  const bottom = screenHeight - 14
  ctx.fillStyle = 'rgb(14 21 25 / 78%)'
  ctx.beginPath()
  ctx.roundRect(left - 10, bottom - 44, boxWidth, 40, 6)
  ctx.fill()

  const barY = bottom - 14
  ctx.strokeStyle = '#e9eef1'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(left, barY - 5)
  ctx.lineTo(left, barY)
  ctx.lineTo(left + width, barY)
  ctx.lineTo(left + width, barY - 5)
  ctx.moveTo(left + width / 2, barY)
  ctx.lineTo(left + width / 2, barY - 3)
  ctx.stroke()

  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = '#e9eef1'
  ctx.fillText(label, left, barY - 10)
  if (note) {
    ctx.fillStyle = '#8fa1aa'
    ctx.fillText(note, left + ctx.measureText(`${label}  `).width, barY - 10)
  }
}

function drawUi() {
  const ctx = uiContext
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, uiCanvas.width, uiCanvas.height)
  ctx.setTransform(devicePixelScale, 0, 0, devicePixelScale, 0, 0)
  drawScaleBar(ctx)
  const toScreen = ([x, y]: Position): Position => [view.x + x * view.scale, view.y + y * view.scale]
  const isLine = activeMode === 'height' && (activeTool === 'range' || activeTool === 'trough')

  if (lineStart !== null && activeMode === 'height') {
    const [sx, sy] = toScreen(lineStart)
    ctx.strokeStyle = 'rgb(255 222 151 / 90%)'
    ctx.fillStyle = '#f2cb78'
    ctx.lineWidth = 2
    if (hoverPoint) {
      const [hx, hy] = toScreen(hoverPoint)
      ctx.setLineDash([6, 5])
      ctx.beginPath()
      ctx.moveTo(sx, sy)
      ctx.lineTo(hx, hy)
      ctx.stroke()
      ctx.setLineDash([])
    }
    ctx.beginPath()
    ctx.arc(sx, sy, 5, 0, Math.PI * 2)
    ctx.fill()
  }
  if (!hoverPoint || panning || !brushActive()) return

  const [cx, cy] = toScreen(hoverPoint)
  ctx.lineWidth = 1.5
  ctx.strokeStyle = activeTool === 'lower' || activeTool === 'trough' ? 'rgb(126 215 245 / 85%)' : 'rgb(255 222 151 / 85%)'
  const [kmX, kmY] = metric.kmPerUnit(hoverPoint[1])
  ctx.beginPath()
  ctx.ellipse(cx, cy, brushRadiusKm / kmX * view.scale, brushRadiusKm / kmY * view.scale, 0, 0, Math.PI * 2)
  ctx.stroke()
  if (isLine) {
    ctx.beginPath()
    ctx.arc(cx, cy, 3, 0, Math.PI * 2)
    ctx.stroke()
  }
}

function resizeCanvases() {
  const rect = workspace.getBoundingClientRect()
  devicePixelScale = window.devicePixelRatio || 1
  const width = Math.max(1, Math.round(rect.width * devicePixelScale))
  const height = Math.max(1, Math.round(rect.height * devicePixelScale))
  for (const canvas of [backgroundCanvas, coverCanvas, uiCanvas]) {
    canvas.width = width
    canvas.height = height
  }
  renderer.resize(width, height)
  markViewChanged()
}

function setView(next: { scale: number; x: number; y: number }) {
  view = next
  markViewChanged()
}

function fitMap() {
  const rect = workspace.getBoundingClientRect()
  const scale = Math.min((rect.width - 72) / graph.width, (rect.height - 72) / graph.height, 3)
  setView({ scale, x: (rect.width - graph.width * scale) / 2, y: (rect.height - graph.height * scale) / 2 })
}

function zoomAt(clientX: number, clientY: number, factor: number) {
  const rect = workspace.getBoundingClientRect()
  const px = clientX - rect.left
  const py = clientY - rect.top
  const maxZoom = Math.max(24, 12 * 2 ** MAX_LEVEL / graph.baseSpacing)
  const scale = Math.min(maxZoom, Math.max(MIN_ZOOM, view.scale * factor))
  const ratio = scale / view.scale
  setView({ scale, x: px - (px - view.x) * ratio, y: py - (py - view.y) * ratio })
}

function eventMapPoint(event: PointerEvent | MouseEvent): Position {
  const rect = uiCanvas.getBoundingClientRect()
  return [(event.clientX - rect.left - view.x) / view.scale, (event.clientY - rect.top - view.y) / view.scale]
}

const insideMap = ([x, y]: Position) => x >= 0 && y >= 0 && x <= graph.width && y <= graph.height

function setDirty(value = true) {
  dirty = value
  const filename = currentProjectPath?.split(/[\\/]/).at(-1) ?? 'Unbenannte Karte'
  document.title = `${dirty ? '• ' : ''}${filename} – Veil Map Editor`
}

// analysis: features, climate, biomes and coastlines follow the elevations a moment after the last edit

function runAnalysis() {
  window.clearTimeout(analysisTimer)
  analysisTimer = undefined
  const started = performance.now()
  analysis = analyzeTerrain({
    graph,
    elevations,
    scale: heightScale(),
    latitude: latitudeRange(project.veil.map, project.veil.planet),
    climate: project.veil.climate,
    coast: project.veil.coast,
    coastOverrides: layerData().coastOverrides,
    hydrology: project.veil.hydrology,
    rivers: project.veil.rivers,
    surface: activeLayer === 'surface',
    seed: activeLayer === 'surface' ? project.veil.mesh.seed : `${project.veil.mesh.seed}:${activeLayer}`,
  })
  analysisStale = false
  updateStatistics()
  findCoastTarget()
  markColorsChanged()
  scheduleViewer()
  if (import.meta.env.DEV) console.debug(`analysis of ${graph.cellCount} cells took ${Math.round(performance.now() - started)} ms`)
}

function invalidateAnalysis(delay = ANALYSIS_DELAY_MS) {
  analysisStale = true
  window.clearTimeout(analysisTimer)
  analysisTimer = window.setTimeout(runAnalysis, delay)
  markColorsChanged()
}

/** territory borders, zone outlines and label places; they follow the ids a moment after the last edit */
function recomputeRegions() {
  window.clearTimeout(regionTimer)
  regionTimer = undefined
  const data = layerData()
  const valid = territoryIds.length === graph.cellCount
  const borders = valid ? traceBorders(graph, cell => territoryIds[cell]) : new Map<number, Border[]>()
  regions = {
    borders: data.territories.filter(territory => borders.has(territory.id)).map(territory => ({ color: territory.color, borders: borders.get(territory.id)! })),
    zones: data.zones.filter(zone => zone.visible && zoneMasks.has(zone.id)).map(zone => ({
      color: zone.color, pattern: zone.pattern, opacity: zone.opacity,
      shapes: traceBorders(graph, cell => zoneMasks.get(zone.id)![cell], 1).get(1) ?? [],
    })),
    labels: valid ? computeLabels(graph, territoryIds, id => data.territories.find(item => item.id === id)?.name.length ?? 0) : new Map(),
    deep: deepBorders(),
  }
  markOverlaysChanged()
}

function invalidateRegions(delay = 180) {
  window.clearTimeout(regionTimer)
  regionTimer = window.setTimeout(recomputeRegions, delay)
}

function markOverlaysChanged() {
  pending.colors = true
  pending.cover = true
  requestRender()
}

function updateStatistics() {
  if (!analysis) return
  document.querySelector('#land-info')!.textContent = `${(analysis.landShare * 100).toFixed(1).replace('.', ',')} %`
  document.querySelector('#feature-info')!.textContent = `${analysis.islands} / ${analysis.lakes}`

  const counts = new Float64Array(BIOMES.length)
  let landArea = 0
  for (let cell = 0; cell < graph.cellCount; cell += 1) {
    if (!elevationsIsLand(cell)) continue
    counts[analysis.biomes[cell]] += 0.25 ** graph.level[cell]
    landArea += 0.25 ** graph.level[cell]
  }
  biomeLegendRows = BIOMES.map((biome, index) => ({ biome, index, count: counts[index] }))
    .filter(({ index, count }) => index !== MARINE_BIOME && count > 0)
    .sort((a, b) => b.count - a.count)
    .map(({ biome, count }) => `<li><i style="background:${biome.color}"></i>${biome.name}<span>${(count / Math.max(1e-9, landArea) * 100).toFixed(1).replace('.', ',')} %</span></li>`)
    .join('')
  updateLegend()
}

const gradientLegend = (title: string, gradient: string, low: string, high: string) =>
  `<p>${title}</p><i class="gradient" style="background:${gradient}"></i><div class="gradient-labels"><span>${low}</span><span>${high}</span></div>`

/** the key of the map view: biomes with their share of the land, or the colour scale of temperature and rain */
function updateLegend() {
  const html = displayMode === 'biome' ? `<ul>${biomeLegendRows}</ul>`
    : displayMode === 'temperature' ? gradientLegend('Temperatur', TEMPERATURE_GRADIENT, `${TEMPERATURE_RANGE[0]} °C`, `${TEMPERATURE_RANGE[1]} °C`)
      : displayMode === 'precipitation' ? gradientLegend('Niederschlag', PRECIPITATION_GRADIENT, 'trocken', `nass (${PRECIPITATION_RANGE[1]}+)`)
        : ''
  viewLegend.innerHTML = html
  viewLegend.classList.toggle('hidden', !html)
}

const elevationsIsLand = (cell: number) => elevations[cell] >= seaLevel()

// history

function snapshot(kind: HistoryKind, zoneId?: number): HistoryEntry {
  const entry: HistoryEntry = { kind, splits }
  if (kind === 'height') entry.elevations = elevations.slice()
  else if (kind === 'territory') entry.territoryIds = territoryIds.slice()
  else if (kind === 'zone') entry.zone = { id: zoneId!, mask: zoneMasks.get(zoneId!)?.slice() ?? null }
  else if (kind === 'markers') entry.markers = structuredClone(layerData().markers)
  else entry.routes = structuredClone(layerData().routes)
  return entry
}

/** call before a change: what is changed is put on the undo stack, one kind of data at a time */
function pushHistory(kind: HistoryKind = 'height', zoneId?: number) {
  undoStack.push(snapshot(kind, zoneId))
  if (undoStack.length > MAX_HISTORY) undoStack.shift()
  redoStack = []
  updateHistoryButtons()
}

function applyEntry(entry: HistoryEntry) {
  if (entry.elevations) elevations = entry.elevations
  if (entry.territoryIds) territoryIds = entry.territoryIds
  if (entry.zone) {
    if (entry.zone.mask) zoneMasks.set(entry.zone.id, entry.zone.mask)
    else zoneMasks.delete(entry.zone.id)
  }
  if (entry.markers) layerData().markers = entry.markers
  if (entry.routes) layerData().routes = entry.routes
}

async function restoreFrom(source: HistoryEntry[], target: HistoryEntry[]) {
  if (busy) return
  const previous = source.pop()
  if (!previous) return
  target.push(snapshot(previous.kind, previous.zone?.id))
  // a stroke that refined the mesh is undone together with the mesh; the other data follows onto it
  if (previous.splits !== splits) await switchMesh(previous.splits, (before, beforeElevations) => previous.elevations ?? remapHeights(before, beforeElevations, graph), 'Auflösung wird zurückgesetzt …')
  applyEntry(previous)
  setDirty()
  updateHistoryButtons()
  invalidateAnalysis(40)
  invalidateRegions(40)
  refreshPanels()
}

const undo = () => void restoreFrom(undoStack, redoStack)
const redo = () => void restoreFrom(redoStack, undoStack)

function updateHistoryButtons() {
  undoButton.disabled = undoStack.length === 0
  redoButton.disabled = redoStack.length === 0
}

// mesh refinement: resolution follows the zoom, but only where something is painted

const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))

/** rebuild the graph for another set of split blocks; build returns the heights for the new graph, the areas follow on their own */
async function switchMesh(nextSplits: ReadonlySet<number>, build: (previous: GridGraph, previousElevations: Float32Array) => Float32Array, label: string) {
  busy = true
  document.querySelector('#generating-label')!.textContent = label
  generatingIndicator.hidden = false
  await nextFrame()
  await new Promise(resolve => setTimeout(resolve))
  try {
    const previous = graph
    const previousElevations = elevations
    const previousIds = territoryIds
    const previousZones = zoneMasks
    splits = nextSplits
    buildGraph()
    elevations = build(previous, previousElevations)
    territoryIds = previousIds.length === previous.cellCount ? remapValues(previous, previousIds, graph) : new Uint16Array(graph.cellCount)
    zoneMasks = new Map([...previousZones].map(([id, mask]) => [id, remapValues(previous, mask, graph)]))
    updateProjectInfo()
    invalidateAnalysis()
    invalidateRegions(60)
    Object.assign(pending, { colors: true, gl: true, cover: true, ui: true })
    requestRender()
  } finally {
    generatingIndicator.hidden = true
    busy = false
  }
}

const baseGridOf = (source: GridGraph): BaseGrid => ({
  width: source.width, height: source.height, cellsX: source.cellsX, cellsY: source.cellsY,
  blockWidth: source.blockWidth, blockHeight: source.blockHeight, spacing: source.baseSpacing,
})

/** the level cells must have on screen for painting at this zoom: none larger than MAX_CELL_PX */
const wantedLevel = () => Math.min(MAX_LEVEL, Math.max(0, Math.ceil(Math.log2(graph.baseSpacing * view.scale / MAX_CELL_PX))))

const cellsInEllipse = (rx: number, ry: number, level: number) => Math.PI * rx * ry / (graph.blockWidth * graph.blockHeight / 4 ** level)

/** the level and the reach (in map units) a refinement around the brush gets, held to the cell budget */
function planRefinement(y: number, radiusKm: number, wanted: number) {
  const [kmX, kmY] = metric.kmPerUnit(y)
  const brushX = radiusKm / kmX * 1.5
  const brushY = radiusKm / kmY * 1.5
  let level = wanted
  while (level > 0 && cellsInEllipse(brushX, brushY, level) > REFINE_CELL_BUDGET) level -= 1

  const cell = graph.baseSpacing / 2 ** level
  let reachX = Math.max(brushX * 2, REFINE_REACH_CELLS * cell)
  let reachY = Math.max(brushY * 2, REFINE_REACH_CELLS * cell)
  const estimate = cellsInEllipse(reachX, reachY, level)
  if (estimate > REFINE_CELL_BUDGET) {
    const shrink = Math.sqrt(REFINE_CELL_BUDGET / estimate)
    reachX *= shrink
    reachY *= shrink
  }
  return { level, reachX: Math.max(reachX, brushX), reachY: Math.max(reachY, brushY) }
}

interface RefineArea {
  x: number
  y: number
  reachX: number
  reachY: number
}

/** split blocks so that every leaf touching the areas reaches the level, then rebuild the mesh */
async function refine(areas: RefineArea[], level: number) {
  const base = baseGridOf(graph)
  const next = new Set(graph.splits)
  for (const area of areas) refineEllipse(base, next, area.x, area.y, area.reachX, area.reachY, level)
  balanceSplits(base, next)
  if (next.size === graph.splits.size) return
  await switchMesh(next, (previous, previousElevations) => remapHeights(previous, previousElevations, graph), 'Auflösung wird erhöht …')
  const finest = graph.baseSpacing * metric.unitKm / 2 ** graph.maxLevel
  statusOutput.textContent = `Auflösung erhöht: ${graph.cellCount.toLocaleString('de-DE')} Zellen, fein bis ≈ ${formatKm(finest)}`
}

/** painting only refines where the stroke goes: raise the level of the cells under the brush if the zoom asks for it */
async function ensureDetail(point: Position): Promise<boolean> {
  const wanted = project.veil.mesh.autoRefine ? wantedLevel() : 0
  if (wanted === 0) return false
  const plan = planRefinement(point[1], brushRadiusKm, wanted)
  let coarsest = MAX_LEVEL
  for (const cell of selector.cells) coarsest = Math.min(coarsest, graph.level[cell])
  if (coarsest >= plan.level) return false
  await refine([{ x: point[0], y: point[1], reachX: plan.reachX, reachY: plan.reachY }], plan.level)
  return true
}

function formatKm(km: number) {
  return `${km >= 10 ? Math.round(km).toLocaleString('de-DE') : km.toLocaleString('de-DE', { maximumFractionDigits: 1 })} km`
}

// brush

const brushSettings = (): BrushSettings => ({ tool: activeTool, radiusKm: brushRadiusKm, strengthM: brushStrengthM, targetM: targetHeightM, filter: cellFilter })

async function stampAt(point: Position) {
  if (activeMode !== 'height') return paintRegionStamp(point)
  selector.select(point[0], point[1], brushRadiusKm, metric)
  if (await ensureDetail(point)) selector.select(point[0], point[1], brushRadiusKm, metric)
  applyBrushStamp(elevations, graph, selector, brushSettings(), heightScale(), strokeRandom)
  enforceCaveLimits(selector.cells)
  scheduleViewer(300)
  setDirty()
  invalidateAnalysis()
}

/** stamps along the way from the last stamp to the point */
async function strokeTo(point: Position) {
  const from = lastStampPoint
  lastStampPoint = point
  if (!from) return stampAt(point)
  const [kmX, kmY] = metric.kmPerUnit(point[1])
  const distanceKm = Math.hypot((point[0] - from[0]) * kmX, (point[1] - from[1]) * kmY)
  const steps = Math.max(1, Math.ceil(distanceKm / Math.max(1, brushRadiusKm * 0.32)))
  for (let step = 1; step <= steps; step += 1) {
    const ratio = step / steps
    await stampAt([from[0] + (point[0] - from[0]) * ratio, from[1] + (point[1] - from[1]) * ratio])
  }
}

function finishStroke() {
  statusOutput.textContent = 'Höhenänderung übernommen'
  if (analysisStale) runAnalysis()
}

/** strokes run one after another; a refinement in between makes later mouse moves wait, and they collapse into the latest one */
async function runStrokes() {
  if (strokeRunning) return
  strokeRunning = true
  try {
    while (strokeQueue.length) await strokeTo(strokeQueue.shift()!)
  } finally {
    strokeRunning = false
  }
  if (!isDrawing) finishStroke()
}

/** a mountain range or trough between two points; the mesh is refined along its course first if the zoom asks for it */
async function paintLine(start: Position, end: Position) {
  pushHistory()
  const settings = brushSettings()
  const wanted = project.veil.mesh.autoRefine ? wantedLevel() : 0
  const between = () => ridgePath(graph, strokeRandom, findCell(graph, start[0], start[1]), findCell(graph, end[0], end[1]), lineRandomness)
  if (wanted > 0) {
    const plan = planRefinement(end[1], brushRadiusKm, wanted)
    const reach = Math.min(plan.reachX, plan.reachY) / 2
    const areas: RefineArea[] = []
    let last: number | undefined
    for (const cell of between()) {
      if (last !== undefined && Math.hypot(graph.x[cell] - graph.x[last], graph.y[cell] - graph.y[last]) < reach / 2) continue
      areas.push({ x: graph.x[cell], y: graph.y[cell], reachX: plan.reachX / 2, reachY: plan.reachY / 2 })
      last = cell
    }
    await refine(areas, plan.level)
  }
  applyLine(elevations, graph, metric, settings, heightScale(), strokeRandom, between())
  enforceCaveLimits()
  setDirty()
  invalidateAnalysis(60)
  statusOutput.textContent = 'Höhenänderung übernommen'
}

function readout(point: Position) {
  const cell = findCell(graph, point[0], point[1])
  const [longitude, latitude] = normalizedToGeo([point[0] / graph.width, point[1] / graph.height], project.veil.map, project.veil.planet)
  const parts = [`${Math.round(elevations[cell]).toLocaleString('de-DE')} m`]
  if (analysis && !analysisStale && elevationsIsLand(cell)) {
    parts.push(BIOMES[analysis.biomes[cell]].name, `${analysis.temperature[cell]} °C`, `Regen ${analysis.precipitation[cell]}`)
  }
  parts.push(`Zelle ≈ ${formatKm(graph.baseSpacing * metric.unitKm / 2 ** graph.level[cell])}`, `${latitude.toFixed(3)}° / ${longitude.toFixed(3)}°`)
  cellReadout.textContent = parts.join(' · ')
}

uiCanvas.addEventListener('contextmenu', event => event.preventDefault())

uiCanvas.addEventListener('pointerdown', event => {
  if (event.button === 1 || event.button === 2 || (event.button === 0 && spaceHeld)) {
    panning = { x: event.clientX, y: event.clientY }
    uiCanvas.setPointerCapture(event.pointerId)
    uiCanvas.style.cursor = 'grabbing'
    return
  }
  if (event.button !== 0 || busy) return
  const point = eventMapPoint(event)
  if (!insideMap(point)) return
  if (activeMode === 'marker') return markerPointerDown(point, event)
  if (activeMode === 'route') return routePointerDown(point, event)
  if (activeMode === 'coast') return pickCoastAt(point)
  if (!brushActive()) return

  if (activeMode === 'height' && (activeTool === 'range' || activeTool === 'trough')) {
    if (lineStart === null) {
      lineStart = point
      statusOutput.textContent = 'Jetzt den Endpunkt anklicken'
    } else {
      const start = lineStart
      lineStart = null
      void paintLine(start, point)
    }
    pending.ui = true
    requestRender()
    return
  }

  pushHistory(activeMode === 'territory' ? 'territory' : activeMode === 'zone' ? 'zone' : 'height', activeZone)
  isDrawing = true
  lastStampPoint = null
  uiCanvas.setPointerCapture(event.pointerId)
  strokeQueue = [point]
  void runStrokes()
})

uiCanvas.addEventListener('pointermove', event => {
  if (panning) {
    setView({ scale: view.scale, x: view.x + event.clientX - panning.x, y: view.y + event.clientY - panning.y })
    panning = { x: event.clientX, y: event.clientY }
    return
  }
  const point = eventMapPoint(event)
  hoverPoint = point
  if (insideMap(point)) readout(point)
  if (draggingMarker && insideMap(point)) {
    const marker = selectedMarkerData()
    if (marker) {
      marker.x = point[0]
      marker.y = point[1]
      markOverlaysChanged()
    }
  }
  if (draggingHandle && insideMap(point)) {
    const route = layerData().routes.find(item => item.id === draggingHandle!.route)
    if (route) {
      route.waypoints[draggingHandle.index] = point
      route.points = [...route.waypoints]
      markOverlaysChanged()
    }
  }
  if (drawingRoute) pending.cover = true

  if (isDrawing && insideMap(point)) {
    strokeQueue = [point]
    void runStrokes()
  }
  pending.ui = true
  requestRender()
})

function stopPointer(event: PointerEvent) {
  if (uiCanvas.hasPointerCapture(event.pointerId)) uiCanvas.releasePointerCapture(event.pointerId)
  if (panning) {
    panning = null
    uiCanvas.style.cursor = restingCursor()
    return
  }
  if (draggingHandle) {
    const route = layerData().routes.find(item => item.id === draggingHandle!.route)
    draggingHandle = null
    if (route) rebuildRoute(route)
    setDirty()
    renderRoutes()
    markOverlaysChanged()
    return
  }
  if (draggingMarker) {
    draggingMarker = false
    setDirty()
    return
  }
  if (!isDrawing) return
  isDrawing = false
  if (!strokeRunning) finishStroke()
}

uiCanvas.addEventListener('pointerup', stopPointer)
uiCanvas.addEventListener('pointercancel', stopPointer)
uiCanvas.addEventListener('pointerleave', () => {
  if (isDrawing || panning) return
  hoverPoint = null
  pending.ui = true
  requestRender()
})
uiCanvas.addEventListener('wheel', event => {
  event.preventDefault()
  const delta = event.deltaY || event.deltaX
  if ((event.altKey && brushActive()) || (event.shiftKey && activeMode === 'height')) {
    if (event.altKey) nudgeRadius(Math.exp(-delta * 0.0012))
    else nudgeSlider(brushStrengthInput, Math.exp(-delta * 0.0012))
    return
  }
  zoomAt(event.clientX, event.clientY, Math.exp(-delta * 0.0016))
}, { passive: false })

// tools and controls

function selectTool(tool: BrushTool) {
  activeTool = tool
  lineStart = null
  const isLine = tool === 'range' || tool === 'trough'
  document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach(button => button.classList.toggle('active', button.dataset.tool === tool))
  document.querySelector('#target-height-row')!.classList.toggle('hidden', tool !== 'set')
  document.querySelector('#randomness-row')!.classList.toggle('hidden', !isLine)
  document.querySelector('#radius-label')!.textContent = isLine ? 'Breite (Radius)' : 'Radius'
  document.querySelector('#strength-label')!.textContent = isLine ? 'Höhe' : 'Stärke'
  statusOutput.textContent = TOOLS.find(item => item.id === tool)!.status
  pending.ui = true
  requestRender()
}

document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach(button => button.addEventListener('click', () => selectTool(button.dataset.tool as BrushTool)))
function setDisplay(mode: DisplayMode) {
  displayMode = mode
  scheduleViewer(60)
  document.querySelectorAll<HTMLButtonElement>('[data-display]').forEach(item => item.classList.toggle('active', item.dataset.display === mode))
  updateLegend()
  markColorsChanged()
}

const restingCursor = () => spaceHeld ? 'grab' : activeMode === 'climate' || activeMode === 'water' || activeMode === 'project' ? 'default' : 'crosshair'

/** the tool palette: only the height mode paints, the others show and tune what follows from the heights */
function selectMode(mode: EditorMode) {
  activeMode = mode
  lineStart = null
  drawingRoute = null
  if (mode !== 'coast') {
    coastTargetAt = null
    q<HTMLInputElement>('#coast-pick').checked = false
    findCoastTarget()
  }
  document.querySelectorAll<HTMLElement>('[data-modes]').forEach(section => { section.hidden = !section.dataset.modes!.split(' ').includes(mode) })
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(button => button.classList.toggle('active', button.dataset.mode === mode))
  const view = MODES.find(item => item.id === mode)!.view
  if (view) setDisplay(view)
  uiCanvas.style.cursor = restingCursor()
  statusOutput.textContent = MODES.find(item => item.id === mode)!.title
  renderMarkers()
  renderRoutes()
  pending.ui = true
  pending.cover = true
  requestRender()
}

document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(button => button.addEventListener('click', () => selectMode(button.dataset.mode as EditorMode)))
document.querySelectorAll<HTMLButtonElement>('[data-display]').forEach(button => button.addEventListener('click', () => setDisplay(button.dataset.display as DisplayMode)))

// sidebar width: dragged at its edge, remembered between sessions

const SIDEBAR_DEFAULT = 240
const SIDEBAR_MIN = 200
const SIDEBAR_MAX = 640
const sidebarResizer = document.querySelector<HTMLElement>('#sidebar-resizer')!
let sidebarWidth = SIDEBAR_DEFAULT

function setSidebarWidth(width: number) {
  sidebarWidth = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(width)))
  document.documentElement.style.setProperty('--sidebar-width', `${sidebarWidth}px`)
}

try {
  const stored = Number(localStorage.getItem('veil.sidebarWidth'))
  if (stored) setSidebarWidth(stored)
} catch { /* storage can be unavailable, the default width stays */ }

function rememberSidebarWidth() {
  try {
    localStorage.setItem('veil.sidebarWidth', String(sidebarWidth))
  } catch { /* not worth failing for */ }
}

sidebarResizer.addEventListener('pointerdown', event => {
  sidebarResizer.setPointerCapture(event.pointerId)
  const startX = event.clientX
  const startWidth = sidebarWidth
  const move = (moved: PointerEvent) => setSidebarWidth(startWidth + moved.clientX - startX)
  const stop = () => {
    sidebarResizer.removeEventListener('pointermove', move)
    sidebarResizer.removeEventListener('pointerup', stop)
    sidebarResizer.removeEventListener('pointercancel', stop)
    rememberSidebarWidth()
  }
  sidebarResizer.addEventListener('pointermove', move)
  sidebarResizer.addEventListener('pointerup', stop)
  sidebarResizer.addEventListener('pointercancel', stop)
})
sidebarResizer.addEventListener('dblclick', () => {
  setSidebarWidth(SIDEBAR_DEFAULT)
  rememberSidebarWidth()
})

const builtAt = new Date(__BUILD_TIME__)
const buildTime = `${builtAt.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })} ${builtAt.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`
document.querySelector('#app-version')!.textContent = `v${__APP_VERSION__} · Build ${buildTime}`
cellFilterSelect.addEventListener('change', () => { cellFilter = cellFilterSelect.value as CellFilter })
showCoastInput.addEventListener('change', () => { pending.cover = true; requestRender() })

function bindRange(input: HTMLInputElement, suffix: string, change: (value: number) => void, decimals = 0) {
  const output = document.querySelector<HTMLOutputElement>(`#${input.id}-output`)!
  input.addEventListener('input', () => {
    const value = Number(input.value)
    output.value = `${value.toLocaleString('de-DE', { maximumFractionDigits: decimals })} ${suffix}`.trim()
    change(value)
    pending.ui = true
    requestRender()
  })
}

// the radius slider is logarithmic, so small and large brushes are both fine to set, in whole kilometres
const radiusLimits = { min: 1, max: 1000 }
const radiusFromSlider = (position: number) => Math.round(radiusLimits.min * (radiusLimits.max / radiusLimits.min) ** (position / 1000))
const sliderFromRadius = (radius: number) => Math.round(1000 * Math.log(radius / radiusLimits.min) / Math.log(radiusLimits.max / radiusLimits.min))
function showBrushRadius() {
  brushRadiusInput.value = String(sliderFromRadius(brushRadiusKm))
  document.querySelector<HTMLOutputElement>('#brush-radius-output')!.value = `${brushRadiusKm.toLocaleString('de-DE')} km`
}
brushRadiusInput.addEventListener('input', () => {
  brushRadiusKm = radiusFromSlider(Number(brushRadiusInput.value))
  document.querySelector<HTMLOutputElement>('#brush-radius-output')!.value = `${brushRadiusKm.toLocaleString('de-DE')} km`
  pending.ui = true
  requestRender()
})
/** a step of the wheel or of [ and ]: a fraction of the radius, but at least one kilometre */
function nudgeRadius(factor: number) {
  const next = Math.round(brushRadiusKm * factor)
  brushRadiusKm = clampValue(next === brushRadiusKm ? brushRadiusKm + Math.sign(factor - 1) : next, radiusLimits.min, radiusLimits.max)
  showBrushRadius()
  pending.ui = true
  requestRender()
}
bindRange(brushStrengthInput, 'm', value => { brushStrengthM = value })
bindRange(targetHeightInput, 'm', value => { targetHeightM = value })
bindRange(randomnessInput, '%', value => { lineRandomness = value / 100 })
bindRange(seaLevelInput, 'm', value => {
  if (activeLayer === 'surface') project.veil.planet.seaLevelM = value
  else layerData().levelM = value
  if (activeLayer === 'underground') {
    refreshCaveLimits()
    invalidateRegions(200)
  }
  setDirty()
  invalidateAnalysis(120)
})

const climateInput = (id: string, key: 'equatorC' | 'northPoleC' | 'southPoleC' | 'precipitationPercent', suffix: string) =>
  bindRange(document.querySelector<HTMLInputElement>(id)!, suffix, value => {
    project.veil.climate[key] = value
    setDirty()
    invalidateAnalysis(120)
  })
climateInput('#climate-equator', 'equatorC', '°C')
climateInput('#climate-north', 'northPoleC', '°C')
climateInput('#climate-south', 'southPoleC', '°C')
climateInput('#climate-precipitation', 'precipitationPercent', '%')

/** the sidebar sliders show what the project holds */
function syncControlsFromProject() {
  const { climate, planet } = project.veil
  const set = (id: string, value: number, suffix: string, decimals = 0) => {
    document.querySelector<HTMLInputElement>(id)!.value = String(value)
    document.querySelector<HTMLOutputElement>(`${id}-output`)!.value = `${value.toLocaleString('de-DE', { maximumFractionDigits: decimals })} ${suffix}`.trim()
  }
  set('#climate-equator', climate.equatorC, '°C')
  set('#climate-north', climate.northPoleC, '°C')
  set('#climate-south', climate.southPoleC, '°C')
  set('#climate-precipitation', climate.precipitationPercent, '%')
  seaLevelInput.min = String(planet.minimumElevationM)
  seaLevelInput.max = String(planet.maximumElevationM)
}

document.querySelector('#zoom-out')!.addEventListener('click', () => zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1 / 1.25))
document.querySelector('#zoom-in')!.addEventListener('click', () => zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1.25))
document.querySelector('#zoom-fit')!.addEventListener('click', fitMap)

// generators

/** run a height change as one undoable step */
function replaceHeights(build: () => Float32Array, status: string) {
  pushHistory()
  elevations = build()
  enforceCaveLimits()
  setDirty()
  runAnalysis()
  statusOutput.textContent = status
}

document.querySelector('#apply-template')!.addEventListener('click', () => {
  const id = document.querySelector<HTMLSelectElement>('#template-select')!.value
  replaceHeights(() => {
    // templates work on the uniform base grid and are spread over the finer cells afterwards
    const scale = heightScale()
    const base = createGraph(graph.seed, graph.width, graph.height, project.veil.mesh.desiredCells, new Set())
    const heights = HeightmapGenerator.fromTemplate(base, createRandom(createSeed()), id)
    const meters = Float32Array.from(heights, height => fmgToMeters(height, scale))
    return splits.size === 0 ? meters : spreadBaseHeights(base, meters, graph)
  }, `Vorlage „${heightmapTemplates[id].name}“ angewendet`)
})

const landscape = { reliefM: 2500, featureKm: 250, ruggedness: 0.55, coastRampKm: 150, keepFromM: 500, keepMix: 0, drain: 0.85 }
bindRange(document.querySelector<HTMLInputElement>('#landscape-relief')!, 'm', value => { landscape.reliefM = value })
bindRange(document.querySelector<HTMLInputElement>('#landscape-size')!, 'km', value => { landscape.featureKm = value })
bindRange(document.querySelector<HTMLInputElement>('#landscape-rugged')!, '%', value => { landscape.ruggedness = value / 100 })
bindRange(document.querySelector<HTMLInputElement>('#landscape-ramp')!, 'km', value => { landscape.coastRampKm = value })
bindRange(document.querySelector<HTMLInputElement>('#landscape-keep')!, 'm', value => { landscape.keepFromM = value })
bindRange(document.querySelector<HTMLInputElement>('#landscape-mix')!, '%', value => { landscape.keepMix = value / 100 })
bindRange(document.querySelector<HTMLInputElement>('#landscape-drain')!, '%', value => { landscape.drain = value / 100 })

document.querySelector('#generate-landscape')!.addEventListener('click', () => {
  let counts = { kept: 0, generated: 0 }
  replaceHeights(() => {
    const { minimumElevationM, maximumElevationM } = project.veil.planet
    const result = generateLandscape(graph, metric, elevations, seaLevel(), { ...landscape, seed: createSeed(), minM: minimumElevationM, maxM: maximumElevationM })
    counts = result
    return result.elevations
  }, 'Keine Landmasse vorhanden')
  if (counts.generated + counts.kept) statusOutput.textContent = `Landschaft erzeugt: ${counts.generated.toLocaleString('de-DE')} Zellen neu, ${counts.kept.toLocaleString('de-DE')} behalten`
})

document.querySelector('#smooth-all')!.addEventListener('click', () => {
  replaceHeights(() => {
    const smoothed = elevations.slice()
    for (let cell = 0; cell < graph.cellCount; cell += 1) {
      let sum = elevations[cell]
      for (const neighbor of graph.neighbors[cell]) sum += elevations[neighbor]
      const mean = sum / (graph.neighbors[cell].length + 1)
      smoothed[cell] = (elevations[cell] * 3 + mean) / 4
    }
    return smoothed
  }, 'Alle Höhen geglättet')
})

document.querySelector('#load-heightmap')!.addEventListener('click', async () => {
  try {
    const path = await open({ multiple: false, directory: false, filters: [{ name: 'Bilder', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] })
    if (typeof path !== 'string') return
    const { bytes, mime } = await readImageFile(path)
    const image = await loadImage(URL.createObjectURL(new Blob([bytes], { type: mime })))
    const canvas = document.createElement('canvas')
    canvas.width = Math.min(image.width, 2048)
    canvas.height = Math.min(image.height, 2048)
    const context = canvas.getContext('2d', { willReadFrequently: true })!
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
    const scale = heightScale()
    replaceHeights(() => Float32Array.from({ length: graph.cellCount }, (_, cell) => {
      const column = Math.min(canvas.width - 1, Math.floor(graph.x[cell] / graph.width * canvas.width))
      const row = Math.min(canvas.height - 1, Math.floor(graph.y[cell] / graph.height * canvas.height))
      const lightness = pixels[(row * canvas.width + column) * 4] / 255
      const powered = lightness < 0.2 ? lightness : 0.2 + (lightness - 0.2) ** 0.8
      return fmgToMeters(Math.min(100, Math.floor(powered * 100)), scale)
    }), `Höhen aus ${path.split(/[\\/]/).at(-1)} übernommen`)
  } catch (error) {
    await message(error instanceof Error ? error.message : 'Bild konnte nicht geladen werden.', { title: 'Fehler', kind: 'error' })
  }
})

// project data

function updateProjectInfo() {
  const { planet, map, reference } = project.veil
  const size = projectedMapSize(map, planet)
  document.querySelector('#planet-name')!.textContent = planet.name
  document.querySelector('#map-mode')!.textContent = map.mode === 'global' ? 'Gesamter Planet' : 'Ausschnitt'
  document.querySelector('#map-size')!.textContent = `${Math.round(size.widthKm).toLocaleString('de-DE')} × ${Math.round(size.heightKm).toLocaleString('de-DE')} km`
  const baseCells = graph.cellsX * graph.cellsY
  const baseKm = graph.baseSpacing * metric.unitKm
  document.querySelector('#mesh-info')!.textContent = graph.cellCount === baseCells
    ? `${graph.cellCount.toLocaleString('de-DE')} Zellen`
    : `${graph.cellCount.toLocaleString('de-DE')} (Basis ${baseCells.toLocaleString('de-DE')})`
  document.querySelector('#cell-scale')!.textContent = graph.maxLevel === 0
    ? `≈ ${formatKm(baseKm)}`
    : `≈ ${formatKm(baseKm)}, fein ${formatKm(baseKm / 2 ** graph.maxLevel)}`
  seaLevelInput.value = String(seaLevel())
  document.querySelector<HTMLOutputElement>('#sea-level-output')!.value = `${seaLevel().toLocaleString('de-DE')} m`
  targetHeightInput.min = String(planet.minimumElevationM)
  targetHeightInput.max = String(planet.maximumElevationM)
  targetHeightM = Math.max(planet.minimumElevationM, Math.min(planet.maximumElevationM, targetHeightM))
  targetHeightInput.value = String(targetHeightM)
  document.querySelector<HTMLOutputElement>('#target-height-output')!.value = `${targetHeightM.toLocaleString('de-DE')} m`
  const shorterSide = Math.min(size.widthKm, size.heightKm)
  radiusLimits.min = Math.max(1, Math.round(shorterSide / 1000))
  radiusLimits.max = Math.max(radiusLimits.min * 2, Math.min(1000, Math.round(shorterSide / 3)))
  brushRadiusKm = clampValue(brushRadiusKm, radiusLimits.min, radiusLimits.max)
  showBrushRadius()
  document.querySelector('#reference-name')!.textContent = reference?.name ?? 'Keine Vorlage geladen'
  referenceOpacity.disabled = !reference
  terrainOpacity.disabled = !reference
  toggleReferenceButton.disabled = !reference
  referenceOpacity.value = String(Math.round((reference?.opacity ?? 0.55) * 100))
  terrainOpacity.value = String(Math.round((reference?.terrainOpacity ?? 0.78) * 100))
  toggleReferenceButton.textContent = referenceVisible && reference ? 'An' : 'Aus'
  applyTerrainOpacity()
  syncControlsFromProject()
}

/** build the graph for the project's seed, cell count and proportions and hand it to the renderer */
function buildGraph(): GridGraph {
  const { mesh, map, planet } = project.veil
  const size = getCanvasSize(map)
  const next = createGraph(mesh.seed, size.width, size.height, mesh.desiredCells, splits)
  graph = next
  metric = createMetric(next, map, planet)
  selector = new CellSelector(next)
  colorBuffer = new Uint8Array(next.cellCount * 4)
  renderer.setGraph(next)
  analysis = null
  analysisStale = true
  lineStart = null
  return next
}

function newElevations(): Float32Array {
  return new Float32Array(graph.cellCount).fill(Math.max(project.veil.planet.minimumElevationM, seaLevel() - 600))
}

function afterProjectChange(refit: boolean) {
  updateProjectInfo()
  updateHistoryButtons()
  runAnalysis()
  recomputeRegions()
  refreshPanels()
  if (refit) fitMap()
  Object.assign(pending, { colors: true, gl: true, background: true, cover: true, ui: true })
  requestRender()
}

async function readImageFile(path: string) {
  const bytes = await readFile(path)
  const extension = path.split('.').at(-1)?.toLowerCase()
  const mime = extension === 'png' ? 'image/png' : extension === 'webp' ? 'image/webp' : 'image/jpeg'
  return { bytes, mime }
}

function loadImage(source: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Das Bild konnte nicht gelesen werden.'))
    image.src = source
  })
}

function bytesToDataUrl(bytes: Uint8Array, mime: string) {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768))
  return `data:${mime};base64,${btoa(binary)}`
}

async function hydrateReference() {
  referenceImage = null
  if (!project.veil.reference) return
  referenceImage = await loadImage(project.veil.reference.dataUrl)
}

async function loadReference() {
  try {
    const path = await open({ multiple: false, directory: false, filters: [{ name: 'Bilder', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] })
    if (typeof path !== 'string') return
    const { bytes, mime } = await readImageFile(path)
    project.veil.reference = { name: path.split(/[\\/]/).at(-1) ?? 'Vorlage', dataUrl: bytesToDataUrl(bytes, mime), opacity: 0.55, terrainOpacity: 0.78 }
    referenceVisible = true
    await hydrateReference()
    updateProjectInfo()
    setDirty()
    pending.background = true
    requestRender()
  } catch (error) {
    await message(error instanceof Error ? error.message : 'Vorlage konnte nicht geladen werden.', { title: 'Fehler', kind: 'error' })
  }
}

/** write the in-memory state of a layer into its saved form */
function commitLayer(id: LayerId) {
  const state = id === activeLayer ? { splits, elevations, territoryIds, zoneMasks } : live[id]
  if (!state) return
  const data = project.veil.layers[id] ?? (project.veil.layers[id] = createLayer())
  data.splits = flattenSplits(state.splits)
  data.elevationsM = Array.from(state.elevations, value => Math.round(value * 10) / 10)
  data.territoryRuns = encodeRuns(state.territoryIds)
  data.zoneRuns = [...state.zoneMasks].map(([zone, mask]) => ({ id: zone, runs: encodeRuns(mask) }))
}

function serializeProject(): string {
  for (const { id } of LAYERS) commitLayer(id)
  return JSON.stringify(project)
}

async function saveProject(forceNewPath = false) {
  try {
    let path = forceNewPath ? null : currentProjectPath
    if (!path) path = await saveDialog({ defaultPath: `${project.veil.planet.name}.veilmap`, filters: [{ name: 'Veil-Höhenkarte', extensions: ['veilmap'] }] })
    if (!path) return
    await writeTextFile(path, serializeProject())
    currentProjectPath = path
    setDirty(false)
    statusOutput.textContent = `Gespeichert: ${path.split(/[\\/]/).at(-1)}`
  } catch (error) {
    await message(error instanceof Error ? error.message : 'Projekt konnte nicht gespeichert werden.', { title: 'Fehler beim Speichern', kind: 'error' })
  }
}

async function mayDiscardChanges() {
  return !dirty || confirm('Ungespeicherte Änderungen verwerfen?', { title: 'Veil Map Editor', kind: 'warning' })
}

/** put the saved data of a layer, or a blank layer, in memory for the graph that is built for it */
function activateLayer(id: LayerId) {
  activeLayer = id
  const data = layerData()
  splits = unflattenSplits(data.splits)
  buildGraph()
  elevations = data.elevationsM.length === graph.cellCount ? Float32Array.from(data.elevationsM) : newElevations()
  territoryIds = data.territoryRuns.length ? decodeRuns(data.territoryRuns, graph.cellCount, length => new Uint16Array(length)) : new Uint16Array(graph.cellCount)
  zoneMasks = new Map(data.zoneRuns.map(zone => [zone.id, decodeRuns(zone.runs, graph.cellCount, length => new Uint8Array(length))]))
}

const surfaceLayer = (splitsList: number[], elevationsM: number[], levelM: number): SavedLayer => ({ ...createLayer(levelM), splits: splitsList, elevationsM })

/** a loaded project of any format as a current one; older files are moved onto the current cell graph */
function adoptProject(loaded: unknown): VeilProject {
  const mismatch = () => new Error('Die Höhendaten passen nicht zum Mesh dieser Datei.')
  const meshOf = (map: MapSettings, cells: number) => createBaseGrid(getCanvasSize(map).width, getCanvasSize(map).height, cells)
  const current = { hydrology: { ...DEFAULT_HYDROLOGY }, rivers: true }

  if (isVeilProject(loaded)) {
    const next = withDefaults(loaded)
    const base = meshOf(next.veil.map, next.veil.mesh.desiredCells)
    for (const layer of Object.values(next.veil.layers)) {
      if (layer.elevationsM.length && enumerateLeaves(base, unflattenSplits(layer.splits)).level.length !== layer.elevationsM.length) throw mismatch()
    }
    return next
  }
  if (isFourProject(loaded)) {
    const { mesh, ...rest } = loaded.veil
    if (enumerateLeaves(meshOf(rest.map, mesh.desiredCells), unflattenSplits(mesh.splits)).level.length !== mesh.elevationsM.length) throw mismatch()
    return withDefaults({
      type: 'FeatureCollection', features: [],
      veil: { ...rest, ...current, formatVersion: 5, mesh: { seed: mesh.seed, desiredCells: mesh.desiredCells, autoRefine: false }, layers: { surface: surfaceLayer(mesh.splits, mesh.elevationsM, rest.planet.seaLevelM) } },
    })
  }
  if (isUniformProject(loaded)) {
    const { mesh, ...rest } = loaded.veil
    const size = getCanvasSize(rest.map)
    const old = createLegacyGraph(mesh.seed, size.width, size.height, mesh.desiredCells)
    if (old.cellCount !== mesh.elevationsM.length) throw mismatch()
    const target = createGraph(mesh.seed, size.width, size.height, mesh.desiredCells, new Set())
    const heights = Array.from(resampleHeights(old, Float32Array.from(mesh.elevationsM), target))
    return withDefaults({
      type: 'FeatureCollection', features: [],
      veil: { ...rest, ...current, formatVersion: 5, mesh: { seed: mesh.seed, desiredCells: mesh.desiredCells, autoRefine: false }, layers: { surface: surfaceLayer([], heights, rest.planet.seaLevelM) } },
    })
  }
  if (isLegacyProject(loaded)) {
    const { mesh, ...rest } = loaded.veil
    const size = getCanvasSize(rest.map)
    const target = createGraph(mesh.seed, size.width, size.height, mesh.desiredCells, new Set())
    const heights = Array.from(resampleLegacyHeights(mesh.points, mesh.elevationsM, target))
    return withDefaults({
      type: 'FeatureCollection', features: [],
      veil: { ...rest, ...current, formatVersion: 5, climate: { ...DEFAULT_CLIMATE }, coast: { ...DEFAULT_COAST }, mesh: { seed: mesh.seed, desiredCells: mesh.desiredCells, autoRefine: false }, layers: { surface: surfaceLayer([], heights, rest.planet.seaLevelM) } },
    })
  }
  throw new Error('Die Datei enthält keine Veil-Höhenkarte.')
}

/** replace the whole project: nothing of the old one stays in memory */
function loadProject(next: VeilProject, path: string | null) {
  project = next
  currentProjectPath = path
  for (const id of Object.keys(live) as LayerId[]) delete live[id]
  undoStack = []
  redoStack = []
  coastTarget = null
  activateLayer('surface')
}

async function openProject() {
  if (!(await mayDiscardChanges())) return
  const path = await open({ multiple: false, directory: false, filters: [{ name: 'Veil-Höhenkarte', extensions: ['veilmap', 'json'] }] })
  if (typeof path !== 'string') return
  try {
    const adopted = adoptProject(JSON.parse(await readTextFile(path)))
    referenceVisible = true
    project = adopted
    await hydrateReference()
    loadProject(adopted, path)
    afterProjectChange(true)
    setDirty(false)
    statusOutput.textContent = `Geladen: ${path.split(/[\\/]/).at(-1)}`
  } catch (error) {
    await message(error instanceof Error ? error.message : 'Projekt konnte nicht geladen werden.', { title: 'Fehler beim Laden', kind: 'error' })
  }
}

async function newProject() {
  if (!(await mayDiscardChanges())) return
  referenceImage = null
  referenceVisible = true
  loadProject(createProject(), null)
  afterProjectChange(true)
  setDirty(false)
  openSettings()
}

/** the sea, coast and cells at export size, without any editor overlay */
function renderExportCanvas(longSide = EXPORT_LONG_SIDE, symbolScale = 2): HTMLCanvasElement {
  if (analysisStale) runAnalysis()
  const scale = longSide / Math.max(graph.width, graph.height)
  const width = Math.round(graph.width * scale)
  const height = Math.round(graph.height * scale)
  const exportView: View = { scale, x: 0, y: 0 }
  const output = document.createElement('canvas')
  output.width = width
  output.height = height
  const context = output.getContext('2d')!
  context.fillStyle = LAYER_STYLES[activeLayer].sea
  context.fillRect(0, 0, width, height)

  const cells = document.createElement('canvas')
  cells.width = width
  cells.height = height
  const exporter = new CellRenderer(cells)
  exporter.setGraph(graph)
  const colors = new Uint8Array(graph.cellCount * 4)
  colorCells(colors, { graph, elevations, scale: heightScale(), mode: displayMode, analysis, layer: activeLayer, tint: territoryTint(), shoreRings: coversSea(displayMode) ? coastReach() : 0 })
  exporter.setColors(colors)
  exporter.draw(exportView)
  context.drawImage(cells, 0, 0)
  exporter.dispose()

  const overlay = document.createElement('canvas')
  overlay.width = width
  overlay.height = height
  const overlayContext = overlay.getContext('2d')!
  drawCoastOverlay(overlayContext, analysis, exportView, { ...coverOptions(), cover: coversSea(displayMode) })
  // symbols and labels are drawn in screen pixels: at twice the size on the large export
  const shown = { view, devicePixelScale }
  view = { scale: scale / symbolScale, x: 0, y: 0 }
  devicePixelScale = symbolScale
  try {
    drawAnnotations(overlayContext)
  } finally {
    view = shown.view
    devicePixelScale = shown.devicePixelScale
  }
  context.drawImage(overlay, 0, 0)
  return output
}

async function exportPng() {
  try {
    const path = await saveDialog({ defaultPath: `${project.veil.planet.name}.png`, filters: [{ name: 'PNG-Bild', extensions: ['png'] }] })
    if (!path) return
    const output = renderExportCanvas()
    const blob = await new Promise<Blob>((resolve, reject) => output.toBlob(value => value ? resolve(value) : reject(new Error('PNG konnte nicht erzeugt werden.')), 'image/png'))
    await writeFile(path, new Uint8Array(await blob.arrayBuffer()))
    statusOutput.textContent = `PNG exportiert: ${path.split(/[\\/]/).at(-1)}`
  } catch (error) {
    await message(error instanceof Error ? error.message : 'PNG konnte nicht exportiert werden.', { title: 'Fehler beim Export', kind: 'error' })
  }
}

// settings dialog

type Fields = HTMLFormControlsCollection & Record<string, HTMLInputElement | HTMLSelectElement>
const settingsFields = () => settingsForm.elements as Fields

function openSettings() {
  const fields = settingsFields()
  const { planet, map, mesh } = project.veil
  fields.planetName.value = planet.name
  fields.equatorialDiameter.value = String(planet.equatorialDiameterKm)
  fields.polarDiameter.value = String(planet.polarDiameterKm)
  fields.axialTilt.value = String(planet.axialTiltDeg)
  fields.minimumElevation.value = String(planet.minimumElevationM)
  fields.seaLevel.value = String(planet.seaLevelM)
  fields.maximumElevation.value = String(planet.maximumElevationM)
  fields.mapMode.value = map.mode
  fields.centerLongitude.value = String(map.centerLongitude)
  fields.centerLatitude.value = String(map.centerLatitude)
  fields.mapWidth.value = String(map.widthKm)
  fields.mapHeight.value = String(map.heightKm)
  fields.desiredCells.value = String(mesh.desiredCells)
  fields.meshSeed.value = mesh.seed
  ;(fields.autoRefine as HTMLInputElement).checked = mesh.autoRefine
  syncCellSize('cells')
  toggleRegionSettings()
  settingsDialog.showModal()
}

function toggleRegionSettings() {
  document.querySelector('#region-settings')!.classList.toggle('disabled-fields', settingsFields().mapMode.value === 'global')
}

/** area of the map in square kilometres as the form describes it right now */
function formArea() {
  const fields = settingsFields()
  const map = { ...project.veil.map, mode: fields.mapMode.value as 'global' | 'region', widthKm: Number(fields.mapWidth.value), heightKm: Number(fields.mapHeight.value) }
  const planet = { ...project.veil.planet, equatorialDiameterKm: Number(fields.equatorialDiameter.value), polarDiameterKm: Number(fields.polarDiameter.value) }
  const size = projectedMapSize(map, planet)
  return size.widthKm * size.heightKm
}

/** cell count and cell size follow each other, the cells tile the map */
function syncCellSize(source: 'cells' | 'size') {
  const fields = settingsFields()
  const area = formArea()
  if (source === 'cells') fields.cellSizeKm.value = String(Number(Math.sqrt(area / Math.max(1, Number(fields.desiredCells.value))).toPrecision(4)))
  else fields.desiredCells.value = String(Math.max(1000, Math.round(area / Math.max(1e-6, Number(fields.cellSizeKm.value)) ** 2)))
  const cells = Number(fields.desiredCells.value)
  document.querySelector('#cells-hint')!.textContent = `${cells.toLocaleString('de-DE')} Zellen brauchen etwa ${Math.round(cells * 0.5 / 1000).toLocaleString('de-DE')} MB Arbeitsspeicher; Klima, Flüsse und Küsten brauchen nach jedem Strich ${cells > 400000 ? 'mehrere Sekunden' : 'einen Moment'}.`
}

for (const name of ['desiredCells', 'mapWidth', 'mapHeight', 'equatorialDiameter', 'polarDiameter']) settingsFields()[name].addEventListener('input', () => syncCellSize('cells'))
settingsFields().mapMode.addEventListener('change', () => syncCellSize('cells'))
settingsFields().cellSizeKm.addEventListener('input', () => syncCellSize('size'))

settingsForm.addEventListener('submit', async event => {
  event.preventDefault()
  const fields = settingsFields()
  const number = (name: string) => Number(fields[name].value)
  const nextMap = {
    mode: fields.mapMode.value as 'global' | 'region',
    projection: 'equirectangular' as const,
    centerLongitude: number('centerLongitude'), centerLatitude: number('centerLatitude'),
    widthKm: number('mapWidth'), heightKm: number('mapHeight'),
  }
  const nextCells = Math.max(1000, Math.round(number('desiredCells')))
  const nextSeed = fields.meshSeed.value.trim()
  const baseChanged = nextCells !== project.veil.mesh.desiredCells
    || Math.abs(getMapAspect(nextMap) - getMapAspect(project.veil.map)) > 0.001
  const regenerate = baseChanged || nextSeed !== project.veil.mesh.seed
  const otherLayers = LAYERS.map(layer => layer.id).filter(id => id !== activeLayer && (live[id] || project.veil.layers[id]?.elevationsM.length))
  if (nextCells > 1000000 && nextCells !== project.veil.mesh.desiredCells && !(await confirm(`${nextCells.toLocaleString('de-DE')} Zellen brauchen viel Arbeitsspeicher und mehrere Sekunden pro Änderung. Fortfahren?`, { title: 'Sehr feines Mesh', kind: 'warning' }))) return
  if (baseChanged && splits.size > 0 && !(await confirm('Eine andere Zellzahl oder ein anderes Seitenverhältnis verwirft die verfeinerten Bereiche. Fortfahren?', { title: 'Mesh neu erzeugen', kind: 'warning' }))) return
  if (regenerate && otherLayers.length && !(await confirm('Höhen und Gebietsflächen der anderen Ebenen werden dabei zurückgesetzt. Marker und Routen bleiben. Fortfahren?', { title: 'Mesh neu erzeugen', kind: 'warning' }))) return

  project.veil.planet = {
    name: fields.planetName.value.trim(), equatorialDiameterKm: number('equatorialDiameter'), polarDiameterKm: number('polarDiameter'),
    axialTiltDeg: number('axialTilt'), minimumElevationM: number('minimumElevation'), seaLevelM: number('seaLevel'), maximumElevationM: number('maximumElevation'),
  }
  project.veil.map = nextMap
  project.veil.mesh.desiredCells = nextCells
  project.veil.mesh.seed = nextSeed
  project.veil.mesh.autoRefine = (fields.autoRefine as HTMLInputElement).checked
  settingsDialog.close()
  generatingIndicator.hidden = false
  await new Promise(resolve => requestAnimationFrame(resolve))
  await new Promise(resolve => setTimeout(resolve))

  const { minimumElevationM, maximumElevationM } = project.veil.planet
  const clamped = (source: Float32Array) => source.map(height => Math.max(minimumElevationM, Math.min(maximumElevationM, height)))
  if (regenerate) {
    const previous = graph
    const previousHeights = elevations
    const previousIds = territoryIds
    const previousZones = zoneMasks
    if (baseChanged) splits = new Set()
    buildGraph()
    elevations = clamped(resampleHeights(previous, previousHeights, graph))
    territoryIds = previousIds.length === previous.cellCount ? resampleValues(previous, previousIds, graph) : new Uint16Array(graph.cellCount)
    zoneMasks = new Map([...previousZones].map(([id, mask]) => [id, resampleValues(previous, mask, graph)]))
    for (const id of otherLayers) {
      delete live[id]
      Object.assign(project.veil.layers[id]!, { splits: [], elevationsM: [], territoryRuns: [], zoneRuns: [] })
    }
  } else {
    elevations = clamped(elevations)
    metric = createMetric(graph, project.veil.map, project.veil.planet)
  }
  undoStack = []
  redoStack = []
  afterProjectChange(regenerate)
  generatingIndicator.hidden = true
  setDirty()
})

document.querySelector('#edit-settings')!.addEventListener('click', openSettings)
document.querySelector('#cancel-settings')!.addEventListener('click', () => settingsDialog.close())
document.querySelector('#cancel-settings-bottom')!.addEventListener('click', () => settingsDialog.close())
;(settingsForm.elements.namedItem('mapMode') as HTMLSelectElement).addEventListener('change', toggleRegionSettings)
document.querySelector('#new-seed')!.addEventListener('click', () => { settingsFields().meshSeed.value = createSeed() })
document.querySelector('#load-reference')!.addEventListener('click', () => void loadReference())
document.querySelector('#new-project')!.addEventListener('click', () => void newProject())
document.querySelector('#open-project')!.addEventListener('click', () => void openProject())
document.querySelector('#save-project')!.addEventListener('click', () => void saveProject())
document.querySelector('#save-project-as')!.addEventListener('click', () => void saveProject(true))
document.querySelector('#export')!.addEventListener('click', () => void exportPng())
undoButton.addEventListener('click', undo)
redoButton.addEventListener('click', redo)

referenceOpacity.addEventListener('input', () => {
  if (!project.veil.reference) return
  project.veil.reference.opacity = Number(referenceOpacity.value) / 100
  setDirty()
  pending.background = true
  requestRender()
})
terrainOpacity.addEventListener('input', () => {
  if (!project.veil.reference) return
  project.veil.reference.terrainOpacity = Number(terrainOpacity.value) / 100
  setDirty()
  applyTerrainOpacity()
})
toggleReferenceButton.addEventListener('click', () => {
  referenceVisible = !referenceVisible
  updateProjectInfo()
  pending.background = true
  requestRender()
})

const typingInField = (event: KeyboardEvent) => event.target instanceof HTMLInputElement && event.target.type !== 'range' || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement

window.addEventListener('keydown', event => {
  if (event.ctrlKey && event.key.toLowerCase() === 's') { event.preventDefault(); void saveProject(event.shiftKey) }
  else if (event.ctrlKey && event.key.toLowerCase() === 'o') { event.preventDefault(); void openProject() }
  else if (event.ctrlKey && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo() }
  else if (event.ctrlKey && event.key.toLowerCase() === 'y') { event.preventDefault(); redo() }
  else if (typingInField(event)) return
  else if (event.key === 'Escape' && (lineStart !== null || drawingRoute)) { lineStart = null; drawingRoute = null; pending.ui = true; pending.cover = true; requestRender() }
  else if (event.key === 'Enter' && drawingRoute) finishRoute()
  else if (event.key === 'Backspace' && drawingRoute) {
    const removed = drawingRoute.marks.pop() ?? 0
    drawingRoute.points.splice(drawingRoute.points.length - removed, removed)
    drawingRoute.waypoints.pop()
    if (!drawingRoute.points.length) drawingRoute = null
    pending.cover = true
    requestRender()
  } else if ((event.key === 'Delete' || event.key === 'Backspace') && activeMode === 'marker') deleteSelectedMarker()
  else if ((event.key === 'Delete' || event.key === 'Backspace') && activeMode === 'route') deleteSelectedRoute()
  else if (brushActive() && (event.key === '[' || event.key === ']')) nudgeRadius(event.key === ']' ? 1.12 : 0.89)
  else if (event.code === 'Space') { event.preventDefault(); spaceHeld = true; if (!panning) uiCanvas.style.cursor = 'grab' }
  else if (activeMode === 'height' && !event.ctrlKey && /^[1-7]$/.test(event.key)) selectTool(TOOLS[Number(event.key) - 1].id)
})
window.addEventListener('keyup', event => {
  if (event.code !== 'Space') return
  spaceHeld = false
  if (!panning) uiCanvas.style.cursor = restingCursor()
})

// ---- the panels of the overlay modes: water, coast, areas, markers, routes ----

const q = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!
const escapeHtml = (text: string) => text.replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!)
const nextId = (items: { id: number }[]) => items.reduce((most, item) => Math.max(most, item.id), 0) + 1
const toScreenPoint = ([x, y]: Position): Position => [view.x + x * view.scale, view.y + y * view.scale]
const clampValue = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

for (const chip of document.querySelectorAll<HTMLInputElement>('[data-overlay]')) {
  chip.addEventListener('change', () => {
    overlayVisible[chip.dataset.overlay as keyof typeof overlayVisible] = chip.checked
    markOverlaysChanged()
  })
}

// water

const isDryLand = (cell: number) => elevationsIsLand(cell) && !(analysis && !analysisStale && analysis.lakeDepth[cell] > 0)

q('#draw-river').addEventListener('click', () => {
  routeKind = 'river'
  selectMode('route')
  renderRoutes()
})
q<HTMLInputElement>('#rivers-enabled').addEventListener('change', event => {
  project.veil.rivers = (event.target as HTMLInputElement).checked
  setDirty()
  invalidateAnalysis(60)
})
q<HTMLInputElement>('#lakes-enabled').addEventListener('change', event => {
  project.veil.hydrology.lakes = (event.target as HTMLInputElement).checked
  setDirty()
  invalidateAnalysis(60)
})
bindRange(q<HTMLInputElement>('#river-density'), '%', value => {
  project.veil.hydrology.riverThreshold = DEFAULT_HYDROLOGY.riverThreshold * 100 / value
  setDirty()
  invalidateAnalysis(150)
})
bindRange(q<HTMLInputElement>('#lake-depth'), 'm', value => {
  project.veil.hydrology.minLakeDepthM = value
  setDirty()
  invalidateAnalysis(150)
})

// coast: the settings of the whole map, or of the island or lake that was picked

let coastTargetAt: Position | null = null

const COAST_SLIDERS: [string, 'maxDepth' | 'baseAmplitude' | 'amplitudeDecay' | 'minEdge' | 'smoothThreshold' | 'roughnessContrast' | 'roughnessScale' | 'lakeSmoothThreshMult' | 'variant', number][] = [
  ['#coast-depth', 'maxDepth', 0], ['#coast-amplitude', 'baseAmplitude', 1], ['#coast-decay', 'amplitudeDecay', 2], ['#coast-minedge', 'minEdge', 1],
  ['#coast-calm', 'smoothThreshold', 2], ['#coast-contrast', 'roughnessContrast', 1], ['#coast-stretch', 'roughnessScale', 0], ['#coast-lake', 'lakeSmoothThreshMult', 1], ['#coast-variant', 'variant', 0],
]

/** the settings of the picked feature, made on demand */
function ownCoastSettings(create: boolean) {
  if (coastTarget === null || !analysis) return undefined
  const feature = analysis.features.features[coastTarget]
  const existing = analysis.overriddenFeatures.get(coastTarget)
  if (existing || !create || !feature) return existing
  const override = { x: graph.x[feature.firstCell], y: graph.y[feature.firstCell], settings: {} }
  layerData().coastOverrides.push(override)
  analysis.overriddenFeatures.set(coastTarget, override.settings)
  return override.settings
}

function syncCoastControls() {
  const settings = { ...project.veil.coast, ...ownCoastSettings(false) }
  for (const [id, key, decimals] of COAST_SLIDERS) {
    q<HTMLInputElement>(id).value = String(settings[key])
    q<HTMLOutputElement>(`${id}-output`).value = settings[key].toLocaleString('de-DE', { maximumFractionDigits: decimals })
  }
  q<HTMLInputElement>('#coast-enabled').checked = settings.enabled
  const feature = coastTarget === null ? undefined : analysis?.features.features[coastTarget]
  q('#coast-target-info').textContent = feature
    ? `${feature.type === 'lake' ? 'See' : 'Insel'} mit ${feature.cells.toLocaleString('de-DE')} Zellen${ownCoastSettings(false) ? ' hat eigene Einstellungen.' : ': die Regler ändern nur diese Küste.'}`
    : 'Die Regler gelten für die ganze Karte.'
  q('#coast-reset').hidden = !ownCoastSettings(false)
}

/** the picked island or lake keeps its place in the numbering of the features when they are counted again */
function findCoastTarget() {
  const at = coastTargetAt
  coastTarget = at && analysis && !analysisStale ? analysis.features.ids[findCell(graph, at[0], at[1])] : null
  if (coastTarget !== null && analysis?.features.features[coastTarget]?.type === 'ocean') coastTarget = null
  syncCoastControls()
}

function setCoastValue<K extends keyof typeof project.veil.coast>(key: K, value: (typeof project.veil.coast)[K]) {
  if (coastTarget === null) project.veil.coast[key] = value
  else Object.assign(ownCoastSettings(true)!, { [key]: value })
  setDirty()
  invalidateAnalysis(120)
}

for (const [id, key, decimals] of COAST_SLIDERS) bindRange(q<HTMLInputElement>(id), '', value => setCoastValue(key, value), decimals)
q<HTMLInputElement>('#coast-enabled').addEventListener('change', event => {
  setCoastValue('enabled', (event.target as HTMLInputElement).checked)
})
q<HTMLInputElement>('#coast-pick').addEventListener('change', event => {
  if (!(event.target as HTMLInputElement).checked) coastTargetAt = null
  findCoastTarget()
  pending.cover = true
  requestRender()
})
q('#coast-reset').addEventListener('click', () => {
  const own = ownCoastSettings(false)
  layerData().coastOverrides = layerData().coastOverrides.filter(override => override.settings !== own)
  setDirty()
  invalidateAnalysis(60)
})

function pickCoastAt(point: Position) {
  if (!q<HTMLInputElement>('#coast-pick').checked || !analysis || analysisStale) return
  const feature = analysis.features.features[analysis.features.ids[findCell(graph, point[0], point[1])]]
  coastTargetAt = feature && feature.type !== 'ocean' ? [graph.x[feature.firstCell], graph.y[feature.firstCell]] : null
  findCoastTarget()
  pending.cover = true
  requestRender()
}

// areas: territories and zones share the brush

let regionTool: 'paint' | 'erase' | 'fill' = 'paint'
let activeTerritory = 0
let activeZone = 0

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-region-tool]')) {
  button.addEventListener('click', () => {
    regionTool = button.dataset.regionTool as typeof regionTool
    document.querySelectorAll<HTMLButtonElement>('[data-region-tool]').forEach(item => item.classList.toggle('active', item === button))
  })
}

const TERRITORY_COLORS = ['#d95f5f', '#5f8fd9', '#5fbf7a', '#d9b25f', '#a55fd9', '#5fc9c9', '#d97fb0', '#8f9f5f']
const ZONE_KINDS = ['Gefahr', 'Magie', 'Krieg', 'Überschwemmung', 'Dürre', 'Krankheit', 'Handel', 'Kultur', 'Eigene']
const ZONE_COLORS: Record<string, string> = { Gefahr: '#c0392b', Magie: '#8e44ad', Krieg: '#a93226', Überschwemmung: '#2e86c1', Dürre: '#ca8a04', Krankheit: '#5b8c2a', Handel: '#d4a017', Kultur: '#16a085', Eigene: '#7f8c8d' }

function renderTerritories() {
  q('#territory-list').innerHTML = layerData().territories.map(territory => `
    <li class="entity${territory.id === activeTerritory ? ' active' : ''}" data-id="${territory.id}">
      <input type="color" value="${territory.color}" data-field="color" title="Farbe" />
      <input type="text" value="${escapeHtml(territory.name)}" data-field="name" />
      <select data-field="labelSize" title="Schriftgröße">${[1, 2, 3, 4, 5].map(size => `<option value="${size}"${size === territory.labelSize ? ' selected' : ''}>${size}</option>`).join('')}</select>
      <input type="checkbox" data-field="showLabel" title="Namen zeigen"${territory.showLabel ? ' checked' : ''} />
      <button data-action="delete" title="Gebiet löschen">×</button>
    </li>`).join('') || '<li class="entity-empty">Noch kein Gebiet.</li>'
}

function renderZones() {
  q('#zone-list').innerHTML = layerData().zones.map(zone => `
    <li class="entity zone${zone.id === activeZone ? ' active' : ''}" data-id="${zone.id}">
      <input type="color" value="${zone.color}" data-field="color" title="Farbe" />
      <input type="text" value="${escapeHtml(zone.name)}" data-field="name" />
      <input type="checkbox" data-field="visible" title="Sichtbar"${zone.visible ? ' checked' : ''} />
      <button data-action="delete" title="Zone löschen">×</button>
      <select data-field="kind">${ZONE_KINDS.map(kind => `<option${kind === zone.kind ? ' selected' : ''}>${kind}</option>`).join('')}</select>
      <select data-field="pattern">${(['hatch', 'cross', 'dots', 'solid'] as const).map(pattern => `<option value="${pattern}"${pattern === zone.pattern ? ' selected' : ''}>${({ hatch: 'schraffiert', cross: 'kariert', dots: 'gepunktet', solid: 'flächig' })[pattern]}</option>`).join('')}</select>
      <input type="range" min="0.1" max="0.9" step="0.05" value="${zone.opacity}" data-field="opacity" title="Deckkraft" />
    </li>`).join('') || '<li class="entity-empty">Noch keine Zone.</li>'
}

/** the row a list event came from */
const rowOf = (event: Event) => (event.target as HTMLElement).closest<HTMLElement>('li[data-id]')

q('#territory-add').addEventListener('click', () => {
  const data = layerData()
  const id = nextId(data.territories)
  data.territories.push({ id, name: `Gebiet ${id}`, color: TERRITORY_COLORS[(id - 1) % TERRITORY_COLORS.length], labelSize: 3, showLabel: true })
  activeTerritory = id
  setDirty()
  renderTerritories()
})

q('#territory-list').addEventListener('input', event => {
  const row = rowOf(event)
  const territory = row && layerData().territories.find(item => item.id === Number(row.dataset.id))
  const field = (event.target as HTMLElement).dataset.field
  if (!territory || !field) return
  const target = event.target as HTMLInputElement
  if (field === 'showLabel') territory.showLabel = target.checked
  else if (field === 'labelSize') territory.labelSize = Number(target.value)
  else if (field === 'color') territory.color = target.value
  else if (field === 'name') territory.name = target.value
  setDirty()
  invalidateRegions(field === 'name' ? 250 : 40)
})

q('#territory-list').addEventListener('click', event => {
  const row = rowOf(event)
  if (!row) return
  const id = Number(row.dataset.id)
  if ((event.target as HTMLElement).dataset.action === 'delete') {
    if (territoryIds.some(value => value === id)) {
      pushHistory('territory')
      territoryIds = territoryIds.map(value => value === id ? 0 : value)
    }
    layerData().territories = layerData().territories.filter(item => item.id !== id)
    if (activeTerritory === id) activeTerritory = 0
    setDirty()
    invalidateRegions(40)
    renderTerritories()
    return
  }
  activeTerritory = id
  document.querySelectorAll('#territory-list .entity').forEach(item => item.classList.toggle('active', item === row))
})

q('#zone-add').addEventListener('click', () => {
  const data = layerData()
  const id = nextId(data.zones)
  data.zones.push({ id, name: `Zone ${id}`, kind: 'Gefahr', color: ZONE_COLORS.Gefahr, pattern: 'hatch', opacity: 0.45, visible: true })
  activeZone = id
  setDirty()
  renderZones()
})

q('#zone-list').addEventListener('input', event => {
  const row = rowOf(event)
  const zone = row && layerData().zones.find(item => item.id === Number(row.dataset.id))
  const field = (event.target as HTMLElement).dataset.field
  if (!zone || !field) return
  const target = event.target as HTMLInputElement
  if (field === 'visible') zone.visible = target.checked
  else if (field === 'opacity') zone.opacity = Number(target.value)
  else if (field === 'pattern') zone.pattern = target.value as typeof zone.pattern
  else if (field === 'color') zone.color = target.value
  else if (field === 'name') zone.name = target.value
  else if (field === 'kind') {
    zone.kind = target.value
    zone.color = ZONE_COLORS[target.value]
    renderZones()
  }
  setDirty()
  invalidateRegions(40)
})

q('#zone-list').addEventListener('click', event => {
  const row = rowOf(event)
  if (!row) return
  const id = Number(row.dataset.id)
  if ((event.target as HTMLElement).dataset.action === 'delete') {
    if (zoneMasks.has(id)) pushHistory('zone', id)
    zoneMasks.delete(id)
    layerData().zones = layerData().zones.filter(item => item.id !== id)
    if (activeZone === id) activeZone = 0
    setDirty()
    invalidateRegions(40)
    renderZones()
    return
  }
  activeZone = id
  document.querySelectorAll('#zone-list .entity').forEach(item => item.classList.toggle('active', item === row))
})

/** the cells a paint or erase stamp covers: the brush disc, or the whole body of land or water that was clicked */
function regionCells(point: Position): number[] {
  if (regionTool !== 'fill') {
    selector.select(point[0], point[1], brushRadiusKm, metric)
    return selector.cells
  }
  const start = findCell(graph, point[0], point[1])
  const land = isDryLand(start)
  const seen = new Uint8Array(graph.cellCount)
  const cells = [start]
  seen[start] = 1
  for (let cursor = 0; cursor < cells.length; cursor += 1) {
    for (const neighbor of graph.neighbors[cells[cursor]]) {
      if (!seen[neighbor] && isDryLand(neighbor) === land) {
        seen[neighbor] = 1
        cells.push(neighbor)
      }
    }
  }
  return cells
}

function paintRegionStamp(point: Position) {
  if (activeMode === 'territory') {
    if (!activeTerritory && regionTool !== 'erase') {
      statusOutput.textContent = 'Lege zuerst ein Gebiet an oder wähle eines aus'
      return
    }
    const value = regionTool === 'erase' ? 0 : activeTerritory
    for (const cell of regionCells(point)) territoryIds[cell] = value
  } else {
    if (!activeZone) {
      statusOutput.textContent = 'Lege zuerst eine Zone an oder wähle eine aus'
      return
    }
    let mask = zoneMasks.get(activeZone)
    if (!mask) {
      if (regionTool === 'erase') return
      zoneMasks.set(activeZone, mask = new Uint8Array(graph.cellCount))
    }
    const value = regionTool === 'erase' ? 0 : 1
    for (const cell of regionCells(point)) mask[cell] = value
  }
  setDirty()
  invalidateRegions()
  pending.colors = true
  requestRender()
}

// markers

let markerKind: MarkerKind = 'city'
let selectedMarker: number | null = null
let draggingMarker = false

const MARKER_COLOR = '#f4e2a8'
const selectedMarkerData = () => layerData().markers.find(marker => marker.id === selectedMarker)

q('#marker-kinds').innerHTML = MARKER_KINDS.map(kind => `<button data-kind="${kind.id}" title="${kind.label}">${kind.label}</button>`).join('')
q<HTMLSelectElement>('#marker-kind').innerHTML = MARKER_KINDS.map(kind => `<option value="${kind.id}">${kind.label}</option>`).join('')

function renderMarkers() {
  document.querySelectorAll<HTMLButtonElement>('#marker-kinds button').forEach(button => button.classList.toggle('active', button.dataset.kind === markerKind))
  const marker = selectedMarkerData()
  q('#marker-editor').hidden = !marker || activeMode !== 'marker'
  if (marker) {
    q<HTMLInputElement>('#marker-name').value = marker.name
    q<HTMLSelectElement>('#marker-kind').value = marker.kind
    q<HTMLSelectElement>('#marker-side').value = marker.labelSide
    q<HTMLInputElement>('#marker-size').value = String(marker.size)
    q<HTMLOutputElement>('#marker-size-output').value = String(marker.size)
    q<HTMLInputElement>('#marker-label').checked = marker.showLabel
    q<HTMLInputElement>('#marker-color').value = marker.color
    q<HTMLTextAreaElement>('#marker-note').value = marker.note
  }
  q('#marker-list').innerHTML = layerData().markers.map(item => `
    <li class="entity${item.id === selectedMarker ? ' active' : ''}" data-id="${item.id}"><span class="entity-kind">${kindLabel(item.kind)}</span><span class="entity-name">${escapeHtml(item.name) || '—'}</span></li>`).join('') || '<li class="entity-empty">Noch kein Marker.</li>'
}

function selectMarker(id: number | null) {
  selectedMarker = id
  renderMarkers()
  markOverlaysChanged()
}

q('#marker-kinds').addEventListener('click', event => {
  const kind = (event.target as HTMLElement).dataset.kind as MarkerKind | undefined
  if (!kind) return
  markerKind = kind
  renderMarkers()
})

function editMarker(change: (marker: Marker) => void) {
  const marker = selectedMarkerData()
  if (!marker) return
  change(marker)
  setDirty()
  markOverlaysChanged()
}

q('#marker-name').addEventListener('input', event => {
  editMarker(marker => { marker.name = (event.target as HTMLInputElement).value })
  const row = document.querySelector(`#marker-list li[data-id="${selectedMarker}"] .entity-name`)
  if (row) row.textContent = (event.target as HTMLInputElement).value || '—'
})
q('#marker-kind').addEventListener('change', event => { editMarker(marker => { marker.kind = (event.target as HTMLSelectElement).value as MarkerKind }); renderMarkers() })
q('#marker-side').addEventListener('change', event => editMarker(marker => { marker.labelSide = (event.target as HTMLSelectElement).value as Marker['labelSide'] }))
bindRange(q<HTMLInputElement>('#marker-size'), '', value => editMarker(marker => { marker.size = value }))
q('#marker-label').addEventListener('change', event => editMarker(marker => { marker.showLabel = (event.target as HTMLInputElement).checked }))
q('#marker-color').addEventListener('input', event => editMarker(marker => { marker.color = (event.target as HTMLInputElement).value }))
q('#marker-note').addEventListener('input', event => editMarker(marker => { marker.note = (event.target as HTMLTextAreaElement).value }))

function deleteSelectedMarker() {
  const marker = selectedMarkerData()
  if (!marker) return
  pushHistory('markers')
  layerData().markers = layerData().markers.filter(item => item.id !== marker.id)
  selectedMarker = null
  setDirty()
  renderMarkers()
  markOverlaysChanged()
}
q('#marker-delete').addEventListener('click', deleteSelectedMarker)
q('#marker-list').addEventListener('click', event => {
  const row = rowOf(event)
  if (row) selectMarker(Number(row.dataset.id))
})

function markerPointerDown(point: Position, event: PointerEvent) {
  const rect = uiCanvas.getBoundingClientRect()
  const screen: Position = [event.clientX - rect.left, event.clientY - rect.top]
  const hit = overlayVisible.markers ? hitMarker(layerData().markers, screen, marker => toScreenPoint([marker.x, marker.y])) : undefined
  pushHistory('markers')
  if (hit) {
    draggingMarker = true
    uiCanvas.setPointerCapture(event.pointerId)
    selectMarker(hit.id)
    return
  }
  const kind = MARKER_KINDS.find(item => item.id === markerKind)!
  const data = layerData()
  const marker: Marker = { id: nextId(data.markers), x: point[0], y: point[1], kind: markerKind, name: kind.label, size: kind.size, showLabel: true, labelSide: 'right', color: MARKER_COLOR, note: '' }
  data.markers.push(marker)
  overlayVisible.markers = true
  q<HTMLInputElement>('[data-overlay=markers]').checked = true
  setDirty()
  selectMarker(marker.id)
}

// routes

let routeKind: RouteKind = 'road'
let selectedRoute: number | null = null
/** the route being drawn: every point so far, and how many points each click added */
let drawingRoute: { waypoints: Position[]; points: Position[]; marks: number[] } | null = null

const selectedRouteData = () => layerData().routes.find(route => route.id === selectedRoute)

q('#route-kinds').innerHTML = ROUTE_KINDS.map(kind => `<button data-kind="${kind.id}">${kind.label}</button>`).join('')

function renderRoutes() {
  document.querySelectorAll<HTMLButtonElement>('#route-kinds button').forEach(button => button.classList.toggle('active', button.dataset.kind === routeKind))
  const route = selectedRouteData()
  q('#route-editor').hidden = !route || activeMode !== 'route'
  if (route) {
    q<HTMLInputElement>('#route-name').value = route.name
    q<HTMLSelectElement>('#route-dash').value = route.dash
    q<HTMLInputElement>('#route-color').value = route.color
    q<HTMLInputElement>('#route-width').value = String(route.width)
    q<HTMLOutputElement>('#route-width-output').value = `${route.width.toLocaleString('de-DE')} px`
    q<HTMLInputElement>('#route-label').checked = route.showLabel
    q('#route-length').textContent = `${routeKindLabel(route.kind)}, ${formatKm(routeLengthKm(route.points, metric))} lang`
  }
  q('#route-list').innerHTML = layerData().routes.map(item => `
    <li class="entity${item.id === selectedRoute ? ' active' : ''}" data-id="${item.id}"><i class="entity-swatch" style="background:${item.color}"></i><span class="entity-name">${escapeHtml(item.name) || routeKindLabel(item.kind)}</span><span class="entity-kind">${formatKm(routeLengthKm(item.points, metric))}</span></li>`).join('') || '<li class="entity-empty">Noch keine Route.</li>'
}

function selectRoute(id: number | null) {
  selectedRoute = id
  renderRoutes()
  markOverlaysChanged()
}

q('#route-kinds').addEventListener('click', event => {
  const kind = (event.target as HTMLElement).dataset.kind as RouteKind | undefined
  if (!kind) return
  routeKind = kind
  renderRoutes()
})

function editRoute(change: (route: Route) => void) {
  const route = selectedRouteData()
  if (!route) return
  change(route)
  setDirty()
  markOverlaysChanged()
}

q('#route-name').addEventListener('input', event => {
  editRoute(route => { route.name = (event.target as HTMLInputElement).value })
  const row = document.querySelector(`#route-list li[data-id="${selectedRoute}"] .entity-name`)
  if (row) row.textContent = (event.target as HTMLInputElement).value || routeKindLabel(selectedRouteData()!.kind)
})
q('#route-dash').addEventListener('change', event => editRoute(route => { route.dash = (event.target as HTMLSelectElement).value as Route['dash'] }))
q('#route-color').addEventListener('input', event => {
  editRoute(route => { route.color = (event.target as HTMLInputElement).value })
})
bindRange(q<HTMLInputElement>('#route-width'), 'px', value => editRoute(route => { route.width = value }), 1)
q('#route-label').addEventListener('change', event => editRoute(route => { route.showLabel = (event.target as HTMLInputElement).checked }))

function deleteSelectedRoute() {
  const route = selectedRouteData()
  if (!route) return
  pushHistory('routes')
  layerData().routes = layerData().routes.filter(item => item.id !== route.id)
  selectedRoute = null
  setDirty()
  renderRoutes()
  markOverlaysChanged()
}
q('#route-delete').addEventListener('click', deleteSelectedRoute)
q('#route-list').addEventListener('click', event => {
  const row = rowOf(event)
  if (row) selectRoute(Number(row.dataset.id))
})

/** a route or river being reshaped: which one and which of its points */
let draggingHandle: { route: number; index: number } | null = null

/** the course of a route from its waypoints: straight, or searched across water or land between them */
function rebuildRoute(route: Route) {
  const search = route.auto && (route.kind === 'sea' || route.kind === 'road' || route.kind === 'trail')
  const points: Position[] = [route.waypoints[0]]
  for (let index = 0; index < route.waypoints.length - 1; index += 1) {
    const [from, to] = [route.waypoints[index], route.waypoints[index + 1]]
    points.push(...(search ? findRouteBetween(graph, route.kind, from, to, metric, elevations, isDryLand) : [from, to]).slice(1))
  }
  route.points = points
}

function distanceToSegment(point: Position, a: Position, b: Position) {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]]
  const length = dx * dx + dy * dy
  const t = length ? clampValue(((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length, 0, 1) : 0
  return Math.hypot(point[0] - (a[0] + dx * t), point[1] - (a[1] + dy * t))
}

function routePointerDown(point: Position, event: PointerEvent) {
  const rect = uiCanvas.getBoundingClientRect()
  const screen: Position = [event.clientX - rect.left, event.clientY - rect.top]
  if (drawingRoute) {
    const last = drawingRoute.points[drawingRoute.points.length - 1]
    const auto = q<HTMLInputElement>('#route-auto').checked && (routeKind === 'sea' || routeKind === 'road' || routeKind === 'trail')
    const segment = auto ? findRouteBetween(graph, routeKind, last, point, metric, elevations, isDryLand) : [last, point]
    drawingRoute.waypoints.push(point)
    drawingRoute.points.push(...segment.slice(1))
    drawingRoute.marks.push(segment.length - 1)
    pending.cover = true
    requestRender()
    return
  }

  const selected = selectedRouteData()
  if (selected && overlayVisible.routes) {
    const handle = selected.waypoints.findIndex(waypoint => {
      const [x, y] = toScreenPoint(waypoint)
      return Math.hypot(x - screen[0], y - screen[1]) <= 8
    })
    if (handle >= 0) {
      pushHistory('routes')
      if (event.altKey && selected.waypoints.length > 2) {
        selected.waypoints.splice(handle, 1)
        rebuildRoute(selected)
        setDirty()
        renderRoutes()
        markOverlaysChanged()
        return
      }
      draggingHandle = { route: selected.id, index: handle }
      uiCanvas.setPointerCapture(event.pointerId)
      return
    }
    if (distanceToRoute(selected, screen, toScreenPoint) <= 6) {
      // a click on the line adds a point there, which can be dragged at once
      let best = 0
      let nearest = Infinity
      for (let index = 0; index < selected.waypoints.length - 1; index += 1) {
        const distance = distanceToSegment(screen, toScreenPoint(selected.waypoints[index]), toScreenPoint(selected.waypoints[index + 1]))
        if (distance < nearest) {
          nearest = distance
          best = index
        }
      }
      pushHistory('routes')
      selected.waypoints.splice(best + 1, 0, point)
      selected.points = [...selected.waypoints]
      draggingHandle = { route: selected.id, index: best + 1 }
      uiCanvas.setPointerCapture(event.pointerId)
      markOverlaysChanged()
      return
    }
  }

  const hit = overlayVisible.routes ? layerData().routes.find(route => distanceToRoute(route, screen, toScreenPoint) <= 6) : undefined
  if (hit) {
    selectRoute(hit.id)
    return
  }
  drawingRoute = { waypoints: [point], points: [point], marks: [1] }
  statusOutput.textContent = 'Nächsten Punkt anklicken, Doppelklick oder Eingabe beendet die Route'
  pending.cover = true
  requestRender()
}

function finishRoute() {
  if (!drawingRoute) return
  const { waypoints, points } = drawingRoute
  drawingRoute = null
  const same = (a: Position, b: Position) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6
  // the second click of a double click repeats the last point
  if (waypoints.length >= 2 && same(waypoints[waypoints.length - 1], waypoints[waypoints.length - 2])) waypoints.pop()
  if (points.length >= 2 && same(points[points.length - 1], points[points.length - 2])) points.pop()
  if (waypoints.length >= 2) {
    pushHistory('routes')
    const kind = ROUTE_KINDS.find(item => item.id === routeKind)!
    const data = layerData()
    const auto = q<HTMLInputElement>('#route-auto').checked && (routeKind === 'sea' || routeKind === 'road' || routeKind === 'trail')
    const route: Route = { id: nextId(data.routes), kind: routeKind, name: '', points, waypoints, auto, color: kind.color, width: kind.width, dash: kind.dash, showLabel: false }
    data.routes.push(route)
    overlayVisible.routes = true
    q<HTMLInputElement>('[data-overlay=routes]').checked = true
    setDirty()
    selectRoute(route.id)
    statusOutput.textContent = `${kind.label} angelegt: ${formatKm(routeLengthKm(points, metric))}`
  }
  pending.cover = true
  requestRender()
}

uiCanvas.addEventListener('dblclick', () => {
  if (activeMode === 'route') finishRoute()
})

// drawing of the annotations, on top of the map

const routePaths = new WeakMap<Position[], { length: number; path: Path2D }>()

function pathOfRoute(route: { points: Position[] }) {
  const cached = routePaths.get(route.points)
  if (cached && cached.length === route.points.length) return cached.path
  const path = routePath(route.points)
  routePaths.set(route.points, { length: route.points.length, path })
  return path
}

function drawRouteLine(ctx: CanvasRenderingContext2D, path: Path2D, color: string, width: number, dash: Route['dash'], pixel: number, selected: boolean) {
  const dashes = { solid: [], dashed: [9, 6], dotted: [1, 5] }[dash].map(length => length * width * 0.6 * pixel)
  if (selected) {
    ctx.setLineDash([])
    ctx.strokeStyle = 'rgb(255 236 180 / 80%)'
    ctx.lineWidth = (width + 5) * pixel
    ctx.stroke(path)
  }
  ctx.setLineDash(dashes)
  ctx.strokeStyle = color
  ctx.lineWidth = width * pixel
  ctx.stroke(path)
  ctx.setLineDash([])
}

/** a hand-drawn river gets wider towards its mouth */
function drawRiver(ctx: CanvasRenderingContext2D, route: Route, pixel: number, selected: boolean) {
  const points = chaikin(route.points, false, 2)
  const base = Math.max(0.9 * pixel, graph.baseSpacing * 0.035 * route.width)
  if (selected) {
    ctx.strokeStyle = 'rgb(255 236 180 / 80%)'
    ctx.lineWidth = base + 5 * pixel
    ctx.stroke(routePath(points))
  }
  ctx.strokeStyle = route.color
  for (let index = 0; index < points.length - 1; index += 1) {
    ctx.lineWidth = Math.max(0.9 * pixel, base * (0.35 + 0.65 * index / (points.length - 1)))
    ctx.beginPath()
    ctx.moveTo(...points[index])
    ctx.lineTo(...points[index + 1])
    ctx.stroke()
  }
}

function drawAnnotations(ctx: CanvasRenderingContext2D) {
  const dpr = devicePixelScale
  const { scale } = view
  ctx.save()
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'

  // routes are in map units, drawn with lines of constant width on screen
  ctx.setTransform(scale * dpr, 0, 0, scale * dpr, view.x * dpr, view.y * dpr)
  const pixel = 1 / scale
  if (overlayVisible.routes) {
    for (const route of layerData().routes) {
      const selected = route.id === selectedRoute && activeMode === 'route'
      if (route.kind === 'river') drawRiver(ctx, route, pixel, selected)
      else drawRouteLine(ctx, pathOfRoute(route), route.color, route.width, route.dash, pixel, selected)
    }
  }
  if (drawingRoute) {
    const kind = ROUTE_KINDS.find(item => item.id === routeKind)!
    const preview = hoverPoint ? [...drawingRoute.points, hoverPoint] : drawingRoute.points
    drawRouteLine(ctx, routePath(preview), kind.color, kind.width, 'dashed', pixel, true)
  }

  // text and symbols are in pixels
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  const editing = activeMode === 'route' && overlayVisible.routes ? selectedRouteData() : undefined
  if (editing) {
    ctx.lineWidth = 2
    ctx.strokeStyle = '#1b2329'
    ctx.fillStyle = '#fff5d6'
    for (const waypoint of editing.waypoints) {
      const [x, y] = toScreenPoint(waypoint)
      ctx.beginPath()
      ctx.arc(x, y, 5, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
    }
  }
  if (overlayVisible.routes) {
    for (const route of layerData().routes) {
      if (!route.showLabel || route.points.length < 2) continue
      const middle = Math.floor((route.points.length - 1) / 2)
      const [a, b] = [toScreenPoint(route.points[middle]), toScreenPoint(route.points[middle + 1])]
      let angle = Math.atan2(b[1] - a[1], b[0] - a[0])
      if (Math.abs(angle) > Math.PI / 2) angle += Math.PI
      ctx.save()
      ctx.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
      ctx.rotate(angle)
      ctx.font = '11px "Segoe UI", sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'bottom'
      const text = `${route.name || routeKindLabel(route.kind)} · ${formatKm(routeLengthKm(route.points, metric))}`
      ctx.lineWidth = 3
      ctx.strokeStyle = 'rgb(250 246 236 / 88%)'
      ctx.strokeText(text, 0, -3)
      ctx.fillStyle = route.color
      ctx.fillText(text, 0, -3)
      ctx.restore()
    }
  }
  if (overlayVisible.territories) {
    for (const territory of layerData().territories) {
      const label = regions.labels.get(territory.id)
      if (!label || !territory.showLabel || !territory.name) continue
      const size = Math.min(110, label.fontSize * scale * (0.5 + territory.labelSize * 0.25))
      if (size < 8) continue
      const [x, y] = toScreenPoint([label.x, label.y])
      ctx.save()
      ctx.translate(x, y)
      ctx.rotate(label.angle)
      ctx.font = `600 ${size}px Georgia, serif`
      ctx.letterSpacing = `${Math.round(size * 0.12)}px`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.lineJoin = 'round'
      ctx.lineWidth = Math.max(2, size * 0.16)
      ctx.strokeStyle = 'rgb(250 246 236 / 78%)'
      ctx.strokeText(territory.name.toUpperCase(), 0, 0)
      ctx.fillStyle = 'rgb(28 34 40 / 88%)'
      ctx.fillText(territory.name.toUpperCase(), 0, 0)
      ctx.restore()
    }
  }
  if (overlayVisible.markers) {
    for (const marker of layerData().markers) {
      const [x, y] = toScreenPoint([marker.x, marker.y])
      if (x < -60 || y < -40 || x > uiCanvas.width / dpr + 60 || y > uiCanvas.height / dpr + 40) continue
      drawMarkerSymbol(ctx, marker, x, y, marker.id === selectedMarker && activeMode === 'marker')
      drawMarkerLabel(ctx, marker, x, y)
    }
  }
  ctx.restore()
}

// brush comfort: Alt and the wheel change the radius, Shift and the wheel the strength, [ and ] the radius too

function nudgeSlider(input: HTMLInputElement, factor: number) {
  const step = Number(input.step) || 1
  const value = Number(input.value)
  let next = value * factor
  if (Math.abs(next - value) < step) next = value + Math.sign(factor - 1) * step
  input.value = String(clampValue(Math.round(next / step) * step, Number(input.min), Number(input.max)))
  input.dispatchEvent(new Event('input'))
}

const brushActive = () => activeMode === 'height' || activeMode === 'territory' || activeMode === 'zone'

// layers

function applyLayerUi() {
  const surface = activeLayer === 'surface'
  document.querySelectorAll<HTMLButtonElement>('[data-layer]').forEach(button => button.classList.toggle('active', button.dataset.layer === activeLayer))
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-mode=climate], [data-mode=water]')) button.hidden = !surface
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-display=biome], [data-display=temperature], [data-display=precipitation]')) button.hidden = !surface
  q('[data-overlay=rivers]').parentElement!.hidden = !surface
  q('#sea-label').textContent = ({ surface: 'Meeresspiegel', underground: 'Tiefste Höhle (m ü. M.)', sky: 'Niveau der Inseln' })[activeLayer]
  q('[data-overlay=shadow]').parentElement!.hidden = surface
  if (!surface && (activeMode === 'climate' || activeMode === 'water')) selectMode('height')
  if (!surface && ['biome', 'temperature', 'precipitation'].includes(displayMode)) setDisplay('height')
  seaLevelInput.value = String(seaLevel())
  q<HTMLOutputElement>('#sea-level-output').value = `${seaLevel().toLocaleString('de-DE')} m`
  pending.background = true
}

async function switchLayer(id: LayerId) {
  if (busy || id === activeLayer) return
  busy = true
  q('#generating-label').textContent = 'Ebene wird geladen …'
  generatingIndicator.hidden = false
  await nextFrame()
  await new Promise(resolve => setTimeout(resolve))
  try {
    if (analysisStale) runAnalysis()
    live[activeLayer] = { graph, analysis, splits, elevations, territoryIds, zoneMasks, undo: undoStack, redo: redoStack }
    const stored = live[id]
    coastTargetAt = null
    selectedMarker = null
    selectedRoute = null
    drawingRoute = null
    if (stored) {
      activeLayer = id
      splits = stored.splits
      buildGraph()
      elevations = stored.elevations
      territoryIds = stored.territoryIds
      zoneMasks = stored.zoneMasks
      undoStack = stored.undo
      redoStack = stored.redo
    } else {
      activateLayer(id)
      undoStack = []
      redoStack = []
    }
    q<HTMLInputElement>('#coast-pick').checked = false
    refreshCaveLimits()
    applyLayerUi()
    // the plain land view shows the shadow of the surface
    if (id !== 'surface' && displayMode === 'height') setDisplay('land')
    afterProjectChange(false)
  } finally {
    generatingIndicator.hidden = true
    busy = false
  }
}

document.querySelectorAll<HTMLButtonElement>('[data-layer]').forEach(button => button.addEventListener('click', () => void switchLayer(button.dataset.layer as LayerId)))

// ---- the underground follows the surface: caves lie below the ground and not under the deep sea ----

/** rock that stays above a cave floor */
const CAVE_COVER_M = 30

/** the highest a cave floor may be at every cell, or null where no limit applies */
let caveCeiling: Float32Array | null = null

const sameMesh = (a: GridGraph, b: GridGraph) => a.cellCount === b.cellCount && a.splits.size === b.splits.size && [...a.splits].every(key => b.splits.has(key))

/** the surface, seen from another layer: its heights per cell of the graph on screen */
function surfaceHeights(): Float32Array | null {
  const surface = activeLayer === 'surface' ? undefined : live.surface
  if (!surface) return null
  if (sameMesh(surface.graph, graph)) return surface.elevations
  return Float32Array.from({ length: graph.cellCount }, (_, cell) => interpolateHeight(surface.graph, surface.elevations, graph.x[cell], graph.y[cell]))
}

/** where a cave can be: below the surface, and only where that is above the deepest allowed cave */
function refreshCaveLimits() {
  const heights = activeLayer === 'underground' ? surfaceHeights() : null
  caveCeiling = heights ? Float32Array.from(heights, height => height - CAVE_COVER_M) : null
  if (!caveCeiling) return
  enforceCaveLimits()
}

function enforceCaveLimits(cells?: ArrayLike<number>) {
  if (!caveCeiling) return
  const level = seaLevel()
  const clampCell = (cell: number) => {
    const limit = caveCeiling![cell] < level ? level - 1 : caveCeiling![cell]
    if (elevations[cell] > limit) elevations[cell] = limit
  }
  if (cells) for (let index = 0; index < cells.length; index += 1) clampCell(cells[index])
  else for (let cell = 0; cell < graph.cellCount; cell += 1) clampCell(cell)
}

/** the outlines of the ground that is too deep under the sea for caves, for the shadow view */
function deepBorders(): Border[] {
  if (!caveCeiling) return []
  const level = seaLevel()
  return traceBorders(graph, cell => caveCeiling![cell] < level ? 1 : 0, 1, true).get(1) ?? []
}

/** the outline of the surface, drawn faintly under the other layers */
function shadowOptions(): OverlayOptions['shadow'] {
  const surface = activeLayer === 'surface' || !overlayVisible.shadow ? undefined : live.surface
  if (!surface?.analysis) return undefined
  return activeLayer === 'sky'
    ? { coast: surface.analysis.coast, landFill: 'rgb(38 58 44 / 42%)', lineColor: 'rgb(38 58 44 / 45%)', deep: [], deepFill: '' }
    : { coast: surface.analysis.coast, landFill: 'rgb(235 225 205 / 15%)', lineColor: 'rgb(235 225 205 / 30%)', deep: regions.deep, deepFill: 'rgb(0 0 0 / 55%)' }
}

// ---- the floating second view: terrain in 3D and the planet as a globe ----

let viewer: Viewer | null = null
let viewerTimer: number | undefined
const viewerPanel = q('#viewer')

/** the colours of the current map view, as the cells show them */
function currentColors() {
  const buffer = new Uint8Array(graph.cellCount * 4)
  colorCells(buffer, { graph, elevations, scale: heightScale(), mode: displayMode, analysis, layer: activeLayer, tint: territoryTint(), shoreRings: coversSea(displayMode) ? coastReach() : 0 })
  return buffer
}

function ensureViewer(): Viewer {
  if (viewer) return viewer
  viewer = new Viewer(q<HTMLCanvasElement>('#viewer-canvas'), {
    graph: () => graph,
    elevations: () => elevations,
    colors: currentColors,
    seaM: seaLevel,
    unitKm: () => metric.unitKm,
    snapshot: () => renderExportCanvas(2048, 1),
    extent: () => {
      const [west, north] = normalizedToGeo([0, 0], project.veil.map, project.veil.planet)
      const [east, south] = normalizedToGeo([1, 1], project.veil.map, project.veil.planet)
      return { west, east, north, south, global: project.veil.map.mode === 'global' }
    },
  })
  return viewer
}

/** read the map into the viewer, a moment after the last change */
function scheduleViewer(delay = 250) {
  if (viewerPanel.hidden) return
  window.clearTimeout(viewerTimer)
  viewerTimer = window.setTimeout(() => {
    if (busy || isDrawing) return scheduleViewer(150)
    try {
      const started = performance.now()
      ensureViewer().update()
      if (import.meta.env.DEV) console.debug(`viewer update took ${Math.round(performance.now() - started)} ms`)
    } catch (error) {
      statusOutput.textContent = error instanceof Error ? error.message : 'Die Ansicht konnte nicht gezeichnet werden.'
    }
  }, delay)
}

function setViewerMode(mode: 'terrain' | 'globe') {
  document.querySelectorAll<HTMLButtonElement>('[data-viewer]').forEach(button => button.classList.toggle('active', button.dataset.viewer === mode))
  q('#viewer-exaggeration').hidden = mode !== 'terrain'
  ensureViewer().setMode(mode)
}

q('#toggle-viewer').addEventListener('click', () => {
  viewerPanel.hidden = !viewerPanel.hidden
  if (viewerPanel.hidden) return
  setViewerMode(viewer?.mode ?? 'terrain')
  ensureViewer().resize()
})
q('#viewer-close').addEventListener('click', () => { viewerPanel.hidden = true })
q('#viewer-refresh').addEventListener('click', () => scheduleViewer(0))
document.querySelectorAll<HTMLButtonElement>('[data-viewer]').forEach(button => button.addEventListener('click', () => setViewerMode(button.dataset.viewer as 'terrain' | 'globe')))
q<HTMLInputElement>('#viewer-exag').addEventListener('input', event => {
  ensureViewer().exaggeration = Number((event.target as HTMLInputElement).value)
  viewer!.draw()
})
new ResizeObserver(() => viewer?.resize()).observe(q('#viewer-canvas'))

// the panel moves by its header and can be resized at its corner
q('#viewer-head').addEventListener('pointerdown', event => {
  if ((event.target as HTMLElement).closest('button, input, label')) return
  const head = q('#viewer-head')
  head.setPointerCapture(event.pointerId)
  const start = { x: event.clientX, y: event.clientY, left: viewerPanel.offsetLeft, top: viewerPanel.offsetTop }
  const move = (moved: PointerEvent) => {
    const bounds = workspace.getBoundingClientRect()
    viewerPanel.style.left = `${clampValue(start.left + moved.clientX - start.x, 0, bounds.width - 80)}px`
    viewerPanel.style.top = `${clampValue(start.top + moved.clientY - start.y, 0, bounds.height - 40)}px`
    viewerPanel.style.right = 'auto'
    viewerPanel.style.bottom = 'auto'
  }
  const stop = () => {
    head.removeEventListener('pointermove', move)
    head.removeEventListener('pointerup', stop)
  }
  head.addEventListener('pointermove', move)
  head.addEventListener('pointerup', stop)
})

/** the lists and the sliders that show what the project holds */
function refreshPanels() {
  renderTerritories()
  renderZones()
  renderMarkers()
  renderRoutes()
  syncCoastControls()
  q<HTMLInputElement>('#rivers-enabled').checked = project.veil.rivers
  q<HTMLInputElement>('#lakes-enabled').checked = project.veil.hydrology.lakes
  const density = Math.round(DEFAULT_HYDROLOGY.riverThreshold * 100 / project.veil.hydrology.riverThreshold)
  q<HTMLInputElement>('#river-density').value = String(density)
  q<HTMLOutputElement>('#river-density-output').value = `${density} %`
  q<HTMLInputElement>('#lake-depth').value = String(project.veil.hydrology.minLakeDepthM)
  q<HTMLOutputElement>('#lake-depth-output').value = `${project.veil.hydrology.minLakeDepthM} m`
  document.querySelectorAll<HTMLInputElement>('[data-overlay]').forEach(chip => { chip.checked = overlayVisible[chip.dataset.overlay as keyof typeof overlayVisible] })
}

new ResizeObserver(resizeCanvases).observe(workspace)

activateLayer('surface')
applyLayerUi()
selectMode('height')
resizeCanvases()
afterProjectChange(true)
setDirty(false)

if (import.meta.env.DEV) {
  Object.assign(window, {
    __veil: {
      get elevations() { return elevations },
      get graph() { return graph },
      get analysis() { return analysis },
      get stale() { return analysisStale },
      get view() { return view },
      get layer() { return layerData() },
      get activeLayer() { return activeLayer },
      get territoryIds() { return territoryIds },
      get zoneMasks() { return zoneMasks },
      get regions() { return regions },
      get project() { return project },
      get splits() { return splits },
      get busy() { return busy },
      get viewer() { return viewer },
      wantedLevel,
      refine: (x: number, y: number, radiusKm: number, level: number) => {
        const plan = planRefinement(y, radiusKm, level)
        return refine([{ x, y, reachX: plan.reachX, reachY: plan.reachY }], plan.level)
      },
      renderExportCanvas,
      serialize: serializeProject,
      adopt: adoptProject,
    },
  })
}
