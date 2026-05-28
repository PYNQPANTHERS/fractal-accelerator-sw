from dataclasses import dataclass


TILE_PIXELS = 256          # one tile is TILE_PIXELS x TILE_PIXELS pixels
TILE_BYTES = TILE_PIXELS * TILE_PIXELS // 2   # nibble-packed: two pixels per byte


@dataclass(frozen=True)
class RenderConfig:
    """One render request.
    Fields mirror the AXI register map's PL-facing config — same shape on
    both sides so the sim and real driver can be swapped behind the same
    interface ... hopefuly.
    """

    pan_x: float
    pan_y: float
    zoom: int
    fractal_type: str         # "mandelbrot" | "julia" | "burning_ship"
    julia_c_real: float = 0.0
    julia_c_imag: float = 0.0


def render_tile(config: RenderConfig, tile_id: int) -> bytes:
    """Return one tile's worth of pixel data """

    if not 0 <= tile_id <= 15:
        raise ValueError(f"tile_id must be 0..15, got {tile_id}")

    out = bytearray(TILE_BYTES)
    for row in range(TILE_PIXELS):
        for col in range(0, TILE_PIXELS, 2):
            # Two pixels per byte: low nibble = even column, high nibble = odd
            low = (col * 16) // TILE_PIXELS
            high = ((col + 1) * 16) // TILE_PIXELS
            out[(row * TILE_PIXELS + col) // 2] = (high << 4) | low
    return bytes(out)
    max_iter: int = 256
