// Template-driven heightmap generator, ported from Azgaar's Fantasy Map Generator (MIT, Copyright 2017-2024 Max Haniyeu).
// Works on the 0-100 scale of the original, where 20 is the lowest land.
import { gridCell, type GridGraph } from './graph'
import { heightmapTemplates } from './heightmap-templates'
import { randomInt, type Random } from './rng'

type Step = 'Hill' | 'Pit' | 'Range' | 'Trough' | 'Strait' | 'Mask' | 'Invert' | 'Add' | 'Multiply' | 'Smooth'

const lim = (value: number) => Math.min(100, Math.max(0, value))

// cell count -> spread of a hill / a ridge; other counts are interpolated
const BLOB_POWER: [number, number][] = [[1000, 0.93], [2000, 0.95], [5000, 0.97], [10000, 0.98], [20000, 0.99], [30000, 0.991], [40000, 0.993], [50000, 0.994], [100000, 0.9973]]
const LINE_POWER: [number, number][] = [[1000, 0.75], [2000, 0.77], [5000, 0.79], [10000, 0.81], [20000, 0.82], [30000, 0.83], [40000, 0.84], [50000, 0.86], [100000, 0.93]]

/** how fast a ridge fades per ring of cells, for a base grid of this many cells */
export const getLinePower = (cells: number) => interpolate(LINE_POWER, cells)

function interpolate(table: [number, number][], cells: number): number {
  if (cells <= table[0][0]) return table[0][1]
  for (let index = 1; index < table.length; index += 1) {
    const [upperCells, upperValue] = table[index]
    if (cells > upperCells) continue
    const [lowerCells, lowerValue] = table[index - 1]
    return lowerValue + (upperValue - lowerValue) * (Math.log(cells / lowerCells) / Math.log(upperCells / lowerCells))
  }
  return table[table.length - 1][1]
}

export class HeightmapGenerator {
  heights: Uint8Array
  private readonly graph: GridGraph
  private readonly random: Random
  private readonly blobPower: number
  private readonly linePower: number

  constructor(graph: GridGraph, random: Random, heights?: Uint8Array) {
    this.graph = graph
    this.random = random
    this.heights = heights ?? new Uint8Array(graph.cellCount)
    this.blobPower = interpolate(BLOB_POWER, graph.cellCount)
    this.linePower = interpolate(LINE_POWER, graph.cellCount)
  }

  /** run a template script from a blank map and return the heights */
  static fromTemplate(graph: GridGraph, random: Random, templateId: string): Uint8Array {
    const template = heightmapTemplates[templateId]
    if (!template) throw new Error(`Unbekannte Höhenvorlage: ${templateId}`)
    const generator = new HeightmapGenerator(graph, random)
    for (const line of template.template.split('\n')) {
      const [tool, a2, a3, a4, a5] = line.trim().split(' ')
      generator.addStep(tool as Step, a2, a3, a4, a5)
    }
    return generator.heights
  }

  addStep(tool: Step, a2: string, a3: string, a4: string, a5: string) {
    if (tool === 'Hill') this.addHill(a2, a3, a4, a5)
    else if (tool === 'Pit') this.addPit(a2, a3, a4, a5)
    else if (tool === 'Range') this.addLine(1, a3, a4, a5, a2, 0.15)
    else if (tool === 'Trough') this.addLine(-1, a3, a4, a5, a2, 0.2)
    else if (tool === 'Strait') this.addStrait(a2, a3)
    else if (tool === 'Mask') this.mask(Number(a2))
    else if (tool === 'Invert') this.invert(Number(a2), a3)
    else if (tool === 'Add') this.modify(a3, Number(a2), 1)
    else if (tool === 'Multiply') this.modify(a3, 0, Number(a2))
    else if (tool === 'Smooth') this.smooth(Number(a2))
  }

  /** "5" is five (a fraction is the chance of one more), "2-4" is a random whole number in between */
  private count(range: string): number {
    const value = Number(range)
    if (!Number.isNaN(value)) {
      const whole = Math.trunc(value)
      return whole + (this.random() < value - whole ? 1 : 0)
    }
    const [low, high] = range.split('-').map(Number)
    const count = randomInt(this.random, low, high)
    return Number.isNaN(count) || count < 0.01 ? 0 : count
  }

  /** a position in "min-max" percent of the given length */
  private pointInRange(range: string, length: number): number {
    const min = parseInt(range.split('-')[0], 10) / 100 || 0
    const max = parseInt(range.split('-')[1], 10) / 100 || min
    return (min + this.random() * (max - min)) * length
  }

  private addHill(count: string, height: string, rangeX: string, rangeY: string) {
    const { graph, heights, random } = this
    for (let n = this.count(count); n > 0; n -= 1) {
      const change = new Uint8Array(heights.length)
      const peak = lim(this.count(height))
      let start = 0
      for (let attempt = 0; attempt < 50; attempt += 1) {
        start = gridCell(graph, this.pointInRange(rangeX, graph.width), this.pointInRange(rangeY, graph.height))
        if (heights[start] + peak <= 90) break
      }
      change[start] = peak
      const queue = [start]
      for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const cell = queue[cursor]
        for (const neighbor of graph.neighbors[cell]) {
          if (change[neighbor]) continue
          change[neighbor] = change[cell] ** this.blobPower * (random() * 0.2 + 0.9)
          if (change[neighbor] > 1) queue.push(neighbor)
        }
      }
      for (let cell = 0; cell < heights.length; cell += 1) heights[cell] = lim(heights[cell] + change[cell])
    }
  }

  private addPit(count: string, height: string, rangeX: string, rangeY: string) {
    const { graph, heights, random } = this
    for (let n = this.count(count); n > 0; n -= 1) {
      const used = new Uint8Array(heights.length)
      let depth = lim(this.count(height))
      let start = 0
      for (let attempt = 0; attempt < 50; attempt += 1) {
        start = gridCell(graph, this.pointInRange(rangeX, graph.width), this.pointInRange(rangeY, graph.height))
        if (heights[start] >= 20) break
      }
      const queue = [start]
      for (let cursor = 0; cursor < queue.length; cursor += 1) {
        depth = depth ** this.blobPower * (random() * 0.2 + 0.9)
        if (depth < 1) break
        for (const neighbor of graph.neighbors[queue[cursor]]) {
          if (used[neighbor]) continue
          heights[neighbor] = lim(heights[neighbor] - depth * (random() * 0.2 + 0.9))
          used[neighbor] = 1
          queue.push(neighbor)
        }
      }
    }
  }

  /** mountain ranges (sign 1) and troughs (sign -1): a wandering ridge line with a falloff to both sides */
  private addLine(sign: 1 | -1, height: string, rangeX: string, rangeY: string, count: string, randomness = 0.15) {
    const { graph, heights, random } = this
    const { neighbors, x, y, width } = graph

    for (let n = this.count(count); n > 0; n -= 1) {
      const used = new Uint8Array(heights.length)
      let power = lim(this.count(height))
      let startX = 0
      let startY = 0
      if (sign === 1) {
        startX = this.pointInRange(rangeX, width)
        startY = this.pointInRange(rangeY, graph.height)
      } else {
        for (let attempt = 0; attempt < 50; attempt += 1) {
          startX = this.pointInRange(rangeX, width)
          startY = this.pointInRange(rangeY, graph.height)
          if (heights[gridCell(graph, startX, startY)] >= 20) break
        }
      }
      const maxDistance = sign === 1 ? width / 3 : width / 2
      let endX = 0
      let endY = 0
      for (let attempt = 0; attempt < 50; attempt += 1) {
        endX = random() * width * 0.8 + width * 0.1
        endY = random() * graph.height * 0.7 + graph.height * 0.15
        const distance = Math.abs(endY - startY) + Math.abs(endX - startX)
        if (distance >= width / 8 && distance <= maxDistance) break
      }
      const start = gridCell(graph, startX, startY)
      const end = gridCell(graph, endX, endY)

      // main ridge: walk to the end cell, sometimes taking a shortcut for a wobble
      const ridge = [start]
      used[start] = 1
      for (let current = start; current !== end;) {
        let min = Infinity
        let next = current
        for (const neighbor of neighbors[current]) {
          if (used[neighbor]) continue
          let distance = (x[end] - x[neighbor]) ** 2 + (y[end] - y[neighbor]) ** 2
          if (random() > 1 - randomness) distance /= 2
          if (distance < min) {
            min = distance
            next = neighbor
          }
        }
        if (min === Infinity) break
        current = next
        ridge.push(current)
        used[current] = 1
      }

      // spread height from the ridge to the cells around it
      let queue = ridge.slice()
      let rings = 0
      while (queue.length) {
        const frontier = queue
        queue = []
        rings += 1
        for (const cell of frontier) heights[cell] = lim(heights[cell] + sign * power * (random() * 0.3 + 0.85))
        power = power ** this.linePower - 1
        if (power < 2) break
        for (const cell of frontier) {
          for (const neighbor of neighbors[cell]) {
            if (used[neighbor]) continue
            queue.push(neighbor)
            used[neighbor] = 1
          }
        }
      }

      // prominences: spurs running downhill from every sixth ridge cell
      ridge.forEach((ridgeCell, index) => {
        if (index % 6 !== 0) return
        let current = ridgeCell
        for (let step = 0; step < rings; step += 1) {
          let lowest = -1
          for (const neighbor of neighbors[current]) if (lowest < 0 || heights[neighbor] < heights[lowest]) lowest = neighbor
          if (lowest < 0) break
          heights[lowest] = (heights[current] * 2 + heights[lowest]) / 3
          current = lowest
        }
      })
    }
  }

  /** a channel across the map, widening the water it crosses */
  private addStrait(width: string, direction: string) {
    const { graph, heights, random } = this
    const desiredWidth = Math.min(this.count(width), graph.cellsX / 3)
    if (desiredWidth < 1 && random() < desiredWidth) return
    const vertical = direction === 'vertical'
    const startX = vertical ? Math.floor(random() * graph.width * 0.4 + graph.width * 0.3) : 5
    const startY = vertical ? 5 : Math.floor(random() * graph.height * 0.4 + graph.height * 0.3)
    const endX = vertical ? Math.floor(graph.width - startX - graph.width * 0.1 + random() * graph.width * 0.2) : graph.width - 5
    const endY = vertical ? graph.height - 5 : Math.floor(graph.height - startY - graph.height * 0.1 + random() * graph.height * 0.2)
    const start = gridCell(graph, startX, startY)
    const end = gridCell(graph, endX, endY)

    let range: number[] = []
    for (let current = start, guard = 0; current !== end && guard < graph.cellCount; guard += 1) {
      let min = Infinity
      let next = current
      for (const neighbor of graph.neighbors[current]) {
        let distance = (graph.x[end] - graph.x[neighbor]) ** 2 + (graph.y[end] - graph.y[neighbor]) ** 2
        if (random() > 0.8) distance /= 2
        if (distance < min) {
          min = distance
          next = neighbor
        }
      }
      current = next
      range.push(current)
    }

    const used = new Uint8Array(heights.length)
    const step = 0.1 / desiredWidth
    for (let index = 0; index < desiredWidth; index += 1) {
      const exponent = 0.9 - step * (desiredWidth - index)
      const widened: number[] = []
      for (const cell of range) {
        for (const neighbor of graph.neighbors[cell]) {
          if (used[neighbor]) continue
          used[neighbor] = 1
          widened.push(neighbor)
          heights[neighbor] **= exponent
          if (heights[neighbor] > 100) heights[neighbor] = 5
        }
      }
      range = widened
    }
  }

  /** add, multiply or raise the heights within a "min-max" range, or of all land / all cells */
  private modify(range: string, add: number, multiply: number, power?: number) {
    const min = range === 'land' ? 20 : range === 'all' ? 0 : Number(range.split('-')[0])
    const max = range === 'land' || range === 'all' ? 100 : Number(range.split('-')[1])
    const land = min === 20
    for (let cell = 0; cell < this.heights.length; cell += 1) {
      let height = this.heights[cell]
      if (height < min || height > max) continue
      if (add) height = land ? Math.max(height + add, 20) : height + add
      if (multiply !== 1) height = land ? (height - 20) * multiply + 20 : height * multiply
      if (power) height = land ? (height - 20) ** power + 20 : height ** power
      this.heights[cell] = lim(height)
    }
  }

  private smooth(strength = 2, add = 0) {
    const { graph } = this
    const source = this.heights.slice()
    for (let cell = 0; cell < source.length; cell += 1) {
      let sum = source[cell]
      for (const neighbor of graph.neighbors[cell]) sum += source[neighbor]
      const mean = sum / (graph.neighbors[cell].length + 1)
      this.heights[cell] = strength === 1 ? mean + add : lim((source[cell] * (strength - 1) + mean + add) / strength)
    }
  }

  /** pull the edges down: positive power keeps a centred land, negative raises the rim instead */
  private mask(power = 1) {
    const { graph } = this
    const fraction = power ? Math.abs(power) : 1
    for (let cell = 0; cell < this.heights.length; cell += 1) {
      const nx = 2 * graph.x[cell] / graph.width - 1
      const ny = 2 * graph.y[cell] / graph.height - 1
      let distance = (1 - nx ** 2) * (1 - ny ** 2)
      if (power < 0) distance = 1 - distance
      const height = this.heights[cell]
      this.heights[cell] = lim((height * (fraction - 1) + height * distance) / fraction)
    }
  }

  private invert(probability: number, axes: string) {
    if (this.random() >= probability) return
    const { cellsX, cellsY } = this.graph
    const invertX = axes !== 'y'
    const invertY = axes !== 'x'
    const source = this.heights.slice()
    for (let cell = 0; cell < source.length; cell += 1) {
      const column = cell % cellsX
      const row = Math.floor(cell / cellsX)
      const sourceColumn = invertX ? cellsX - column - 1 : column
      const sourceRow = invertY ? cellsY - row - 1 : row
      this.heights[cell] = source[sourceColumn + sourceRow * cellsX]
    }
  }

  /** smooth all cells once, the "Alles glätten" button */
  smoothAll(strength = 4, add = 1.5) {
    this.smooth(strength, add)
  }
}
