// Shared internal kernel: iteration + band remap.
//
// Both the brute-force compute_tile (iterate.cpp) and the Mariani-
// Silver compute_tile_mariani (mariani_silver.cpp) use these inlines.
// Defined in a header so each TU can inline the hot loop.

#pragma once

#include <cmath>
#include <cstdint>

namespace fractal_sim {

// Iterate z^2 + c (or burning-ship variant) up to max_iter and return
// the escape iteration count, or max_iter if it never escaped.
inline int iterate_z2c(double z_re, double z_im,
                       double c_re, double c_im,
                       int max_iter,
                       bool burning_ship) {
    for (int i = 0; i < max_iter; ++i) {
        if (burning_ship) {
            z_re = std::fabs(z_re);
            z_im = std::fabs(z_im);
        }
        const double new_re = z_re * z_re - z_im * z_im + c_re;
        const double new_im = 2.0 * z_re * z_im + c_im;
        z_re = new_re;
        z_im = new_im;
        if (z_re * z_re + z_im * z_im > 4.0) {
            return i;
        }
    }
    return max_iter;
}

// Remap an iteration count to a 4-bit palette band (0..15). In-set
// points (iters >= max_iter) map to band 0; escaped points spread
// across bands 1..15 on a log1p scale so deep zooms keep boundary
// structure visible.
inline uint8_t band_for(int iters, int max_iter) {
    if (iters >= max_iter) return 0;
    const double t = std::log1p(static_cast<double>(iters))
                   / std::log1p(static_cast<double>(max_iter));
    int band = 1 + static_cast<int>(t * 14.999);
    if (band < 1) band = 1;
    if (band > 15) band = 15;
    return static_cast<uint8_t>(band);
}

}  // namespace fractal_sim
