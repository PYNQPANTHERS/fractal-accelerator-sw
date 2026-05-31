"""Wire-format parsing and packing.

Incoming (browser -> server): JSON text frames.
Outgoing (server -> browser): binary chunk frames.

Binary chunk frame layout:
  byte 0      : message_type = 0x01
  byte 1      : panel_id (0=mandelbrot main, 1=julia main,
                           2=mandelbrot minimap, 3=julia minimap)
  byte 2      : chunk_id (0..15, 256 x 256 browser chunk)
  bytes 3-4   : frame_seq, uint16 little-endian
  bytes 5-6   : width,     uint16 little-endian
  bytes 7-8   : height,    uint16 little-endian
  byte 9      : pixel_format = 0x10 (4-bit indices, nibble-packed, low first)
  bytes 10-15 : reserved (zeros)
  bytes 16..  : payload — width*height/2 bytes
"""

from __future__ import annotations

import json
import struct
from dataclasses import dataclass
from typing import Any

from sim.config import RenderConfig


# ── Panel IDs ─────────────────────────────────────────────────────────────────

PANEL_MANDELBROT_MAIN    = 0
PANEL_JULIA_MAIN         = 1
PANEL_MANDELBROT_MINIMAP = 2
PANEL_JULIA_MINIMAP      = 3

# ── Binary frame constants ────────────────────────────────────────────────────

MSG_CHUNK        = 0x01
MSG_CHUNK_BUNDLE = 0x02      # all chunks for one render, one WS frame
PIXEL_FMT_4BIT  = 0x10       # nibble-packed 4-bit indices, low nibble first
CHUNK_PIXELS     = 256

_HEADER_FMT  = "<BBBHHHB6x"   # 16 bytes: 10 data + 6 reserved zeros
_HEADER_SIZE = struct.calcsize(_HEADER_FMT)  # 16


# ── Incoming message types ────────────────────────────────────────────────────

@dataclass
class SetViewMessage:
    """Browser is panning or zooming a main panel."""
    panel_id:  int
    frame_seq: int
    pan_x:     float
    pan_y:     float
    zoom:      int
    fractal_type: str
    julia_c_real: float = 0.0
    julia_c_imag: float = 0.0
    max_iter:  int = 256
    # "full" (default) for crisp output, "preview" for the fast
    # subsampled path the client uses during active drag.
    quality:   str = "full"
    # "active" while a pointer drag is streaming, "final" for the
    # release/settled viewport, "idle" for ordinary non-drag updates.
    interaction: str = "idle"


@dataclass
class SetModeMessage:
    """Browser toggled the scheduling mode."""
    mode: str   # "performance" | "live_evolution"


@dataclass
class SetMinimapsMessage:
    """Browser toggled frontend minimap visibility."""
    enabled: bool
    frame_seq: int = 0


@dataclass
class SetTelemetryMessage:
    """Browser toggled workload telemetry streaming."""
    enabled: bool


@dataclass
class UnknownMessage:
    raw: dict[str, Any]


ParsedMessage = (
    SetViewMessage
    | SetModeMessage
    | SetMinimapsMessage
    | SetTelemetryMessage
    | UnknownMessage
)


def parse_message(text: str) -> ParsedMessage:
    """Parse one JSON text frame from the browser."""
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return UnknownMessage(raw={"raw_text": text})

    msg_type = data.get("type", "")

    if msg_type == "set_view":
        try:
            quality = str(data.get("quality", "full"))
            if quality not in ("full", "preview"):
                quality = "full"
            interaction = str(data.get("interaction", "idle"))
            if interaction not in ("idle", "active", "final"):
                interaction = "idle"
            return SetViewMessage(
                panel_id     = int(data["panel_id"]),
                frame_seq    = int(data.get("frame_seq", 0)),
                pan_x        = float(data["pan_x"]),
                pan_y        = float(data["pan_y"]),
                zoom         = int(data["zoom"]),
                fractal_type = str(data["fractal_type"]),
                julia_c_real = float(data.get("julia_c_real", 0.0)),
                julia_c_imag = float(data.get("julia_c_imag", 0.0)),
                max_iter     = int(data.get("max_iter", 256)),
                quality      = quality,
                interaction  = interaction,
            )
        except (KeyError, ValueError, TypeError):
            return UnknownMessage(raw=data)

    if msg_type == "set_mode":
        mode = data.get("mode", "")
        if mode in ("performance", "live_evolution"):
            return SetModeMessage(mode=mode)
        return UnknownMessage(raw=data)

    if msg_type == "set_minimaps":
        try:
            return SetMinimapsMessage(
                enabled=bool(data.get("enabled", True)),
                frame_seq=int(data.get("frame_seq", 0)),
            )
        except (ValueError, TypeError):
            return UnknownMessage(raw=data)

    if msg_type == "set_telemetry":
        return SetTelemetryMessage(enabled=bool(data.get("enabled", False)))

    return UnknownMessage(raw=data)


def set_view_to_config(msg: SetViewMessage) -> RenderConfig:
    """Convert a SetViewMessage into a RenderConfig for the renderer."""
    return RenderConfig(
        pan_x        = msg.pan_x,
        pan_y        = msg.pan_y,
        zoom         = msg.zoom,
        fractal_type = msg.fractal_type,
        julia_c_real = msg.julia_c_real,
        julia_c_imag = msg.julia_c_imag,
        max_iter     = msg.max_iter,
        preview      = (msg.quality == "preview"),
    )


# ── Outgoing frame packing ────────────────────────────────────────────────────

def pack_chunk_frame(panel_id:  int,
                     chunk_id:  int,
                     frame_seq: int,
                     payload:   bytes,
                     width:     int = CHUNK_PIXELS,
                     height:    int = CHUNK_PIXELS) -> bytes:
    """Pack one 256 x 256 browser chunk into a binary WebSocket frame."""
    header = struct.pack(
        _HEADER_FMT,
        MSG_CHUNK,
        panel_id,
        chunk_id,
        frame_seq & 0xFFFF,
        width,
        height,
        PIXEL_FMT_4BIT,
    )
    return header + payload


def pack_chunk_bundle(panel_id:  int,
                      frame_seq: int,
                      chunks:    list[tuple[int, bytes]],
                      width:     int = CHUNK_PIXELS,
                      height:    int = CHUNK_PIXELS) -> bytes:
    """Pack all browser chunks for one render into one WS binary frame.

    Format:
      bytes 0-15  : header (same 16-byte layout as pack_chunk_frame,
                    but msg_type = MSG_CHUNK_BUNDLE and the byte that
                    is chunk_id in a single frame is now chunk_count).
      bytes 16..  : N chunk records, each = (u8 chunk_id) + (w*h/2 payload).

    Sending one bundled frame instead of N separate chunk frames removes
    N x ws.send overhead per render. Current geometry is 16 x 32 KB chunks.
    """
    chunk_count = len(chunks)
    if chunk_count > 255:
        raise ValueError(f"chunk_count {chunk_count} > 255")
    header = struct.pack(
        _HEADER_FMT,
        MSG_CHUNK_BUNDLE,
        panel_id,
        chunk_count,
        frame_seq & 0xFFFF,
        width,
        height,
        PIXEL_FMT_4BIT,
    )
    # Pre-size the bytearray and fill in one pass. bytes.join would
    # also work but allocates more temporaries.
    payload_bytes_per_chunk = (width * height) // 2
    record_size = 1 + payload_bytes_per_chunk
    out = bytearray(_HEADER_SIZE + chunk_count * record_size)
    out[:_HEADER_SIZE] = header
    pos = _HEADER_SIZE
    for chunk_id, payload in chunks:
        out[pos] = chunk_id & 0xFF
        out[pos + 1 : pos + 1 + payload_bytes_per_chunk] = payload
        pos += record_size
    return bytes(out)
