# FPGA Preview Mode Note

This note clarifies the distinction between the simulator, the full-quality
FPGA-equivalent render path, and the low-resolution intermediate Performance
mode used while panning or zooming.

## One Simulator

There is one simulator implementation in the software app path:

```text
server/main.py -> sim/renderer.py -> sim/cpp/build/fractal_sim
```

The simulator has more than one quality mode, but it is not multiple simulator
implementations.

## Full-Quality Path

The full-quality simulator path uses Mariani-Silver:

```text
render_image(preview=false) -> compute_tile_mariani(...)
```

This is the FPGA-equivalent software path. It matches the intended hardware
architecture: quad jobs, border sampling, colour comparison, split mixed
regions, flood-fill uniform regions, and complete tiles/regions as work
finishes.

This is the path that should be used for the main CPU-vs-FPGA correctness and
throughput comparison.

## Performance Preview Path

Performance mode uses a cheaper intermediate render while the user is actively
panning or wheel-zooming:

```text
interaction=active
quality=preview
lower max_iter
```

In the current simulator, `preview=true` uses a subsampled 2 x 2 broadcast path:
one pixel is computed and reused for a small block. When the interaction
settles, the frontend sends a final full-quality render.

The important nuance:

**Preview is not a second simulator. It is a lower-quality interaction mode
inside the same simulator/backend contract.**

## Can The FPGA Do This?

Yes, the FPGA architecture can support this style of intermediate panning.
Whether RTL changes are needed depends on what we mean by "preview".

The software stack is already ready for that because `RenderConfig` has a
`preview` flag and the frontend/server already send active vs final interaction
state.

## Hardware Options

### 1. Lower `max_iter` During Active Navigation

This is the easiest FPGA-compatible preview mode, and should be PS-side policy
only if the PL already exposes a configurable `max_iter` register/control.

The PS sends a smaller iteration budget while the user is panning/zooming, then
sends the normal full `max_iter` on settle.

Pros:

- No RTL change beyond the normal `max_iter` control path.
- Keeps the same pixel grid and tile output format.
- Easy to benchmark against the current software behaviour.

Cons:

- It reduces iteration depth, not spatial resolution.
- Deep zoom previews may still be expensive if many pixels run to the cap.

### 2. Coarse Pixel Broadcast

The PL samples one pixel per 2 x 2 or 4 x 4 block and writes/broadcasts that
colour across the block.

Pros:

- Closest to the current simulator preview.
- Directly reduces the number of iterator jobs.
- Same final tile payload format can still be emitted.

Cons:

- Needs RTL/control support for stepping over block origins and expanding the
  result into the tile memory/output format.
- Must be clearly marked as preview-only because it is visibly lower resolution.

PS-only downsampling after the FPGA has already rendered a full tile would not
increase FPGA throughput; it would only make the displayed image look lower
resolution after paying the full hardware compute cost.

### 3. Mariani-Silver Preview Granularity

The PL keeps the Mariani-Silver structure but stops subdivision earlier while
the user is actively navigating.

Example policy:

```text
preview=false: split down to normal leaf size
preview=true:  split only to a larger leaf size, then fill/brute-force coarser blocks
```

Pros:

- Fits the existing quad-tree/flood-fill architecture naturally.
- Reduces work by changing subdivision depth rather than adding a separate
  renderer.
- Likely the cleanest "hardware story" if the RTL scheduler already owns quad
  size and leaf policy.

Cons:

- Needs careful correctness framing: it is intentionally approximate until the
  settled full-quality render arrives.
- Requires PL configurability for leaf/stop size or preview mode.

If the RTL already exposes this leaf/stop-size policy as a register, then the
PS can select it without RTL changes. If it is hard-coded, then supporting this
form of preview needs RTL work.

## Recommended Policy

For project clarity, treat this as two separate benchmark modes:

1. **Full quality:** Mariani-Silver simulator vs Mariani-Silver FPGA.
2. **Interactive preview:** software preview vs FPGA preview policy.

That avoids claiming the preview image is the full-quality hardware result,
while still showing an FPGA-friendly optimisation for user interaction.

## Frontend Contract

The frontend/server contract already has the right shape:

- `interaction="active"` during pan/zoom
- `interaction="final"` on release or wheel settle
- `quality="preview"` for active Performance renders
- `quality="full"` for settled renders
- same tile ids, frame sequence, panel ids, and binary tile payload format

So the frontend should not need redesigning when the FPGA path arrives.

For the first implementation, the cleanest path is:

```text
preview=true  -> PS sends lower max_iter to existing PL control
preview=false -> PS sends normal max_iter
```

That version is PS-side scheduling/config policy, not an RTL redesign. RTL is
only needed if we want true spatial low-resolution preview that avoids computing
the skipped pixels.
