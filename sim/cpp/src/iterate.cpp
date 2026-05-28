#include "iterate.hpp"

#include <cmath>

namespace fractal_sim {

namespace {

// Iterate one pixel of z^2 + c (Mandelbrot/Julia formula). Returns the
// quantised iteration count 0..PALETTE_BANDS-1.
inline uint8_t iterate_z2c(double z_re, double z_im,
                           double c_re, double c_im,
                           bool burning_ship) {
    for (int i = 0; i < PALETTE_BANDS; ++i) {
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
            return static_cast<uint8_t>(i);
        }
    }
    // Never escaped — assign the "in-set" colour (max band).
    return PALETTE_BANDS - 1;
}

}  // anonymous namespace

void compute_tile(TileBuffer& out,
                  int tile_id,
                  double pan_x,
                  double pan_y,
                  int zoom,
                  const std::string& fractal_type,
                  double julia_c_real,
                  double julia_c_imag) {
    const bool is_julia        = (fractal_type == "julia");
    const bool is_burning_ship = (fractal_type == "burning_ship");

    // Viewport math: pixel coordinates -> complex plane.
    // Window halves with each zoom step (matches the PL's zoom LUT).
    const double window     = WINDOW_AT_ZOOM_0 / std::pow(2.0, zoom);
    const double pixel_size = window / IMAGE_PIXELS;
    const double centre_off = IMAGE_PIXELS / 2.0;

    // Top-left of the tile in pixels relative to the image origin.
    const int tile_col = tile_id % TILES_PER_SIDE;
    const int tile_row = tile_id / TILES_PER_SIDE;
    const int col_origin = tile_col * TILE_PIXELS;
    const int row_origin = tile_row * TILE_PIXELS;

    for (int py = 0; py < TILE_PIXELS; ++py) {
        const double y_complex = (row_origin + py - centre_off) * pixel_size + pan_y;

        for (int px = 0; px < TILE_PIXELS; ++px) {
            const double x_complex = (col_origin + px - centre_off) * pixel_size + pan_x;

            double z_re, z_im, c_re, c_im;
            if (is_julia) {
                // Julia: z starts at pixel coord, c is the global constant.
                z_re = x_complex;
                z_im = y_complex;
                c_re = julia_c_real;
                c_im = julia_c_imag;
            } else {
                // Mandelbrot / Burning Ship: z starts at zero, c is the pixel coord.
                z_re = 0.0;
                z_im = 0.0;
                c_re = x_complex;
                c_im = y_complex;
            }

            const uint8_t band = iterate_z2c(z_re, z_im, c_re, c_im, is_burning_ship);

            // Nibble-pack: two pixels per byte, low nibble = even column.
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
