// Mariani-Silver fractal tile renderer.
//
// Recursive quadtree subdivision. Instead of iterating every pixel,
// we sample the perimeter of a sub-rectangle and check whether all
// perimeter pixels give the same iteration band. When they do, the
// Maximum-Modulus Principle guarantees the interior is uniform too —
// we flood-fill the band instead of iterating. Otherwise we split
// the rectangle into 4 quadrants and recurse.
//
// At a leaf size (rectangles smaller than MS_LEAF_PX) we fall back
// to the brute-force iterator from iterate.cpp.
//
// This mirrors the FPGA cluster's per-sixteenth Mariani-Silver loop
// described in fractal-accelerator-rtl/README.md.

#pragma once

#include "iterate.hpp"

namespace fractal_sim {

// Below this size (px on a side) we just iterate every pixel.
// Tuned empirically: smaller leaves cost more perimeter overhead;
// larger leaves miss small fractal features.
constexpr int MS_LEAF_PX = 8;

// Same signature/output format as compute_tile (which we keep around
// for the preview path and for fallback). Renders one 256x256 tile.
void compute_tile_mariani(TileBuffer& out,
                          int tile_id,
                          double pan_x,
                          double pan_y,
                          int zoom,
                          int max_iter,
                          const std::string& fractal_type,
                          double julia_c_real,
                          double julia_c_imag);

}  // namespace fractal_sim
