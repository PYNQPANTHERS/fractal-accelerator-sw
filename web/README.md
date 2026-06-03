# web/

React/Vite frontend for the dual-panel fractal explorer.

The frontend is intentionally close to the hardware contract: it sends compact
view/config messages, receives 4-bit chunk payloads, drops stale frame sequences,
and paints only complete 4 x 4 frames.

## Run

```sh
npm install
npm run dev
```

Set `VITE_WS_URL=ws://host:8765` if the server is not on the same machine.

## Main Flow

1. `App.tsx` owns Mandelbrot and Julia panel state.
2. `useViewState.ts` converts drag/wheel gestures into `set_view` messages.
3. `useRenderSocket.ts` sends JSON control messages and receives binary chunk
   bundles.
4. `chunkWorker.ts` unpacks nibble-packed 4-bit chunk payloads off the main
   thread.
5. `ChunkPainter` stages bitmaps and swaps the visible canvas when all 16 chunks
   for a `frame_seq` are ready.

## Current Frontend Optimisations

- 1024 x 1024 render surface, 4 x 4 chunks, no active pre-render margin.
- CSS-transform drag preview for immediate pointer feedback.
- Direct DOM transform writes in the pointer hot path.
- Client-side backpressure: one in-flight render, latest pending view wins.
- Performance mode active pan/zoom uses preview quality and lower `max_iter`.
- Release and wheel-settle send full-quality final renders.
- Worker decode keeps chunk unpacking and `ImageBitmap` creation off the main
  thread.
- Double-buffered canvas painting avoids partial-frame patchwork.
- Wrap-aware `frame_seq` dropping prevents stale bundles painting over the
  newest view.
- Optional minimaps can be disabled from the debug panel. Both minimaps are
  frontend overview caches with view rectangles drawn over them; built-ins use
  stable cache keys, and future arbitrary equations can use expression hashes.
- Floating Workload Inspector enables telemetry only while open.

## FPGA-Facing Debug UI

The Workload Inspector is a draggable overlay rather than a fixed debug-panel
section so it can stay visible while the user pans and zooms. It shows the two
main panels only:

- active and pending panel state
- frame sequence
- preview/full quality
- dropped stale frames
- chunk completion order over the 4 x 4 grid
- per-render and per-chunk latency

Today those chunk events come from the simulator. On hardware, chunk events
should come from the PS Chunk Streamer after it has aggregated 16 x 16 RTL
tiles into a 256 x 256 browser chunk.
