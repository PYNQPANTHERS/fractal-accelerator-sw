"""Python-side client for the C++ simulator binary.

The simulator itself is a long-running C++ process in sim/cpp/. This module
will speak the stdio protocol to it: JSON commands on stdin, framed binary
tile responses on stdout.

For now this is a stub. The C++ binary lands in subsequent commits.
"""

from sim.config import RenderConfig


TILE_PIXELS = 256          # one tile is TILE_PIXELS x TILE_PIXELS pixels
TILE_BYTES = TILE_PIXELS * TILE_PIXELS // 2   # nibble-packed: two pixels per byte


def render_tile(config: RenderConfig, tile_id: int) -> bytes:
    """Render one tile by calling out to the C++ simulator.

    Not implemented yet — wired up once sim/cpp/ produces a working binary.
    """
    raise NotImplementedError("sim/cpp binary not yet wired in")
