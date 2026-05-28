# sim/cpp/

C++ implementation of the simulator. Long-running binary that speaks the stdio protocol described in [../README.md](../README.md).

## Build

```
cd sim/cpp
cmake -B build
cmake --build build
```

Produces `build/fractal_sim`.

## Run

```
./build/fractal_sim
```

Reads stdin, writes binary tile responses to stdout, logs to stderr. Press Ctrl-D to close stdin and exit.

## Status

Scaffolding. Reads stdin and logs received bytes to stderr. No protocol parsing, no rendering yet.
