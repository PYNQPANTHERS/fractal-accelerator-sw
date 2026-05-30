# sim/

Software simulator for the PL. Lets the frontend, scheduler, wire protocol, and
benchmark tooling be built before the FPGA backend is ready.

Renders Mandelbrot, Julia, and Burning Ship at 1024 x 1024 in 4 x 4 tiles,
matching the shape the real pipeline will expose to the PS.

## Quick start

```sh
# Build the C++ binary
cd sim/cpp && cmake -B build && cmake --build build

# Render one tile from Python
python3 -m sim.cli --pan-x -0.5 --pan-y 0 --zoom 0 --tile 5 > tile.bin

# Run the contract tests
pytest tests/
```

## How It Works

```
Python caller
  └─ render_image(config)
       sim/renderer.py
         └─ JSON command on stdin -> sim/cpp/build/fractal_sim
            framed binary tiles on stdout <-┘
       yields (tile_id, bytes, elapsed_ms)
```

C++ does the math. Python is a thin client over stdio. The intended hardware
driver has the same shape, just with AXI/DMA and PL status/IRQ events instead
of stdin/stdout.

The full-image path computes all 16 tiles in parallel and streams each tile
frame back as its worker completes. This gives realistic tile-completion order
for the Workload Inspector today, and maps to future FPGA `tile_id` +
`tile_done` / transfer-complete status later.

## From Python

```python
from sim.config import RenderConfig
from sim.renderer import render_image

cfg = RenderConfig(pan_x=-0.5, pan_y=0.0, zoom=0, fractal_type="mandelbrot")
async for tile_id, tile_bytes, elapsed_ms in render_image(cfg):
    ...
```

The C++ subprocess spawns on first call and is reused for the rest of the session.

## Tile layout

- Full image: 1024 x 1024, split into 16 tiles of 256 x 256 each (4 x 4 grid,
  `tile_id` 0..15, row-major).
- Each pixel: 4-bit iteration count.
- Nibble-packed, two pixels per byte → **32 KB per tile**.

## Performance

Full image (16 tiles) renders in roughly the same latency as the slowest tile
because the simulator runs one worker per tile. Exact numbers depend on zoom,
`max_iter`, CPU, and preview/full quality.

Full-quality renders use the Mariani-Silver path. Preview renders use a
subsampled 2 x 2 broadcast path, which the frontend uses for active Performance
mode pan/zoom before requesting a full-quality settled frame.
