# sim/

Software simulator for the PL. Lets the rest of the stack be built before the FPGA is ready.

Renders Mandelbrot, Julia, and Burning Ship at 1024×1024, in tiles, matching the wire format the real pipeline will use.

## Quick start

```sh
# Build the C++ binary
cd sim/cpp && cmake -B build && cmake --build build

# Render one tile from Python
python3 -m sim.cli --pan-x -0.5 --pan-y 0 --zoom 0 --tile 5 > tile.bin

# Run the contract tests
pytest tests/
```

## How it works

```
Python caller
  └─ render_tile(config, tile_id)
       sim/renderer.py
         └─ JSON command on stdin ─► sim/cpp/build/fractal_sim
            framed binary tile on stdout ◄─┘
       returns bytes
```

C++ does the math. Python is a thin client over stdio. Same shape the real PL driver will have, just with AXI/DMA instead of stdio.

## From Python

```python
from sim.config import RenderConfig
from sim.renderer import render_tile

cfg = RenderConfig(pan_x=-0.5, pan_y=0.0, zoom=0, fractal_type="mandelbrot")
tile_bytes = render_tile(cfg, tile_id=5)   # 32768 bytes
```

The C++ subprocess spawns on first call and is reused for the rest of the session.

## Tile layout

- Full image: 1024×1024, split into 16 tiles of 256×256 each (4×4 grid, `tile_id` 0..15, row-major).
- Each pixel: 4-bit iteration count.
- Nibble-packed, two pixels per byte → **32 KB per tile**.

## Performance

Full image (16 tiles) renders in ~15 ms via the Python wrapper on a modern laptop.
