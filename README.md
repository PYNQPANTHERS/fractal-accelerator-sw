# fractal-accelerator-sw

PS-side driver, WebSocket server, simulator bridge, and browser UI for the
fractal accelerator.

The matching PL / RTL work lives in `fractal-accelerator-rtl`. This repo keeps
the software contract FPGA-shaped while the real hardware path is still being
brought up: the browser talks to a PS-side scheduler, the scheduler emits
`RenderConfig` jobs, and today those jobs are served by the C++ simulator. Later
the same job shape can be routed to the PYNQ/PL driver.

## Current App

Two large panels are rendered side by side:

- **Mandelbrot**: pannable and wheel-zoomable; the panel centre is the Julia
  probe point.
- **Julia**: pannable and wheel-zoomable; renders with `c = Mandelbrot centre`.
- **Optional minimaps**: low-priority real render jobs that can be disabled from
  the debug panel to remove extra backend work.
- **Workload Inspector**: floating, draggable FPGA-facing debug overlay showing
  scheduler state, active/pending panel, frame sequence, preview/full quality,
  tile completion order, tile latency, stale drops, and render latency.

## Render Contract

- Main image is **1024 x 1024**.
- Tile geometry is **4 x 4**, 16 tiles total, each **256 x 256**.
- Pixel format is nibble-packed **4-bit palette indices**.
- There is no active 5x5/6x6 pre-rendered margin and no predictive prefetch in
  the current fast path. Those were tested and rolled back because the extra
  work increased jitter more than it helped.
- `frame_seq` is a u16 sequence used by the client to drop stale frames.
- `quality` is `full` or `preview`; Performance mode uses `preview` plus lower
  `max_iter` during active pan/zoom, then requests a full-quality settled frame.

## Current Optimisations

- Last-write-wins scheduler slots per panel, so pointermove bursts do not build
  a stale render queue.
- Performance mode prioritises the actively interacted main panel; Live
  Evolution alternates the two main panels.
- Active Performance renders are cheaper (`preview` and reduced `max_iter`);
  final settled renders are full quality.
- Wheel zoom uses the same active/final interaction split as panning.
- Canvas panning is CSS-transform based and written directly to the DOM hot path
  to avoid React work during pointer movement.
- Client backpressure keeps at most one in-flight render per panel interaction;
  the latest view overwrites any pending view.
- Tile unpacking and `ImageBitmap` creation happen in a Web Worker.
- The painter double-buffers and swaps only when all 16 tiles for a frame arrive.
- Binary WebSocket sends are bundled per render rather than sent as 16 separate
  tile messages.
- Workload telemetry is opt-in and only enabled while the floating inspector is
  open, so the normal render path does not pay for debug data.

More detail is in [OPTIMISATIONS.md](OPTIMISATIONS.md) and the pan/jitter
history is in [PAN_SMOOTHNESS.md](PAN_SMOOTHNESS.md).

## Run

Build the simulator:

```sh
cd sim/cpp
cmake -B build
cmake --build build
```

Start the server:

```sh
python3 -m server.main
```

Start the web UI:

```sh
cd web
npm install
npm run dev
```

By default the browser connects to `ws://localhost:8765`. Override with
`VITE_WS_URL` for another server.

## Layout

```text
server/    WebSocket protocol, PS-side scheduler, render loop
sim/       Python wrapper plus C++ simulator standing in for the PL
web/       React/Vite frontend, canvas renderer, debug tooling
driver/    Future PYNQ / hardware driver boundary
tests/     Protocol and scheduler tests
```
