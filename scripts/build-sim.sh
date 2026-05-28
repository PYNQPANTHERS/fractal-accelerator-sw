#!/usr/bin/env bash
# Build the C++ simulator backend.
#
# Output: sim/cpp/build/fractal_sim — the binary that sim/renderer.py
# spawns to produce tiles. Re-run after touching anything under sim/cpp/src.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="$REPO_ROOT/sim/cpp/build"

c() { printf '\033[%sm' "$1"; }
DIM="$(c 2)"; BOLD="$(c 1)"; AMBER="$(c '38;5;179')"; GREEN="$(c '38;5;108')"; RESET="$(c 0)"

echo "${DIM}┌─${RESET} ${BOLD}pynqzoom${RESET} ${DIM}· build sim${RESET}"
echo "${DIM}└─ $BUILD_DIR${RESET}"
echo

mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

if [[ ! -f Makefile && ! -f build.ninja ]]; then
  echo "${AMBER}→${RESET} configuring (Release)"
  cmake -DCMAKE_BUILD_TYPE=Release .. > /dev/null
fi

echo "${AMBER}→${RESET} compiling"
cmake --build . --config Release -j

BIN="$BUILD_DIR/fractal_sim"
if [[ -x "$BIN" ]]; then
  echo
  echo "${GREEN}✓${RESET} built ${BOLD}$BIN${RESET}"
else
  echo "${BOLD}build did not produce fractal_sim${RESET}" >&2
  exit 1
fi
