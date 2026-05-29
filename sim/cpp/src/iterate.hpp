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
// rendered image is oversized — we render a 6x6 grid (1536 px) so the
// centre 4x4 (1024 px) is visible to the user and the surrounding ring
// of sixteenths is a pre-rendered margin that the canvas can pan into
// without waiting for a new render. The PL doesn't care that we ask for
// 36 sixteenths instead of 16; Mariani-Silver on the FPGA makes the
// margin tiles nearly free (large in-set / far-exterior regions skip).
constexpr int  TILE_PIXELS    = 256;                       // tile side (one sixteenth)
constexpr int  VISIBLE_PIXELS = 1024;                      // centre region the user sees
constexpr int  IMAGE_PIXELS   = 1280;                      // visible + 128-px margin each side
constexpr int  TILES_PER_SIDE = IMAGE_PIXELS / TILE_PIXELS; // 5 (5x5 grid of sixteenths)
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
