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
  /** Cursor position (relative to drag origin) when the *currently in
   *  flight* render request was sent. The baseline used for the
   *  preview transform once that render lands. We rebase to *sent*
   *  position, not current cursor — the canvas bitmap shows the view
   *  that corresponds to where the cursor was at send time. */
  sentMx: number
  sentMy: number
  /** Cursor position used as transform baseline right now. Updated to
   *  sentMx/sentMy when notifyFrameApplied fires. */
  baselineMx: number
  baselineMy: number
  /** Latest cursor position from the most recent pointermove. */
  lastMx: number
  lastMy: number
}

export function useViewState(
  initial: ViewState,
  onCommit: (next: ViewState) => void,
  /** If true, stream renders mid-drag instead of only on release. */
  streamDuringDrag: boolean = false,
): ViewController {
  const [view, setView] = useState<ViewState>(initial)
  const viewRef = useRef(view)
  viewRef.current = view
  const canvasElRef = useRef<HTMLCanvasElement | null>(null)
  const wheelAcc = useRef(0)
  const drag = useRef<DragSession | null>(null)
  // True when a streamed render is in flight (sent but final tile not
  // yet received). Used to gate the next stream-commit so we never
  // pipeline requests faster than the server can drain them — that's
  // what was causing the latency to grow and the canvas to fall behind.
  const inFlight = useRef(false)
  // If a new view appears while a render is in flight, stash it here.
  // We send it as soon as the in-flight render completes.
  const pending = useRef<ViewState | null>(null)

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
   * Painter calls this each time a complete frame swaps in. Three jobs:
   *  1. Rebase the visual baseline to the cursor position at the
   *     moment the render was *requested* — that's the position the
   *     newly-painted bitmap actually shows. (Not the current cursor:
   *     the cursor moved during the render. Rebasing to "now" would
   *     snap the canvas backward by that distance.)
   *  2. Apply the residual transform (cursor-now − cursor-at-send) so
   *     the canvas visually catches up to where the user actually is.
   *     No "back to 0" snap.
   *  3. Flush any pending stream-commit that was held back while a
   *     render was in flight. Backpressure: at most one render queued.
   */
  const notifyFrameApplied = useCallback(() => {
    inFlight.current = false
    const sess = drag.current
    const el = canvasElRef.current
    if (sess) {
      sess.baselineMx = sess.sentMx
      sess.baselineMy = sess.sentMy
      if (el) {
        const tx = sess.lastMx - sess.baselineMx
        const ty = sess.lastMy - sess.baselineMy
        el.style.transform =
          tx === 0 && ty === 0 ? '' : `translate(${tx}px, ${ty}px)`
      }
    } else if (el) {
      el.style.transform = ''
    }

    // Flush a stashed view if one accumulated during the in-flight render.
    if (pending.current) {
      const next = pending.current
      pending.current = null
      inFlight.current = true
      if (sess) {
        sess.sentMx = sess.lastMx
        sess.sentMy = sess.lastMy
      }
      viewRef.current = next
      onCommit(next)
    }
  }, [onCommit])

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
          marginX,
          marginY,
          sentMx: 0,
          sentMy: 0,
          baselineMx: 0,
          baselineMy: 0,
          lastMx: 0,
          lastMy: 0,
        }
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
          if (inFlight.current) {
            pending.current = next
            setView(next)
            viewRef.current = next
          } else {
            inFlight.current = true
            commit(next)
          }
          return
        }

        writeTransform(mx - sess.baselineMx, my - sess.baselineMy)

        if (!streamDuringDrag) return
        // Backpressure: only send if the previous render has finished;
        // otherwise keep the latest view stashed (last-write-wins).
        if (inFlight.current) {
          pending.current = next
        } else {
          inFlight.current = true
          sess.sentMx = mx
          sess.sentMy = my
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
          const next = { panX: cur.panX, panY: cur.panY, zoom: nextZoom }
          setView(next)
          viewRef.current = next
          if (inFlight.current) {
            pending.current = next
          } else {
            inFlight.current = true
            onCommit(next)
          }
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
