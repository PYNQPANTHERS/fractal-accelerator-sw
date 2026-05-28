/**
 * WebSocket lifecycle for the render server.
 *
 * Single connection used for both control (JSON) and tiles (binary).
 * Stale-frame drop: each panel has a "latest seq" — tiles with an
 * older seq are discarded so we never paint the previous viewport
 * over the current one when the server is mid-frame.
 */
import { useEffect, useRef, useState } from 'react'
import {
  parseFrame,
  Panel,
  type ClientMessage,
  type TileFrame,
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
  onTile: (tile: TileFrame) => void,
): RenderSocket {
  const [state, setState] = useState<ConnState>('connecting')
  const wsRef = useRef<WebSocket | null>(null)
  const latestSeqRef = useRef<Record<Panel, number>>({
    [Panel.MandelbrotMain]: -1,
    [Panel.JuliaMain]: -1,
    [Panel.MandelbrotMini]: -1,
    [Panel.JuliaMini]: -1,
  })
  // Stable ref so the effect doesn't re-subscribe when onTile identity changes.
  const onTileRef = useRef(onTile)
  onTileRef.current = onTile

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
          // Server-side JSON (status, errors). Ignored for now.
          return
        }
        let frame: TileFrame
        try {
          frame = parseFrame(ev.data as ArrayBuffer)
        } catch (err) {
          console.warn('[ws] bad frame:', err)
          return
        }
        const seen = latestSeqRef.current[frame.panel]
        // frame_seq is shared across all 16 tiles of one image, so we
        // only drop tiles whose seq is strictly older than what we've
        // already seen (i.e. leftovers from a previous viewport).
        if (seen >= 0 && isOlder(frame.frameSeq, seen)) {
          return
        }
        latestSeqRef.current[frame.panel] = frame.frameSeq
        onTileRef.current(frame)
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
 * Equal seq is NOT older — same image, just another tile.
 */
function isOlder(a: number, b: number): boolean {
  const diff = (b - a) & 0xffff
  return diff !== 0 && diff < 0x8000
}
