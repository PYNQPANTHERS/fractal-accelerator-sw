/**
 * Double-buffered tile painter.
 *
 * Tiles for one render arrive striped over the WebSocket — paint them
 * straight onto the visible canvas and the user sees an 8-old-8-new
 * patchwork for a frame or two. To avoid that we stage tiles into an
 * off-screen canvas and only blit to the visible canvas once an
 * entire frame is complete (all 16 tiles for a given frame_seq).
 *
 * Memory: 2× canvas per panel (1024² RGBA = 4 MB each). Cheap on
 * desktop, fine on mobile.
 *
 * One ImageData scratch buffer is allocated lazily and reused.
 */
import { PALETTE_RGBA } from './palette'
import { IMAGE_PX, TILE_PX, tileGridPosition, type TileFrame } from './protocol'

const TILES_PER_FRAME = 16
const ALL_TILES_MASK = (1 << TILES_PER_FRAME) - 1 // 0xffff

export class TilePainter {
  readonly canvas: HTMLCanvasElement
  private displayCtx: CanvasRenderingContext2D
  private staging: HTMLCanvasElement
  private stagingCtx: CanvasRenderingContext2D
  private scratch: ImageData
  // Bitmask of tile_ids painted into staging for the current frame_seq.
  private tilesGot = 0
  private currentSeq = -1
  /** Called when a full frame has been swapped into the visible canvas. */
  onFrameComplete: (() => void) | null = null

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
    this.scratch = sCtx.createImageData(TILE_PX, TILE_PX)
  }

  paint(tile: TileFrame): void {
    if (tile.width !== TILE_PX || tile.height !== TILE_PX) return

    // New frame: reset staging-progress tracking. Staging keeps the
    // previous frame's pixels — that's fine, they're about to be
    // overwritten tile by tile, and the user never sees staging.
    if (tile.frameSeq !== this.currentSeq) {
      this.currentSeq = tile.frameSeq
      this.tilesGot = 0
    }

    // Unpack into the scratch ImageData and blit into staging.
    unpackIntoImageData(tile.payload, this.scratch.data)
    const { col, row } = tileGridPosition(tile.tileId)
    this.stagingCtx.putImageData(this.scratch, col * TILE_PX, row * TILE_PX)
    this.tilesGot |= 1 << tile.tileId

    // Frame complete → atomic swap. The drag controller (via
    // onFrameComplete) is responsible for resetting the preview
    // transform AND recording the new cursor baseline so the next
    // pointermove writes a correct delta relative to the new origin.
    if (this.tilesGot === ALL_TILES_MASK) {
      this.displayCtx.drawImage(this.staging, 0, 0)
      this.tilesGot = 0
      this.onFrameComplete?.()
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
export function unpackIntoImageData(
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
