# Chunk-Path Optimisations

The chunk concept exists at three independent layers: hardware completion
(16x16 RTL tiles), browser transport (256x256 chunks bundled per frame), and
telemetry. Keeping those layers separable opens up a small family of
optimisations on the transport layer that pay off both today (simulator) and
once the real FPGA path lands. See [FPGA_CHUNK_STREAMING.md](FPGA_CHUNK_STREAMING.md)
for the layer contract these build on.

This note tracks four. The first is implemented; the other three are
candidates with notes on shape, where the win is, and what to watch for.

## 1. Dirty-chunk transmission (implemented)

**Status:** landed on `feature/tile-streaming`.

The server keeps a per-panel `hash(chunk_bytes)` for the last 16 chunks it
sent. When the renderer produces a new frame, chunks whose hash matches the
cached value are dropped from the bundle. The client treats omitted chunks
as "still correct on staging" and swaps when `chunksGot == bundleSize`
rather than always waiting for 16.

The wire format did not change. `MSG_CHUNK_BUNDLE`'s `chunk_count` byte
already varied 0..255; partial bundles use the existing slot. An empty
bundle (`chunk_count == 0`) is now meaningful: "this frame produced no
visible delta, just advance your stale-seq tracker."

**Where the win is real:**

- Duplicate / debounced `set_view` pushes (same config sent twice in
  quick succession) — bundle goes empty.
- Live Evolution mode with Julia's `c` momentarily unchanged.
- Deep zooms where most chunks are solid-in-set: those chunks render
  identically every frame, so only the boundary chunks ship.
- The Julia-coupling path (Mandelbrot pan retriggers Julia render) when
  `c` happens to land identically.

**Where the win is small or zero:**

- Active pans on the main panel. A pan shifts complex-plane coordinates
  everywhere, so every chunk's pixels change and nothing caches.
- Zoom and quality flips: the cache is invalidated, so the first frame
  after the change sends all 16 chunks regardless.

**Cache invalidation rules** (server, [main.py](server/main.py),
`_config_invalidates_cache`): zoom, fractal_type, julia_c, max_iter, or
preview flag change → drop cached hashes for that panel. Pan alone keeps
the cache. Minimap disable also drops the minimap caches so re-enabling
paints a full first frame.

**Telemetry:** `render_finished` events now carry `chunks_skipped`. Watch
this to confirm the optimisation is doing something — if it's always 0
on the workloads you care about, the next three options matter more.

## 2. Per-chunk early flush during active drag

**Idea.** Today the render path is "compute all 16 chunks, then send one
bundle." During an `interaction=active` pointer drag, flush each chunk
the instant it's ready (`MSG_CHUNK`, single-chunk frame) instead of
waiting for all 16. Settled / `interaction=final` renders stay bundled.

**Why it's worth doing.** On the FPGA, RTL tile completions trickle in
over a few ms each. A 1024x1024 frame at 16 chunks could plausibly take
30-60 ms end-to-end; sending the first ready chunk as soon as it lands
turns that into visible progressive paint instead of one big swap at the
end. The painter already handles `MSG_CHUNK` — `parseMessage` returns a
single-element array with `bundleSize: 1`, and the dirty-chunk completion
trigger already swaps after one chunk in that case.

**Where to wire it.** [server/main.py](server/main.py),
`_render_and_stream`. Inside the `async for chunk in render_image`
loop: if the job's interaction phase is `active`, send a `MSG_CHUNK`
frame immediately and append to a "sent so far" list; at the end, only
the final settled bundle path runs for `final`/`idle`.

**Catch.** Each `MSG_CHUNK` send is N=16 WebSocket sends instead of 1, so
overhead per frame rises a little. Worth measuring against the current
backpressure threshold (`_MAX_SEND_BUFFER`) — partial sends should still
yield mid-frame if the browser is slow.

**Interaction with #1.** During active drag the cache won't help much
(pans differ every frame). So sending early-and-often during drag, then
falling back to dirty-skip-bundled on settle, is the right combo.

## 3. Solid-set chunk shortcut

**Idea.** Add a new `pixel_format` value, e.g. `0x20 = solid`, with a
1-byte payload: the single palette index that fills the entire 256x256
chunk. The PS Chunk Streamer (or the simulator's chunk emitter) detects
"all 65,536 pixels carry max_iter" — cheap during aggregation, no extra
pass — and emits the solid record instead of 32 KB of identical nibbles.

**Why it's worth doing.** At extreme zoom inside the set, the majority
of 256x256 chunks are uniformly black (max_iter). One solid record per
chunk replaces 32 KB with ~18 bytes (header + 1-byte payload). At deep
zoom this can drop a 524 KB frame to under 100 KB.

**Where to wire it.** Server: a per-chunk solid-check during
`render_image` aggregation. Protocol: extend `pixel_format` in the
header; client decode picks up the new value and either paints a solid
rect into the chunk position or uploads a 1x1 texture and scales.

**Catch.** The "is this chunk solid?" check must be O(payload) but
branchless — `any(b != 0xFF for b in payload)` is fine in C++, but in
Python it's 32 KB worth of byte comparisons per chunk. Worth doing in
the C++ sim, not in Python.

**Interaction with #1.** Independent. A solid chunk also caches well
(deterministic bytes), so it compounds — first frame at depth pays the
solid-encode cost, every subsequent frame sends nothing for that chunk.

## 4. Scheduler in-flight slot

**Idea.** The scheduler today is "pick one job, render, return, pick
again." With the FPGA the cycle "kick off render → first RTL tile back"
is non-zero. If the user pans while panel A is mid-render, the scheduler
should be able to cancel A's outstanding RTL tiles and re-issue from
the new viewport instead of letting A finish and only then noticing the
new pan.

**Why it's worth doing.** Today the wasted work is the entire in-flight
frame — typically 1-2 frames of latency past the user's intent. With a
real FPGA and harder workloads (deeper iter counts) this gets worse,
not better. The `frame_seq` stale-frame logic on the client already
discards stragglers, but the FPGA still spent the time computing them.

**Where to wire it.** [server/scheduler.py](server/scheduler.py) needs
to model "frame in flight" alongside "pending." `next_job` returns
either a new job or a preemption signal; the render loop checks
preemption between RTL tile completions and bails out if the active
panel's pending config has advanced.

**Catch.** Real preemption needs FPGA-side support — the driver has to
expose a "cancel in-flight tiles" path, or the PS Chunk Streamer has to
discard completions for cancelled `frame_seq`s. The simulator can fake
this trivially; the FPGA path is a driver design decision. The shape of
the contract should be decided before the driver locks in, which is the
main reason to think about this now.

**Interaction with #1 and #2.** Independent of #1. With #2 (active-drag
streaming), preemption matters less — chunks ship as they're ready, so
a cancelled frame just means a few unsent chunks rather than wasted work.
The two are partially redundant; pick one for active drag.

## Recommended order

1. Done: dirty-chunk.
2. **#2 (early flush during drag)** — biggest perceived-latency win on
   FPGA, mostly server-side, painter already supports the path.
3. **#3 (solid chunks)** — easy if the C++ sim is the sole producer;
   harder if added later because protocol gains a new pixel_format
   variant and every client must understand it.
4. **#4 (in-flight preemption)** — design now, implement when the FPGA
   driver lands. Worth thinking about before the driver contract is
   final so cancellation isn't bolted on.
