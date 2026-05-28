/**
 * Per-panel view state + gesture hookup for a Mandelbrot/Julia viewport.
 *
 * The committed (panX, panY, zoom) lives in React state — drives the
 * coordinate label and is what we send to the server. The drag preview
 * transform writes directly to the canvas via a ref instead of through
 * state, because at 120 Hz pointermove a setState per frame causes
 * visible jitter in the surrounding UI.
 *
 * Three things matter for drag smoothness:
 *  1. No `getBoundingClientRect()` per pointermove — we cache the
 *     clamp margins once at drag start (rect lookup forces layout).
 *  2. Stream commits during the drag DO NOT call `setView` — they only
 *     fire `onCommit` (the WebSocket send) and update the internal
 *     ref. React stays out of the per-frame path entirely.
 *  3. The drag origin (`dragStart`) is fixed for the whole gesture.
 *     We never re-baseline mid-drag, so segment delta is monotonic
 *     and there's no snap-back when a stream commit completes.
 *
 * Zoom is integer 0..15 (matches the FPGA's 4-bit zoom register in
 * translate.sv: window = 4.0 / 2^zoom). Wheel is centre-anchored:
 * the crosshair / Julia probe point doesn't drift on zoom.
 */
import { useCallback, useRef, useState } from 'react'
import { useGesture } from '@use-gesture/react'
import { IMAGE_PX } from './protocol'

export interface ViewState {
  panX: number
  panY: number
  zoom: number
}

const ZOOM_MIN = 0
const ZOOM_MAX = 15
const WHEEL_PER_STEP = 100
/** Must match --canvas-margin in styles.css (12%). */
const CANVAS_MARGIN_FRAC = 0.12

export interface ViewController {
  view: ViewState
  canvasRef: (el: HTMLCanvasElement | null) => void
  bind: ReturnType<typeof useGesture>
  setView: (next: ViewState) => void
  /**
   * Called by the TilePainter when a full streamed frame has landed.
   * Re-baselines the drag baseline so the next pointermove writes the
   * correct transform delta relative to the freshly-painted origin.
   */
  notifyFrameApplied: () => void
}

interface DragSession {
  startView: ViewState
  marginX: number
  marginY: number
  /** Pixel offset that's already been "consumed" by a streamed render.
   *  Subsequent pointer movements compute their world delta relative
   *  to this baseline, not the original drag start. */
  baselineMx: number
  baselineMy: number
  /** The view that's currently painted in the canvas (after the most
   *  recent staging→display swap), used as the origin for new transforms. */
  appliedView: ViewState
  /** Latest cursor position, used to re-baseline on frame apply. */
  lastMx: number
  lastMy: number
}

export function useViewState(
  initial: ViewState,
  onCommit: (next: ViewState) => void,
  /** ms between mid-drag stream commits. <=0 disables streaming. */
  streamIntervalMs: number = 0,
): ViewController {
  const [view, setView] = useState<ViewState>(initial)
  const viewRef = useRef(view)
  viewRef.current = view
  const canvasElRef = useRef<HTMLCanvasElement | null>(null)
  const wheelAcc = useRef(0)
  const drag = useRef<DragSession | null>(null)
  const lastStream = useRef(0)

  const writeTransform = useCallback((x: number, y: number) => {
    const el = canvasElRef.current
    if (!el) return
    if (x === 0 && y === 0) {
      el.style.transform = ''
      return
    }
    const sess = drag.current
    if (sess) {
      const cx = clamp(x, -sess.marginX, sess.marginX)
      const cy = clamp(y, -sess.marginY, sess.marginY)
      el.style.transform = `translate(${cx}px, ${cy}px)`
    } else {
      el.style.transform = `translate(${x}px, ${y}px)`
    }
  }, [])

  const commit = useCallback(
    (next: ViewState) => {
      setView(next)
      viewRef.current = next
      onCommit(next)
    },
    [onCommit],
  )

  const canvasRef = useCallback((el: HTMLCanvasElement | null) => {
    canvasElRef.current = el
  }, [])

  /**
   * Painter calls this each time a complete frame swaps in.
   * If a drag is in progress, advance the visual baseline to the
   * current cursor so the next pointermove writes a transform of zero
   * (or a tiny delta), avoiding the snap that would otherwise happen.
   * Outside a drag we just clear any leftover transform.
   */
  const notifyFrameApplied = useCallback(() => {
    const sess = drag.current
    const el = canvasElRef.current
    if (!sess) {
      if (el) el.style.transform = ''
      return
    }
    sess.baselineMx = sess.lastMx
    sess.baselineMy = sess.lastMy
    if (el) el.style.transform = ''
  }, [])

  const bind = useGesture(
    {
      onDragStart: () => {
        const el = canvasElRef.current
        let marginX = Infinity
        let marginY = Infinity
        if (el) {
          // One getBoundingClientRect per gesture instead of per frame.
          const rect = el.getBoundingClientRect()
          const factor = CANVAS_MARGIN_FRAC / (1 + CANVAS_MARGIN_FRAC * 2)
          marginX = rect.width * factor
          marginY = rect.height * factor
        }
        drag.current = {
          startView: viewRef.current,
          appliedView: viewRef.current,
          marginX,
          marginY,
          baselineMx: 0,
          baselineMy: 0,
          lastMx: 0,
          lastMy: 0,
        }
        lastStream.current = performance.now()
      },
      onDrag: ({ movement: [mx, my], last }) => {
        const sess = drag.current
        if (!sess) return
        sess.lastMx = mx
        sess.lastMy = my

        const start = sess.startView

        // World pan is 1:1 with cursor (measured from the *original*
        // drag start). The committed view always tracks the full
        // cursor distance — no overshoot, no clamping.
        const win = 4.0 / Math.pow(2, start.zoom)
        const next: ViewState = {
          panX: start.panX + -mx * (win / IMAGE_PX),
          panY: start.panY + -my * (win / IMAGE_PX),
          zoom: start.zoom,
        }

        if (last) {
          drag.current = null
          commit(next)
          return
        }

        // Preview transform is measured from the *applied* origin, not
        // the drag start. When a streamed render lands, baselineMx/My
        // advance to the current cursor so the next transform is small
        // (delta since apply), and the canvas pixels showing the
        // applied view stay aligned.
        writeTransform(mx - sess.baselineMx, my - sess.baselineMy)

        if (streamIntervalMs <= 0) return
        const now = performance.now()
        if (now - lastStream.current >= streamIntervalMs) {
          lastStream.current = now
          viewRef.current = next
          onCommit(next)
        }
      },
      onWheel: ({ delta: [, dy], event }) => {
        if (event.cancelable) event.preventDefault()
        wheelAcc.current += dy
        while (Math.abs(wheelAcc.current) >= WHEEL_PER_STEP) {
          const direction = wheelAcc.current > 0 ? -1 : 1
          wheelAcc.current -= direction * -WHEEL_PER_STEP

          const cur = viewRef.current
          const nextZoom = clamp(cur.zoom + direction, ZOOM_MIN, ZOOM_MAX)
          if (nextZoom === cur.zoom) continue

          // Centre-anchored: the crosshair (= panel centre = Julia's c
          // for the Mandelbrot panel) must not drift on zoom.
          commit({ panX: cur.panX, panY: cur.panY, zoom: nextZoom })
        }
      },
    },
    {
      drag: { filterTaps: true, pointer: { capture: true } },
      wheel: { eventOptions: { passive: false } },
    },
  )

  return { view, canvasRef, bind, setView: commit, notifyFrameApplied }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}
