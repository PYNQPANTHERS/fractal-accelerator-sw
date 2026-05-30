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
 *                       julia_c_real?, julia_c_imag?, max_iter?,
 *                       quality?: "full" | "preview",
 *                       interaction?: "idle" | "active" | "final" }
 *   { type: "set_mode", mode: "performance" | "live_evolution" }
 *   { type: "set_minimaps", enabled, frame_seq }
 *   { type: "set_telemetry", enabled }
 */

export const HEADER_BYTES = 16
export const TILE_PX = 256
/** 4×4 grid of 256-px tiles (16 tiles total). */
export const GRID = 4
export const VISIBLE_PX = 1024
export const IMAGE_PX = TILE_PX * GRID // 1024
export const VISIBLE_OFFSET = 0
export const TILE_PAYLOAD_BYTES = (TILE_PX * TILE_PX) / 2 // 32 768

export const MSG_TILE        = 0x01
export const MSG_TILE_BUNDLE = 0x02
export const PIXEL_FMT_4BIT  = 0x10

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

/**
 * Parse one binary WebSocket message into TileFrames.
 *
 * Two formats supported:
 *   MSG_TILE        — single tile, 16-byte header + payload
 *   MSG_TILE_BUNDLE — N tiles, 16-byte header + N × (1 + payload)
 *
 * Always returns an array — callers iterate and deliver each TileFrame
 * to the painter, regardless of how the server chose to pack them.
 */
export function parseMessage(buf: ArrayBuffer): TileFrame[] {
  if (buf.byteLength < HEADER_BYTES) {
    throw new Error(`frame too short: ${buf.byteLength} bytes`)
  }
  const view = new DataView(buf)
  const msgType = view.getUint8(0)
  if (msgType === MSG_TILE) {
    const panel = view.getUint8(1) as Panel
    const tileId = view.getUint8(2)
    const frameSeq = view.getUint16(3, true)
    const width = view.getUint16(5, true)
    const height = view.getUint16(7, true)
    const pixelFormat = view.getUint8(9)
    const payloadBytes = (width * height) / 2
    return [{
      panel,
      tileId,
      frameSeq,
      width,
      height,
      pixelFormat,
      payload: new Uint8Array(buf, HEADER_BYTES, payloadBytes),
    }]
  }
  if (msgType === MSG_TILE_BUNDLE) {
    const panel = view.getUint8(1) as Panel
    const tileCount = view.getUint8(2)
    const frameSeq = view.getUint16(3, true)
    const width = view.getUint16(5, true)
    const height = view.getUint16(7, true)
    const pixelFormat = view.getUint8(9)
    const payloadBytes = (width * height) / 2
    const recordSize = 1 + payloadBytes
    const out: TileFrame[] = new Array(tileCount)
    let pos = HEADER_BYTES
    for (let i = 0; i < tileCount; i++) {
      const tileId = view.getUint8(pos)
      out[i] = {
        panel,
        tileId,
        frameSeq,
        width,
        height,
        pixelFormat,
        payload: new Uint8Array(buf, pos + 1, payloadBytes),
      }
      pos += recordSize
    }
    return out
  }
  throw new Error(`unexpected message type: 0x${msgType.toString(16)}`)
}

/** Back-compat single-tile parser kept for tests. */
export function parseFrame(buf: ArrayBuffer): TileFrame {
  const frames = parseMessage(buf)
  if (frames.length !== 1) {
    throw new Error(`expected single tile, got ${frames.length}`)
  }
  return frames[0]
}

/** (col, row) in the 4×4 tile grid for a given tile id. */
export function tileGridPosition(tileId: number): { col: number; row: number } {
  return { col: tileId % GRID, row: Math.floor(tileId / GRID) }
}

export type Quality = 'full' | 'preview'
export type InteractionPhase = 'idle' | 'active' | 'final'

export type TelemetryMessage =
  | {
      type: 'telemetry'
      event: 'scheduler'
      mode: 'performance' | 'live_evolution'
      active_panel: Panel
      interacting_panel: Panel | null
      pending: Array<{
        panel_id: Panel
        frame_seq: number
        quality: Quality
      }>
    }
  | {
      type: 'telemetry'
      event: 'render_started'
      panel_id: Panel
      frame_seq: number
      quality: Quality
      max_iter: number
      backend: string
      tile_cols: number
      tile_rows: number
    }
  | {
      type: 'telemetry'
      event: 'tile_done'
      panel_id: Panel
      frame_seq: number
      tile_id: number
      elapsed_ms: number
      quality: Quality
      backend: string
      stage: 'available' | 'compute' | 'transfer'
      tile_cols: number
      tile_rows: number
    }
  | {
      type: 'telemetry'
      event: 'render_finished'
      panel_id: Panel
      frame_seq: number
      elapsed_ms: number
      tile_count: number
      quality: Quality
      backend: string
    }
  | {
      type: 'telemetry'
      event: 'render_dropped'
      panel_id: Panel
      frame_seq: number
      reason: string
    }
  | {
      type: 'telemetry'
      event: 'client_frame_dropped'
      panel_id: Panel
      frame_seq: number
      seen_frame_seq: number
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
      /** Optional. Defaults to "full". Server-side "preview" renders
       *  use the subsampled C++ path — ~3-4× faster, slightly blocky. */
      quality?: Quality
      /** Optional. Lets the PS scheduler distinguish active drag work
       *  from the final settled viewport without guessing from silence. */
      interaction?: InteractionPhase
    }
  | { type: 'set_mode'; mode: 'performance' | 'live_evolution' }
  | { type: 'set_minimaps'; enabled: boolean; frame_seq: number }
  | { type: 'set_telemetry'; enabled: boolean }
