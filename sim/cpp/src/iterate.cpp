#include "iterate.hpp"

#include <cmath>

namespace fractal_sim {

namespace {

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
        // z = z*z + c
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

// Remap an escape iteration count (0..max_iter) to a 4-bit palette band
// (0..15). Points that never escaped map to band 0 (the in-set colour).
// Logarithmic banding keeps the boundary visible at any iteration cap —
// without it, deep zooms collapse to a single band.
inline uint8_t band_for(int iters, int max_iter) {
    if (iters >= max_iter) return 0;
    // log1p-scaled, then split into 15 outer bands (1..15).
    const double t = std::log1p(static_cast<double>(iters))
                   / std::log1p(static_cast<double>(max_iter));
    int band = 1 + static_cast<int>(t * 14.999);
    if (band < 1) band = 1;
    if (band > 15) band = 15;
    return static_cast<uint8_t>(band);
}

}  // anonymous namespace

void compute_tile(TileBuffer& out,
                  int tile_id,
                  double pan_x,
                  double pan_y,
                  int zoom,
                  int max_iter,
                  const std::string& fractal_type,
                  double julia_c_real,
                  double julia_c_imag) {
    const bool is_julia        = (fractal_type == "julia");
    const bool is_burning_ship = (fractal_type == "burning_ship");

    const double window     = WINDOW_AT_ZOOM_0 / std::pow(2.0, zoom);
    const double pixel_size = window / IMAGE_PIXELS;
    const double centre_off = IMAGE_PIXELS / 2.0;

    const int tile_col   = tile_id % TILES_PER_SIDE;
    const int tile_row   = tile_id / TILES_PER_SIDE;
    const int col_origin = tile_col * TILE_PIXELS;
    const int row_origin = tile_row * TILE_PIXELS;

    for (int py = 0; py < TILE_PIXELS; ++py) {
        const double y_complex = (row_origin + py - centre_off) * pixel_size + pan_y;

        for (int px = 0; px < TILE_PIXELS; ++px) {
            const double x_complex = (col_origin + px - centre_off) * pixel_size + pan_x;

            double z_re, z_im, c_re, c_im;
            if (is_julia) {
                z_re = x_complex;
                z_im = y_complex;
                c_re = julia_c_real;
                c_im = julia_c_imag;
            } else {
                z_re = 0.0;
                z_im = 0.0;
                c_re = x_complex;
                c_im = y_complex;
            }

            const int iters = iterate_z2c(z_re, z_im, c_re, c_im,
                                          max_iter, is_burning_ship);
            const uint8_t band = band_for(iters, max_iter);

            const int linear_pixel = py * TILE_PIXELS + px;
            const std::size_t byte_idx = linear_pixel / 2;
            if (px % 2 == 0) {
                out[byte_idx] = std::byte{band};
            } else {
                out[byte_idx] |= std::byte{static_cast<uint8_t>(band << 4)};
            }
        }
    }
}

}  // namespace fractal_sim
