# server/

WebSocket server. Bridges the browser UI and the fractal renderer.

## Responsibilities

- Accept WebSocket connections from the browser.
- Parse `set_view` / `set_mode` JSON messages.
- Schedule render jobs (single-slot coalescing, priority-based).
- Drive `sim/renderer.py` (or later `driver/pynq_driver.py`) for tiles.
- Pack and stream binary tile frames back to the browser.

## Run

```sh
python3 -m server.main
```

Listens on `ws://localhost:8765` by default. Set `SERVER_HOST` / `SERVER_PORT` env vars to override.

## Scheduling modes

- **Performance** (default): active panel gets full renderer throughput. The other panel defers until the active one is idle for >50 ms.
- **Live Evolution**: both panels interleave, each at roughly half the render rate. Trades throughput for the visual of both panels updating together.

Switch via `{"type": "set_mode", "mode": "live_evolution"}` from the browser.

## Files

```
protocol.py    parse incoming JSON, pack outgoing binary frames
scheduler.py   single-slot coalescing + priority picker
main.py        WebSocket handler, render loop
```
