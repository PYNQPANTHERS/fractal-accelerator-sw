# server/

WebSocket server. This is the PS-side bridge between the browser UI and the
current renderer backend.

Today there is one backend implementation in use: `sim/renderer.py` driving the
single C++ simulator binary. Full-quality simulator renders use Mariani-Silver,
matching the intended FPGA algorithm; preview is only a cheaper interaction
quality inside that same simulator.

The server is deliberately written so that the same scheduler and protocol can
later call a PYNQ/FPGA driver instead.

## Responsibilities

- Accept WebSocket connections from the browser.
- Parse `set_view`, `set_mode`, `set_minimaps`, and `set_telemetry` JSON
  messages.
- Schedule render jobs with single-slot, last-write-wins coalescing.
- Track active/final interaction state for Performance mode.
- Drive `sim/renderer.py` now, or later `driver/pynq_driver.py`.
- Emit optional scheduler/tile/render telemetry for the Workload Inspector.
- Pack the 16 browser chunks for a render into one binary WebSocket bundle.
- In the FPGA path, aggregate 16 x 16 RTL tile completions into 256 x 256
  browser chunks through the PS Tile Streamer.

## Run

```sh
python3 -m server.main
```

Listens on `ws://localhost:8765` by default. Set `SERVER_HOST` / `SERVER_PORT` env vars to override.

## Scheduling modes

- **Performance** (default): active main panel gets first priority, then the
  other main panel fills gaps. The frontend also makes active
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
- `set_minimaps`: compatibility/debug toggle for frontend minimap visibility.
  Minimap images are frontend overview caches, not server render jobs.
- `set_telemetry`: enables/disables Workload Inspector telemetry.

Server -> browser binary:

- `MSG_TILE_BUNDLE`: one WebSocket binary frame containing all 16 chunk
  payloads for one panel/frame sequence. These payloads are browser-facing
  256 x 256 chunks, not individual 16 x 16 RTL tiles.
- `MSG_TILE`: supported parser format for a single 256 x 256 chunk.

Server -> browser JSON telemetry, only when enabled:

- `scheduler`: mode, active panel, interacting panel, pending jobs.
- `render_started`: panel, frame sequence, quality, `max_iter`, backend.
- `tile_done`: tile id and elapsed time as observed by the backend boundary.
  With FPGA telemetry this can be the 16 x 16 RTL tile grid; it does not have to
  match the image payload granularity.
- `render_finished`: total render latency and tile count.
- `render_dropped`: server-side backpressure drop.

Client-side stale frame drops are also fed into the same inspector state.

## FPGA Mapping

The server should keep seeing one `RenderConfig` in and browser chunks out. With
the simulator, completion currently arrives as chunk-shaped stdout frames. With
hardware, completion arrives as 16 x 16 RTL tile readiness inside a 256 x 256
sixteenth. The PS Tile Streamer should accumulate those RTL tiles into a chunk
buffer, flush browser chunks through the existing binary protocol, and emit
per-RTL-tile telemetry only while the Workload Inspector is open.

See [../FPGA_TILE_STREAMING.md](../FPGA_TILE_STREAMING.md) for the full
granularity contract.

## Files

```
protocol.py    parse incoming JSON, pack outgoing binary frames
scheduler.py   single-slot coalescing + priority picker
main.py        WebSocket handler, render loop
```
