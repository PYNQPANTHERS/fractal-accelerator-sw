/**
 * Double-buffered tile painter.
 *
 * Tiles for one render arrive over the WebSocket (one bundle, then
 * unpacked here). To avoid the user seeing a half-finished render we
 * stage tiles into an off-screen canvas and only blit to the visible
 * canvas once a full frame is complete.
 *
 * Per-tile pipeline:
 *   payload bytes
 *     → unpacked to a fresh RGBA Uint8ClampedArray
 *     → wrapped in an ImageData
 *     → createImageBitmap → ImageBitmap (GPU-resident)
 *     → stagingCtx.drawImage(bitmap, col*256, row*256) — GPU bitblit
 *     → bitmap.close() — release GPU memory
 *
 * vs the previous putImageData path, this keeps tile pixels on the
 * GPU rather than round-tripping them through CPU on every drawImage,
 * and prepares the painter for a future Web Worker that does the
 * unpack off the main thread.
 *
 * createImageBitmap is async, so paint() is fire-and-forget. If a new
 * frame_seq arrives mid-bitmap, stale bitmaps are skipped on resolve.
 *
 * Memory: 2× canvas per panel (1280² RGBA ≈ 6.5 MB each). Cheap on
 * desktop, fine on mobile.
 */
import { PALETTE_RGBA } from './palette'
import {
  GRID,
  IMAGE_PX,
  TILE_PX,
  tileGridPosition,
  type TileFrame,
} from './protocol'

const TILES_PER_FRAME = GRID * GRID

export class TilePainter {
  readonly canvas: HTMLCanvasElement
  private displayCtx: CanvasRenderingContext2D
  private staging: HTMLCanvasElement
  private stagingCtx: CanvasRenderingContext2D
  // Set of tile_ids successfully painted into staging for the current
  // frame_seq. When the size reaches TILES_PER_FRAME we blit.
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

  paint(tile: TileFrame): void {
    if (tile.width !== TILE_PX || tile.height !== TILE_PX) return

    // New frame: reset progress. Stale bitmaps still resolving from the
    // previous frame_seq will be skipped via the currentSeq check below.
    if (tile.frameSeq !== this.currentSeq) {
      this.currentSeq = tile.frameSeq
      this.tilesGot.clear()
    }

    // Fire-and-forget. Errors are swallowed (createImageBitmap can
    // throw on weirdly-sized data; we never want to crash the WS
    // handler over a single bad tile).
    void this.paintAsync(tile)
  }

  private async paintAsync(tile: TileFrame): Promise<void> {
    // Allocate a fresh RGBA buffer per tile. Reusing one buffer would
    // mean N parallel paintAsync calls would corrupt each other; the
    // allocator overhead at 256 KB / tile is negligible vs the win
    // from concurrent GPU bitmap encoding.
    const rgba = new Uint8ClampedArray(TILE_PX * TILE_PX * 4)
    unpackIntoRgba(tile.payload, rgba)
    const imageData = new ImageData(rgba, TILE_PX, TILE_PX)

    let bitmap: ImageBitmap
    try {
      bitmap = await createImageBitmap(imageData)
    } catch {
      return
    }

    // If a newer frame_seq has arrived while we were creating the
    // bitmap, this tile is stale — drop it.
    if (tile.frameSeq !== this.currentSeq) {
      bitmap.close()
      return
    }

    const { col, row } = tileGridPosition(tile.tileId)
    this.stagingCtx.drawImage(bitmap, col * TILE_PX, row * TILE_PX)
    bitmap.close()

    // Even after the drawImage, another paint might have already
    // marked this tile_id (impossible in normal flow but defensive).
    this.tilesGot.add(tile.tileId)
    if (this.tilesGot.size === TILES_PER_FRAME) {
      this.displayCtx.drawImage(this.staging, 0, 0)
      this.tilesGot.clear()
      this.onFrameComplete?.(tile.frameSeq)
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
 * RGBA bytes in `out`. `out.length` must be 4 × pixel count.
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

/** Back-compat alias kept for tests / external imports. */
export const unpackIntoImageData = unpackIntoRgba
