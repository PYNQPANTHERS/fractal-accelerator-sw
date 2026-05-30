# sim/cpp/

C++ implementation of the software PL simulator. This is the single simulator
implementation used by the app/server path. It is a long-running binary that
speaks a small JSON-over-stdin / framed-binary-over-stdout protocol used by
`sim/renderer.py`.

## Build

```sh
cd sim/cpp
cmake -B build
cmake --build build
```

Produces `build/fractal_sim`.

## Run

```sh
./build/fractal_sim
```

Reads JSON commands from stdin, writes framed binary tile responses to stdout,
and logs diagnostics to stderr. Press Ctrl-D to close stdin and exit.

## Commands

- `ping`: returns a pong frame.
- `render_tile`: renders one 256 x 256 tile.
- `render_image`: renders the current 4 x 4 image, 16 tiles total, and streams
  tile frames as worker threads complete.

## Render Paths

- Full quality uses the Mariani-Silver adaptive renderer, matching the intended
  FPGA algorithm.
- Preview quality uses a subsampled 2 x 2 broadcast kernel inside this same
  binary; it is an interaction shortcut, not a second simulator implementation.
- Output is nibble-packed 4-bit palette indices, two pixels per byte.

## FPGA Relevance

The simulator intentionally behaves like the future PS/PL boundary:

- one render config enters the backend
- independent tile workers complete in their own order
- the PS-side layer observes tile id plus completion time
- the frontend receives the same tile payload shape regardless of backend

When the FPGA driver replaces this process, the completion source changes from
stdout frames to PL tile-done / transfer-complete status, but the server and
frontend contract should remain the same.
