# Pan smoothness — iteration log

Running log of fixes to the Mandelbrot/Julia pan UX. Each entry: what
the user reported, what the actual root cause was, and what changed.

The goal is mandelbrot-maps-style behaviour: drag feels weighted and
continuous, fast flicks don't fling the world past the cursor, no
visible "snap" or "wall" or "render flash" during or after the gesture.

---

## v0 — direct 1:1 drag, no preview transform

**Reported**: canvas only updates when mouse is released; mid-drag is dead.

**Cause**: `commit` only fired on `last: true`. No CSS preview, no
streaming commits.

**Change**: introduced a CSS-transform preview during drag, and stream
commits at a throttled interval (220ms Performance / 100ms Live Evo)
so Julia could morph live as Mandelbrot pans.

---

## v1 — "8-old-8-new patchwork"

**Reported**: while a new render arrives, half the panel shows the
old image and half shows the new — flicker.

**Cause**: tiles painted directly into the visible canvas as they
arrive. The user sees the half-painted frame.

**Change**: double-buffered painter (`tilePainter.ts`). Off-screen
staging canvas accumulates tiles; visible canvas only updates via
`drawImage(staging, …)` once all 16 tiles for a `frame_seq` have
landed. Cost: one ~0.2 ms bitblit per render.

---

## v2 — "black flash on release"

**Reported**: at drag release the canvas briefly goes back to the in-set
navy colour before the new render appears.

**Cause**: ref callbacks on the `<canvas>` were being re-created on
every App render (mode toggle, drag commit, etc.). React saw a new
identity → unmounted (deleted the painter) → re-mounted (created a new
painter and ran `painter.clear()` → navy fill).

**Change**: memoised the ref callbacks with `useMemo`; the painter
register checks "same canvas as before? skip clear."

Separately: don't reset the CSS transform at drag end either — leave it
in place until the painter actually swaps in the new frame, then clear
atomically as part of the swap.

---

## v3 — "Performance feels worse than Live Evolution"

**Reported**: Mandelbrot pan in Performance is choppier than in Live
Evolution, which is the opposite of what should happen.

**Cause**: server-side. Every Mandelbrot `set_view` also pushed a
Julia coupling render. The coupling push was overwriting
`_active_panel = JULIA`, so `_pick_performance` ran Julia (now
"active") immediately and **deferred Mandelbrot until 250 ms of true
idle** — which never happened during a continuous drag.

**Change**: `scheduler.push(panel, cfg, seq, mark_active=False)` for
system-derived pushes. `recv_loop` uses it for the Julia coupling.
Active stays where the user is actually pointing.

Also bumped `DEFER_MS` to 250 (was 50) so Performance keeps Mandelbrot
the focus for longer.

---

## v4 — "all pans hit a wall, even small ones"

**Reported**: canvas pans up to a fixed visible margin then stops; on
release it jumps to the actual position.

**Cause**: `writeTransform` had a hard clamp at the 12% canvas overshoot
margin. With the rate-limit-then-fix-later approach, the world raced
past the clamp and the canvas "jumped" on release.

**Change**: dropped the velocity cap entirely; pan is 1:1 with the
cursor again. Margin is still rendered into the canvas as a
visual-overflow zone, but no JS-side clamp on the transform.

---

## v5 — "latency grows during drag, then jumps"

**Reported**: panning starts smooth but gets choppier the longer the
drag lasts. Stop, release, big jump.

**Cause**: the client streamed every 100ms regardless of render rate.
Each render took ~30-40ms, so we fell behind by ~10-15ms per cycle.
Latency grew unboundedly. Probe results showed 70-79ms by the 16th
send. Server-side coalescing dropped 3/20 requests.

**Change**: client-side backpressure. Only send a new render request
when the previous one has fully landed. New views during in-flight
stash in `pending.current` (last-write-wins). When the render
completes, the stashed view fires immediately.

Effect: server gets exactly the renders it can handle, in order, no
queue growth, no skew.

---

## v6 — "small jump on every render-applied during drag"

**Reported**: even with backpressure, fast pans have a tiny but
visible "snap" at every render arrival.

**Cause**: `notifyFrameApplied` was rebasing the transform baseline to
the *current cursor position* (lastMx/lastMy), but the bitmap that
just landed shows the view at the *cursor position when the request
was sent* (sentMx/sentMy). Mismatch by `cursor_now - cursor_at_send`
pixels → snap of exactly that distance per render.

**Change**: rebase to `sentMx/sentMy` (cursor at send), not lastMx/lastMy.
Apply a residual transform `translate(lastMx - sentMx, lastMy - sentMy)`
instead of clearing. The bitmap-content shift cancels with the transform
shift; net visual position is continuous.

---

## v7 — "fast flicks still feel like a chuck-the-screen jump"

**Reported**: slow pans are perfect; flicks have a hang then a jump on
release. Mandelbrot-maps doesn't have this — they seem to refuse
extreme pointer velocity.

**Cause**: per-frame velocity cap (round 1). The cursor races ahead of
the world; the world only moves MAX_PAN_PX/event. On release, the
leftover cursor lead is discarded. *But* the committed view in earlier
attempts tracked the full cursor distance, so the visible position
and the committed view drifted apart, causing a snap on release.

**Change**: rate-cap *both* the world and the committed view; the
preview transform tracks the rate-limited world too. Release just
stops the world; no overshoot.

---

## v8 — "still snappy on quick flicks" — current

**Reported**: even with the velocity cap, fast flicks still show a
visible discontinuity at each render arrival.

**Cause**: while a render is in flight, world keeps advancing toward
the cursor. By the time the in-flight render lands, the world (and
the *next* render's sent position) can be far ahead of the just-
landed bitmap. The transform compensates mathematically (visible
position is continuous on paper), but the *bitmap pixel content*
swaps by `worldX - sentX` pixels in one frame — a content jump that
the eye reads as motion.

**Change**: freeze the world while a render is in flight. The cursor
can race ahead but the world stays at its in-flight snapshot. When
the render lands, the world resumes by **one cap-step** toward the
latest cursor position and fires the next request. Bitmap-content
swap is bounded at one cap-step (~14 px), barely perceptible.

Tunable: `MAX_PAN_PX_PER_EVENT` at the top of `useViewState.ts`.

---

## v9 — "slow pan feels worse, fast flick has too much weight"

**Reported**: v8's freeze-while-in-flight stole the silkiness from slow
pans (world only advances at render-arrival cadence ≈ 30 Hz instead of
60 Hz). Fast flicks now feel sluggish — the cursor weight is too high.

**Cause**: freezing the world capped its update rate to render
completion rate. At slow speeds you could see the canvas pause for
~30 ms between renders. At fast speeds the per-event cap was too
generous (≤14 px/event regardless of how often events fired).

**Change**: switched to a **time-based velocity cap**
(`MAX_PAN_PX_PER_MS = 1.5`). The world advances *every* pointermove
event (no freeze) by at most `1.5 × elapsed_ms` pixels. Slow drags
pass through 1:1 (the cap is generous for normal motion ≤ 90 px/frame
at 60 Hz). Fast flicks get throttled at the velocity level, not the
event level.

Bitmap-content swap bound becomes `MAX_PAN_PX_PER_MS × render_latency_ms`.
At 30 ms render latency that's ~45 px — modest, comfortably below the
12% canvas margin.

## v10 — render-margin (Option A)

**Reported**: fast flicks still show a content swap at each render arrival.
The cap-velocity trick on its own can't eliminate it — at any non-zero
flick speed, the cursor races ahead of the world during the render
latency and the bitmap content "catches up" when the new render lands.

**Cause**: fundamental. As long as we wait for a server render to know
what content goes at the cursor's new position, that wait is visible.
Mandelbrot-maps and Google Maps hide it the same way: render *more
than the visible region* and let the canvas translate into pre-rendered
margin while a background render happens.

**Change**: render at 1536×1536 (6×6 grid of 256-px sixteenths) instead
of 1024×1024 (4×4). Centre 4×4 (1024 px) is the user-visible region;
surrounding ring is pre-rendered pan margin. The canvas is CSS-sized
to 150% of the viewport with a -25% offset on each side so the centre
fills exactly. During pan, the canvas translates into the margin —
real fractal pixels appear at the edges instead of waiting for a new
render.

Sim slows ~2.25× per render (more compute). On FPGA day this is mostly
free because Mariani-Silver prunes large in-set / far-exterior regions
in the edge sixteenths.

Wire format unchanged (`tile_id` is u8, fits 0..35; `width`/`height`
in the binary header already self-describe).

## v11 — shrink margin + add preview-quality path

**Reported**: v10's 6×6 grid (1536 image) made even small pans feel
choppier because every render now costs 2.25× more.

**Cause**: paying full margin cost for renders that don't use the
margin (small pans never approach the edge). Bigger margin = bigger
render = lower fps for everyone.

**Change** (two pieces):

1. **Shrink the margin** from 6×6 to **5×5**. Image is 1280×1280;
   margin is 128 px (12.5%) on each side. Sim cost drops from 2.25×
   to 1.56× of the original. Still enough margin to absorb most
   flicks; not enough to bleed throughput on small pans.

2. **Preview quality path**. The sim's `compute_tile` now takes a
   `preview` flag. In preview mode it computes 1 in 4 pixels (one
   per 2×2 block) and broadcasts. ~3× faster per tile. Slightly
   blocky but the user only sees it during active drag. Client
   sends `quality: "preview"` mid-drag and `quality: "full"` on
   release / wheel-zoom. Server propagates quality to the Julia
   coupling push so Julia stays fast too.

Net effect: mid-drag renders complete in ~50 ms (vs ~150 ms before).
Release commits at full crispness in ~150 ms. Small pans benefit
because they never had to pay the full-quality cost during motion.

Wire format: gains an optional `quality` field on `set_view`. No
binary format change.

## v12 — revert to 5×5 full, add predictive prefetch

**Reported**: v11's preview kernel didn't meaningfully help. Bigger
grid (v10b at 7×7 mixed-quality) traded too much render rate for
marginal gain. We need a way to extend the effective margin without
making each render slower.

**Change** — back to 5×5 (1280-px image, 128-px margin) at full
quality, plus **predictive prefetch**:

- The drag session tracks a smoothed world velocity (EWMA, alpha=0.3).
- When a render lands mid-drag with measurable velocity
  (>0.2 px/ms), `notifyFrameApplied` doesn't sit idle waiting for
  the next pointermove. Instead it speculatively requests a render
  at `worldPos + velocity × 150 ms`. That tile set arrives roughly
  when the cursor gets there.
- Backpressure: speculative requests share the same in-flight slot
  as everything else. A *real* pointermove during the speculative
  in-flight overwrites the pending stash (last-write-wins), so a
  reversal-of-direction quickly cancels the speculation.

Effectively this decouples margin size from per-render latency. The
canvas isn't catching up to where the cursor *is* — it's racing the
cursor to where it'll *be*. As long as motion is roughly steady, the
visible region always has fresh fractal pixels.

Tunables at the top of `useViewState.ts`:
- `PREFETCH_MIN_SPEED_PX_PER_MS` (0.2): below this, no prediction.
- `PREFETCH_LOOKAHEAD_MS` (150): how far ahead to predict. Should
  roughly match observed render latency.

## v13 — 4×4 no-margin jitter / black-border fix

**Reported**: after returning to 4×4, pan felt jumpier again and could
show black / unrendered border at the viewport edge during frame swaps.

**Cause**: pointermove transforms were clamped by `writeTransform()`,
but `notifyFrameApplied()` applied its residual transform directly.
With `CANVAS_MARGIN_FRAC = 0`, that bypass could still translate the
canvas outside the rendered 1024×1024 image after a frame landed.

Predictive prefetch also made less sense in 4×4 mode: with no rendered
pan margin, speculative swaps can expose the fact that the content has
no extra pixels to slide into.

**Change**:

- Route frame-applied residual transforms through `writeTransform()`,
  so drag and frame-swap paths share the same clamp.
- Disable predictive prefetch when `CANVAS_MARGIN_FRAC <= 0`.

**Effect**: reduced visible jitter and stopped the black/unrendered
border from appearing during 4×4 pan.

## What to try next if v12 still feels off

- Drop `permessage-deflate` on the WebSocket — fractal payload is
  entropy-dense, compression buys nothing but costs ~3-5 ms per tile.
- Concatenate all 16 tile binary frames into one `ws.send` per render
  (saves ~16 socket-write overheads).
- During drag in Performance mode, drop `max_iter` to 32 (vs 64) at
  zoom 0–3 — render takes ~5ms instead of ~12ms. Bump back up on
  drag release.
- Add a debug overlay showing live `cursor_x - canvas_x` mismatch in
  pixels. Spikes at render-apply tell us if v8 is or isn't fixing it.
