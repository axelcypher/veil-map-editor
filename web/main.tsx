import 'ol/ol.css'
import { render } from 'preact'
import * as actions from './model/actions'
import * as exporter from './model/export'
import * as store from './model/store'
import * as terrain from './model/terrain'
import { App } from './ui/App'
import { mapView } from './ui/mapRef'
import './style.css'

render(<App />, document.getElementById('app')!)

// for automated checks over the DevTools protocol
;(window as unknown as { __veil: unknown }).__veil = { actions, exporter, store, terrain, mapView }
