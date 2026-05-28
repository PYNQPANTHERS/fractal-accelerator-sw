"""Contract tests for the simulator.

Every test exercises the full Python -> C++ -> Python round trip via the
real subprocess. If the C++ binary isn't built, all tests skip (so a fresh
clone doesn't see a wall of failures before someone has run cmake).

Run from the repo root:
    pytest tests/
"""

from __future__ import annotations

import collections
from pathlib import Path

import pytest

from sim.config import RenderConfig
from sim.renderer import (
    SimError,
    TILE_BYTES,
    _BINARY_PATH,
    ping,
    render_tile,
)


# All tests skip cleanly if the sim binary hasn't been built yet.
pytestmark = pytest.mark.skipif(
    not _BINARY_PATH.exists(),
    reason=f"sim binary not built at {_BINARY_PATH}",
)


# ---------- helpers ----------

def _unpack_nibbles(payload: bytes) -> list[int]:
    """Return the per-pixel palette indices (0..15) from a packed tile."""
    out: list[int] = []
    for b in payload:
        out.append(b & 0x0F)
        out.append(b >> 4)
    return out


@pytest.fixture
def default_mandelbrot() -> RenderConfig:
    return RenderConfig(pan_x=-0.5, pan_y=0.0, zoom=0, fractal_type="mandelbrot")


# ---------- protocol-level checks ----------

def test_ping():
    """A round-trip ping should not raise."""
    ping()


def test_tile_size(default_mandelbrot):
    """A rendered tile is always exactly TILE_BYTES."""
    payload = render_tile(default_mandelbrot, 0)
    assert len(payload) == TILE_BYTES


def test_palette_indices_in_range(default_mandelbrot):
    """Every pixel's palette index fits in 4 bits (0..15)."""
    payload = render_tile(default_mandelbrot, 5)
    indices = _unpack_nibbles(payload)
    assert all(0 <= i <= 15 for i in indices)


# ---------- correctness sanity ----------

def test_mandelbrot_centre_tile_has_variety(default_mandelbrot):
    """Tile 5 covers the middle of the image. It should contain a mix
    of in-set pixels (band 15) and escape pixels (lower bands) — not a
    single uniform colour."""
    payload = render_tile(default_mandelbrot, 5)
    indices = _unpack_nibbles(payload)
    distinct = len(set(indices))
    assert distinct >= 8, f"expected variety, got {distinct} distinct bands"


def test_mandelbrot_corner_tile_mostly_escaped(default_mandelbrot):
    """Tile 0 is the top-left corner. At zoom 0 with pan=(-0.5,0), this
    is entirely outside the set, so most pixels escape quickly (low band)
    and very few are at band 15."""
    payload = render_tile(default_mandelbrot, 0)
    counts = collections.Counter(_unpack_nibbles(payload))
    in_set = counts.get(15, 0)
    assert in_set < 1000, (
        f"corner tile has {in_set} in-set pixels — expected near zero "
        f"for an exterior region"
    )


def test_julia_renders():
    """Julia at Douady's rabbit (c = -0.7 + 0.27i) renders cleanly."""
    cfg = RenderConfig(
        pan_x=0.0,
        pan_y=0.0,
        zoom=0,
        fractal_type="julia",
        julia_c_real=-0.7,
        julia_c_imag=0.27,
    )
    payload = render_tile(cfg, 5)
    assert len(payload) == TILE_BYTES
    indices = _unpack_nibbles(payload)
    assert len(set(indices)) >= 4   # at least a handful of distinct bands


def test_burning_ship_renders():
    cfg = RenderConfig(
        pan_x=-0.5,
        pan_y=-0.5,
        zoom=0,
        fractal_type="burning_ship",
    )
    payload = render_tile(cfg, 5)
    assert len(payload) == TILE_BYTES


# ---------- validation paths ----------

def test_tile_id_out_of_range_rejected_clientside(default_mandelbrot):
    """tile_id < 0 or > 15 raises ValueError before reaching the sim."""
    with pytest.raises(ValueError, match="tile_id must be 0..15"):
        render_tile(default_mandelbrot, 99)


def test_unknown_fractal_type_surfaces_as_sim_error():
    """A bad fractal_type passes Python's check but fails sim-side; the
    sim's error frame becomes a SimError with the C++ message."""
    cfg = RenderConfig(pan_x=0, pan_y=0, zoom=0, fractal_type="spirals")
    with pytest.raises(SimError, match="unknown fractal_type"):
        render_tile(cfg, 0)


# ---------- determinism ----------

def test_same_config_yields_same_bytes(default_mandelbrot):
    """The sim is deterministic — same inputs, identical bytes."""
    a = render_tile(default_mandelbrot, 5)
    b = render_tile(default_mandelbrot, 5)
    assert a == b
