# server/

WebSocket server. This is the PS-side bridge between the browser UI and the
current renderer backend.

Today the backend is `sim/renderer.py`. The server is deliberately written so
that the same scheduler and protocol can later call a PYNQ/FPGA driver instead.

## Responsibilities

- Accept WebSocket connections from the browser.
- Parse `set_view`, `set_mode`, `set_minimaps`, and `set_telemetry` JSON
  messages.
- Schedule render jobs with single-slot, last-write-wins coalescing.
- Track active/final interaction state for Performance mode.
- Drive `sim/renderer.py` now, or later `driver/pynq_driver.py`.
- Emit optional scheduler/tile/render telemetry for the Workload Inspector.
- Pack the 16 tiles for a render into one binary WebSocket bundle.

## Run

```sh
python3 -m server.main
```

Listens on `ws://localhost:8765` by default. Set `SERVER_HOST` / `SERVER_PORT` env vars to override.

## Scheduling modes

- **Performance** (default): active main panel gets first priority. The other
  main panel fills gaps, then minimaps. The frontend also makes active
  Performance renders cheaper by sending preview quality and lower `max_iter`.
- **Live Evolution**: main panels alternate when both have work pending. This is
  useful when you want the Mandelbrot/Julia relationship to update visibly
  together.

Switch via `{"type": "set_mode", "mode": "live_evolution"}` from the browser.

## Current Protocol

Browser -> server JSON:

- `set_view`: panel id, frame sequence, pan, zoom, fractal type, Julia c,
  `max_iter`, `quality`, and `interaction`.
- `set_mode`: `performance` or `live_evolution`.
- `set_minimaps`: enables/disables minimap render jobs.
- `set_telemetry`: enables/disables Workload Inspector telemetry.

Server -> browser binary:

- `MSG_TILE_BUNDLE`: one WebSocket binary frame containing all 16 tile payloads
  for one panel/frame sequence.

Server -> browser JSON telemetry, only when enabled:

- `scheduler`: mode, active panel, interacting panel, pending jobs.
- `render_started`: panel, frame sequence, quality, `max_iter`, backend.
- `tile_done`: tile id and elapsed time as observed by the backend boundary.
- `render_finished`: total render latency and tile count.
- `render_dropped`: server-side backpressure drop.

Client-side stale frame drops are also fed into the same inspector state.

## FPGA Mapping

The server should keep seeing one `RenderConfig` in and tile completions out.
With the simulator, completions are stdout frames. With hardware, completions
should come from the PS driver after it observes PL tile id plus tile done /
transfer-complete status. The frontend does not need to know which backend
produced the event.

## Files

```
protocol.py    parse incoming JSON, pack outgoing binary frames
scheduler.py   single-slot coalescing + priority picker
main.py        WebSocket handler, render loop
```
