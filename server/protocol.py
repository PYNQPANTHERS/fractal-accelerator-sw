"""Wire-format parsing and packing.

Incoming (browser -> server): JSON text frames.
Outgoing (server -> browser): binary tile frames.

Binary tile frame layout (matches docs/wire-format.md):
  byte 0      : message_type = 0x01
  byte 1      : panel_id (0=mandelbrot main, 1=julia main,
                           2=mandelbrot minimap, 3=julia minimap)
  byte 2      : tile_id (0..15)
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

MSG_TILE        = 0x01
MSG_TILE_BUNDLE = 0x02       # all tiles for one render, one WS frame
PIXEL_FMT_4BIT  = 0x10       # nibble-packed 4-bit indices, low nibble first
TILE_PIXELS     = 256

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
    """Browser toggled minimap rendering."""
    enabled: bool
    frame_seq: int = 0


@dataclass
class UnknownMessage:
    raw: dict[str, Any]


ParsedMessage = SetViewMessage | SetModeMessage | SetMinimapsMessage | UnknownMessage


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

def pack_tile_frame(panel_id:  int,
                    tile_id:   int,
                    frame_seq: int,
                    payload:   bytes,
                    width:     int = TILE_PIXELS,
                    height:    int = TILE_PIXELS) -> bytes:
    """Pack one tile into a binary WebSocket frame ready to send."""
    header = struct.pack(
        _HEADER_FMT,
        MSG_TILE,
        panel_id,
        tile_id,
        frame_seq & 0xFFFF,
        width,
        height,
        PIXEL_FMT_4BIT,
    )
    return header + payload


def pack_tile_bundle(panel_id:  int,
                     frame_seq: int,
                     tiles:     list[tuple[int, bytes]],
                     width:     int = TILE_PIXELS,
                     height:    int = TILE_PIXELS) -> bytes:
    """Pack all tiles for one render into a single WS binary frame.

    Format:
      bytes 0-15  : header (same 16-byte layout as pack_tile_frame,
                    but msg_type = MSG_TILE_BUNDLE and the byte that
                    used to be tile_id is now tile_count).
      bytes 16..  : N tile records, each = (u8 tile_id) + (w*h/2 payload).

    Sending one ~800 KB frame instead of 25 × ~32.8 KB frames removes
    25 × ws.send overhead per render.
    """
    tile_count = len(tiles)
    if tile_count > 255:
        raise ValueError(f"tile_count {tile_count} > 255")
    header = struct.pack(
        _HEADER_FMT,
        MSG_TILE_BUNDLE,
        panel_id,
        tile_count,
        frame_seq & 0xFFFF,
        width,
        height,
        PIXEL_FMT_4BIT,
    )
    # Pre-size the bytearray and fill in one pass. bytes.join would
    # also work but allocates more temporaries.
    payload_bytes_per_tile = (width * height) // 2
    record_size = 1 + payload_bytes_per_tile
    out = bytearray(_HEADER_SIZE + tile_count * record_size)
    out[:_HEADER_SIZE] = header
    pos = _HEADER_SIZE
    for tile_id, payload in tiles:
        out[pos] = tile_id & 0xFF
        out[pos + 1 : pos + 1 + payload_bytes_per_tile] = payload
        pos += record_size
    return bytes(out)
