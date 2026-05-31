/**
 * Top-level layout for the fractal explorer.
 *
 * Two full-bleed viewports (Mandelbrot | Julia) with optional cached
 * minimaps overlaid in the lower-left. Each viewport owns a 1024×1024
 * canvas driven by a ChunkPainter; incoming binary frames are routed to
 * the painter whose panel id matches.
 *
 * Interaction: drag to pan, wheel to step zoom by ±1 (matches the FPGA's
 * 4-bit zoom register). Mandelbrot pan/zoom is the input — the server
 * automatically re-renders Julia with c = Mandelbrot centre.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './styles.css'
import { useRenderSocket } from './useRenderSocket'
import {
  IMAGE_PX,
  Panel,
  type ChunkFrame,
  type InteractionPhase,
  type Quality,
} from './protocol'
import { ChunkPainter } from './chunkPainter'
import { useChunkWorker } from './useChunkWorker'
import { useViewState, type ViewState } from './useViewState'
import { DebugPanel, DEFAULT_DEBUG_FLAGS, type DebugFlags } from './DebugPanel'
import { FpsOverlay, useFpsCounters } from './FpsOverlay'
import {
  FloatingWorkloadPanel,
  useWorkloadTelemetry,
} from './WorkloadInspector'

type Mode = 'performance' | 'live_evolution'

const WS_URL =
  import.meta.env.VITE_WS_URL ?? `ws://${window.location.hostname}:8765`

const MANDELBROT_INITIAL: ViewState = { panX: -0.5, panY: 0, zoom: 0 }
const JULIA_INITIAL: ViewState = { panX: 0, panY: 0, zoom: 0 }
const JULIA_C_INITIAL = { real: -0.7, imag: 0.27 }
const BUILTIN_MANDELBROT_KEY = 'builtin:mandelbrot:v1'

type MinimapCacheKey = string
// Future arbitrary equations can use keys like `custom:<expression-hash>:v1`;
// built-ins keep stable keys so overview caches survive ordinary navigation.

interface FrameOverviewMeta {
  cacheKey: MinimapCacheKey
  view: ViewState
}

interface CachedOverview extends FrameOverviewMeta {
  canvas: HTMLCanvasElement
}

export default function App() {
  const [mode, setMode] = useState<Mode>('performance')
  const modeRef = useRef(mode)
  modeRef.current = mode
  const [debugOpen, setDebugOpen] = useState(false)
  const [workloadOpen, setWorkloadOpen] = useState(false)
  const [debugFlags, setDebugFlags] = useState<DebugFlags>(DEFAULT_DEBUG_FLAGS)
  const { handle: fps, rates: fpsRates } = useFpsCounters()
  const workload = useWorkloadTelemetry()
  const paintersRef = useRef<Partial<Record<Panel, ChunkPainter>>>({})
  // Bumped on every set_view so server can drop stale chunk frames.
  const seqRef = useRef(0)
  // Julia tracks the c implied by the Mandelbrot centre.
  const juliaCRef = useRef(JULIA_C_INITIAL)
  const mandelbrotFrameMetaRef = useRef<Map<number, FrameOverviewMeta>>(new Map())
  const juliaFrameMetaRef = useRef<Map<number, FrameOverviewMeta>>(new Map())
  const lastSentJuliaMetaRef = useRef<FrameOverviewMeta>({
    cacheKey: juliaCacheKey(JULIA_C_INITIAL),
    view: JULIA_INITIAL,
  })
  const mandelbrotOverviewRef = useRef<CachedOverview | null>(null)
  const juliaOverviewRef = useRef<CachedOverview | null>(null)
  const [mandelbrotMinimapView, setMandelbrotMinimapView] =
    useState<ViewState>(MANDELBROT_INITIAL)
  const [juliaMinimapView, setJuliaMinimapView] =
    useState<ViewState>(JULIA_INITIAL)

  // Stable lookup the worker dispatcher uses to route bitmaps to the
  // right painter once the worker has finished decoding them.
  const getPainter = useCallback(
    (panel: Panel) => paintersRef.current[panel],
    [],
  )
  const chunkWorker = useChunkWorker(getPainter)

  // Hot path now does the absolute minimum on the main thread: hand
  // the payload to the worker as a transferable. Unpack + decode +
  // bitmap creation all happen off-thread.
  const handleChunk = useCallback(
    (chunk: ChunkFrame) => chunkWorker.enqueue(chunk),
    [chunkWorker],
  )

  const { state, send } = useRenderSocket(
    WS_URL,
    handleChunk,
    workload.handleTelemetry,
  )
  const sendRef = useRef(send)
  sendRef.current = send

  const nextSeq = useCallback(() => {
    seqRef.current = (seqRef.current + 1) & 0xffff
    return seqRef.current
  }, [])

  const rememberFrameMeta = useCallback((
    map: React.MutableRefObject<Map<number, FrameOverviewMeta>>,
    seq: number,
    meta: FrameOverviewMeta,
  ) => {
    const frames = map.current
    frames.set(seq, meta)
    if (frames.size > 128) {
      const oldest = frames.keys().next().value
      if (oldest !== undefined) frames.delete(oldest)
    }
  }, [])

  const ensureOverview = useCallback((
    ref: React.MutableRefObject<CachedOverview | null>,
    meta: FrameOverviewMeta,
  ) => {
    let overview = ref.current
    if (!overview || overview.cacheKey !== meta.cacheKey) {
      const canvas = document.createElement('canvas')
      canvas.width = IMAGE_PX
      canvas.height = IMAGE_PX
      overview = { ...meta, canvas }
      ref.current = overview
    } else {
      overview.view = meta.view
    }
    return overview
  }, [])

  const commitMandelbrot = useCallback(
    (next: ViewState, interaction: InteractionPhase = 'idle') => {
      const panChanged =
        next.panX !== juliaCRef.current.real ||
        next.panY !== juliaCRef.current.imag
      if (panChanged) {
        juliaCRef.current = { real: next.panX, imag: next.panY }
      }
      const seq = nextSeq()
      const mandelbrotMeta = {
        cacheKey: BUILTIN_MANDELBROT_KEY,
        view: next,
      }
      rememberFrameMeta(mandelbrotFrameMetaRef, seq, mandelbrotMeta)
      fps.noteRender(seq, Panel.MandelbrotMain)
      if (panChanged) {
        const juliaMeta = {
          cacheKey: juliaCacheKey(juliaCRef.current),
          view: lastSentJuliaMetaRef.current.view,
        }
        lastSentJuliaMetaRef.current = juliaMeta
        rememberFrameMeta(juliaFrameMetaRef, seq, juliaMeta)
        fps.noteRender(seq, Panel.JuliaMain)
      }
      sendRef.current({
        type: 'set_view',
        panel_id: Panel.MandelbrotMain,
        frame_seq: seq,
        pan_x: next.panX,
        pan_y: next.panY,
        zoom: next.zoom,
        fractal_type: 'mandelbrot',
        max_iter: maxIterFor(next.zoom, interaction, modeRef.current),
        quality: qualityFor(interaction, modeRef.current),
        interaction,
      })
    },
    [nextSeq, fps, rememberFrameMeta],
  )

  const commitJulia = useCallback(
    (next: ViewState, interaction: InteractionPhase = 'idle') => {
      const seq = nextSeq()
      const juliaMeta = {
        cacheKey: juliaCacheKey(juliaCRef.current),
        view: next,
      }
      lastSentJuliaMetaRef.current = juliaMeta
      rememberFrameMeta(juliaFrameMetaRef, seq, juliaMeta)
      fps.noteRender(seq, Panel.JuliaMain)
      sendRef.current({
        type: 'set_view',
        panel_id: Panel.JuliaMain,
        frame_seq: seq,
        pan_x: next.panX,
        pan_y: next.panY,
        zoom: next.zoom,
        fractal_type: 'julia',
        julia_c_real: juliaCRef.current.real,
        julia_c_imag: juliaCRef.current.imag,
        max_iter: maxIterFor(next.zoom, interaction, modeRef.current),
        quality: qualityFor(interaction, modeRef.current),
        interaction,
      })
    },
    [nextSeq, fps, rememberFrameMeta],
  )

  // Both modes stream mid-drag; backpressure inside useViewState gates
  // requests so the server never queues more than one render. Each
  // request carries an interaction phase so Performance mode can give
  // the active surface first refusal while still letting Julia fill
  // renderer bubbles between Mandelbrot frames.
  const mandelbrotView = useViewState(MANDELBROT_INITIAL, commitMandelbrot, true)
  const juliaView = useViewState(JULIA_INITIAL, commitJulia, true)

  // Fire initial views once the socket is open.
  useEffect(() => {
    if (state !== 'open') return
    commitMandelbrot(MANDELBROT_INITIAL)
    commitJulia(JULIA_INITIAL)
  }, [state, commitMandelbrot, commitJulia])

  useEffect(() => {
    if (state !== 'open' || debugFlags.minimaps) return
    sendRef.current({
      type: 'set_minimaps',
      enabled: false,
      frame_seq: nextSeq(),
    })
  }, [state, debugFlags.minimaps, nextSeq])

  useEffect(() => {
    if (state !== 'open') return
    sendRef.current({
      type: 'set_telemetry',
      enabled: workloadOpen,
    })
  }, [state, workloadOpen])

  const onModeChange = (next: Mode) => {
    setMode(next)
    sendRef.current({ type: 'set_mode', mode: next })
  }

  const onDebugFlagsChange = (next: DebugFlags) => {
    if (next.minimaps !== debugFlags.minimaps) {
      sendRef.current({
        type: 'set_minimaps',
        enabled: next.minimaps,
        frame_seq: nextSeq(),
      })
    }
    setDebugFlags(next)
  }

  // Frame-applied callbacks pipe through fps.notePaint so the overlay
  // can show the actual render-completion rate and request→display lat.
  const onMandelFrame = useCallback(
    (seq: number) => {
      fps.notePaint(seq, Panel.MandelbrotMain)
      mandelbrotView.notifyFrameApplied()
      const rendered = consumeFrameMeta(mandelbrotFrameMetaRef, seq)
      if (rendered && isMandelbrotOverviewView(rendered.view)) {
        captureOverview(
          paintersRef,
          Panel.MandelbrotMain,
          Panel.MandelbrotMini,
          mandelbrotOverviewRef,
          rendered,
          setMandelbrotMinimapView,
          ensureOverview,
        )
      }
    },
    [fps, mandelbrotView.notifyFrameApplied, ensureOverview],
  )
  const syncMandelbrotMinimap = useCallback(() => {
    const overview = mandelbrotOverviewRef.current
    const mini = paintersRef.current[Panel.MandelbrotMini]
    if (overview && mini) {
      mini.copyFrom(overview.canvas)
    }
  }, [])
  const syncJuliaMinimap = useCallback(() => {
    const overview = juliaOverviewRef.current
    const mini = paintersRef.current[Panel.JuliaMini]
    if (overview && mini) {
      mini.copyFrom(overview.canvas)
    }
  }, [])
  const onJuliaFrame = useCallback(
    (seq: number) => {
      fps.notePaint(seq, Panel.JuliaMain)
      juliaView.notifyFrameApplied()
      const rendered =
        consumeFrameMeta(juliaFrameMetaRef, seq) ?? lastSentJuliaMetaRef.current
      if (rendered && isZoomedOutView(rendered.view)) {
        captureOverview(
          paintersRef,
          Panel.JuliaMain,
          Panel.JuliaMini,
          juliaOverviewRef,
          rendered,
          setJuliaMinimapView,
          ensureOverview,
        )
      }
    },
    [fps, juliaView.notifyFrameApplied, ensureOverview],
  )

  // Stable ref callbacks — without `useMemo`, every App re-render (e.g. mode
  // toggle, view-state change) would hand React new function identities and
  // remount each canvas, wiping the painter state and flashing the canvas.
  const registerMandelbrotMain = useMemo(
    () => mergeRefs(
      makeRegister(paintersRef, Panel.MandelbrotMain, onMandelFrame),
      mandelbrotView.canvasRef,
    ),
    [mandelbrotView.canvasRef, onMandelFrame],
  )
  const registerJuliaMain = useMemo(
    () => mergeRefs(
      makeRegister(paintersRef, Panel.JuliaMain, onJuliaFrame),
      juliaView.canvasRef,
    ),
    [juliaView.canvasRef, onJuliaFrame],
  )
  const registerMandelbrotMini = useMemo(
    () => makeRegister(paintersRef, Panel.MandelbrotMini, null, syncMandelbrotMinimap),
    [syncMandelbrotMinimap],
  )
  const registerJuliaMini = useMemo(
    () => makeRegister(paintersRef, Panel.JuliaMini, null, syncJuliaMinimap),
    [syncJuliaMinimap],
  )

  return (
    <div className="app">
      <header className="header">
        <div className="header-title">
          <h1>
            Pynq<em>Zoom</em>
          </h1>
        </div>
        <div
          className={`mode-toggle mode-toggle-${mode}`}
          role="tablist"
          aria-label="Render mode"
        >
          <span className="mode-toggle-indicator" aria-hidden="true" />
          <button
            className={mode === 'performance' ? 'active' : ''}
            onClick={() => onModeChange('performance')}
            role="tab"
            aria-selected={mode === 'performance'}
          >
            Performance
          </button>
          <button
            className={mode === 'live_evolution' ? 'active' : ''}
            onClick={() => onModeChange('live_evolution')}
            role="tab"
            aria-selected={mode === 'live_evolution'}
          >
            Live Evolution
          </button>
        </div>
        <span className="header-meta">
          <span className={`status status-${state}`}>{state}</span>
          <span className="sep">/</span>
          v0.1
        </span>
      </header>

      <main className="viewports">
        <Viewport
          name="Mandelbrot"
          view={mandelbrotView.view}
          bind={mandelbrotView.bind}
          showCrosshair
          canvasRef={registerMandelbrotMain}
          minimapCanvasRef={registerMandelbrotMini}
          minimapView={mandelbrotMinimapView}
          showMinimap={debugFlags.minimaps}
          formatCoord={formatMandelbrotCoord}
        />
        <Viewport
          name="Julia"
          view={juliaView.view}
          bind={juliaView.bind}
          canvasRef={registerJuliaMain}
          minimapCanvasRef={registerJuliaMini}
          minimapView={juliaMinimapView}
          showMinimap={debugFlags.minimaps}
          formatCoord={(v) =>
            `c = ${formatNumber(juliaCRef.current.real)} + ${formatNumber(juliaCRef.current.imag)}i  ·  ×${zoomLabel(v.zoom)}`
          }
        />

        <button
          className="settings-btn"
          aria-label="Debug"
          onClick={() => setDebugOpen((x) => !x)}
        >
          <Cog />
        </button>

        {debugFlags.fpsOverlay && <FpsOverlay rates={fpsRates} />}

        <FloatingWorkloadPanel
          open={workloadOpen}
          onOpen={() => setWorkloadOpen(true)}
          onClose={() => setWorkloadOpen(false)}
          snapshot={workload.snapshot}
        />
      </main>

      <DebugPanel
        open={debugOpen}
        onClose={() => setDebugOpen(false)}
        flags={debugFlags}
        onChange={onDebugFlagsChange}
      />
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
  paintersRef: React.MutableRefObject<Partial<Record<Panel, ChunkPainter>>>,
  panel: Panel,
  onFrameComplete: ((seq: number) => void) | null = null,
  onReady: (() => void) | null = null,
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
      onReady?.()
      return
    }
    const painter = new ChunkPainter(canvas)
    painter.onFrameComplete = onFrameComplete
    painter.clear()
    paintersRef.current[panel] = painter
    onReady?.()
  }
}

function Viewport({
  name,
  view,
  bind,
  showCrosshair = false,
  canvasRef,
  minimapCanvasRef,
  minimapView,
  showMinimapViewRect = true,
  showMinimap,
  formatCoord,
}: {
  name: string
  view: ViewState
  bind: ReturnType<typeof useViewState>['bind']
  showCrosshair?: boolean
  canvasRef: (canvas: HTMLCanvasElement | null) => void
  minimapCanvasRef: (canvas: HTMLCanvasElement | null) => void
  minimapView: ViewState
  showMinimapViewRect?: boolean
  showMinimap: boolean
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
      {showMinimap && (
        <div className="minimap" role="img" aria-label={`${name} minimap`}>
          <canvas
            className="minimap-canvas"
            width={IMAGE_PX}
            height={IMAGE_PX}
            ref={minimapCanvasRef}
          />
          {showMinimapViewRect && (
            <div
              className="minimap-viewrect"
              style={viewRectStyle(view, minimapView)}
            />
          )}
          <span className="minimap-label">{name}</span>
        </div>
      )}
    </section>
  )
}

function viewRectStyle(
  view: ViewState,
  minimapView: ViewState,
): React.CSSProperties {
  // The viewrect represents the visible region at the current zoom/pan
  // inside the cached overview image shown by the minimap.
  const minimapWindow = 4.0 / Math.pow(2, minimapView.zoom)
  const visibleWindow = 4.0 / Math.pow(2, view.zoom)
  const size = (visibleWindow / minimapWindow) * 100
  const left =
    50 + ((view.panX - minimapView.panX) / minimapWindow) * 100 - size / 2
  const top =
    50 + ((view.panY - minimapView.panY) / minimapWindow) * 100 - size / 2
  return {
    left: `${left}%`,
    top: `${top}%`,
    width: `${size}%`,
    height: `${size}%`,
  }
}

function consumeFrameMeta(
  map: React.MutableRefObject<Map<number, FrameOverviewMeta>>,
  seq: number,
): FrameOverviewMeta | undefined {
  const meta = map.current.get(seq)
  map.current.delete(seq)
  return meta
}

function captureOverview(
  paintersRef: React.MutableRefObject<Partial<Record<Panel, ChunkPainter>>>,
  sourcePanel: Panel,
  minimapPanel: Panel,
  overviewRef: React.MutableRefObject<CachedOverview | null>,
  meta: FrameOverviewMeta,
  setMinimapView: (view: ViewState) => void,
  ensureOverview: (
    ref: React.MutableRefObject<CachedOverview | null>,
    meta: FrameOverviewMeta,
  ) => CachedOverview,
): void {
  const source = paintersRef.current[sourcePanel]
  if (!source) return
  const overview = ensureOverview(overviewRef, meta)
  const ctx = overview.canvas.getContext('2d', { alpha: false })
  if (!ctx) return
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(source.canvas, 0, 0, IMAGE_PX, IMAGE_PX)
  setMinimapView(meta.view)
  const mini = paintersRef.current[minimapPanel]
  if (mini) {
    mini.copyFrom(overview.canvas)
  }
}

function isMandelbrotOverviewView(view: ViewState): boolean {
  return view.zoom === MANDELBROT_INITIAL.zoom
    && view.panX === MANDELBROT_INITIAL.panX
    && view.panY === MANDELBROT_INITIAL.panY
}

function isZoomedOutView(view: ViewState): boolean {
  return view.zoom === 0
}

function juliaCacheKey(c: { real: number; imag: number }): MinimapCacheKey {
  return `builtin:julia:c=${cacheNumber(c.real)},${cacheNumber(c.imag)}:v1`
}

function cacheNumber(n: number): string {
  return Number.isFinite(n) ? n.toPrecision(12) : String(n)
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
function maxIterFor(
  zoom: number,
  interaction: InteractionPhase = 'idle',
  mode: Mode = 'live_evolution',
): number {
  const full = Math.min(1500, 64 + zoom * 96)
  if (mode !== 'performance' || interaction !== 'active') return full
  return Math.min(full, 512, 48 + zoom * 40)
}

function qualityFor(
  interaction: InteractionPhase,
  mode: Mode,
): Quality {
  return mode === 'performance' && interaction === 'active'
    ? 'preview'
    : 'full'
}

function Cog() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
  )
}
