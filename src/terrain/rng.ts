export type Random = () => number

export function hashSeed(seed: string): number {
  let hash = 2166136261
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export function mulberry32(seed: number): Random {
  return () => {
    let value = seed += 0x6d2b79f5
    value = Math.imul(value ^ value >>> 15, value | 1)
    value ^= value + Math.imul(value ^ value >>> 7, value | 61)
    return ((value ^ value >>> 14) >>> 0) / 4294967296
  }
}

export function createRandom(seed: string): Random {
  return mulberry32(hashSeed(seed))
}

export function createSeed(): string {
  return crypto.randomUUID().slice(0, 8)
}

/** integer in [min, max], both ends included */
export function randomInt(random: Random, min: number, max: number): number {
  return Math.floor(random() * (max - min + 1)) + min
}

export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
