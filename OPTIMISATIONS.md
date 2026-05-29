# Optimisations log

What's currently in the codebase that exists for performance / UX
smoothness reasons, organised by layer. Each entry: where it lives,
what it does, why we added it, and whether it's still earning its
keep.

This is intentionally a flat list rather than a narrative — when
performance work compounds, knowing what's optional and what's load-
bearing is the only way to back things out safely.

---

## C++ sim (`sim/cpp/src/`)

### Parallel tile rendering
- **Where**: `main.cpp` — `std::thread` per tile in `RenderImage`
- **What**: Each tile compute runs on its own thread; main thread joins all then writes frames in order.
- **Why**: 25 tiles × 12 ms serial would be 300 ms per render. Parallel = single tile time (~12 ms at zoom 0).
- **Status**: **Load-bearing**. Removing this would push wall time per render past 200 ms even at zoom 0.

### Log-banded escape-time remap
- **Where**: `iterate.cpp` — `band_for()`
- **What**: Remaps iteration count to 4-bit palette band via log1p curve.
- **Why**: With fixed-iter buckets, deep zooms collapse to one band. log-scaling preserves visible boundary structure at any max_iter.
- **Status**: **Load-bearing**. Without it, deep zoom looks flat.

### Adaptive `max_iter` per zoom
- **Where**: `web/src/App.tsx` — `maxIterFor(zoom)`
- **What**: `max_iter = min(1500, 64 + zoom × 96)`. Low zoom: 64 iters (~5 ms). Deep zoom: 1500 iters (~150 ms).
- **Why**: Boundary thinness grows with zoom; need more iters to resolve it.
- **Status**: **Load-bearing**. Without scaling, deep zooms either look blank (too few) or are unusably slow (too many).

### Preview kernel (subsampled)
- **Where**: `iterate.cpp` — `compute_tile(..., preview)`
- **What**: Optional flag computes 1-in-4 pixels (one per 2×2 block) and broadcasts.
- **Why**: ~3× faster per tile for during-drag renders.
- **Status**: **Currently unused** — wired in but client always sends `quality: "full"` since v12. Keep the kernel; the wiring may revive if we want it for FPGA's preview-mode-equivalent.

### Render-margin geometry (5×5 tile grid)
- **Where**: `iterate.hpp` — `IMAGE_PIXELS = 1280`, `VISIBLE_PIXELS = 1024`
- **What**: Sim renders 1280×1280 (25 tiles); browser displays centre 1024×1024.
- **Why**: 128 px of pre-rendered margin on each side absorbs short pans without round-tripping.
- **Status**: **Load-bearing**. The basis for the prefetch behaviour to work. Bumping to 7×7 made each render too slow (see PAN_SMOOTHNESS.md v10/v11).

---

## Python server (`server/`)

### Single-slot per-panel scheduler
- **Where**: `scheduler.py`
- **What**: One pending job per panel — new pushes overwrite stale ones (last-write-wins).
- **Why**: User flicks generate many pointermoves; we should render the latest, not a queue of stale ones.
- **Status**: **Load-bearing**.

### Performance mode defer
- **Where**: `scheduler.py` — `DEFER_MS = 250`
- **What**: In Performance mode, the non-active panel waits 250 ms of idle before rendering.
- **Why**: Lets Mandelbrot keep the sim's full throughput during interaction; Julia catches up on pause.
- **Status**: **Load-bearing for Performance mode UX.**

### `mark_active=False` for system-derived pushes
- **Where**: `scheduler.py` — `push(..., mark_active=False)` for Julia coupling
- **What**: Julia auto-pushes triggered by Mandelbrot pans don't claim active-panel status.
- **Why**: Without this, the active panel kept flipping to Julia on every Mandelbrot frame, causing Mandelbrot to be deferred forever during drag.
- **Status**: **Load-bearing** — see PAN_SMOOTHNESS.md v3.

### Skip Julia coupling on pure zoom
- **Where**: `main.py` — `recv_loop` checks `pan_changed`
- **What**: Mandelbrot zoom-only commits don't re-render Julia.
- **Why**: Cursor-anchored zoom previously kept Julia's c fixed but the server still re-rendered it identically. Pure waste.
- **Status**: **Load-bearing**.

### Event-driven render loop (no idle sleep)
- **Where**: `main.py` — `await scheduler.job_available.wait()` instead of polling
- **What**: Render loop wakes on the first push, not on a fixed timer.
- **Why**: Zero idle latency.
- **Status**: **Load-bearing**.

### Deferred-pending sleep fallback
- **Where**: `main.py` — `await asyncio.sleep(0.05)` when has_pending but next_job returned None
- **What**: If the scheduler picks nothing but has pending jobs (because of defer logic), retry in 50 ms.
- **Why**: Otherwise the event would only fire on a *new* push and deferred jobs would never run.
- **Status**: **Load-bearing**.

---

## Browser (`web/src/`)

### Double-buffered painter
- **Where**: `tilePainter.ts` — staging canvas + atomic blit
- **What**: Tiles paint into an off-screen 1280×1280 canvas. Only when all 25 land does `drawImage(staging → display)` happen.
- **Why**: Without this, the user sees a half-rendered patchwork between tile arrivals (16 ms gaps × 25 tiles = visible mid-render artifact).
- **Status**: **Load-bearing**.

### CSS-translate preview during drag
- **Where**: `useViewState.ts` — `writeTransform()`
- **What**: During an active drag, the canvas is `transform: translate(...)`ed instantly, before any render request. Cleared when fresh tiles land.
- **Why**: Provides 60 Hz visual feedback decoupled from the ~25-30 Hz render rate.
- **Status**: **Load-bearing**.

### Direct DOM transform writes (not React state)
- **Where**: `useViewState.ts` — `writeTransform()` writes to `el.style.transform` directly
- **What**: Transform updates skip React re-renders.
- **Why**: At 120 Hz pointermove, a setState per move was causing 8-15 ms of reconciliation per frame.
- **Status**: **Load-bearing**.

### Stream-commits during drag (per-mode interval)
- **Where**: `useViewState.ts` — `onCommit` mid-drag
- **What**: Every pointermove that finds the in-flight slot empty fires a new `set_view`.
- **Why**: Server receives updates throughout the drag, not just at release. Backpressure caps the rate at one-render-in-flight.
- **Status**: **Load-bearing**.

### Client-side backpressure
- **Where**: `useViewState.ts` — `inFlight.current` ref + `pending.current` stash
- **What**: Client never sends a new render request while one is in flight. New views during in-flight overwrite the stash.
- **Why**: Without this, server queues grew without bound during fast drags, latency cascaded.
- **Status**: **Load-bearing** — see PAN_SMOOTHNESS.md v5.

### Wrap-aware u16 seq drop
- **Where**: `useRenderSocket.ts` — `isOlder()`
- **What**: Tile frames with seq strictly older than the latest seen are dropped (per panel).
- **Why**: Edge case for very fast pans where the server starts streaming a render after the client moved on. Wrap-aware because frame_seq is u16.
- **Status**: **Load-bearing** for correctness, even if it doesn't fire often.

### `sentX/sentY` → `baselineX/baselineY` rebase
- **Where**: `useViewState.ts` — `notifyFrameApplied()`
- **What**: When a streamed render lands, the transform baseline rebases to the cursor position at the moment of *send*, not now. Transform residual = cursor-now − cursor-at-send (small).
- **Why**: Without this, the canvas snapped by `cursor-now − last-baseline` pixels on every render arrival. Visible jump on flicks.
- **Status**: **Load-bearing** — see PAN_SMOOTHNESS.md v6.

### Time-based velocity cap (not event-based)
- **Where**: `useViewState.ts` — `MAX_PAN_PX_PER_MS = 1.5`, `advanceWorld()`
- **What**: World pans at most 1.5 px per ms (≈90 px per 60 Hz frame).
- **Why**: High pointer rates (120/240 Hz) blew past a per-event cap. Wall-clock cap is invariant to pointer rate.
- **Status**: **Load-bearing for fast-flick smoothness.**

### Predictive prefetch
- **Where**: `useViewState.ts` — speculative onCommit in `notifyFrameApplied`
- **What**: When a render lands mid-drag with velocity > threshold, fire a speculative request at `worldPos + velocity × 150 ms`.
- **Why**: Render latency is ~150 ms. Pre-fetch means the canvas always has fresh tiles where the cursor is heading, not where it just was.
- **Status**: **Experimental, kept as of v12.** Removable if it causes visible jitter on direction changes.

### Memoised ref callbacks
- **Where**: `App.tsx` — `useMemo(() => mergeRefs(...), [...])`
- **What**: Canvas ref-callback identity stays stable across renders.
- **Why**: Inline arrows recreated every render → React unmounted/remounted canvases → painter rebuilt → `clear()` ran → black flash.
- **Status**: **Load-bearing**.

### Painter "same canvas" guard
- **Where**: `App.tsx` — `makeRegister()` skips clear if same canvas already registered
- **What**: Repeated ref calls with the same DOM node don't recreate the painter.
- **Why**: Belt-and-braces against the same flash bug above.
- **Status**: **Load-bearing**.

### Suppress WS handlers on cleanup
- **Where**: `useRenderSocket.ts` — sets `ws.onopen/.onclose/...` to null on unmount
- **What**: React 19 StrictMode double-mount fires a cleanup → re-mount cycle that would normally log a "WebSocket closed before connection established" warning.
- **Why**: Cosmetic, but reduces console noise during dev.
- **Status**: **Cosmetic. Keep.**

### Reconnect backoff
- **Where**: `useRenderSocket.ts` — exponential 250 ms → 4 s cap
- **What**: After WS close, retry with growing delay.
- **Why**: Server restart shouldn't require page refresh.
- **Status**: **Load-bearing** for usability.

### Set-based 25-tile completion tracking
- **Where**: `tilePainter.ts` — `tilesGot: Set<number>`
- **What**: Tracks tile arrivals via `Set.add()`, swap when size === 25.
- **Why**: Bitmask broke at >32 tiles when we tried 6×6 / 7×7; Set works for any count and is fast enough.
- **Status**: **Load-bearing for current geometry; portable to any tile count.**

---

## Things we tried and rolled back

- **6×6 / 7×7 grids** (v10, v11b): more margin but per-render cost grew past usable.
- **Preview-quality during drag** (v11): rendered ~3× faster but visually noticeable in motion; user preferred crisp uniform output.
- **Per-event velocity cap** (v7/v8): high pointer rates bypassed it; replaced with time-based cap.
- **Freeze world during in-flight render** (v8): killed pan velocity on slow drags. Replaced with the time-based cap that lets the world advance continuously.

---

## What we still haven't tried

- **WebSocket compression off**: `permessage-deflate` costs ~3-5 ms per tile, payload is entropy-dense (negligible compression). Worth disabling.
- **Concatenated tile sends**: one binary frame of 25 × 32 KB instead of 25 separate sends. Saves socket-write overhead.
- **Lower max_iter during drag**: e.g. drop to 32 during active interaction, restore on release. Sim renders faster, slight quality drop.
- **Mariani-Silver in C++ sim**: would skip large in-set regions wholesale. Faster than current pixel-by-pixel iteration at low zoom.

