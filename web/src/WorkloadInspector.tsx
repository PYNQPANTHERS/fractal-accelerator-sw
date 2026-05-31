import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { useCallback, useRef, useState } from 'react'
import { Panel, type Quality, type TelemetryMessage } from './protocol'

type LaneStatus = 'idle' | 'pending' | 'rendering' | 'complete' | 'dropped'

interface TileProgress {
  elapsedMs: number
  order: number
  stage: string
}

interface PanelWorkload {
  panel: Panel
  label: string
  status: LaneStatus
  frameSeq: number | null
  pendingFrameSeq: number | null
  quality: Quality | null
  backend: string | null
  maxIter: number | null
  tileCols: number
  tileRows: number
  tiles: Record<number, TileProgress>
  lastFrameMs: number | null
  dropped: number
}

export interface WorkloadSnapshot {
  mode: 'performance' | 'live_evolution'
  activePanel: Panel
  interactingPanel: Panel | null
  pendingCount: number
  lanes: Record<Panel, PanelWorkload>
}

const PANEL_ORDER = [
  Panel.MandelbrotMain,
  Panel.JuliaMain,
] as const

const ALL_PANELS = [
  Panel.MandelbrotMain,
  Panel.JuliaMain,
  Panel.MandelbrotMini,
  Panel.JuliaMini,
] as const

const PANEL_LABEL: Record<Panel, string> = {
  [Panel.MandelbrotMain]: 'Mandelbrot',
  [Panel.JuliaMain]: 'Julia',
  [Panel.MandelbrotMini]: 'Mandel mini',
  [Panel.JuliaMini]: 'Julia mini',
}

const RENDER_CHUNK_PX = 256
const RTL_TILE_PX = 16
const RTL_TILES_PER_CHUNK_SIDE = RENDER_CHUNK_PX / RTL_TILE_PX

export function useWorkloadTelemetry() {
  const [snapshot, setSnapshot] = useState<WorkloadSnapshot>(() => ({
    mode: 'performance',
    activePanel: Panel.MandelbrotMain,
    interactingPanel: null,
    pendingCount: 0,
    lanes: makeInitialLanes(),
  }))

  const handleTelemetry = useCallback((msg: TelemetryMessage) => {
    setSnapshot((current) => applyTelemetry(current, msg))
  }, [])

  return { snapshot, handleTelemetry }
}

export function WorkloadInspector({
  snapshot,
}: {
  snapshot: WorkloadSnapshot
}) {
  return (
    <div className="workload">
      <div className="workload-summary">
        <Metric label="Mode" value={modeLabel(snapshot.mode)} />
        <Metric
          label="Active"
          value={PANEL_LABEL[snapshot.activePanel] ?? 'Unknown'}
        />
        <Metric label="Pending" value={String(snapshot.pendingCount)} />
      </div>

      <div className="workload-lanes">
        {PANEL_ORDER.map((panel) => (
          <WorkloadLane
            key={panel}
            lane={snapshot.lanes[panel]}
            active={snapshot.activePanel === panel}
          />
        ))}
      </div>

      <p className="workload-note">
        Sim telemetry reports 256 px render chunks. FPGA telemetry can report
        the 16 px RTL tile_done / transfer-complete grid directly.
      </p>
    </div>
  )
}

export function FloatingWorkloadPanel({
  open,
  onOpen,
  onClose,
  snapshot,
}: {
  open: boolean
  onOpen: () => void
  onClose: () => void
  snapshot: WorkloadSnapshot
}) {
  const [collapsed, setCollapsed] = useState(false)
  const [position, setPosition] = useState({ x: 22, y: 86 })
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    originX: number
    originY: number
  } | null>(null)

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: position.x,
      originY: position.y,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    setPosition(
      clampPosition({
        x: drag.originX + event.clientX - drag.startX,
        y: drag.originY + event.clientY - drag.startY,
      }),
    )
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  if (!open) {
    return (
      <button
        className="workload-launcher"
        type="button"
        onClick={onOpen}
        aria-label="Open workload inspector"
      >
        <span>Workload Inspector</span>
      </button>
    )
  }

  return (
    <aside
      className={`workload-floating ${collapsed ? 'collapsed' : ''}`}
      style={{
        '--workload-x': `${position.x}px`,
        '--workload-y': `${position.y}px`,
      } as CSSProperties}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <header
        className="workload-floating-header"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div>
          <h2>Workload</h2>
          <span>{collapsed ? compactStatus(snapshot) : 'tile telemetry'}</span>
        </div>
        <div
          className="workload-floating-actions"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => setCollapsed((value) => !value)}
            aria-label={collapsed ? 'Expand workload inspector' : 'Collapse workload inspector'}
          >
            {collapsed ? '+' : '-'}
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close workload inspector"
          >
            x
          </button>
        </div>
      </header>

      {collapsed ? (
        <WorkloadMiniSummary snapshot={snapshot} />
      ) : (
        <WorkloadInspector snapshot={snapshot} />
      )}
    </aside>
  )
}

function WorkloadMiniSummary({ snapshot }: { snapshot: WorkloadSnapshot }) {
  const active = snapshot.lanes[snapshot.activePanel]
  const total = active.tileCols * active.tileRows
  const done = Object.keys(active.tiles).length
  const lastTileMs = latestTileMs(active)
  const grid = gridInfo(active)

  return (
    <div className="workload-mini">
      <Metric label="Active" value={PANEL_LABEL[snapshot.activePanel]} />
      <Metric label={grid.metricLabel} value={`${done}/${total}`} />
      <Metric
        label="Last"
        value={lastTileMs === null ? '-' : `${lastTileMs.toFixed(1)} ms`}
      />
      <Metric label="Pending" value={String(snapshot.pendingCount)} />
    </div>
  )
}

function WorkloadLane({
  lane,
  active,
}: {
  lane: PanelWorkload
  active: boolean
}) {
  const tileTotal = lane.tileCols * lane.tileRows
  const doneCount = Object.keys(lane.tiles).length
  const lastTileMs = latestTileMs(lane)
  const grid = gridInfo(lane)

  return (
    <div className={`workload-lane workload-lane-${lane.status}`}>
      <div className="workload-lane-header">
        <div>
          <span className="workload-lane-name">{lane.label}</span>
          <span className="workload-lane-meta">
            {lane.frameSeq === null ? 'seq -' : `seq ${lane.frameSeq}`}
            {' · '}
            {grid.meta}
          </span>
        </div>
        <div className="workload-badges">
          {active && <span className="workload-badge active">active</span>}
          {lane.pendingFrameSeq !== null && (
            <span className="workload-badge pending">pending</span>
          )}
          <span className={`workload-badge ${lane.status}`}>
            {lane.status}
          </span>
        </div>
      </div>

      <div className="workload-grid-caption">
        <span>{grid.title}</span>
        <span>{grid.map}</span>
      </div>

      <div
        className={`workload-tile-grid workload-tile-grid-${grid.kind}`}
        style={{ '--tile-cols': lane.tileCols } as CSSProperties}
      >
        {Array.from({ length: tileTotal }, (_, tileId) => {
          const tile = lane.tiles[tileId]
          const title = tile
            ? `${grid.cellLabel} ${tileId}: ${tile.elapsedMs.toFixed(2)} ms`
            : `${grid.cellLabel} ${tileId}`
          return (
            <span
              key={tileId}
              className={`workload-tile ${tile ? 'done' : ''}`}
              title={title}
            >
              {grid.showElapsedInCell && tile ? tile.elapsedMs.toFixed(1) : ''}
            </span>
          )
        })}
      </div>

      <div className="workload-lane-footer">
        <span>{lane.quality ?? '-'}</span>
        <span>{lane.backend ?? 'backend -'}</span>
        <span>
          {doneCount}/{tileTotal} {grid.countLabel}
        </span>
        <span>{lastTileMs === null ? '-' : `${lastTileMs.toFixed(1)} ms`}</span>
        <span>drop {lane.dropped}</span>
      </div>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="workload-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function applyTelemetry(
  current: WorkloadSnapshot,
  msg: TelemetryMessage,
): WorkloadSnapshot {
  if (msg.event === 'scheduler') {
    const pending = new Map(msg.pending.map((job) => [job.panel_id, job]))
    const lanes = cloneLanes(current.lanes)
    for (const panel of PANEL_ORDER) {
      const job = pending.get(panel)
      const lane = lanes[panel]
      const status = job
        ? lane.status === 'rendering' ? 'rendering' : 'pending'
        : lane.status === 'pending' ? 'idle' : lane.status
      lanes[panel] = {
        ...lane,
        status,
        pendingFrameSeq: job?.frame_seq ?? null,
        quality: job?.quality ?? lane.quality,
      }
    }
    return {
      ...current,
      mode: msg.mode,
      activePanel: msg.active_panel,
      interactingPanel: msg.interacting_panel,
      pendingCount: msg.pending.length,
      lanes,
    }
  }

  if (msg.event === 'render_started') {
    const lanes = cloneLanes(current.lanes)
    lanes[msg.panel_id] = {
      ...lanes[msg.panel_id],
      status: 'rendering',
      frameSeq: msg.frame_seq,
      pendingFrameSeq: null,
      quality: msg.quality,
      backend: msg.backend,
      maxIter: msg.max_iter,
      tileCols: msg.tile_cols,
      tileRows: msg.tile_rows,
      tiles: {},
    }
    return { ...current, lanes }
  }

  if (msg.event === 'tile_done') {
    const lanes = cloneLanes(current.lanes)
    const lane = lanes[msg.panel_id]
    const order = Object.keys(lane.tiles).length + 1
    lanes[msg.panel_id] = {
      ...lane,
      status: 'rendering',
      frameSeq: msg.frame_seq,
      quality: msg.quality,
      backend: msg.backend,
      tileCols: msg.tile_cols,
      tileRows: msg.tile_rows,
      tiles: {
        ...lane.tiles,
        [msg.tile_id]: {
          elapsedMs: msg.elapsed_ms,
          order,
          stage: msg.stage,
        },
      },
    }
    return { ...current, lanes }
  }

  if (msg.event === 'render_finished') {
    const lanes = cloneLanes(current.lanes)
    lanes[msg.panel_id] = {
      ...lanes[msg.panel_id],
      status: 'complete',
      frameSeq: msg.frame_seq,
      quality: msg.quality,
      backend: msg.backend,
      lastFrameMs: msg.elapsed_ms,
      pendingFrameSeq: null,
    }
    return { ...current, lanes }
  }

  if (msg.event === 'render_dropped') {
    const lanes = cloneLanes(current.lanes)
    lanes[msg.panel_id] = {
      ...lanes[msg.panel_id],
      status: 'dropped',
      frameSeq: msg.frame_seq,
      dropped: lanes[msg.panel_id].dropped + 1,
      pendingFrameSeq: null,
    }
    return { ...current, lanes }
  }

  if (msg.event === 'client_frame_dropped') {
    const lanes = cloneLanes(current.lanes)
    lanes[msg.panel_id] = {
      ...lanes[msg.panel_id],
      dropped: lanes[msg.panel_id].dropped + 1,
    }
    return { ...current, lanes }
  }

  return current
}

function makeInitialLanes(): Record<Panel, PanelWorkload> {
  return ALL_PANELS.reduce((lanes, panel) => {
    lanes[panel] = {
      panel,
      label: PANEL_LABEL[panel],
      status: 'idle',
      frameSeq: null,
      pendingFrameSeq: null,
      quality: null,
      backend: null,
      maxIter: null,
      tileCols: 4,
      tileRows: 4,
      tiles: {},
      lastFrameMs: null,
      dropped: 0,
    }
    return lanes
  }, {} as Record<Panel, PanelWorkload>)
}

function cloneLanes(
  lanes: Record<Panel, PanelWorkload>,
): Record<Panel, PanelWorkload> {
  return { ...lanes }
}

function latestTileMs(lane: PanelWorkload): number | null {
  let latest: TileProgress | null = null
  for (const tile of Object.values(lane.tiles)) {
    if (!latest || tile.order > latest.order) latest = tile
  }
  return latest?.elapsedMs ?? null
}

function gridInfo(lane: PanelWorkload) {
  if (lane.tileCols === 4 && lane.tileRows === 4) {
    return {
      kind: 'render-chunk',
      title: '4 x 4 render chunks',
      meta: `${RENDER_CHUNK_PX} px chunks`,
      map: `${RTL_TILES_PER_CHUNK_SIDE} x ${RTL_TILES_PER_CHUNK_SIDE} RTL tiles per chunk`,
      cellLabel: 'chunk',
      countLabel: 'chunks',
      metricLabel: 'Chunks',
      showElapsedInCell: true,
    }
  }

  if (lane.tileCols === 16 && lane.tileRows === 16) {
    return {
      kind: 'rtl-tile',
      title: '16 x 16 RTL tiles',
      meta: `${RTL_TILE_PX} px RTL tiles`,
      map: `one ${RENDER_CHUNK_PX} px sixteenth`,
      cellLabel: 'rtl tile',
      countLabel: 'rtl tiles',
      metricLabel: 'RTL tiles',
      showElapsedInCell: false,
    }
  }

  return {
    kind: 'generic',
    title: `${lane.tileCols} x ${lane.tileRows} telemetry cells`,
    meta: `${lane.tileCols} x ${lane.tileRows} cells`,
    map: 'backend-defined grid',
    cellLabel: 'cell',
    countLabel: 'cells',
    metricLabel: 'Cells',
    showElapsedInCell: lane.tileCols * lane.tileRows <= 16,
  }
}

function clampPosition(position: { x: number; y: number }): { x: number; y: number } {
  const maxX = Math.max(0, window.innerWidth - 340)
  const maxY = Math.max(0, window.innerHeight - 118)
  return {
    x: Math.min(Math.max(8, position.x), maxX),
    y: Math.min(Math.max(58, position.y), maxY),
  }
}

function compactStatus(snapshot: WorkloadSnapshot): string {
  const active = snapshot.lanes[snapshot.activePanel]
  const total = active.tileCols * active.tileRows
  const done = Object.keys(active.tiles).length
  const grid = gridInfo(active)
  return `${PANEL_LABEL[snapshot.activePanel]} ${done}/${total} ${grid.countLabel}`
}

function modeLabel(mode: WorkloadSnapshot['mode']): string {
  return mode === 'live_evolution' ? 'Live' : 'Performance'
}
