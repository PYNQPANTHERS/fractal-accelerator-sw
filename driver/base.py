"""The FractalDriver contract.

Any backend that produces tiles for the server implements this interface.
Two concrete implementations live alongside:
    - SimDriver: wraps the C++ simulator (sim/cpp/)
    - PynqDriver: wraps the real PL on a Pynq board (added when PL is ready)

The server consumes only this base class, so it can be swapped at runtime
without server-side changes.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import AsyncIterator

from sim.config import RenderConfig


# Number of tiles per full image. Matches the sim's 4x4 grid.
TILES_PER_IMAGE = 16


class FractalDriver(ABC):

    @abstractmethod
    def render(self, config: RenderConfig) -> AsyncIterator[tuple[int, bytes]]:
        """Render one full image, yielding (tile_id, tile_bytes) per tile.

        Tiles arrive in implementation-defined order. The caller should
        treat each yielded tile as ready to ship as soon as it's received.
        """

    @abstractmethod
    async def ping(self) -> None:
        """Verify the backend is alive. Raises on failure."""

    @abstractmethod
    async def close(self) -> None:
        """Release any backend resources (subprocess, hardware handles)."""
