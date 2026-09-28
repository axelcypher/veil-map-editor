// Cuts drawn areas to the land. The coast polygons are large, so this runs off the main thread and
// first trims the land to the area's bounding box.
import polygonClipping from 'polygon-clipping'

type Pair = [number, number]
type Poly = Pair[][]

let land: { poly: Poly; bbox: [number, number, number, number] }[] = []

function bboxOfRing(ring: Pair[]): [number, number, number, number] {
  const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const [x, y] of ring) {
    box[0] = Math.min(box[0], x)
    box[1] = Math.min(box[1], y)
    box[2] = Math.max(box[2], x)
    box[3] = Math.max(box[3], y)
  }
  return box
}

/** Sutherland-Hodgman against an axis-aligned box */
function clipRing(ring: Pair[], [x0, y0, x1, y1]: [number, number, number, number]): Pair[] {
  const edges: [(p: Pair) => boolean, (a: Pair, b: Pair) => Pair][] = [
    [p => p[0] >= x0, (a, b) => [x0, a[1] + ((b[1] - a[1]) * (x0 - a[0])) / (b[0] - a[0])]],
    [p => p[0] <= x1, (a, b) => [x1, a[1] + ((b[1] - a[1]) * (x1 - a[0])) / (b[0] - a[0])]],
    [p => p[1] >= y0, (a, b) => [a[0] + ((b[0] - a[0]) * (y0 - a[1])) / (b[1] - a[1]), y0]],
    [p => p[1] <= y1, (a, b) => [a[0] + ((b[0] - a[0]) * (y1 - a[1])) / (b[1] - a[1]), y1]],
  ]
  let out = ring.slice(0, -1)
  for (const [inside, cut] of edges) {
    if (!out.length) break
    const input = out
    out = []
    for (let i = 0; i < input.length; i++) {
      const cur = input[i]
      const prev = input[(i + input.length - 1) % input.length]
      if (inside(cur)) {
        if (!inside(prev)) out.push(cut(prev, cur))
        out.push(cur)
      } else if (inside(prev)) out.push(cut(prev, cur))
    }
  }
  if (out.length < 3) return []
  out.push(out[0])
  return out
}

self.onmessage = (event: MessageEvent) => {
  const message = event.data as { type: 'land'; coordinates: Poly[] } | { type: 'clip'; id: number; coordinates: Poly[] }
  if (message.type === 'land') {
    land = message.coordinates.map(poly => ({ poly, bbox: bboxOfRing(poly[0]) }))
    return
  }
  try {
    const box = message.coordinates.reduce(
      (acc, poly) => {
        const b = bboxOfRing(poly[0])
        return [Math.min(acc[0], b[0]), Math.min(acc[1], b[1]), Math.max(acc[2], b[2]), Math.max(acc[3], b[3])] as [number, number, number, number]
      },
      [Infinity, Infinity, -Infinity, -Infinity] as [number, number, number, number],
    )
    const pad: [number, number, number, number] = [box[0] - 0.01, box[1] - 0.01, box[2] + 0.01, box[3] + 0.01]
    const pieces: Poly[] = []
    for (const item of land) {
      const b = item.bbox
      if (b[0] > pad[2] || b[2] < pad[0] || b[1] > pad[3] || b[3] < pad[1]) continue
      const inside = b[0] >= pad[0] && b[2] <= pad[2] && b[1] >= pad[1] && b[3] <= pad[3]
      if (inside) {
        pieces.push(item.poly)
        continue
      }
      const outer = clipRing(item.poly[0], pad)
      if (!outer.length) continue
      const holes = item.poly.slice(1).map(h => clipRing(h, pad)).filter(h => h.length)
      pieces.push([outer, ...holes])
    }
    const result = pieces.length ? polygonClipping.intersection(message.coordinates as never, pieces as never) : []
    ;(self as unknown as Worker).postMessage({ id: message.id, coordinates: result })
  } catch (error) {
    ;(self as unknown as Worker).postMessage({ id: message.id, error: String(error) })
  }
}
