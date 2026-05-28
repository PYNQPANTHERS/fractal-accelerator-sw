/**
 * Wire protocol shared with the server (see server/protocol.py).
 *
 * Server → client: binary tile frames, 16-byte header + payload.
 *   u8  msg_type     0x01 = tile
 *   u8  panel_id     0..3 (see Panel below)
 *   u8  tile_id      0..15 row-major within the 4×4 panel grid
 *   u16 frame_seq    LE; per-panel; used to drop stale tiles
 *   u16 width        LE
 *   u16 height       LE
 *   u8  pixel_format 0x10 = 4-bit indices, nibble-packed, low nibble first
 *   6   reserved     zeros
 *   payload          width * height / 2 bytes
 *
 * Client → server: JSON text frames.
 *   { type: "set_view", panel_id, frame_seq, pan_x, pan_y, zoom,
 *                       fractal_type: "mandelbrot" | "julia",
 *                       julia_c_real?, julia_c_imag?, max_iter? }
 *   { type: "set_mode", mode: "performance" | "live_evolution" }
 */

export const HEADER_BYTES = 16
export const TILE_PX = 256
export const GRID = 4
export const IMAGE_PX = TILE_PX * GRID // 1024
export const TILE_PAYLOAD_BYTES = (TILE_PX * TILE_PX) / 2 // 32 768

export const MSG_TILE = 0x01
export const PIXEL_FMT_4BIT = 0x10

export const Panel = {
  MandelbrotMain: 0,
  JuliaMain: 1,
  MandelbrotMini: 2,
  JuliaMini: 3,
} as const

export type Panel = (typeof Panel)[keyof typeof Panel]

export interface TileFrame {
  panel: Panel
  tileId: number
  frameSeq: number
  width: number
  height: number
  pixelFormat: number
  payload: Uint8Array
}

/** Parse one binary frame received over the WebSocket. */
export function parseFrame(buf: ArrayBuffer): TileFrame {
  if (buf.byteLength < HEADER_BYTES) {
    throw new Error(`frame too short: ${buf.byteLength} bytes`)
  }
  const view = new DataView(buf)
  const msgType = view.getUint8(0)
  if (msgType !== MSG_TILE) {
    throw new Error(`unexpected message type: 0x${msgType.toString(16)}`)
  }
  const panel = view.getUint8(1) as Panel
  const tileId = view.getUint8(2)
  const frameSeq = view.getUint16(3, true)
  const width = view.getUint16(5, true)
  const height = view.getUint16(7, true)
  const pixelFormat = view.getUint8(9)
  const expectedPayload = (width * height) / 2
  const payload = new Uint8Array(buf, HEADER_BYTES, expectedPayload)
  return { panel, tileId, frameSeq, width, height, pixelFormat, payload }
}

/** (col, row) in the 4×4 tile grid for a given tile id. */
export function tileGridPosition(tileId: number): { col: number; row: number } {
  return { col: tileId % GRID, row: Math.floor(tileId / GRID) }
}

export type ClientMessage =
  | {
      type: 'set_view'
      panel_id: Panel
      frame_seq: number
      pan_x: number
      pan_y: number
      zoom: number
      fractal_type: 'mandelbrot' | 'julia'
      julia_c_real?: number
      julia_c_imag?: number
      max_iter?: number
    }
  | { type: 'set_mode'; mode: 'performance' | 'live_evolution' }
