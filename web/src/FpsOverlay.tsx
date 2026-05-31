/**
 * FPS overlay + counters.
 *
 * Rolling stats over a 1-second window:
 *   fps   — completed renders per second (notifyFrameApplied calls)
 *   m/j   — per-panel FPS plus latency in ms
 *   lat   — wall-clock latency: request → final chunk landed (EWMA, ms)
 *
 * fps and lat tell the sim/server/wire story together: low fps with
 * low lat means we're idle, low fps with high lat means we're CPU-
 * bound.
 *
 * Counters are always running (negligible cost). The overlay component
 * is only mounted when the debug flag is on.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Panel } from './protocol'

const WINDOW_MS = 1000

type PaintSample = {
  time: number
  panel: Panel
}

export interface Rates {
  fps: number
  latMs: number
  mandelbrotFps: number
  mandelbrotLatMs: number
  juliaFps: number
  juliaLatMs: number
}

export interface FpsHandle {
  /** Mark a render *requested* — start the latency timer for that seq. */
  noteRender: (seq: number, panel: Panel) => void
  /** Mark a render *complete* — close the latency timer for that seq. */
  notePaint: (seq: number, panel: Panel) => void
}

export function useFpsCounters(): { handle: FpsHandle; rates: Rates } {
  const paintTimes = useRef<PaintSample[]>([])
  // panel:seq -> request timestamp. notePaint(panel, seq) closes the
  // entry and contributes its duration to the smoothed latency.
  const renderStartBySeq = useRef<Map<string, number>>(new Map())
  const latEwma = useRef<number>(0)
  const mandelbrotLatEwma = useRef<number>(0)
  const juliaLatEwma = useRef<number>(0)
  const [rates, setRates] = useState<Rates>({
    fps: 0,
    latMs: 0,
    mandelbrotFps: 0,
    mandelbrotLatMs: 0,
    juliaFps: 0,
    juliaLatMs: 0,
  })

  const noteRender = useCallback((seq: number, panel: Panel) => {
    renderStartBySeq.current.set(renderKey(panel, seq), performance.now())
    // Bound the map — if we never get a paint for an old seq (because
    // the server coalesced it) we don't want to leak memory.
    if (renderStartBySeq.current.size > 32) {
      const firstKey = renderStartBySeq.current.keys().next().value
      if (firstKey !== undefined) renderStartBySeq.current.delete(firstKey)
    }
  }, [])
  const notePaint = useCallback((seq: number, panel: Panel) => {
    paintTimes.current.push({ time: performance.now(), panel })
    const key = renderKey(panel, seq)
    const start = renderStartBySeq.current.get(key)
    if (start !== undefined) {
      const dur = performance.now() - start
      renderStartBySeq.current.delete(key)
      // EWMA smoothing — track real latency without overlay flicker.
      latEwma.current =
        latEwma.current === 0 ? dur : latEwma.current * 0.7 + dur * 0.3
      if (panel === Panel.MandelbrotMain) {
        mandelbrotLatEwma.current =
          mandelbrotLatEwma.current === 0
            ? dur
            : mandelbrotLatEwma.current * 0.7 + dur * 0.3
      } else if (panel === Panel.JuliaMain) {
        juliaLatEwma.current =
          juliaLatEwma.current === 0
            ? dur
            : juliaLatEwma.current * 0.7 + dur * 0.3
      }
    }
  }, [])
  const handle = useMemo<FpsHandle>(
    () => ({ noteRender, notePaint }),
    [noteRender, notePaint],
  )

  useEffect(() => {
    let rafId = 0
    let lastSample = 0

    const tick = (now: number) => {
      if (now - lastSample > 250) {
        lastSample = now
        const cutoff = now - WINDOW_MS
        const prune = <T,>(arr: T[], timeOf: (item: T) => number): T[] => {
          let i = 0
          while (i < arr.length && timeOf(arr[i]) < cutoff) i++
          return i > 0 ? arr.slice(i) : arr
        }
        paintTimes.current = prune(paintTimes.current, (p) => p.time)
        const mandelbrotFps = paintTimes.current.filter(
          (p) => p.panel === Panel.MandelbrotMain,
        ).length
        const juliaFps = paintTimes.current.filter(
          (p) => p.panel === Panel.JuliaMain,
        ).length
        setRates({
          fps: paintTimes.current.length,
          latMs: Math.round(latEwma.current),
          mandelbrotFps,
          mandelbrotLatMs: Math.round(mandelbrotLatEwma.current),
          juliaFps,
          juliaLatMs: Math.round(juliaLatEwma.current),
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
      <Row label="m" value={`${rates.mandelbrotFps} / ${rates.mandelbrotLatMs} ms`} />
      <Row label="j" value={`${rates.juliaFps} / ${rates.juliaLatMs} ms`} />
      <Row label="lat" value={`${rates.latMs} ms`} />
    </div>
  )
}

function renderKey(panel: Panel, seq: number): string {
  return `${panel}:${seq}`
}

function Row({ label, value }: { label: string; value: number | string }) {
  return (
    <div>
      <span className="fps-label">{label}</span>
      <span className="fps-value">{value}</span>
    </div>
  )
}
