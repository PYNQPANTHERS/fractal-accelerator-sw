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
from collections.abc import Iterator
import json
import struct
import subprocess
import threading
import time
from pathlib import Path

from sim.config import RenderConfig


CHUNK_PIXELS = 256
CHUNK_BYTES  = CHUNK_PIXELS * CHUNK_PIXELS // 2   # 32768
# 4x4 grid of 256-px browser chunks: 1024-px rendered image, no pre-rendered
# pan margin in the current fast path.
CHUNKS_PER_IMAGE = 16

# Frame format from sim/cpp/src/response.hpp:
#   byte 0    : message_type
#   byte 1    : chunk_id
#   bytes 2-5 : payload length, little-endian uint32
_HEADER_FMT  = "<BBI"
_HEADER_SIZE = struct.calcsize(_HEADER_FMT)   # 6

_MSG_CHUNK = 0x01
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
        msg_type, chunk_id, length = struct.unpack(_HEADER_FMT, header)
        payload = self._proc.stdout.read(length) if length > 0 else b""
        if len(payload) < length:
            raise SimError(
                f"sim stdout closed mid-payload ({len(payload)}/{length} bytes)"
            )
        return msg_type, chunk_id, payload

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


def render_chunk(config: RenderConfig, chunk_id: int) -> bytes:
    """Render one chunk. Returns 32768 bytes of nibble-packed 4-bit indices."""
    if not 0 <= chunk_id <= 15:
        raise ValueError(f"chunk_id must be 0..15, got {chunk_id}")

    sim = _get_sim()
    msg_type, returned_id, payload = sim.request({
        "cmd":          "render_chunk",
        "chunk_id":     chunk_id,
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
    if msg_type != _MSG_CHUNK:
        raise SimError(f"expected chunk, got {msg_type:#x}")
    if returned_id != chunk_id:
        raise SimError(f"chunk_id mismatch: sent {chunk_id}, got {returned_id}")
    if len(payload) != CHUNK_BYTES:
        raise SimError(f"expected {CHUNK_BYTES} bytes, got {len(payload)}")
    return payload


async def render_image(config: RenderConfig):
    """Render all 16 chunks, yielding (chunk_id, bytes, elapsed_ms) per chunk.

    One round trip to the C++ binary (render_image command). The binary
    computes all 16 browser chunks in parallel threads and streams each frame back
    as its worker completes. The elapsed_ms value is measured at the Python
    driver boundary, which mirrors the future Pynq path: chunk-ready status
    received by PS, then forwarded to the websocket layer.
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

    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[
        tuple[float, int, int, bytes] | BaseException | None
    ] = asyncio.Queue()
    started = time.perf_counter()

    def stream_frames() -> None:
        try:
            for msg_type, chunk_id, payload in sim.request_stream(
                cmd,
                CHUNKS_PER_IMAGE,
            ):
                elapsed_ms = (time.perf_counter() - started) * 1000.0
                loop.call_soon_threadsafe(
                    queue.put_nowait,
                    (elapsed_ms, msg_type, chunk_id, payload),
                )
        except BaseException as exc:
            loop.call_soon_threadsafe(queue.put_nowait, exc)
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, None)

    threading.Thread(target=stream_frames, daemon=True).start()

    while True:
        item = await queue.get()
        if item is None:
            break
        if isinstance(item, BaseException):
            raise item

        elapsed_ms, msg_type, chunk_id, payload = item
        if msg_type == _MSG_ERROR:
            raise SimError(payload.decode("utf-8", errors="replace"))
        if msg_type != _MSG_CHUNK:
            raise SimError(f"expected chunk, got {msg_type:#x}")
        if len(payload) != CHUNK_BYTES:
            raise SimError(f"expected {CHUNK_BYTES} bytes, got {len(payload)}")
        yield chunk_id, payload, elapsed_ms


def ping() -> None:
    """Verify the sim is alive. Raises SimError if not."""
    sim = _get_sim()
    msg_type, _, _ = sim.request({"cmd": "ping"})
    if msg_type != _MSG_PONG:
        raise SimError(f"expected pong, got {msg_type:#x}")
