/// <reference types="vite/client" />
declare const __APP_VERSION__: string
declare const __BUILD_TIME__: string

// gifenc ships no types; only what the globe export uses
declare module 'gifenc' {
  export type Palette = number[][]
  export interface QuantizeOptions { format?: 'rgb565' | 'rgb444' | 'rgba4444'; oneBitAlpha?: boolean | number; clearAlpha?: boolean; clearAlphaThreshold?: number; clearAlphaColor?: number }
  export function quantize(rgba: Uint8Array | Uint8ClampedArray, maxColors: number, options?: QuantizeOptions): Palette
  export function applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: Palette, format?: 'rgb565' | 'rgb444' | 'rgba4444'): Uint8Array
  export interface FrameOptions { palette?: Palette; delay?: number; repeat?: number; transparent?: boolean; transparentIndex?: number; dispose?: number; first?: boolean }
  export interface Encoder { writeFrame(index: Uint8Array, width: number, height: number, options?: FrameOptions): void; finish(): void; bytes(): Uint8Array }
  export function GIFEncoder(options?: { auto?: boolean; initialCapacity?: number }): Encoder
}
