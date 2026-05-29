"""Python-side client for the C++ simulator binary.

The simulator (sim/cpp/) is a long-running C++ process. This module spawns
it once per Python session, sends JSON commands on its stdin, and reads
framed binary responses from its stdout.

The same shape will apply to the eventual real PL driver: send a command,
receive bytes. So callers can be written against this interface and later
swapped to a PynqDriver with minimal change.
"""

from __future__ import annotations

import asyncio
import atexit
import json
import struct
import subprocess
import threading
from pathlib import Path

from sim.config import RenderConfig


TILE_PIXELS = 256
TILE_BYTES  = TILE_PIXELS * TILE_PIXELS // 2   # 32768
# 5×5 grid of 256-px tiles: 1280-px rendered image, centre 1024 is the
# browser-visible region, surrounding ring (128 px each side) is
# pre-rendered pan margin.
TILES_PER_IMAGE = 25

# Frame format from sim/cpp/src/response.hpp:
#   byte 0    : message_type
#   byte 1    : tile_id
#   bytes 2-5 : payload length, little-endian uint32
_HEADER_FMT  = "<BBI"
_HEADER_SIZE = struct.calcsize(_HEADER_FMT)   # 6

_MSG_TILE  = 0x01
_MSG_PONG  = 0x02
_MSG_ERROR = 0xFF

_BINARY_PATH = Path(__file__).parent / "cpp" / "build" / "fractal_sim"


class SimError(RuntimeError):
    """Raised when the simulator returns an error frame or exits unexpectedly."""


class _Sim:
    """Wraps the long-running C++ subprocess."""

    def __init__(self) -> None:
        if not _BINARY_PATH.exists():
            raise SimError(
                f"sim binary not found at {_BINARY_PATH}. "
                "Build it: cd sim/cpp && cmake -B build && cmake --build build"
            )
        self._proc = subprocess.Popen(
            [str(_BINARY_PATH)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        self._lock = threading.Lock()

    def _send(self, command: dict) -> None:
        """Write one JSON command to the subprocess stdin. Caller holds lock."""
        line = (json.dumps(command) + "\n").encode("utf-8")
        assert self._proc.stdin is not None
        try:
            self._proc.stdin.write(line)
            self._proc.stdin.flush()
        except BrokenPipeError as e:
            raise SimError("sim subprocess closed stdin") from e

    def _read_frame(self) -> tuple[int, int, bytes]:
        """Read one framed response from stdout. Caller holds lock."""
        assert self._proc.stdout is not None
        header = self._proc.stdout.read(_HEADER_SIZE)
        if len(header) < _HEADER_SIZE:
            raise SimError("sim subprocess closed stdout before a complete header")
        msg_type, tile_id, length = struct.unpack(_HEADER_FMT, header)
        payload = self._proc.stdout.read(length) if length > 0 else b""
        if len(payload) < length:
            raise SimError(
                f"sim stdout closed mid-payload ({len(payload)}/{length} bytes)"
            )
        return msg_type, tile_id, payload

    def request(self, command: dict) -> tuple[int, int, bytes]:
        """Send one command, read one response frame."""
        with self._lock:
            self._send(command)
            return self._read_frame()

    def request_stream(self, command: dict, n_frames: int) -> Iterator[tuple[int, int, bytes]]:
        """Send one command, read n_frames response frames.

        Holds the lock for the entire multi-frame sequence so no other
        caller can interleave commands while we're reading responses.
        Yields each frame as soon as it's received from the subprocess.
        """
        with self._lock:
            self._send(command)
            for _ in range(n_frames):
                yield self._read_frame()

    def close(self) -> None:
        if self._proc.stdin and not self._proc.stdin.closed:
            self._proc.stdin.close()
        try:
            self._proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self._proc.kill()


# Module-level singleton. One subprocess per Python process.
_sim_instance: _Sim | None = None
_sim_instance_lock = threading.Lock()


def _get_sim() -> _Sim:
    global _sim_instance
    with _sim_instance_lock:
        if _sim_instance is None:
            _sim_instance = _Sim()
            atexit.register(_sim_instance.close)
        return _sim_instance


def render_tile(config: RenderConfig, tile_id: int) -> bytes:
    """Render one tile. Returns 32768 bytes of nibble-packed 4-bit indices."""
    if not 0 <= tile_id <= 15:
        raise ValueError(f"tile_id must be 0..15, got {tile_id}")

    sim = _get_sim()
    msg_type, returned_id, payload = sim.request({
        "cmd":          "render_tile",
        "tile_id":      tile_id,
        "pan_x":        config.pan_x,
        "pan_y":        config.pan_y,
        "zoom":         config.zoom,
        "fractal_type": config.fractal_type,
        "julia_c_real": config.julia_c_real,
        "julia_c_imag": config.julia_c_imag,
        "max_iter":     config.max_iter,
    })
    if msg_type == _MSG_ERROR:
        raise SimError(payload.decode("utf-8", errors="replace"))
    if msg_type != _MSG_TILE:
        raise SimError(f"expected tile, got {msg_type:#x}")
    if returned_id != tile_id:
        raise SimError(f"tile_id mismatch: sent {tile_id}, got {returned_id}")
    if len(payload) != TILE_BYTES:
        raise SimError(f"expected {TILE_BYTES} bytes, got {len(payload)}")
    return payload


async def render_image(config: RenderConfig):
    """Render all 16 tiles in one command, yielding (tile_id, bytes) per tile.

    One round trip to the C++ binary (render_image command). The binary
    computes all 16 tiles in parallel threads, then streams each frame back.
    All frames are collected in one asyncio.to_thread call — no per-frame
    queue overhead — then yielded synchronously. The event loop is free for
    the full duration of the C++ compute.
    """
    cmd = {
        "cmd":          "render_image",
        "pan_x":        config.pan_x,
        "pan_y":        config.pan_y,
        "zoom":         config.zoom,
        "fractal_type": config.fractal_type,
        "julia_c_real": config.julia_c_real,
        "julia_c_imag": config.julia_c_imag,
        "max_iter":     config.max_iter,
        "preview":      config.preview,
    }
    sim = _get_sim()

    # Collect all 16 frames in a single thread call. The C++ side has already
    # parallelised the compute — by the time request_stream returns the first
    # frame, all tiles are computed and sitting in write_frame buffers.
    #
    # FPGA-day cleanup: when the C++ subprocess is replaced by a Pynq
    # driver, the underlying read is already non-blocking — the PL writes
    # the framebuffer via AXI HP / DMA and signals "done" via an IRQ.
    # At that point this `asyncio.to_thread(...)` wrapper can be dropped
    # entirely in favour of a direct synchronous fetch on the event loop:
    #   frames = pynq_driver.fetch_all(cmd)
    # Saves ~3 ms of thread-pool dispatch + context switch per render.
    frames = await asyncio.to_thread(
        lambda: list(sim.request_stream(cmd, TILES_PER_IMAGE))
    )

    for msg_type, tile_id, payload in frames:
        if msg_type == _MSG_ERROR:
            raise SimError(payload.decode("utf-8", errors="replace"))
        if msg_type != _MSG_TILE:
            raise SimError(f"expected tile, got {msg_type:#x}")
        if len(payload) != TILE_BYTES:
            raise SimError(f"expected {TILE_BYTES} bytes, got {len(payload)}")
        yield tile_id, payload


def ping() -> None:
    """Verify the sim is alive. Raises SimError if not."""
    sim = _get_sim()
    msg_type, _, _ = sim.request({"cmd": "ping"})
    if msg_type != _MSG_PONG:
        raise SimError(f"expected pong, got {msg_type:#x}")
