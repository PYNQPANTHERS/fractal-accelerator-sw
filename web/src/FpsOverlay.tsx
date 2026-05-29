/**
 * FPS overlay + counters.
 *
 * Four rolling stats over a 1-second window:
 *   fps   — completed renders per second (notifyFrameApplied calls)
 *   lat   — wall-clock latency: request → final tile landed (EWMA, ms)
 *   move  — pointermove events per second during drag
 *   frame — browser requestAnimationFrame ticks (compositor health)
 *
 * fps and lat tell the sim/server/wire story together: low fps with
 * low lat means we're idle, low fps with high lat means we're CPU-
 * bound. move and frame together tell us if the compositor is keeping
 * up with the user's input, regardless of how slow the sim is.
 *
 * Counters are always running (negligible cost). The overlay component
 * is only mounted when the debug flag is on.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const WINDOW_MS = 1000

export interface Rates {
  fps: number
  latMs: number
  move: number
  frame: number
}

export interface FpsHandle {
  /** Mark a render *requested* — start the latency timer for that seq. */
  noteRender: (seq: number) => void
  /** Mark a render *complete* — close the latency timer for that seq. */
  notePaint: (seq: number) => void
  noteMove: () => void
}

export function useFpsCounters(): { handle: FpsHandle; rates: Rates } {
  const paintTimes = useRef<number[]>([])
  const moveTimes = useRef<number[]>([])
  const frameTimes = useRef<number[]>([])
  // seq -> request timestamp. notePaint(seq) closes the entry and
  // contributes its duration to the smoothed latency.
  const renderStartBySeq = useRef<Map<number, number>>(new Map())
  const latEwma = useRef<number>(0)
  const [rates, setRates] = useState<Rates>({
    fps: 0, latMs: 0, move: 0, frame: 0,
  })

  const noteRender = useCallback((seq: number) => {
    renderStartBySeq.current.set(seq, performance.now())
    // Bound the map — if we never get a paint for an old seq (because
    // the server coalesced it) we don't want to leak memory.
    if (renderStartBySeq.current.size > 32) {
      const firstKey = renderStartBySeq.current.keys().next().value
      if (firstKey !== undefined) renderStartBySeq.current.delete(firstKey)
    }
  }, [])
  const notePaint = useCallback((seq: number) => {
    paintTimes.current.push(performance.now())
    const start = renderStartBySeq.current.get(seq)
    if (start !== undefined) {
      const dur = performance.now() - start
      renderStartBySeq.current.delete(seq)
      // EWMA smoothing — track real latency without overlay flicker.
      latEwma.current =
        latEwma.current === 0 ? dur : latEwma.current * 0.7 + dur * 0.3
    }
  }, [])
  const noteMove = useCallback(() => {
    moveTimes.current.push(performance.now())
  }, [])

  const handle = useMemo<FpsHandle>(
    () => ({ noteRender, notePaint, noteMove }),
    [noteRender, notePaint, noteMove],
  )

  useEffect(() => {
    let rafId = 0
    let lastSample = 0

    const tick = (now: number) => {
      frameTimes.current.push(now)
      if (now - lastSample > 250) {
        lastSample = now
        const cutoff = now - WINDOW_MS
        const prune = (arr: number[]): number[] => {
          let i = 0
          while (i < arr.length && arr[i] < cutoff) i++
          return i > 0 ? arr.slice(i) : arr
        }
        paintTimes.current = prune(paintTimes.current)
        moveTimes.current = prune(moveTimes.current)
        frameTimes.current = prune(frameTimes.current)
        setRates({
          fps: paintTimes.current.length,
          latMs: Math.round(latEwma.current),
          move: moveTimes.current.length,
          frame: frameTimes.current.length,
        })
      }
      rafId = requestAnimationFrame(tick)
    }

    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [])

  return { handle, rates }
}

export function FpsOverlay({ rates }: { rates: Rates }) {
  return (
    <div className="fps-overlay">
      <Row label="fps" value={rates.fps} />
      <Row label="lat" value={`${rates.latMs} ms`} />
      <Row label="move" value={rates.move} />
      <Row label="frame" value={rates.frame} />
    </div>
  )
}

function Row({ label, value }: { label: string; value: number | string }) {
  return (
    <div>
      <span className="fps-label">{label}</span>
      <span className="fps-value">{value}</span>
    </div>
  )
}
