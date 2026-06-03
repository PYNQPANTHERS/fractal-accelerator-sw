# sim/

Software simulator for the PL. Lets the frontend, scheduler, wire protocol, and
benchmark tooling be built before the FPGA backend is ready.

Renders Mandelbrot, Julia, and Burning Ship at 1024 x 1024 in 4 x 4 chunks,
matching the shape the real pipeline will expose to the PS.

There is one simulator implementation: the C++ binary in `sim/cpp`. The browser
server uses its `render_image` command. Full-quality `render_image` uses the
Mariani-Silver adaptive renderer, matching the intended FPGA architecture.
Preview quality is a faster active-navigation mode inside the same binary, not a
second simulator.

## Quick start

```sh
# Build the C++ binary
cd sim/cpp && cmake -B build && cmake --build build

# Render one chunk from Python
python3 -m sim.cli --pan-x -0.5 --pan-y 0 --zoom 0 --chunk 5 > chunk.bin

# Run the contract tests
pytest tests/
```

## How It Works

```
Python caller
  └─ render_image(config)
       sim/renderer.py
         └─ JSON command on stdin -> sim/cpp/build/fractal_sim
            framed binary chunks on stdout <-┘
       yields (chunk_id, bytes, elapsed_ms)
```

C++ does the math. Python is a thin client over stdio. The intended hardware
driver has the same shape, just with AXI/DMA and PL status/IRQ events instead
of stdin/stdout.

The full-image path computes all 16 browser chunks in parallel and streams each
chunk frame back as its worker completes. This gives realistic chunk-completion
order for the Workload Inspector today. The future FPGA path can feed finer
16 x 16 RTL tile telemetry separately while the PS Chunk Streamer aggregates
image bytes into these same 256 x 256 chunks.

## From Python

```python
from sim.config import RenderConfig
from sim.renderer import render_image

cfg = RenderConfig(pan_x=-0.5, pan_y=0.0, zoom=0, fractal_type="mandelbrot")
async for chunk_id, chunk_bytes, elapsed_ms in render_image(cfg):
    ...
```

The C++ subprocess spawns on first call and is reused for the rest of the session.

## Chunk layout

- Full image: 1024 x 1024, split into 16 chunks of 256 x 256 each (4 x 4 grid,
  `chunk_id` 0..15, row-major).
- Each pixel: 4-bit iteration count.
- Nibble-packed, two pixels per byte -> **32 KB per chunk**.

## Performance

Full image (16 chunks) renders in roughly the same latency as the slowest chunk
because the simulator runs one worker per chunk. Exact numbers depend on zoom,
`max_iter`, CPU, and preview/full quality.

Full-quality renders use the Mariani-Silver path. Preview renders use a
subsampled 2 x 2 broadcast path inside the same simulator binary, which the
frontend uses for active Performance mode pan/zoom before requesting a
full-quality settled frame.
