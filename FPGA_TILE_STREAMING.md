# FPGA Tile Streaming Contract

This note separates three granularities that are easy to conflate:

| Layer | Owner | Unit | Why |
| --- | --- | --- | --- |
| Hardware completion | FPGA / PL | 16 x 16 RTL tile | Matches BRAM layout, core batches, and `tile_done` cadence. |
| Transport / paint | PS -> browser | 256 x 256 chunk, optionally bundled per frame | Keeps image transport coarse enough for the browser while allowing batching for smoothness. |
| Progress / debug | Workload Inspector | 16 x 16 RTL tile telemetry | Shows true hardware behaviour rather than the display abstraction. |

## Hardware Completion

The RTL produces completion at the microtile level. Inside one 256 x 256
sixteenth, there are 16 x 16 RTL tiles:

```text
one 256 x 256 sixteenth
  = 16 x 16 RTL tiles
  = 256 tile_done bits

one RTL tile
  = 16 x 16 pixels
  = 256 pixels
```

When a `tile_done[i]` bit becomes visible to the PS side, that means one 16 x 16
tile is ready. The PS should treat that as hardware progress, not as the
browser image payload boundary.

## PS Tile Streamer

The PS Tile Streamer is the aggregation point between PL completion and browser
transport.

It should:

- receive 16 x 16 RTL tile completions from the FPGA driver,
- copy/pack each tile into the correct position in a 256 x 256 chunk buffer,
- emit optional per-RTL-tile telemetry while the Workload Inspector is open,
- flush a 256 x 256 chunk to the browser when the chunk is complete, or earlier
  under the configured timeout policy.

This preserves the existing browser-facing protocol:

```text
full frame        = 1024 x 1024
browser chunks    = 4 x 4
one chunk         = 256 x 256
chunk records     = 16 per frame
```

The browser does not need to know whether those chunks came from the simulator
or from the FPGA. The simulator currently emits chunk-shaped completion directly;
the FPGA path should make the aggregation explicit in the PS Tile Streamer.

## Image Path vs Telemetry Path

Image payloads and telemetry should stay decoupled:

- **Image payload:** aggregated 256 x 256 chunks, sent with the existing binary
  tile/chunk protocol.
- **Telemetry:** per-16 x 16 RTL tile events, sent only when the Workload
  Inspector is open through the existing opt-in `set_telemetry` path.

That lets the canvas paint chunk-sized payloads while the inspector shows true
hardware readiness.

## Flush Policy

Two flush policies are useful:

- **Settled/full-quality renders:** flush a 256 x 256 chunk when all 256 RTL
  tiles in that chunk are complete. This avoids partial redraw churn.
- **Active interaction:** optionally flush partially complete chunk buffers on a
  short timeout, for example around one display frame, so visible progress does
  not stall behind a slow tile.

Because browser frames already carry `frame_seq`, stale partial or full chunks
can be dropped by the existing stale-frame logic. Timeout flushing is therefore
safe to experiment with without changing the image protocol.

## Workload Inspector

The inspector should render the grid described by telemetry:

- simulator/chunk telemetry: 4 x 4 cells, where each cell is a 256 x 256 chunk;
- FPGA microtile telemetry: 16 x 16 cells, where each cell is one 16 x 16 RTL
  tile inside the active 256 x 256 sixteenth.

This is the important separation: the inspector can show the real FPGA tile
flow without forcing the canvas protocol to stream thousands of tiny image
messages.
