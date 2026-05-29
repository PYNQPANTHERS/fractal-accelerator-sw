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
import { VISIBLE_PX, type InteractionPhase } from './protocol'

export interface ViewState {
  panX: number
  panY: number
  zoom: number
}

const ZOOM_MIN = 0
const ZOOM_MAX = 15
const WHEEL_PER_STEP = 100
/** Fraction of the viewport (per side) of pre-rendered margin we can
 *  translate into before running out of fractal pixels. */
const CANVAS_MARGIN_FRAC = 0.0 // 4×4 grid has no margin
/** Max world-pan speed in pixels per millisecond. Cap is enforced by
 *  wall-clock time (not per pointermove event), so very high pointer
 *  rates don't blow past it. At 1.5 px/ms the world can sweep across
 *  a 1000-px panel in 666 ms; that's well above any intentional drag
 *  but below "flick the screen across the room." */
const MAX_PAN_PX_PER_MS = 1.5
/** Predictive prefetch: when a render lands mid-drag with the world
 *  still moving above this speed, speculatively request the *next*
 *  render at (worldPos + velocity × LOOKAHEAD). Tiles arrive roughly
 *  when the cursor gets there, so the swap is timely instead of late. */
const PREFETCH_MIN_SPEED_PX_PER_MS = 0.2
const PREFETCH_LOOKAHEAD_MS = 150

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
  /** World position (px relative to drag start) — the canvas's view of
   *  where things are. Lags the cursor by at most one render's worth
   *  of cap × time. This is what we commit to the server. */
  worldX: number
  worldY: number
  /** Wall-clock time of the last world-advance step, for time-based cap. */
  worldLastTs: number
  /** Smoothed world velocity (px / ms), used for predictive prefetch. */
  vx: number
  vy: number
  /** World position when the in-flight render was sent. */
  sentX: number
  sentY: number
  /** Current transform baseline (= sentX/Y after a render applies). */
  baselineX: number
  baselineY: number
  /** Latest cursor position. */
  cursorX: number
  cursorY: number
}

interface PendingCommit {
  view: ViewState
  interaction: InteractionPhase
}

export function useViewState(
  initial: ViewState,
  onCommit: (next: ViewState, interaction: InteractionPhase) => void,
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
  // pipeline requests faster than the server can drain them.
  const inFlight = useRef(false)
  // If a new view appears while a render is in flight, stash it here.
  // Sent as soon as the in-flight render completes (last-write-wins).
  const pending = useRef<PendingCommit | null>(null)

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
    (next: ViewState, interaction: InteractionPhase = 'idle') => {
      setView(next)
      viewRef.current = next
      onCommit(next, interaction)
    },
    [onCommit],
  )

  const canvasRef = useCallback((el: HTMLCanvasElement | null) => {
    canvasElRef.current = el
  }, [])

  // Advance the world toward (cursorX, cursorY) at a wall-clock cap.
  // Time-based, not event-based: high pointer rates don't blow past
  // the cap. Also updates an EWMA-smoothed velocity for use by the
  // predictive prefetch.
  const advanceWorld = (sess: DragSession, cursorX: number, cursorY: number) => {
    const now = performance.now()
    const dt = Math.max(1, now - sess.worldLastTs)
    sess.worldLastTs = now
    const maxStep = MAX_PAN_PX_PER_MS * dt
    const stepX = clamp(cursorX - sess.worldX, -maxStep, maxStep)
    const stepY = clamp(cursorY - sess.worldY, -maxStep, maxStep)
    sess.worldX += stepX
    sess.worldY += stepY
    // Smooth velocity (px/ms). alpha picked so the velocity tracks
    // genuine motion within ~50 ms but ignores per-event jitter.
    const instVx = stepX / dt
    const instVy = stepY / dt
    const alpha = 0.3
    sess.vx = sess.vx * (1 - alpha) + instVx * alpha
    sess.vy = sess.vy * (1 - alpha) + instVy * alpha
  }

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
      // Bitmap shows view-at-(sentX, sentY) → that's the new baseline.
      // World may have advanced further; transform shows the gap.
      sess.baselineX = sess.sentX
      sess.baselineY = sess.sentY
      if (el) {
        const tx = sess.worldX - sess.baselineX
        const ty = sess.worldY - sess.baselineY
        el.style.transform =
          tx === 0 && ty === 0 ? '' : `translate(${tx}px, ${ty}px)`
      }
    } else if (el) {
      el.style.transform = ''
    }

    // Flush any stashed view. If we're still in a drag, rebuild the
    // view from the *current* world position — the world has likely
    // advanced past the stash. Outside a drag (e.g. release stash),
    // send the stashed view as-is.
    const stashed = pending.current
    if (stashed) {
      pending.current = null
      let next = stashed.view
      let interaction = stashed.interaction
      if (sess) {
        const start = sess.startView
        const win = 4.0 / Math.pow(2, start.zoom)
        next = {
          panX: start.panX + -sess.worldX * (win / VISIBLE_PX),
          panY: start.panY + -sess.worldY * (win / VISIBLE_PX),
          zoom: start.zoom,
        }
        sess.sentX = sess.worldX
        sess.sentY = sess.worldY
        interaction = 'active'
      }
      inFlight.current = true
      viewRef.current = next
      onCommit(next, interaction)
      return
    }

    // Nothing stashed — if we're mid-drag with measurable velocity,
    // speculatively request the *next* viewport now. By the time the
    // tiles land, the cursor is likely there and we swap atomically
    // instead of waiting for a fresh render after the user crosses
    // into uncharted territory.
    if (!sess) return
    const speed = Math.hypot(sess.vx, sess.vy)
    if (speed < PREFETCH_MIN_SPEED_PX_PER_MS) return
    const predX = sess.worldX + sess.vx * PREFETCH_LOOKAHEAD_MS
    const predY = sess.worldY + sess.vy * PREFETCH_LOOKAHEAD_MS
    const start = sess.startView
    const win = 4.0 / Math.pow(2, start.zoom)
    const speculative: ViewState = {
      panX: start.panX + -predX * (win / VISIBLE_PX),
      panY: start.panY + -predY * (win / VISIBLE_PX),
      zoom: start.zoom,
    }
    inFlight.current = true
    sess.sentX = predX
    sess.sentY = predY
    viewRef.current = speculative
    onCommit(speculative, 'active')
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
          worldX: 0,
          worldY: 0,
          worldLastTs: performance.now(),
          vx: 0,
          vy: 0,
          sentX: 0,
          sentY: 0,
          baselineX: 0,
          baselineY: 0,
          cursorX: 0,
          cursorY: 0,
        }
      },
      onDrag: ({ movement: [mx, my], last }) => {
        const sess = drag.current
        if (!sess) return
        sess.cursorX = mx
        sess.cursorY = my

        // World advances at a wall-clock cap toward the cursor on every
        // pointermove. Slow drags pass through 1:1 (the cap is generous
        // for normal motion). Fast flicks get throttled.
        advanceWorld(sess, mx, my)

        const start = sess.startView
        const win = 4.0 / Math.pow(2, start.zoom)
        const next: ViewState = {
          panX: start.panX + -sess.worldX * (win / VISIBLE_PX),
          panY: start.panY + -sess.worldY * (win / VISIBLE_PX),
          zoom: start.zoom,
        }

        if (last) {
          drag.current = null
          if (inFlight.current) {
            pending.current = { view: next, interaction: 'final' }
            setView(next)
            viewRef.current = next
          } else {
            inFlight.current = true
            commit(next, 'final')
          }
          return
        }

        writeTransform(sess.worldX - sess.baselineX, sess.worldY - sess.baselineY)

        if (!streamDuringDrag) return
        if (inFlight.current) {
          pending.current = { view: next, interaction: 'active' }
        } else {
          inFlight.current = true
          sess.sentX = sess.worldX
          sess.sentY = sess.worldY
          viewRef.current = next
          onCommit(next, 'active')
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
            pending.current = { view: next, interaction: 'idle' }
          } else {
            inFlight.current = true
            onCommit(next, 'idle')
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
