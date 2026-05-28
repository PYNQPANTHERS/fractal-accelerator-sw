#!/usr/bin/env bash
# Start the WebSocket render server.
#
# The server speaks JSON ↔ binary tiles on ws://localhost:8765 by default
# and spawns the C++ sim under the hood. Override via env:
#   SERVER_HOST=0.0.0.0 SERVER_PORT=9000 scripts/run-server.sh
#
# If the sim binary is missing, this script builds it first.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SIM_BIN="$REPO_ROOT/sim/cpp/build/fractal_sim"
export SERVER_HOST="${SERVER_HOST:-localhost}"
export SERVER_PORT="${SERVER_PORT:-8765}"

c() { printf '\033[%sm' "$1"; }
DIM="$(c 2)"; BOLD="$(c 1)"; AMBER="$(c '38;5;179')"; GREEN="$(c '38;5;108')"; RESET="$(c 0)"

echo "${DIM}┌─${RESET} ${BOLD}pynqzoom${RESET} ${DIM}· server${RESET}"
echo "${DIM}└─ ws://$SERVER_HOST:$SERVER_PORT${RESET}"
echo

if [[ ! -x "$SIM_BIN" ]]; then
  echo "${AMBER}→${RESET} sim binary not found, building first"
  "$REPO_ROOT/scripts/build-sim.sh"
  echo
fi

# Kill any prior server still bound to our port — saves repeatedly debugging
# "address already in use" when a previous run was detached or backgrounded.
if command -v ss >/dev/null && ss -tln "sport = :$SERVER_PORT" 2>/dev/null | grep -q LISTEN; then
  echo "${AMBER}→${RESET} port $SERVER_PORT in use, stopping prior server"
  pkill -f "python.* -m server.main" 2>/dev/null || true
  sleep 0.3
fi

cd "$REPO_ROOT"
echo "${GREEN}✓${RESET} starting server (Ctrl-C to stop)"
echo
PYTHON="${PYTHON:-$(command -v python3 || command -v python || true)}"
if [[ -z "$PYTHON" ]]; then
  echo "no python interpreter found (set PYTHON=...)" >&2
  exit 1
fi
exec "$PYTHON" -m server.main
