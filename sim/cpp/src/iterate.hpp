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

constexpr int  TILE_PIXELS    = 256;                       // tile side length
constexpr int  IMAGE_PIXELS   = 1024;                      // full image side length
constexpr int  TILES_PER_SIDE = IMAGE_PIXELS / TILE_PIXELS; // 4 (4x4 grid of tiles)
constexpr int  PALETTE_BANDS  = 16;                        // 4-bit output (palette indices)
constexpr double WINDOW_AT_ZOOM_0 = 4.0;                   // complex-plane window at zoom 0

constexpr std::size_t TILE_BYTES = TILE_PIXELS * TILE_PIXELS / 2;
using TileBuffer = std::array<std::byte, TILE_BYTES>;

// Compute one tile and write its bytes into out.
//
// fractal_type must be "mandelbrot", "julia", or "burning_ship".
// tile_id is 0..15 (4x4 row-major).
// max_iter is the iteration cap; on the FPGA path this comes from a
// register, here it's the JSON field of the same name. Iterations are
// remapped to 16 palette bands for the wire format.
void compute_tile(TileBuffer& out,
                  int tile_id,
                  double pan_x,
                  double pan_y,
                  int zoom,
                  int max_iter,
                  const std::string& fractal_type,
                  double julia_c_real,
                  double julia_c_imag);

}  // namespace fractal_sim
