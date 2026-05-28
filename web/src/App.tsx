/**
 * Top-level layout for the fractal explorer.
 *
 * Two full-bleed viewports (Mandelbrot | Julia) with minimaps overlaid
 * in the lower-left of each one. Each viewport owns a 1024×1024 canvas
 * driven by a TilePainter; incoming binary frames are routed to the
 * painter whose panel id matches.
 *
 * Interaction: drag to pan, wheel to step zoom by ±1 (matches the FPGA's
 * 4-bit zoom register). Mandelbrot pan/zoom is the input — the server
 * automatically re-renders Julia with c = Mandelbrot centre.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './styles.css'
import { useRenderSocket } from './useRenderSocket'
import { IMAGE_PX, Panel, type TileFrame } from './protocol'
import { TilePainter } from './tilePainter'
import { useViewState, type ViewState } from './useViewState'

type Mode = 'performance' | 'live_evolution'

const WS_URL =
  import.meta.env.VITE_WS_URL ?? `ws://${window.location.hostname}:8765`

const MANDELBROT_INITIAL: ViewState = { panX: -0.5, panY: 0, zoom: 0 }
const JULIA_INITIAL: ViewState = { panX: 0, panY: 0, zoom: 0 }
const JULIA_C_INITIAL = { real: -0.7, imag: 0.27 }

export default function App() {
  const [mode, setMode] = useState<Mode>('performance')
  const paintersRef = useRef<Partial<Record<Panel, TilePainter>>>({})
  // Bumped on every set_view so server can drop stale tile frames.
  const seqRef = useRef(0)
  // Julia tracks the c implied by the Mandelbrot centre.
  const juliaCRef = useRef(JULIA_C_INITIAL)

  const handleTile = useCallback((tile: TileFrame) => {
    paintersRef.current[tile.panel]?.paint(tile)
  }, [])

  const { state, send } = useRenderSocket(WS_URL, handleTile)
  const sendRef = useRef(send)
  sendRef.current = send

  const nextSeq = useCallback(() => {
    seqRef.current = (seqRef.current + 1) & 0xffff
    return seqRef.current
  }, [])

  const commitMandelbrot = useCallback(
    (next: ViewState) => {
      // Only update Julia's c when Mandelbrot actually moved — pure
      // zoom-changes keep the crosshair on the same complex point, so
      // there's no reason to re-render Julia.
      const panChanged =
        next.panX !== juliaCRef.current.real ||
        next.panY !== juliaCRef.current.imag
      if (panChanged) {
        juliaCRef.current = { real: next.panX, imag: next.panY }
      }
      sendRef.current({
        type: 'set_view',
        panel_id: Panel.MandelbrotMain,
        frame_seq: nextSeq(),
        pan_x: next.panX,
        pan_y: next.panY,
        zoom: next.zoom,
        fractal_type: 'mandelbrot',
        max_iter: maxIterFor(next.zoom),
      })
    },
    [nextSeq],
  )

  const commitJulia = useCallback(
    (next: ViewState) => {
      sendRef.current({
        type: 'set_view',
        panel_id: Panel.JuliaMain,
        frame_seq: nextSeq(),
        pan_x: next.panX,
        pan_y: next.panY,
        zoom: next.zoom,
        fractal_type: 'julia',
        julia_c_real: juliaCRef.current.real,
        julia_c_imag: juliaCRef.current.imag,
        max_iter: maxIterFor(next.zoom),
      })
    },
    [nextSeq],
  )

  // Both modes stream mid-drag; backpressure inside useViewState gates
  // requests so the server never queues more than one render. What
  // distinguishes the modes is *server-side* scheduling:
  //   Performance    → Mandelbrot gets full sim throughput; Julia
  //                    coupling waits 250ms (DEFER_MS) before rendering.
  //   Live Evolution → both mains round-robin; Julia keeps up live.
  const mandelbrotView = useViewState(MANDELBROT_INITIAL, commitMandelbrot, true)
  const juliaView = useViewState(JULIA_INITIAL, commitJulia, true)

  // Fire initial views once the socket is open.
  useEffect(() => {
    if (state !== 'open') return
    commitMandelbrot(MANDELBROT_INITIAL)
    commitJulia(JULIA_INITIAL)
  }, [state, commitMandelbrot, commitJulia])

  const onModeChange = (next: Mode) => {
    setMode(next)
    sendRef.current({ type: 'set_mode', mode: next })
  }

  // Stable ref callbacks — without `useMemo`, every App re-render (e.g. mode
  // toggle, view-state change) would hand React new function identities and
  // remount each canvas, wiping the painter state and flashing the canvas.
  const registerMandelbrotMain = useMemo(
    () => mergeRefs(
      makeRegister(
        paintersRef,
        Panel.MandelbrotMain,
        mandelbrotView.notifyFrameApplied,
      ),
      mandelbrotView.canvasRef,
    ),
    [mandelbrotView.canvasRef, mandelbrotView.notifyFrameApplied],
  )
  const registerJuliaMain = useMemo(
    () => mergeRefs(
      makeRegister(
        paintersRef,
        Panel.JuliaMain,
        juliaView.notifyFrameApplied,
      ),
      juliaView.canvasRef,
    ),
    [juliaView.canvasRef, juliaView.notifyFrameApplied],
  )
  const registerMandelbrotMini = useMemo(
    () => makeRegister(paintersRef, Panel.MandelbrotMini),
    [],
  )
  const registerJuliaMini = useMemo(
    () => makeRegister(paintersRef, Panel.JuliaMini),
    [],
  )

  return (
    <div className="app">
      <header className="header">
        <div className="header-title">
          <h1>
            Pynq<em>Zoom</em>
          </h1>
        </div>
        <span className="header-meta">
          <span className={`status status-${state}`}>{state}</span>
          <span className="sep">/</span>
          v0.1
        </span>
      </header>

      <main className="viewports">
        <div className="mode-toggle" role="tablist" aria-label="Render mode">
          <button
            className={mode === 'performance' ? 'active' : ''}
            onClick={() => onModeChange('performance')}
          >
            Performance
          </button>
          <button
            className={mode === 'live_evolution' ? 'active' : ''}
            onClick={() => onModeChange('live_evolution')}
          >
            Live Evolution
          </button>
        </div>

        <Viewport
          name="Mandelbrot"
          view={mandelbrotView.view}
          bind={mandelbrotView.bind}
          showCrosshair
          canvasRef={registerMandelbrotMain}
          minimapCanvasRef={registerMandelbrotMini}
          formatCoord={formatMandelbrotCoord}
        />
        <Viewport
          name="Julia"
          view={juliaView.view}
          bind={juliaView.bind}
          canvasRef={registerJuliaMain}
          minimapCanvasRef={registerJuliaMini}
          formatCoord={(v) =>
            `c = ${formatNumber(juliaCRef.current.real)} + ${formatNumber(juliaCRef.current.imag)}i  ·  ×${zoomLabel(v.zoom)}`
          }
        />

        <button className="settings-btn" aria-label="Settings">
          <Cog />
        </button>
      </main>
    </div>
  )
}

/** Fan-out a ref to multiple consumers. */
function mergeRefs<T>(
  ...refs: Array<(value: T | null) => void>
): (value: T | null) => void {
  return (value) => {
    for (const ref of refs) ref(value)
  }
}

function makeRegister(
  paintersRef: React.MutableRefObject<Partial<Record<Panel, TilePainter>>>,
  panel: Panel,
  onFrameComplete: (() => void) | null = null,
) {
  return (canvas: HTMLCanvasElement | null) => {
    if (!canvas) {
      delete paintersRef.current[panel]
      return
    }
    const existing = paintersRef.current[panel]
    if (existing?.canvas === canvas) {
      // Same canvas across re-renders: just update the callback.
      existing.onFrameComplete = onFrameComplete
      return
    }
    const painter = new TilePainter(canvas)
    painter.onFrameComplete = onFrameComplete
    painter.clear()
    paintersRef.current[panel] = painter
  }
}

function Viewport({
  name,
  view,
  bind,
  showCrosshair = false,
  canvasRef,
  minimapCanvasRef,
  formatCoord,
}: {
  name: string
  view: ViewState
  bind: ReturnType<typeof useViewState>['bind']
  showCrosshair?: boolean
  canvasRef: (canvas: HTMLCanvasElement | null) => void
  minimapCanvasRef: (canvas: HTMLCanvasElement | null) => void
  formatCoord: (v: ViewState) => string
}) {
  return (
    <section className="viewport" {...bind()}>
      <canvas
        className="viewport-canvas"
        width={IMAGE_PX}
        height={IMAGE_PX}
        ref={canvasRef}
      />
      <div className="viewport-label" data-coord={formatCoord(view)}>
        {name}
      </div>
      {showCrosshair && <div className="viewport-crosshair" />}
      <div className="minimap" role="img" aria-label={`${name} minimap`}>
        <canvas
          className="minimap-canvas"
          width={IMAGE_PX}
          height={IMAGE_PX}
          ref={minimapCanvasRef}
        />
        <div
          className="minimap-viewrect"
          style={viewRectStyle(view)}
        />
        <span className="minimap-label">{name}</span>
      </div>
    </section>
  )
}

function viewRectStyle(view: ViewState): React.CSSProperties {
  // Minimap shows zoom=0 (window 4.0 wide, centred at (0,0) for julia, (-0.5,0) for mandel).
  // The viewrect represents the visible region at the current zoom/pan.
  // We approximate by scaling the rect to a fraction of the minimap.
  const minimapWindow = 4.0
  const visibleWindow = 4.0 / Math.pow(2, view.zoom)
  const size = (visibleWindow / minimapWindow) * 100
  // Centre the rect on the pan position relative to the minimap centre (0,0).
  const left = 50 + ((view.panX - (-0.5)) / minimapWindow) * 100 - size / 2
  const top = 50 + (view.panY / minimapWindow) * 100 - size / 2
  return {
    left: `${left}%`,
    top: `${top}%`,
    width: `${size}%`,
    height: `${size}%`,
  }
}

function formatMandelbrotCoord(v: ViewState): string {
  return `${formatNumber(v.panX)} + ${formatNumber(v.panY)}i  ·  ×${zoomLabel(v.zoom)}`
}

function formatNumber(n: number): string {
  const sign = n < 0 ? '−' : ''
  return `${sign}${Math.abs(n).toFixed(3)}`
}

function zoomLabel(zoom: number): string {
  return Math.pow(2, zoom).toFixed(zoom > 6 ? 0 : 1)
}

// More iterations at higher zoom — at zoom 0 the boundary is fat and 64
// iters resolve it cleanly; at zoom 12 the boundary is hair-thin and
// most pixels need 1000+ iterations to escape. Capped so deep zoom
// renders stay interactive.
function maxIterFor(zoom: number): number {
  return Math.min(1500, 64 + zoom * 96)
}

function Cog() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
  )
}
