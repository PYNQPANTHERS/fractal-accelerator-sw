# sim/

Python simulator standing in for the PL during development.

Produces tile bytes in the somewhat same wire format the real PL/PS pipeline will. Lets the PS driver, server, and UI be built and tested before the FPGA is ready.

## Tile geometry

A render is 1024×1024 split into 16 tiles of 256×256 each, arranged in a 4×4 grid (tile_id 0..15 row-major). Each pixel is a 4-bit iteration count; tiles are nibble-packed, two pixels per byte. One tile = 32 KB.

## Status

Scaffolding. Renders a placeholder pattern. Numpy Mandelbrot/Julia comes next.
