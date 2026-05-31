/**
 * WebSocket lifecycle for the render server.
 *
 * Single connection used for both control (JSON) and chunks (binary).
 * Stale-frame drop: each panel has a "latest seq" — chunks with an
 * older seq are discarded so we never paint the previous viewport
 * over the current one when the server is mid-frame.
 */
import { useEffect, useRef, useState } from 'react'
import {
  parseMessage,
  Panel,
  type ChunkFrame,
  type ClientMessage,
  type TelemetryMessage,
} from './protocol'

type ConnState = 'connecting' | 'open' | 'closed'

export interface RenderSocket {
  state: ConnState
  send: (msg: ClientMessage) => void
}

const INITIAL_BACKOFF_MS = 250
const MAX_BACKOFF_MS = 4_000

export function useRenderSocket(
  url: string,
  onChunk: (chunk: ChunkFrame) => void,
  onTelemetry?: (msg: TelemetryMessage) => void,
): RenderSocket {
  const [state, setState] = useState<ConnState>('connecting')
  const wsRef = useRef<WebSocket | null>(null)
  const latestSeqRef = useRef<Record<Panel, number>>({
    [Panel.MandelbrotMain]: -1,
    [Panel.JuliaMain]: -1,
    [Panel.MandelbrotMini]: -1,
    [Panel.JuliaMini]: -1,
  })
  // Stable ref so the effect doesn't re-subscribe when onChunk identity changes.
  const onChunkRef = useRef(onChunk)
  onChunkRef.current = onChunk
  const onTelemetryRef = useRef(onTelemetry)
  onTelemetryRef.current = onTelemetry

  useEffect(() => {
    let cancelled = false
    let backoff = INITIAL_BACKOFF_MS
    let reconnectTimer: number | undefined

    const connect = () => {
      if (cancelled) return
      setState('connecting')
      const ws = new WebSocket(url)
      ws.binaryType = 'arraybuffer'
      wsRef.current = ws

      ws.onopen = () => {
        backoff = INITIAL_BACKOFF_MS
        setState('open')
      }

      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          try {
            const msg = JSON.parse(ev.data) as TelemetryMessage
            if (msg.type === 'telemetry') {
              onTelemetryRef.current?.(msg)
            }
          } catch (err) {
            console.warn('[ws] bad json:', err)
          }
          return
        }
        let frames: ChunkFrame[]
        try {
          frames = parseMessage(ev.data as ArrayBuffer)
        } catch (err) {
          console.warn('[ws] bad frame:', err)
          return
        }
        // An empty bundle means the server rendered the frame but every
        // chunk was byte-identical to the previous send (dirty-chunk
        // skip). The canvas is already correct; we just need to advance
        // the stale-seq tracker so older chunks for this panel can't
        // clobber it. The header carries panel/frame_seq even when
        // there are no chunk records — re-parse them from the raw bytes.
        if (frames.length === 0) {
          const view = new DataView(ev.data as ArrayBuffer)
          const panel = view.getUint8(1) as Panel
          const frameSeq = view.getUint16(3, true)
          const seen = latestSeqRef.current[panel]
          if (seen < 0 || !isOlder(frameSeq, seen)) {
            latestSeqRef.current[panel] = frameSeq
          }
          return
        }
        const first = frames[0]
        const seen = latestSeqRef.current[first.panel]
        if (seen >= 0 && isOlder(first.frameSeq, seen)) {
          onTelemetryRef.current?.({
            type: 'telemetry',
            event: 'client_frame_dropped',
            panel_id: first.panel,
            frame_seq: first.frameSeq,
            seen_frame_seq: seen,
          })
          return
        }
        latestSeqRef.current[first.panel] = first.frameSeq
        for (const f of frames) onChunkRef.current(f)
      }

      ws.onclose = () => {
        wsRef.current = null
        setState('closed')
        if (cancelled) return
        reconnectTimer = window.setTimeout(connect, backoff)
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
      }

      ws.onerror = () => {
        // onclose will run next; backoff handled there.
      }
    }

    connect()

    return () => {
      cancelled = true
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer)
      const ws = wsRef.current
      if (ws) {
        // Suppress handlers so React 19 StrictMode's double-mount
        // doesn't log a "closed before connection established" warning
        // when the first mount tears down its still-connecting socket.
        ws.onopen = null
        ws.onmessage = null
        ws.onclose = null
        ws.onerror = null
        if (
          ws.readyState === WebSocket.OPEN ||
          ws.readyState === WebSocket.CONNECTING
        ) {
          ws.close()
        }
      }
      wsRef.current = null
    }
  }, [url])

  const send = (msg: ClientMessage) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify(msg))
  }

  return { state, send }
}

/**
 * Wrap-aware seq comparison: a is "older" than b if it sits in the
 * backward half of the 16-bit window. Tolerates u16 rollover (0 → 65535).
 * Equal seq is NOT older — same image, just another chunk.
 */
function isOlder(a: number, b: number): boolean {
  const diff = (b - a) & 0xffff
  return diff !== 0 && diff < 0x8000
}
