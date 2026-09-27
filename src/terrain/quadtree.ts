// The map is a grid of base blocks; any block can be split into four, recursively, so that resolution can follow the zoom.
// Only the split blocks are stored. Neighbouring leaves never differ by more than one level, which grades the cell size smoothly.

export const MAX_LEVEL = 9

/** the coarse grid every leaf descends from */
export interface BaseGrid {
  width: number
  height: number
  cellsX: number
  cellsY: number
  /** block size in map units */
  blockWidth: number
  blockHeight: number
  /** average distance between neighbouring points at level 0 */
  spacing: number
}

export type Splits = ReadonlySet<number>

// room for 4 million blocks per axis, enough for any base resolution at the deepest level
const KEY_STRIDE = 4194304

export const nodeKey = (level: number, ix: number, iy: number) => level + 16 * (ix + KEY_STRIDE * iy)

export function decodeKey(key: number): [number, number, number] {
  const level = key % 16
  const rest = (key - level) / 16
  const ix = rest % KEY_STRIDE
  return [level, ix, (rest - ix) / KEY_STRIDE]
}

export function createBaseGrid(width: number, height: number, baseCells: number): BaseGrid {
  const spacing = Math.sqrt(width * height / baseCells)
  const cellsX = Math.max(2, Math.round(width / spacing))
  const cellsY = Math.max(2, Math.round(height / spacing))
  const blockWidth = width / cellsX
  const blockHeight = height / cellsY
  return { width, height, cellsX, cellsY, blockWidth, blockHeight, spacing: Math.sqrt(blockWidth * blockHeight) }
}

export interface Leaves {
  level: Uint8Array
  ix: Int32Array
  iy: Int32Array
}

/** all leaves in depth-first order, base blocks row by row: the order every per-cell array follows */
export function enumerateLeaves(base: BaseGrid, splits: Splits): Leaves {
  const level: number[] = []
  const ix: number[] = []
  const iy: number[] = []
  const visit = (nodeLevel: number, x: number, y: number) => {
    if (nodeLevel < MAX_LEVEL && splits.has(nodeKey(nodeLevel, x, y))) {
      for (let child = 0; child < 4; child += 1) visit(nodeLevel + 1, x * 2 + (child & 1), y * 2 + (child >> 1))
      return
    }
    level.push(nodeLevel)
    ix.push(x)
    iy.push(y)
  }
  for (let y = 0; y < base.cellsY; y += 1) for (let x = 0; x < base.cellsX; x += 1) visit(0, x, y)
  return { level: Uint8Array.from(level), ix: Int32Array.from(ix), iy: Int32Array.from(iy) }
}

/** block size at a level, in map units */
export const blockSizeAt = (base: BaseGrid, level: number): [number, number] => [base.blockWidth / 2 ** level, base.blockHeight / 2 ** level]

function intersectsEllipse(x0: number, y0: number, x1: number, y1: number, cx: number, cy: number, rx: number, ry: number) {
  const dx = (Math.min(x1, Math.max(x0, cx)) - cx) / rx
  const dy = (Math.min(y1, Math.max(y0, cy)) - cy) / ry
  return dx * dx + dy * dy <= 1
}

/** split every block that touches the ellipse until its leaves have the given level */
export function refineEllipse(base: BaseGrid, splits: Set<number>, cx: number, cy: number, rx: number, ry: number, level: number) {
  const visit = (nodeLevel: number, x: number, y: number) => {
    if (nodeLevel >= level) return
    const [width, height] = blockSizeAt(base, nodeLevel)
    if (!intersectsEllipse(x * width, y * height, (x + 1) * width, (y + 1) * height, cx, cy, rx, ry)) return
    splits.add(nodeKey(nodeLevel, x, y))
    for (let child = 0; child < 4; child += 1) visit(nodeLevel + 1, x * 2 + (child & 1), y * 2 + (child >> 1))
  }
  const fromX = Math.max(0, Math.floor((cx - rx) / base.blockWidth))
  const toX = Math.min(base.cellsX - 1, Math.floor((cx + rx) / base.blockWidth))
  const fromY = Math.max(0, Math.floor((cy - ry) / base.blockHeight))
  const toY = Math.min(base.cellsY - 1, Math.floor((cy + ry) / base.blockHeight))
  for (let y = fromY; y <= toY; y += 1) for (let x = fromX; x <= toX; x += 1) visit(0, x, y)
}

/** split more blocks until neighbouring leaves differ by at most one level */
export function balanceSplits(base: BaseGrid, splits: Set<number>) {
  const queue = [...splits]
  while (queue.length) {
    const [level, ix, iy] = decodeKey(queue.pop()!)
    if (level === 0) continue
    const limitX = base.cellsX * 2 ** level
    const limitY = base.cellsY * 2 ** level
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const nx = ix + dx
        const ny = iy + dy
        if ((dx === 0 && dy === 0) || nx < 0 || ny < 0 || nx >= limitX || ny >= limitY) continue
        const parent = nodeKey(level - 1, nx >> 1, ny >> 1)
        if (splits.has(parent)) continue
        splits.add(parent)
        queue.push(parent)
      }
    }
  }
}

/** splits as a flat list of level, x, y for the project file */
export function flattenSplits(splits: Splits): number[] {
  const flat: number[] = []
  for (const key of splits) flat.push(...decodeKey(key))
  return flat
}

export function unflattenSplits(flat: ArrayLike<number>): Set<number> {
  const splits = new Set<number>()
  for (let index = 0; index + 2 < flat.length; index += 3) splits.add(nodeKey(flat[index], flat[index + 1], flat[index + 2]))
  return splits
}
