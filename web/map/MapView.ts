// The map: OpenLayers in the equirectangular EPSG:4326 view, so the poles stay visible. Terrain
// comes as tiles from the import cache; every element layer mirrors a list in the project.
import Collection from 'ol/Collection'
import Feature from 'ol/Feature'
import GeoJSON from 'ol/format/GeoJSON'
import type Geometry from 'ol/geom/Geometry'
import LineString from 'ol/geom/LineString'
import Point from 'ol/geom/Point'
import Polygon from 'ol/geom/Polygon'
import { defaults as defaultInteractions, Draw, Modify, Snap, Translate } from 'ol/interaction'
import type Interaction from 'ol/interaction/Interaction'
import type BaseLayer from 'ol/layer/Base'
import Graticule from 'ol/layer/Graticule'
import ImageLayer from 'ol/layer/Image'
import TileLayer from 'ol/layer/Tile'
import VectorLayer from 'ol/layer/Vector'
import OlMap from 'ol/Map'
import Overlay from 'ol/Overlay'
import ImageCanvasSource from 'ol/source/ImageCanvas'
import TileImage from 'ol/source/TileImage'
import VectorSource from 'ol/source/Vector'
import { Fill, Stroke, Style, Text, Circle as CircleStyle } from 'ol/style'
import TileGrid from 'ol/tilegrid/TileGrid'
import View from 'ol/View'
import { unByKey } from 'ol/Observable'
import type { EventsKey } from 'ol/events'
import { AREA_KINDS, type AreaGeometry, type Display, type Entity, type EntityKind, type Filter, type ImageLayerId, type KoppenClass, type LayerId, type LineGeometry, type LonLat, type Project } from '../model/types'
import { isImageLayer } from '../model/catalog'
import { areaKm2, formatKm, formatKm2, greatCircle, lineLengthM, smoothStroke } from '../model/geo'
import { deleteVertices, freehand, freehandSmoothing, snapCities, type MeasureMode, type Tool } from '../model/store'
import { altKeyOnly, shiftKeyOnly, singleClick } from 'ol/events/condition'
import type MapBrowserEvent from 'ol/MapBrowserEvent'
import { shownGeometry } from '../model/terrain'
import type { KoppenMeta, SatelliteMeta, TerrainMeta } from '../platform'
import { platform } from '../platform'
import { entityStyle, hexToRgb, SELECT_COLOR, type StyleContext } from './styles'
import { textureUrl } from './texture'

export const EXTENT = [-180, -90, 180, 90]
const BASE_RESOLUTION = 360 / 512

const KIND_LAYER: Record<EntityKind, LayerId> = {
  state: 'states',
  province: 'provinces',
  culture: 'cultures',
  religion: 'religions',
  zone: 'zones',
  city: 'cities',
  route: 'routes',
  river: 'rivers',
  label: 'labels',
  marker: 'markers',
  regiment: 'regiments',
}
const ALL_KINDS = Object.keys(KIND_LAYER) as EntityKind[]
/** what a click picks first when things overlap */
const PICK_ORDER: EntityKind[] = ['label', 'marker', 'city', 'regiment', 'route', 'river', 'zone', 'province', 'state', 'religion', 'culture']
const COLLECTIONS: Record<EntityKind, keyof Project> = {
  state: 'states', province: 'provinces', culture: 'cultures', religion: 'religions', zone: 'zones',
  city: 'cities', route: 'routes', river: 'rivers', label: 'labels', marker: 'markers', regiment: 'regiments',
}

export interface MapEvents {
  select(kind: EntityKind | null, id: string | null): void
  /** `px`: degrees per screen pixel when drawn */
  create(tool: Tool, geometry: { type: 'Point'; coordinates: LonLat } | LineGeometry, px: number): void
  /** a stroke drawn onto a route */
  reshape(id: string, stroke: LonLat[], px: number): void
  editGeometry(kind: EntityKind, id: string, geometry: Entity['geometry']): void
  area(tool: Tool, polygon: LonLat[][], at: LonLat): void
  pick(purpose: string, at: LonLat): void
  hover(at: LonLat | null): void
  measure(result: { mode: MeasureMode; text: string; value: number } | null): void
  view(center: LonLat, zoom: number): void
}

const format = new GeoJSON()
const toOl = (geometry: object) => format.readGeometry(geometry) as Geometry
function fromOl(geometry: Geometry): Entity['geometry'] {
  const object = format.writeGeometryObject(geometry, { decimals: 5 }) as unknown as { type: string; coordinates: unknown }
  if (object.type === 'Polygon') return { type: 'MultiPolygon', coordinates: [object.coordinates as LonLat[][]] }
  return object as Entity['geometry']
}

/** CSS class of a layer's canvas; "img:<id>" becomes "layer-img-<id>" */
export const layerClass = (id: LayerId) => `layer-${id.replace(':', '-')}`

export const filterCss = (f: Filter | undefined) =>
  !f ? '' : `grayscale(${f.grayscale}) sepia(${f.sepia}) saturate(${f.saturate}) brightness(${f.brightness}) contrast(${f.contrast}) hue-rotate(${f.hue}deg) blur(${f.blur}px) invert(${f.invert})`

/** Shift, or the freehand switch for touch screens */
const freehandCondition = (event: MapBrowserEvent) => freehand.peek() || shiftKeyOnly(event)
/** Alt+click, or a tap while the delete switch is on */
const deleteCondition = (event: MapBrowserEvent) => singleClick(event) && (deleteVertices.peek() || altKeyOnly(event))

/** a tile pyramid from the cache: level z is 512·2^z px wide */
function tileSource(meta: { maxZoom: number; tileSize: number; tileExt?: string }, path: string) {
  const ext = meta.tileExt || 'png'
  return new TileImage({
    projection: 'EPSG:4326',
    // tiles come from the veil:// protocol, another origin; without this the 3D view cannot read the map
    crossOrigin: 'anonymous',
    tileGrid: new TileGrid({
      extent: EXTENT,
      origin: [-180, 90],
      resolutions: Array.from({ length: meta.maxZoom + 1 }, (_, z) => BASE_RESOLUTION / 2 ** z),
      tileSize: meta.tileSize,
    }),
    wrapX: false,
    interpolate: true,
    tileUrlFunction: ([z, x, y]) => platform.cacheUrl(`${path}/${z}/${x}/${y}.${ext}`),
  })
}

export class MapView {
  readonly map: OlMap
  readonly layers = {} as Record<LayerId, BaseLayer>
  private readonly sources = {} as Record<EntityKind, VectorSource>
  private readonly features = {} as Record<EntityKind, Map<string, Feature>>
  private readonly editSource = new VectorSource()
  private readonly measureSource = new VectorSource()
  private readonly coastSource = new VectorSource()
  private interactions: Interaction[] = []
  /** the drawing in progress, for the touch buttons */
  private activeDraw: Draw | null = null
  private context: StyleContext
  private styleVersion = 0
  private project: Project
  private tool: Tool = { id: 'select' }
  private selection: { kind: EntityKind; id: string } | null = null
  private measureTip: Overlay
  private readonly styleSheet = document.createElement('style')

  private readonly events: MapEvents

  constructor(target: HTMLElement, project: Project, events: MapEvents) {
    this.events = events
    this.project = project
    this.context = { project, selectedId: null, diplomacyColors: null }
    document.head.appendChild(this.styleSheet)

    const view = new View({
      projection: 'EPSG:4326',
      extent: EXTENT,
      showFullExtent: true,
      constrainOnlyCenter: true,
      maxResolution: BASE_RESOLUTION * 1.5,
      minResolution: BASE_RESOLUTION / 2048,
      center: project.view.center,
      zoom: project.view.zoom,
    })
    this.map = new OlMap({
      target,
      view,
      controls: [],
      interactions: defaultInteractions({ doubleClickZoom: false }),
    })

    // terrain tiles come later, in setTerrain
    this.layers.relief = new TileLayer({ className: 'layer-relief' })
    this.layers.satellite = new TileLayer({ className: 'layer-satellite' })
    this.layers.shade = new TileLayer({ className: 'layer-shade' })
    this.layers.coast = new VectorLayer({ className: 'layer-coast', source: this.coastSource, style: () => this.coastStyle() })
    this.layers.koppen = new ImageLayer({ className: 'layer-koppen' })
    for (const kind of ALL_KINDS) {
      this.sources[kind] = new VectorSource()
      this.features[kind] = new Map()
      const layerId = KIND_LAYER[kind]
      this.layers[layerId] = new VectorLayer({
        className: `layer-${layerId}`,
        source: this.sources[kind],
        style: entityStyle(kind, () => this.context, () => this.styleVersion),
        declutter: kind === 'city' || kind === 'marker' ? kind : false,
        updateWhileInteracting: kind !== 'river',
        renderBuffer: 200,
      })
    }
    this.layers.graticule = this.makeGraticule(project.display)
    this.layers.texture = new TileLayer({ className: 'layer-texture' })
    for (const layer of Object.values(this.layers)) this.map.addLayer(layer)

    const edit = new VectorLayer({
      source: this.editSource,
      zIndex: 900,
      style: new Style({
        stroke: new Stroke({ color: SELECT_COLOR, width: 1.5, lineDash: [6, 4] }),
        image: new CircleStyle({ radius: 4, fill: new Fill({ color: SELECT_COLOR }) }),
      }),
    })
    const measure = new VectorLayer({
      source: this.measureSource,
      zIndex: 950,
      style: new Style({
        stroke: new Stroke({ color: '#d7263d', width: 2, lineDash: [8, 5] }),
        fill: new Fill({ color: 'rgba(215, 38, 61, 0.12)' }),
        image: new CircleStyle({ radius: 4, fill: new Fill({ color: '#d7263d' }) }),
      }),
    })
    this.map.addLayer(edit)
    this.map.addLayer(measure)
    snapCities.subscribe(on => {
      for (const interaction of this.interactions) if (interaction instanceof Snap) interaction.setActive(on)
    })

    const tip = document.createElement('div')
    tip.className = 'measure-tip'
    this.measureTip = new Overlay({ element: tip, offset: [12, -12], positioning: 'bottom-left' })
    this.map.addOverlay(this.measureTip)

    this.map.on('singleclick', event => this.onClick(event.coordinate as LonLat, event.pixel))
    let frame = 0
    this.map.on('pointermove', event => {
      if (event.dragging) return
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => events.hover(event.coordinate as LonLat))
    })
    target.addEventListener('mouseleave', () => events.hover(null))
    this.map.on('moveend', () => {
      const v = this.map.getView()
      events.view(v.getCenter() as LonLat, v.getZoom() ?? 1)
    })
    this.applyProject(project)
    this.fitWorldIfDefault(project)
  }

  /** a new project starts with the whole planet in view */
  fitWorldIfDefault(project: Project) {
    const { center, zoom } = project.view
    if (center[0] === 0 && center[1] === 0 && zoom === 1) {
      requestAnimationFrame(() => this.map.getView().fit(EXTENT, { padding: [10, 10, 10, 10] }))
    } else {
      this.map.getView().setCenter(center)
      this.map.getView().setZoom(zoom)
    }
  }

  // ------------------------------------------------------------------------------------------
  // terrain and climate

  setTerrain(meta: TerrainMeta | null) {
    const relief = this.layers.relief as TileLayer<TileImage>
    const shade = this.layers.shade as TileLayer<TileImage>
    if (!meta) {
      relief.setSource(null)
      shade.setSource(null)
      this.coastSource.clear()
      return
    }
    relief.setSource(tileSource(meta, `terrain/${meta.id}/tiles/relief`))
    shade.setSource(tileSource(meta, `terrain/${meta.id}/tiles/shade`))
  }

  setSatellite(meta: SatelliteMeta | null) {
    ;(this.layers.satellite as TileLayer<TileImage>).setSource(meta ? tileSource(meta, `satellite/${meta.id}/tiles`) : null)
  }

  /** own image layers come and go with the project; each is a tile layer like the satellite picture */
  private imageSources = new Map<ImageLayerId, SatelliteMeta>()
  setImageLayers(images: Map<string, SatelliteMeta>) {
    for (const id of Object.keys(this.layers) as LayerId[]) {
      if (isImageLayer(id) && !images.has(id.slice(4))) {
        this.map.removeLayer(this.layers[id])
        delete this.layers[id]
        this.imageSources.delete(id)
      }
    }
    for (const [cacheId, meta] of images) {
      const id: ImageLayerId = `img:${cacheId}`
      if (this.imageSources.get(id) === meta) continue
      this.imageSources.set(id, meta)
      const existing = this.layers[id] as TileLayer<TileImage> | undefined
      if (existing) existing.setSource(tileSource(meta, `satellite/${meta.id}/tiles`))
      else {
        const layer = new TileLayer({ className: layerClass(id), source: tileSource(meta, `satellite/${meta.id}/tiles`) })
        this.layers[id] = layer
        this.map.addLayer(layer)
      }
    }
    this.applyLayers(this.project)
  }

  setLand(land: AreaGeometry | null) {
    this.coastSource.clear()
    if (!land) return
    this.coastSource.addFeatures(land.coordinates.map(poly => new Feature(new Polygon(poly))))
  }

  private coastStyle() {
    const s = this.project.style.coast
    return new Style({
      fill: new Fill({ color: s.fill || '#efe6cf' }),
      stroke: s.strokeWidth > 0 ? new Stroke({ color: s.stroke || '#3d4b52', width: s.strokeWidth }) : undefined,
    })
  }

  setKoppen(data: { meta: KoppenMeta; classes: Uint8Array } | null, classes: KoppenClass[]) {
    const layer = this.layers.koppen as ImageLayer<ImageCanvasSource>
    if (!data) {
      layer.setSource(null)
      return
    }
    const { width, height, codes } = data.meta
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')!
    const image = ctx.createImageData(width, height)
    const lut = codes.map(code => {
      const found = classes.find(c => c.code === code)
      return found ? [...hexToRgb(found.color), 255] : [0, 0, 0, 0]
    })
    for (let i = 0; i < data.classes.length; i++) {
      const v = data.classes[i]
      if (v) image.data.set(lut[v - 1], i * 4)
    }
    ctx.putImageData(image, 0, 0)
    layer.setSource(
      new ImageCanvasSource({
        projection: 'EPSG:4326',
        ratio: 1,
        canvasFunction: (extent, resolution, pixelRatio, size) => {
          const out = document.createElement('canvas')
          out.width = size[0]
          out.height = size[1]
          const c = out.getContext('2d')!
          c.imageSmoothingEnabled = false
          const sx = ((extent[0] + 180) / 360) * width
          const sy = ((90 - extent[3]) / 180) * height
          const sw = ((extent[2] - extent[0]) / 360) * width
          const sh = ((extent[3] - extent[1]) / 180) * height
          c.drawImage(canvas, sx, sy, sw, sh, 0, 0, size[0], size[1])
          void resolution
          void pixelRatio
          return out
        },
      }),
    )
  }

  // ------------------------------------------------------------------------------------------
  // project → layers

  applyProject(project: Project) {
    const previous = this.project
    this.project = project
    if (previous.style !== project.style || previous.catalog !== project.catalog || previous.display !== project.display) this.styleVersion++
    this.context = { project, selectedId: this.selection?.id ?? null, diplomacyColors: this.diplomacyColors(project) }
    for (const kind of ALL_KINDS) this.syncKind(kind, project)
    this.applyLayers(project)
    if (previous.display.graticule !== project.display.graticule) {
      const old = this.layers.graticule
      this.map.removeLayer(old)
      this.layers.graticule = this.makeGraticule(project.display)
      this.map.addLayer(this.layers.graticule)
      this.applyLayers(project)
    }
    this.applyTexture(project.display)
    this.applyFilters(project.display)
    for (const layer of Object.values(this.layers)) layer.changed()
    this.updateEditOverlay()
  }

  /** re-read the land-cut shapes after the worker answered */
  refreshAreas() {
    for (const kind of AREA_KINDS) this.syncKind(kind, this.project, true)
  }

  private diplomacyColors(project: Project) {
    const focus = project.display.diplomacyFocus
    if (!focus) return null
    const colors = new Map<string, string>()
    for (const state of project.states) {
      if (state.id === focus) {
        colors.set(state.id, '#f2d16b')
        continue
      }
      const relation = project.catalog.relations.find(r => r.id === (project.diplomacy[`${focus}>${state.id}`] ?? 'neutral'))
      colors.set(state.id, relation?.color ?? '#c8c2b0')
    }
    return colors
  }

  private syncKind(kind: EntityKind, project: Project, geometryOnly = false) {
    const entities = project[COLLECTIONS[kind]] as unknown as Entity[]
    const known = this.features[kind]
    const source = this.sources[kind]
    const seen = new Set<string>()
    const added: Feature[] = []
    const isArea = (AREA_KINDS as readonly string[]).includes(kind)
    for (const entity of entities) {
      seen.add(entity.id)
      let feature = known.get(entity.id)
      const geometrySource = isArea ? shownGeometry(entity.geometry as AreaGeometry | null, (entity as { clip: boolean }).clip) : entity.geometry
      if (!feature) {
        feature = new Feature()
        feature.setId(entity.id)
        known.set(entity.id, feature)
        added.push(feature)
      } else if (geometryOnly && feature.get('geometrySource') === geometrySource) continue
      if (feature.get('geometrySource') !== geometrySource) {
        feature.setGeometry(geometrySource ? toOl(geometrySource) : undefined)
        feature.set('geometrySource', geometrySource, true)
      }
      if (feature.get('entity') !== entity) {
        feature.set('entity', entity, true)
        feature.set('kind', kind, true)
        feature.changed()
      }
    }
    if (added.length) source.addFeatures(added)
    if (!geometryOnly && known.size !== seen.size) {
      for (const [id, feature] of known) {
        if (!seen.has(id)) {
          source.removeFeature(feature)
          known.delete(id)
        }
      }
    }
  }

  private applyLayers(project: Project) {
    project.layers.forEach((setting, index) => {
      const layer = this.layers[setting.id]
      if (!layer) return
      layer.setZIndex(index + 1)
      layer.setVisible(setting.visible)
      layer.setOpacity(setting.opacity)
    })
    this.map.getTargetElement()?.style.setProperty('background', project.display.background)
  }

  private makeGraticule(display: Display) {
    const g = display.graticule
    return new Graticule({
      className: 'layer-graticule',
      strokeStyle: new Stroke({ color: g.color, width: g.width, lineDash: [2, 3] }),
      showLabels: g.labels,
      wrapX: false,
      intervals: g.step > 0 ? [g.step] : [90, 45, 30, 20, 10, 5, 2, 1, 0.5, 0.25, 0.1],
      // a fixed step is drawn at every zoom, however close its lines get
      targetSize: g.step > 0 ? 1 : 100,
      lonLabelStyle: new Text({ font: '10px "Segoe UI", sans-serif', textBaseline: 'bottom', fill: new Fill({ color: g.color }), stroke: new Stroke({ color: 'rgba(255,255,255,0.8)', width: 3 }) }),
      latLabelStyle: new Text({ font: '10px "Segoe UI", sans-serif', textAlign: 'end', fill: new Fill({ color: g.color }), stroke: new Stroke({ color: 'rgba(255,255,255,0.8)', width: 3 }) }),
    })
  }

  private textureKey = ''
  private async applyTexture(display: Display) {
    const t = display.texture
    const key = `${t.kind}|${t.image}|${t.scale}`
    if (key === this.textureKey) return
    this.textureKey = key
    let url: string
    try {
      url = t.kind === 'custom' && t.image ? await platform.fileUrl(t.image) : textureUrl(t.kind === 'custom' ? 'paper' : t.kind)
    } catch {
      url = textureUrl('paper')
    }
    const size = Math.round(256 * t.scale)
    ;(this.layers.texture as TileLayer<TileImage>).setSource(
      new TileImage({
        projection: 'EPSG:4326',
        crossOrigin: 'anonymous',
        wrapX: false,
        tileGrid: new TileGrid({
          extent: EXTENT,
          origin: [-180, 90],
          tileSize: size,
          resolutions: Array.from({ length: 16 }, (_, z) => (360 / (size * 2)) / 2 ** z),
        }),
        tileUrlFunction: () => url,
      }),
    )
  }

  private applyFilters(display: Display) {
    // the hillshade is white where flat and on the sea, so it darkens whatever lies below
    const rules = [`.ol-layers { filter: ${filterCss(display.mapFilter)}; background: ${display.background}; }`, `.layer-texture { mix-blend-mode: ${display.texture.blend}; }`, `.layer-shade { mix-blend-mode: multiply; }`]
    for (const [id, filter] of Object.entries(display.layerFilters)) rules.push(`.${layerClass(id as LayerId)} { filter: ${filterCss(filter)}; }`)
    this.styleSheet.textContent = rules.join('\n')
  }

  // ------------------------------------------------------------------------------------------
  // selection and tools

  setSelection(selection: { kind: EntityKind; id: string } | null) {
    const before = this.selection
    this.selection = selection
    this.context = { ...this.context, selectedId: selection?.id ?? null }
    for (const s of [before, selection]) if (s) this.features[s.kind]?.get(s.id)?.changed()
    this.updateEditOverlay()
    this.setTool(this.tool)
  }

  /** the drawn (not land-cut) outline of the selected area */
  private updateEditOverlay() {
    this.editSource.clear()
    const s = this.selection
    if (!s || !(AREA_KINDS as readonly string[]).includes(s.kind)) return
    const entity = (this.project[COLLECTIONS[s.kind]] as unknown as Entity[]).find(e => e.id === s.id)
    if (!entity?.geometry) return
    const feature = new Feature(toOl(entity.geometry))
    feature.set('entity', entity)
    this.editSource.addFeature(feature)
  }

  focus(kind: EntityKind, id: string) {
    const feature = this.features[kind].get(id)
    const geometry = feature?.getGeometry()
    if (!geometry) return
    const view = this.map.getView()
    if (geometry instanceof Point) view.animate({ center: geometry.getCoordinates(), zoom: Math.max(view.getZoom() ?? 3, 5), duration: 400 })
    else view.fit(geometry.getExtent(), { padding: [60, 60, 60, 60], duration: 400, maxZoom: 8 })
  }

  goTo(center: LonLat, zoom?: number) {
    const view = this.map.getView()
    view.animate({ center, zoom: zoom ?? Math.max(view.getZoom() ?? 3, 5), duration: 400 })
  }

  setTool(tool: Tool) {
    this.tool = tool
    for (const interaction of this.interactions) this.map.removeInteraction(interaction)
    this.interactions = []
    this.activeDraw = null
    const add = (interaction: Interaction) => {
      this.interactions.push(interaction)
      this.map.addInteraction(interaction)
      if (interaction instanceof Draw) this.activeDraw = interaction
    }
    // after the drawing or dragging, so they see the pointer first; the last one added has the
    // last word, so a city wins over a route passing next to it
    const snapForRoutes = (exclude?: string) => {
      const routes = this.sources.route.getFeatures().filter(f => f.getId() !== exclude)
      const onRoutes = new Snap({ features: new Collection(routes), pixelTolerance: 10 })
      const onCities = new Snap({ source: this.sources.city, edge: false, pixelTolerance: 12 })
      for (const snap of [onRoutes, onCities]) {
        snap.setActive(snapCities.peek())
        add(snap)
      }
    }
    const target = this.map.getTargetElement()
    if (target) target.style.cursor = tool.id === 'select' ? '' : 'crosshair'
    if (tool.id !== 'measure') {
      this.measureSource.clear()
      this.measureTip.setPosition(undefined)
    }

    const s = this.selection
    if (tool.id === 'select' && s) {
      const feature = this.features[s.kind].get(s.id)
      const geometry = feature?.getGeometry()
      if (feature && geometry instanceof Point) {
        const translate = new Translate({ features: new Collection([feature]) })
        translate.on('translateend', () => this.events.editGeometry(s.kind, s.id, fromOl(feature.getGeometry()!)))
        add(translate)
      } else if (feature && geometry instanceof LineString) {
        const modify = new Modify({ features: new Collection([feature]), deleteCondition })
        modify.on('modifyend', () => this.events.editGeometry(s.kind, s.id, fromOl(feature.getGeometry()!)))
        add(modify)
        if (s.kind === 'route') snapForRoutes(s.id)
      }
    }
    if (tool.id === 'vertices' && s) {
      const feature = this.editSource.getFeatures()[0] ?? this.features[s.kind].get(s.id)
      if (feature) {
        const modify = new Modify({ features: new Collection([feature]), deleteCondition })
        modify.on('modifyend', () => this.events.editGeometry(s.kind, s.id, fromOl(feature.getGeometry()!)))
        add(modify)
      }
    }
    if (tool.id === 'draw-line') {
      const draw = new Draw({ type: 'LineString', source: this.measureSource, freehandCondition })
      draw.on('drawend', event => {
        const geometry = fromOl(event.feature.getGeometry()!) as LineGeometry
        setTimeout(() => this.measureSource.clear())
        geometry.coordinates = this.smooth(geometry.coordinates, false)
        this.events.create(tool, geometry, this.resolution())
      })
      add(draw)
      if (tool.kind === 'route') snapForRoutes()
    }
    if (tool.id === 'reshape') {
      const draw = new Draw({ type: 'LineString', source: this.measureSource, freehandCondition })
      draw.on('drawend', event => {
        const coords = (event.feature.getGeometry() as LineString).getCoordinates() as LonLat[]
        setTimeout(() => this.measureSource.clear())
        this.events.reshape(tool.entityId, this.smooth(coords, false), this.resolution())
      })
      add(draw)
      snapForRoutes(tool.entityId)
    }
    if (tool.id === 'area-new' || tool.id === 'area-add' || tool.id === 'area-subtract') {
      const draw = new Draw({ type: 'Polygon', source: this.measureSource, freehandCondition })
      draw.on('drawend', event => {
        const drawn = (event.feature.getGeometry() as Polygon).getCoordinates() as LonLat[][]
        const polygon = drawn.map(ring => this.smooth(ring, true))
        setTimeout(() => this.measureSource.clear())
        this.events.area(tool, polygon, polygon[0][0])
      })
      add(draw)
    }
    if (tool.id === 'measure') this.addMeasure(tool.mode, add)
  }

  /** the touch buttons: finish the drawing, take back the last point, or drop it */
  drawAction(action: 'finish' | 'undo' | 'abort') {
    const draw = this.activeDraw
    if (!draw) return
    if (action === 'finish') draw.finishDrawing()
    else if (action === 'undo') draw.removeLastPoint()
    else draw.abortDrawing()
  }

  /** freehand strokes get smoothed; the sampling follows the current zoom (about 2 px) */
  private smooth(coords: LonLat[], closed: boolean): LonLat[] {
    return smoothStroke(coords, closed, freehandSmoothing.peek(), this.resolution() * 2)
  }

  private addMeasure(mode: MeasureMode, add: (i: Interaction) => void) {
    const radius = () => this.project.planetRadius
    const describe = (geometry: Geometry) => {
      if (geometry instanceof Polygon) {
        const km2 = areaKm2({ type: 'MultiPolygon', coordinates: [geometry.getCoordinates() as LonLat[][]] }, radius())
        return { text: formatKm2(km2), value: km2 }
      }
      const coords = (geometry as LineString).getCoordinates() as LonLat[]
      const m = lineLengthM(mode === 'ruler' && coords.length >= 2 ? greatCircle(coords[0], coords[coords.length - 1]) : coords, radius())
      return { text: formatKm(m), value: m / 1000 }
    }
    const draw = new Draw({
      type: mode === 'area' ? 'Polygon' : 'LineString',
      source: this.measureSource,
      maxPoints: mode === 'ruler' ? 2 : undefined,
      freehandCondition: mode === 'ruler' ? () => false : freehandCondition,
    })
    let listener: EventsKey | null = null
    draw.on('drawstart', event => {
      this.measureSource.clear()
      const geometry = event.feature.getGeometry()!
      listener = geometry.on('change', () => {
        const result = describe(geometry)
        const element = this.measureTip.getElement()!
        element.textContent = result.text
        const coords = geometry instanceof Polygon ? geometry.getInteriorPoint().getCoordinates() : (geometry as LineString).getLastCoordinate()
        this.measureTip.setPosition(coords.slice(0, 2))
      })
    })
    draw.on('drawend', event => {
      if (listener) unByKey(listener)
      const geometry = event.feature.getGeometry()!
      if (mode === 'ruler' && geometry instanceof LineString) {
        const coords = geometry.getCoordinates() as LonLat[]
        if (coords.length >= 2) geometry.setCoordinates(greatCircle(coords[0], coords[coords.length - 1]))
      }
      const result = describe(geometry)
      this.measureTip.getElement()!.textContent = result.text
      this.events.measure({ mode, ...result })
    })
    add(draw)
  }

  private onClick(at: LonLat, pixel: number[]) {
    const tool = this.tool
    if (tool.id === 'pick') {
      this.events.pick(tool.purpose, at)
      return
    }
    if (tool.id === 'place') {
      this.events.create(tool, { type: 'Point', coordinates: at }, this.resolution())
      return
    }
    if (tool.id === 'area-island') {
      this.events.area(tool, [], at)
      return
    }
    if (tool.id !== 'select') return
    const hits = new Map<EntityKind, string>()
    this.map.forEachFeatureAtPixel(
      pixel,
      feature => {
        const kind = feature.get('kind') as EntityKind | undefined
        const entity = feature.get('entity') as Entity | undefined
        if (kind && entity && !hits.has(kind)) hits.set(kind, entity.id)
      },
      { hitTolerance: 5, layerFilter: layer => layer.getVisible() && ALL_KINDS.some(k => this.layers[KIND_LAYER[k]] === layer) },
    )
    const kind = PICK_ORDER.find(k => hits.has(k))
    this.events.select(kind ?? null, kind ? hits.get(kind)! : null)
  }

  /** everything currently drawn, as one canvas (for the 3D view and the globe) */
  snapshot(): HTMLCanvasElement {
    const size = this.map.getSize() ?? [1, 1]
    const out = document.createElement('canvas')
    out.width = size[0]
    out.height = size[1]
    const ctx = out.getContext('2d')!
    ctx.fillStyle = this.project.display.background
    ctx.fillRect(0, 0, out.width, out.height)
    const viewport = this.map.getViewport()
    for (const canvas of viewport.querySelectorAll<HTMLCanvasElement>('.ol-layers canvas')) {
      if (!canvas.width) continue
      const parent = canvas.parentElement as HTMLElement
      const opacity = Number(parent.style.opacity || canvas.style.opacity || 1)
      ctx.globalAlpha = opacity
      const blend = getComputedStyle(parent).mixBlendMode
      ctx.globalCompositeOperation = (blend && blend !== 'normal' ? blend : 'source-over') as GlobalCompositeOperation
      const transform = canvas.style.transform
      const match = transform.match(/^matrix\(([^(]*)\)$/)
      if (match) {
        const m = match[1].split(',').map(Number)
        ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5])
      } else ctx.setTransform(size[0] / canvas.width, 0, 0, size[1] / canvas.height, 0, 0)
      ctx.drawImage(canvas, 0, 0)
    }
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    return out
  }

  /**
   * The map at full extent in a given size, rendered once off-screen for the globe. `only` shows
   * just these layers, fully opaque (the satellite picture or the relief on their own).
   */
  async renderWorld(width: number, only?: LayerId[]): Promise<HTMLCanvasElement> {
    const target = this.map.getTargetElement() as HTMLElement
    const view = this.map.getView()
    const saved = { center: view.getCenter(), resolution: view.getResolution(), width: target.style.width, height: target.style.height }
    if (only) {
      for (const [id, layer] of Object.entries(this.layers) as [LayerId, BaseLayer][]) {
        layer.setVisible(only.includes(id))
        if (only.includes(id)) layer.setOpacity(1)
      }
    }
    const ratio = window.devicePixelRatio || 1
    target.style.width = `${width / ratio}px`
    target.style.height = `${width / 2 / ratio}px`
    this.map.updateSize()
    view.setCenter([0, 0])
    view.setResolution(360 / (width / ratio))
    await new Promise<void>(resolve => this.map.once('rendercomplete', () => resolve()))
    const canvas = this.snapshot()
    if (only) this.applyLayers(this.project)
    target.style.width = saved.width
    target.style.height = saved.height
    this.map.updateSize()
    view.setCenter(saved.center)
    view.setResolution(saved.resolution)
    return canvas
  }

  viewExtent(): [number, number, number, number] {
    return this.map.getView().calculateExtent(this.map.getSize()) as [number, number, number, number]
  }

  resolution() {
    return this.map.getView().getResolution() ?? 1
  }
}

