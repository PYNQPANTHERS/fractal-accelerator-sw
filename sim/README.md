# sim/

Software simulator standing in for the PL during development. Produces tile bytes in the same wire format the real PL/PS pipeline will, so the PS driver, server, and UI can be built before the FPGA is ready.

## Architecture

The simulator is a **long-running C++ binary** (in [cpp/](cpp/)) that speaks a simple stdio protocol:

- **stdin**: JSON commands, one per line.
- **stdout**: framed binary responses (tile bytes).

Python (`sim/renderer.py`) is a thin client that spawns the binary once per session and exchanges commands and tiles with it.

This mirrors how the real PS driver will talk to the FPGA: send a command, receive bytes back. Same shape, different transport.

## Tile geometry

A render is 1024×1024 split into 16 tiles of 256×256 each, arranged in a 4×4 grid (tile_id 0..15 row-major). Each pixel is a 4-bit iteration count; tiles are nibble-packed, two pixels per byte. One tile = 32 KB.

## Status

Scaffolding. Python stub raises NotImplementedError until the C++ binary lands.
