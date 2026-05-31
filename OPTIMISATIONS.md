# Optimisations log

Current performance and UX decisions in the software stack. This is written as
a practical rollback map: what exists, why it exists, and whether it should be
kept when the backend changes from the simulator to the FPGA driver.

Last updated: 2026-05-30.

## Current Render Shape

- **Single simulator backend**: the app/server path uses one simulator binary,
  `sim/cpp/build/fractal_sim`, via `sim/renderer.py`.
- **Mariani-Silver full-quality path**: normal settled renders use the
  Mariani-Silver adaptive renderer, matching the intended FPGA algorithm in
  `fractal-accelerator-rtl`.
- **Preview is an in-simulator shortcut**: active Performance-mode pan/zoom can
  request a subsampled preview kernel from the same simulator. It is not a
  second simulator implementation.
- **4 x 4 browser chunk grid**: 16 chunks per render, each 256 x 256, giving a
  1024 x 1024 image. The FPGA path can report finer 16 x 16 RTL microtile telemetry
  without changing this image protocol.
- **No active prefetch margin**: 5x5, 6x6, and 7x7 margin experiments were
  tried and rolled back because extra chunk work lowered the frame ceiling and
  increased visible jitter.
- **No active predictive prefetch**: the hook is still guarded in code, but it
  is disabled while `CANVAS_MARGIN_FRAC` is zero. With no rendered margin,
  prediction can expose unrendered edges instead of hiding them.
- **Nibble-packed output**: each pixel is a 4-bit palette index, two pixels per
  byte. A 256 x 256 browser chunk payload is 32 KB.
- **FPGA-friendly config**: `RenderConfig` mirrors the intended PL register
  shape: pan, zoom, fractal type, Julia c, max iteration budget, and preview
  flag.

## C++ Simulator

### Parallel Chunk Rendering

- **Where**: `sim/cpp/src/main.cpp`
- **What**: `render_image` launches one worker per browser chunk and streams
  chunk frames back to Python as workers complete.
- **Why**: It mimics the hardware model: independent chunk/sixteenth workers
  complete in their own order, then the PS side serialises results.
- **Status**: **Load-bearing**. It gives realistic chunk-completion telemetry and
  keeps the simulator useful for frontend and scheduler work.

### Completion-Order Streaming

- **Where**: `sim/cpp/src/main.cpp`, `sim/renderer.py`
- **What**: Python yields `(chunk_id, payload, elapsed_ms)` as each simulator
  chunk frame is received.
- **Why**: The Workload Inspector can show real "chunk completed at 3.2 ms"
  style timings now. Future FPGA runs can also feed finer `microtile_done` /
  transfer-complete telemetry on the separate debug path.
- **Status**: **Load-bearing for FPGA readiness**.

### Mariani-Silver Full-Quality Path

- **Where**: `sim/cpp/src/mariani_silver.hpp`, `sim/cpp/src/main.cpp`
- **What**: Full-quality renders use adaptive subdivision to skip uniform
  regions.
- **Why**: Large in-set and far-exterior areas do not need per-pixel iteration.
- **Status**: **Load-bearing**. This is the simulator's hardware-equivalent
  render path and should be the main comparison point for FPGA benchmarks.

### Preview Kernel

- **Where**: `sim/cpp/src/iterate.cpp`
- **What**: Computes one pixel per 2 x 2 block and broadcasts the band.
- **Why**: Performance mode can make active pan/zoom frames cheaper without
  changing the wire format.
- **Status**: **Load-bearing for Performance mode**, but it is an interaction
  shortcut inside the same simulator, not a separate simulator and not the main
  full-quality FPGA-equivalent path. The settled frame is re-requested at full
  quality.

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
  main panel. Live Evolution alternates the two main panels.
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

### Optional Minimap Work

- **Where**: `web/src/App.tsx`, `web/src/DebugPanel.tsx`
- **What**: Both minimaps are frontend overview caches. Mandelbrot caches the
  canonical built-in overview; Julia caches the latest zoom=0 Julia frame and
  ignores zoomed Julia frames.
- **Why**: Minimap imagery no longer competes for scheduler slots, sim time,
  chunk-worker decode, or WebSocket bandwidth. The cache is keyed so common
  built-ins can reuse stable identities and future arbitrary equations can use
  expression hashes.
- **Status**: **Keep**.

### Telemetry Only When Needed

- **Where**: `server/main.py`, `web/src/WorkloadInspector.tsx`
- **What**: `set_telemetry` turns scheduler/chunk/render JSON events on only
  while the floating Workload Inspector is open.
- **Why**: The normal render path should not pay debug overhead.
- **Status**: **Keep**.

### PS Chunk Streamer Aggregation

- **Where**: future `driver/` FPGA path.
- **What**: The PS Chunk Streamer accumulates 16 x 16 RTL microtile completions into
  256 x 256 chunk buffers, then flushes those chunks through the existing
  browser image protocol.
- **Why**: The FPGA's natural completion unit is a 16 x 16 microtile, while the
  browser's efficient paint/transport unit is a 256 x 256 chunk. Keeping the PS
  as the explicit aggregation point preserves wire optimisations and lets the
  Workload Inspector show true hardware readiness through separate telemetry.
- **Status**: **Design contract for FPGA integration**. Prefer full-chunk flushes
  for settled renders; consider short timeout flushes during interaction so a
  slow microtile does not stall visible progress.

### Bundled Binary Chunk Sends

- **Where**: `server/protocol.py`, `server/main.py`,
  `web/src/protocol.ts`
- **What**: The server observes chunk completion progressively for telemetry,
  but sends the image payload as one binary WebSocket bundle per render.
- **Why**: Reduces WebSocket/message churn and avoids patchwork visible updates.
  The Workload Inspector still shows readiness via the telemetry channel.
- **Status**: **Load-bearing for browser smoothness**.

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
  immediately, without waiting for new chunks.
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

### Worker-Based Chunk Decode

- **Where**: `web/src/chunkWorker.ts`, `web/src/useChunkWorker.ts`
- **What**: Nibble unpacking, RGBA expansion, and `ImageBitmap` creation happen
  in a Web Worker.
- **Why**: The main thread only blits ready bitmaps, which protects pan and
  zoom smoothness.
- **Status**: **Load-bearing**.

### Double-Buffered Painter

- **Where**: `web/src/chunkPainter.ts`
- **What**: Browser chunks draw into an off-screen staging canvas. The visible
  canvas swaps only when the frame's chunks are ready. Late worker results from
  older frame sequences are dropped.
- **Why**: Avoids half-old / half-new patchwork during chunk arrival.
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
  compact collapsed summary and a backend-defined grid per lane. Simulator
  telemetry currently appears as 4 x 4 browser chunks; FPGA telemetry can appear
  as the 16 x 16 RTL microtile grid.
- **Why**: Lets us inspect scheduling and true hardware microtile completion while
  still panning and zooming the main UI.
- **Status**: **Keep**. This is a differentiating frontend feature and maps
  directly to future `microtile_id` + `microtile_done` PL status.

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
- **Treating both minimaps as reused main data**: this is now the current path.
  The tradeoff is that a brand-new equation needs a zoomed-out main render before
  its minimap cache is fresh.

## Benchmark Plan

The simulator is useful because it gives a CPU baseline before the FPGA path is
ready. Benchmarks should replay the same pan/zoom traces through both backends
and record:

- main-panel FPS and p95 request-to-display latency
- active preview latency vs final full-quality latency
- dropped stale frames and browser-backpressure drops
- chunk completion order and per-chunk elapsed time
- minimaps on vs off
- Performance mode vs Live Evolution
- simulator backend vs FPGA backend once PL is connected

For the FPGA backend, the Workload Inspector telemetry should be fed from the
PS driver after it observes microtile completion or transfer-complete status
bits. The frontend does not need a redesign for that; only the backend telemetry
source changes.
