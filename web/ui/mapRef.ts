import type { MapView } from '../map/MapView'

/** the one map instance, for panels that need to move or snapshot it */
export const mapView: { current: MapView | null } = { current: null }
