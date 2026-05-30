// Fractal iteration kernel.
//
// Takes a render request, produces one tile's worth of nibble-packed
// 4-bit iteration counts (32 KB output).

#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <string>

namespace fractal_sim {

// Geometry follows the FPGA's "sixteenth" architecture: each tile is a
// 256x256 sixteenth, processed independently by the PL cluster. The
// current software path renders exactly the visible 4x4 grid (1024 px)
// with no pre-rendered margin; larger margin experiments were tried and
// rolled back because the extra work increased frontend jitter.
constexpr int  TILE_PIXELS    = 256;                       // tile side (one sixteenth)
constexpr int  VISIBLE_PIXELS = 1024;                      // centre region the user sees
constexpr int  IMAGE_PIXELS   = 1024;                      // 4x4 grid, no margin
constexpr int  TILES_PER_SIDE = IMAGE_PIXELS / TILE_PIXELS; // 4 (4x4 grid of sixteenths)
constexpr int  PALETTE_BANDS  = 16;                        // 4-bit output (palette indices)
constexpr double WINDOW_AT_ZOOM_0 = 4.0;                   // complex window over the VISIBLE area at zoom 0

constexpr std::size_t TILE_BYTES = TILE_PIXELS * TILE_PIXELS / 2;
using TileBuffer = std::array<std::byte, TILE_BYTES>;

// Compute one tile and write its bytes into out.
//
// fractal_type must be "mandelbrot", "julia", or "burning_ship".
// tile_id is 0..15 (4x4 row-major).
// max_iter is the iteration cap; on the FPGA path this comes from a
// register, here it's the JSON field of the same name. Iterations are
// remapped to 16 palette bands for the wire format.
// `preview=true` switches to a subsampled kernel: compute one pixel per
// 2x2 block, broadcast the same band to all 4 cells. ~4x faster, with
// slightly blocky output that the client only uses during active drag.
void compute_tile(TileBuffer& out,
                  int tile_id,
                  double pan_x,
                  double pan_y,
                  int zoom,
                  int max_iter,
                  const std::string& fractal_type,
                  double julia_c_real,
                  double julia_c_imag,
                  bool preview = false);

}  // namespace fractal_sim
