/**
 * Tile-unpack worker.
 *
 * Owns the per-tile pipeline that used to run on the main thread:
 *   nibble-packed payload bytes
 *     → unpacked RGBA Uint8ClampedArray
 *     → ImageData
 *     → ImageBitmap (via createImageBitmap, GPU-resident)
 *
 * Returns the ImageBitmap as a `transfer`-able so the main thread
 * can drawImage it onto staging in O(1) main-thread time.
 *
 * Replaces the inline paintAsync in TilePainter so deep-zoom renders
 * (which produce 25 tiles back-to-back) don't bottleneck the main
 * thread's pan smoothness.
 */

import { TILE_PX } from './protocol'

type InitMsg = { type: 'init'; palette: Uint8ClampedArray }
type TileMsg = {
  type: 'tile'
  jobId: number              // monotonic per main-thread send
  panel: number              // PanelId (kept opaque here)
  tileId: number
  frameSeq: number
  payload: ArrayBuffer       // transferred from main
}
type WorkerInbound = InitMsg | TileMsg

export type WorkerOutbound = {
  type: 'bitmap'
  jobId: number
  panel: number
  tileId: number
  frameSeq: number
  bitmap: ImageBitmap
}

// Palette LUT, copied in from the main thread on init. 16 entries × 4 RGBA.
let palette: Uint8ClampedArray | null = null

function unpackIntoRgba(payload: Uint8Array, out: Uint8ClampedArray) {
  if (!palette) return
  const lut = palette
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

self.addEventListener('message', async (ev: MessageEvent<WorkerInbound>) => {
  const msg = ev.data
  if (msg.type === 'init') {
    palette = msg.palette
    return
  }
  if (msg.type === 'tile') {
    const rgba = new Uint8ClampedArray(TILE_PX * TILE_PX * 4)
    unpackIntoRgba(new Uint8Array(msg.payload), rgba)
    const imageData = new ImageData(rgba, TILE_PX, TILE_PX)
    let bitmap: ImageBitmap
    try {
      bitmap = await createImageBitmap(imageData)
    } catch {
      return
    }
    const out: WorkerOutbound = {
      type: 'bitmap',
      jobId: msg.jobId,
      panel: msg.panel,
      tileId: msg.tileId,
      frameSeq: msg.frameSeq,
      bitmap,
    }
    ;(self as unknown as Worker).postMessage(out, [bitmap])
  }
})
