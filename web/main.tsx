import 'ol/ol.css'
// fonts ship with the app, so the map and the logo look the same offline and on the tablet
// (Latin with the extended set, enough for German and most invented names)
import '@fontsource/aref-ruqaa-ink/latin-400.css'
import '@fontsource/aref-ruqaa-ink/latin-ext-400.css'
import '@fontsource/aref-ruqaa-ink/latin-700.css'
import '@fontsource/aref-ruqaa-ink/latin-ext-700.css'
import '@fontsource/cinzel/latin-400.css'
import '@fontsource/cinzel/latin-ext-400.css'
import '@fontsource/cinzel/latin-700.css'
import '@fontsource/cinzel/latin-ext-700.css'
import '@fontsource/forum/latin-400.css'
import '@fontsource/forum/latin-ext-400.css'
import '@fontsource/marcellus/latin-400.css'
import '@fontsource/marcellus/latin-ext-400.css'
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
