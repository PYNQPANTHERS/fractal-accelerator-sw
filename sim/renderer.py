from dataclasses import dataclass

import numpy as np


TILE_PIXELS = 256          # one tile is TILE_PIXELS x TILE_PIXELS pixels
TILE_BYTES = TILE_PIXELS * TILE_PIXELS // 2   # nibble-packed: two pixels per byte
IMAGE_PIXELS = 1024        # full panel image is IMAGE_PIXELS x IMAGE_PIXELS
TILES_PER_SIDE = IMAGE_PIXELS // TILE_PIXELS  # 4
PALETTE_BANDS = 16         # 4-bit iteration count: 16 distinct values

# Width of the complex-plane window at zoom level 0. The window halves with
# each zoom step, mirroring the PL's zoom LUT.
WINDOW_AT_ZOOM_0 = 4.0


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



### Return the (col_px, row_px) of the tile's top-left in the full image.
def _tile_origin_pixels(tile_id: int) -> tuple[int, int]:
    
    col = tile_id % TILES_PER_SIDE
    row = tile_id // TILES_PER_SIDE
    return col * TILE_PIXELS, row * TILE_PIXELS



### Build the 256x256 array of complex coordinates this tile covers.
def _tile_complex_grid(config: RenderConfig, tile_id: int) -> np.ndarray:
    
    window = WINDOW_AT_ZOOM_0 / (2 ** config.zoom)
    pixel_size = window / IMAGE_PIXELS

    # Top-left of the tile in pixels relative to the image centre.
    col_origin_px, row_origin_px = _tile_origin_pixels(tile_id)
    centre_offset = IMAGE_PIXELS / 2

    xs = (np.arange(TILE_PIXELS) + col_origin_px - centre_offset) * pixel_size + config.pan_x
    ys = (np.arange(TILE_PIXELS) + row_origin_px - centre_offset) * pixel_size + config.pan_y

    # meshgrid with xs across columns, ys down rows
    X, Y = np.meshgrid(xs, ys)
    return X + 1j * Y




### Run the escape-time loop and return iteration counts quantised to 0..15.
def _iterate(z0: np.ndarray, c: np.ndarray, fractal_type: str) -> np.ndarray:

    z = z0.copy()
    iters = np.zeros(z.shape, dtype=np.uint8)
    escaped = np.zeros(z.shape, dtype=bool)

    # Escaped points keep getting squared until the loop ends - goes inf - this is ok
    with np.errstate(over="ignore", invalid="ignore"):
        for i in range(PALETTE_BANDS):
            if fractal_type == "burning_ship":
                z = (np.abs(z.real) + 1j * np.abs(z.imag)) ** 2 + c
            else:
                z = z * z + c
            newly_escaped = (~escaped) & (np.abs(z) > 2.0)
            iters[newly_escaped] = i
            escaped |= newly_escaped

    # Points that never escaped get the max-band value
    iters[~escaped] = PALETTE_BANDS - 1
    return iters




### Pack a (H, W) array of 4-bit values into bytes, two pixels per byte.
### Low nibble = even column, high nibble = odd column. Matches possible wire-format spec.
def _nibble_pack(indices: np.ndarray) -> bytes:
   
    flat = indices.reshape(-1)
    low = flat[0::2]
    high = flat[1::2]
    packed = (high << 4) | low
    return packed.astype(np.uint8).tobytes()




### Return one tile's worth of nibble-packed pixel data.
def render_tile(config: RenderConfig, tile_id: int) -> bytes:
    if not 0 <= tile_id <= 15:
        raise ValueError(f"tile_id must be 0..15, got {tile_id}")

    grid = _tile_complex_grid(config, tile_id)

    if config.fractal_type == "julia":
        c_const = complex(config.julia_c_real, config.julia_c_imag)
        z0 = grid
        c = np.full_like(grid, c_const)
    else:
        # Mandelbrot and burning_ship: z starts at zero, c is the pixel coord
        z0 = np.zeros_like(grid)
        c = grid

    indices = _iterate(z0, c, config.fractal_type)
    return _nibble_pack(indices)
    max_iter: int = 256
