/**
 * Double-buffered tile painter.
 *
 * The hot pipeline (unpack → ImageData → ImageBitmap) lives in a Web
 * Worker (`tileWorker.ts`). This painter just takes already-made
 * ImageBitmaps and blits them into the staging canvas via drawImage.
 * When all tiles for a frame_seq land, staging swaps to the visible
 * canvas atomically. Stale bitmaps (from older frame_seqs) are
 * dropped at the boundary.
 *
 * Memory: 2× canvas per panel (1024² RGBA ≈ 4 MB). Cheap on
 * desktop, fine on mobile.
 */
import { PALETTE_RGBA } from './palette'
import {
  GRID,
  IMAGE_PX,
  TILE_PX,
  tileGridPosition,
} from './protocol'

const TILES_PER_FRAME = GRID * GRID

export class TilePainter {
  readonly canvas: HTMLCanvasElement
  private displayCtx: CanvasRenderingContext2D
  private staging: HTMLCanvasElement
  private stagingCtx: CanvasRenderingContext2D
  private tilesGot = new Set<number>()
  private currentSeq = -1
  /** Called when a full frame has been swapped into the visible canvas. */
  onFrameComplete: ((seq: number) => void) | null = null

  constructor(canvas: HTMLCanvasElement) {
    const display = canvas.getContext('2d', { alpha: false })
    if (!display) throw new Error('2D context unavailable')
    this.canvas = canvas
    this.displayCtx = display

    this.staging = document.createElement('canvas')
    this.staging.width = IMAGE_PX
    this.staging.height = IMAGE_PX
    const sCtx = this.staging.getContext('2d', { alpha: false })
    if (!sCtx) throw new Error('staging 2D context unavailable')
    this.stagingCtx = sCtx
  }

  /**
   * Paint an already-decoded bitmap (produced by the worker) into the
   * staging canvas at the tile's grid position. Closes the bitmap
   * regardless of whether we drew it (so the GPU memory is released).
   */
  paintBitmap(
    frameSeq: number,
    tileId: number,
    bitmap: ImageBitmap,
  ): void {
    if (frameSeq !== this.currentSeq) {
      this.currentSeq = frameSeq
      this.tilesGot.clear()
    }

    const { col, row } = tileGridPosition(tileId)
    this.stagingCtx.drawImage(bitmap, col * TILE_PX, row * TILE_PX)
    bitmap.close()

    this.tilesGot.add(tileId)
    if (this.tilesGot.size === TILES_PER_FRAME) {
      this.displayCtx.drawImage(this.staging, 0, 0)
      this.tilesGot.clear()
      this.onFrameComplete?.(frameSeq)
    }
  }

  /** Wipe the visible canvas to the in-set colour. */
  clear(): void {
    const r = PALETTE_RGBA[0]
    const g = PALETTE_RGBA[1]
    const b = PALETTE_RGBA[2]
    this.displayCtx.fillStyle = `rgb(${r},${g},${b})`
    this.displayCtx.fillRect(0, 0, this.canvas.width, this.canvas.height)
    this.stagingCtx.fillStyle = this.displayCtx.fillStyle
    this.stagingCtx.fillRect(0, 0, IMAGE_PX, IMAGE_PX)
  }
}

/**
 * Expand `payload` (one byte = two 4-bit pixels, low nibble first) into
 * RGBA bytes in `out`. Kept here for tests / non-worker paths.
 */
export function unpackIntoRgba(
  payload: Uint8Array,
  out: Uint8ClampedArray,
): void {
  const lut = PALETTE_RGBA
  let oi = 0
  for (let i = 0; i < payload.length; i++) {
    const byte = payload[i]
    const lo = (byte & 0x0f) * 4
    const hi = (byte >> 4) * 4
    out[oi++] = lut[lo]
    out[oi++] = lut[lo + 1]
    out[oi++] = lut[lo + 2]
    out[oi++] = lut[lo + 3]
    out[oi++] = lut[hi]
    out[oi++] = lut[hi + 1]
    out[oi++] = lut[hi + 2]
    out[oi++] = lut[hi + 3]
  }
}

export const unpackIntoImageData = unpackIntoRgba
