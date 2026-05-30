# Optimisations log

Current performance and UX decisions in the software stack. This is written as
a practical rollback map: what exists, why it exists, and whether it should be
kept when the backend changes from the simulator to the FPGA driver.

Last updated: 2026-05-30.

## Current Render Shape

- **4 x 4 tile grid**: 16 tiles per render, each 256 x 256, giving a 1024 x 1024
  image.
- **No active prefetch margin**: 5x5, 6x6, and 7x7 margin experiments were
  tried and rolled back because extra tile work lowered the frame ceiling and
  increased visible jitter.
- **No active predictive prefetch**: the hook is still guarded in code, but it
  is disabled while `CANVAS_MARGIN_FRAC` is zero. With no rendered margin,
  prediction can expose unrendered edges instead of hiding them.
- **Nibble-packed output**: each pixel is a 4-bit palette index, two pixels per
  byte. A tile payload is 32 KB.
- **FPGA-friendly config**: `RenderConfig` mirrors the intended PL register
  shape: pan, zoom, fractal type, Julia c, max iteration budget, and preview
  flag.

## C++ Simulator

### Parallel Tile Rendering

- **Where**: `sim/cpp/src/main.cpp`
- **What**: `render_image` launches one worker per tile and streams tile frames
  back to Python as workers complete.
- **Why**: It mimics the hardware model: independent tile/sixteenth workers
  complete in their own order, then the PS side serialises results.
- **Status**: **Load-bearing**. It gives realistic tile-completion telemetry and
  keeps the simulator useful for frontend and scheduler work.

### Completion-Order Streaming

- **Where**: `sim/cpp/src/main.cpp`, `sim/renderer.py`
- **What**: Python yields `(tile_id, payload, elapsed_ms)` as each simulator
  tile frame is received.
- **Why**: The Workload Inspector can show real "tile completed at 3.2 ms"
  style timings now, and the same interface maps cleanly to future PL
  `tile_done` / transfer-complete events.
- **Status**: **Load-bearing for FPGA readiness**.

### Mariani-Silver Full-Quality Path

- **Where**: `sim/cpp/src/mariani_silver.hpp`, `sim/cpp/src/main.cpp`
- **What**: Full-quality renders use adaptive subdivision to skip uniform
  regions.
- **Why**: Large in-set and far-exterior areas do not need per-pixel iteration.
- **Status**: **Keep**. This is both a simulator optimisation and a useful model
  for the hardware-side optimisation story.

### Preview Kernel

- **Where**: `sim/cpp/src/iterate.cpp`
- **What**: Computes one pixel per 2 x 2 block and broadcasts the band.
- **Why**: Performance mode can make active pan/zoom frames cheaper without
  changing the wire format.
- **Status**: **Load-bearing for Performance mode**. The settled frame is
  re-requested at full quality.

### Log-Banded Palette Mapping

- **Where**: `sim/cpp/src/iterate.cpp`
- **What**: Escape counts are remapped to 16 bands with a log curve.
- **Why**: Fixed linear buckets flatten deep zooms into a tiny number of visible
  bands.
- **Status**: **Keep**.

## Python Server / PS Scheduler

### Single-Slot Per-Panel Scheduler

- **Where**: `server/scheduler.py`
- **What**: Each panel has one pending job. New pushes overwrite stale pending
  work.
- **Why**: Pointermove can produce more views than the backend can render; the
  latest view is the only one worth keeping.
- **Status**: **Load-bearing** and directly FPGA-friendly.

### Explicit Interaction State

- **Where**: `web/src/useViewState.ts`, `server/protocol.py`,
  `server/scheduler.py`
- **What**: Requests carry `interaction: "active" | "final" | "idle"`.
- **Why**: The PS side does not infer interaction state from silence; it knows
  when the user is actively navigating and when a settled full-quality render is
  required.
- **Status**: **Load-bearing**.

### Performance vs Live Evolution

- **Where**: `server/scheduler.py`
- **What**: Performance mode picks the active main panel first, then the other
  main panel, then minimaps. Live Evolution alternates the two main panels.
- **Why**: Performance mode should give Mandelbrot or Julia navigation first
  refusal; Live Evolution is for seeing both panels update together.
- **Status**: **Keep**. Scheduling alone does not make frames cheaper, so the
  main FPS gain comes from active-preview work, not from starving Julia.

### Julia Coupling Without Stealing Activity

- **Where**: `server/main.py`, `server/scheduler.py`
- **What**: Mandelbrot pan changes queue a Julia render with `mark_active=False`.
- **Why**: The system-derived Julia job must not steal active-panel status from
  the panel the user is actually dragging.
- **Status**: **Load-bearing**.

### Skip Waste on Pure Zoom

- **Where**: `server/main.py`
- **What**: Pure Mandelbrot zoom does not re-render Julia just because the
  Mandelbrot viewport changed; Julia only needs a new `c`.
- **Why**: Avoids duplicate Julia work during centre-anchored zoom.
- **Status**: **Load-bearing**.

### Optional Real Minimap Jobs

- **Where**: `server/main.py`, `web/src/DebugPanel.tsx`
- **What**: Minimaps are genuine low-priority render jobs and can be toggled
  off.
- **Why**: A minimap is a different camera, so reusing main-panel pixels would
  be wrong except at matching zoom/pan. The toggle gives a clean benchmark path
  with no minimap load.
- **Status**: **Keep**.

### Telemetry Only When Needed

- **Where**: `server/main.py`, `web/src/WorkloadInspector.tsx`
- **What**: `set_telemetry` turns scheduler/tile/render JSON events on only
  while the floating Workload Inspector is open.
- **Why**: The normal render path should not pay debug overhead.
- **Status**: **Keep**.

### Bundled Binary Tile Sends

- **Where**: `server/protocol.py`, `server/main.py`,
  `web/src/protocol.ts`
- **What**: The server collects the 16 tile payloads for one render and sends
  one binary WebSocket bundle.
- **Why**: Reduces per-`ws.send` overhead while preserving per-tile timing via
  optional telemetry.
- **Status**: **Load-bearing for browser throughput**.

### WebSocket Send Backpressure

- **Where**: `server/main.py`
- **What**: If the browser send buffer is already too large, the current render
  is dropped and a telemetry event explains why.
- **Why**: Better to drop stale output than queue hundreds of KB behind the
  user's current view.
- **Status**: **Keep**.

## Browser Frontend

### CSS Transform Pan Preview

- **Where**: `web/src/useViewState.ts`
- **What**: During drag the canvas is moved with `transform: translate(...)`
  immediately, without waiting for new tiles.
- **Why**: Pointer feedback stays responsive even when render latency is above a
  display frame.
- **Status**: **Load-bearing**.

### Direct DOM Writes in the Hot Path

- **Where**: `web/src/useViewState.ts`
- **What**: Transform updates write directly to the canvas element instead of
  going through React state.
- **Why**: Keeps high-rate pointer movement from causing React reconciliation
  jitter.
- **Status**: **Load-bearing**.

### Client Backpressure and Last-Write-Wins Pending View

- **Where**: `web/src/useViewState.ts`
- **What**: At most one render is in flight for an interaction. If the user
  moves again, the pending view is overwritten with the newest one.
- **Why**: Avoids latency buildup and matches the PS scheduler's coalescing
  behaviour.
- **Status**: **Load-bearing**.

### Active Preview + Final Full Render

- **Where**: `web/src/App.tsx`, `web/src/useViewState.ts`
- **What**: In Performance mode, active pan/zoom sends `quality: "preview"` and
  a reduced `max_iter`; release or wheel-settle sends `quality: "full"`.
- **Why**: This is the real Performance-mode FPS lever: make active frames
  cheaper, then clean them up when the view settles.
- **Status**: **Load-bearing**.

### Wheel Zoom Debounce

- **Where**: `web/src/useViewState.ts`
- **What**: Wheel steps render active preview frames immediately, then a full
  render after 140 ms without wheel input.
- **Why**: Zoom gets the same latency/quality split as pan.
- **Status**: **Keep**.

### Frame Sequence Dropping

- **Where**: `web/src/useRenderSocket.ts`
- **What**: Older `frame_seq` bundles are dropped per panel, with wrap-aware
  u16 comparison.
- **Why**: Prevents late stale renders from painting over the current view.
- **Status**: **Load-bearing**.

### Worker-Based Tile Decode

- **Where**: `web/src/tileWorker.ts`, `web/src/useTileWorker.ts`
- **What**: Nibble unpacking, RGBA expansion, and `ImageBitmap` creation happen
  in a Web Worker.
- **Why**: The main thread only blits ready bitmaps, which protects pan and
  zoom smoothness.
- **Status**: **Load-bearing**.

### Double-Buffered Painter

- **Where**: `web/src/tilePainter.ts`
- **What**: Tiles draw into an off-screen staging canvas. The visible canvas is
  swapped only when all 16 tiles for the frame are ready.
- **Why**: Avoids half-old / half-new patchwork during tile arrival.
- **Status**: **Load-bearing**.

### Stable Canvas Registration

- **Where**: `web/src/App.tsx`
- **What**: Canvas ref callbacks are memoised and the painter ignores repeated
  registration of the same DOM node.
- **Why**: Prevents React re-renders from remounting canvases and causing black
  flashes.
- **Status**: **Load-bearing**.

### Floating Workload Inspector

- **Where**: `web/src/WorkloadInspector.tsx`
- **What**: A draggable floating panel shows only the two main panels, with a
  compact collapsed summary and a 4 x 4 tile grid per lane.
- **Why**: Lets us inspect scheduling and tile completion while still panning
  and zooming the main UI.
- **Status**: **Keep**. This is a differentiating frontend feature and maps
  directly to future `tile_id` + `tile_done` PL status.

## Tried and Rolled Back

- **5x5 / 6x6 / 7x7 render margins**: more pixels to pan into, but much more
  backend work. In practice this lowered FPS and increased jitter.
- **Predictive prefetch**: promising with a rendered margin, but with the
  current 4x4 no-margin shape it can expose unrendered edges and make swaps
  feel jumpy.
- **Long Performance-mode defer**: delaying Julia by a fixed idle window made
  Performance feel worse. The better policy is active-panel priority plus
  cheaper active renders.
- **Full-quality only during active navigation**: clean image, but lower FPS
  ceiling. Current Performance mode uses preview for active interaction and full
  quality for the settled frame.
- **Treating minimaps as reused main data**: rejected because minimaps are
  different cameras. They are real jobs, but optional.

## Benchmark Plan

The simulator is useful because it gives a CPU baseline before the FPGA path is
ready. Benchmarks should replay the same pan/zoom traces through both backends
and record:

- main-panel FPS and p95 request-to-display latency
- active preview latency vs final full-quality latency
- dropped stale frames and browser-backpressure drops
- tile completion order and per-tile elapsed time
- minimaps on vs off
- Performance mode vs Live Evolution
- simulator backend vs FPGA backend once PL is connected

For the FPGA backend, the Workload Inspector telemetry should be fed from the
PS driver after it observes `tile_id` plus a `tile_done` or transfer-complete
status bit. The frontend does not need a redesign for that; only the backend
telemetry source changes.
