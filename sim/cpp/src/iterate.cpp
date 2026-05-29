#include "iterate.hpp"
#include "kernel.hpp"

#include <cmath>

namespace fractal_sim {

// Write a 4-bit band into the nibble-packed output buffer at (px, py).
inline void write_pixel(TileBuffer& out, int px, int py, uint8_t band) {
    const int linear_pixel = py * TILE_PIXELS + px;
    const std::size_t byte_idx = linear_pixel / 2;
    if (px % 2 == 0) {
        // Clear the low nibble before writing (= becomes |=) so that
        // preview-mode 2x2 broadcasts don't OR into garbage when the
        // same byte is touched twice.
        const auto cur = out[byte_idx];
        out[byte_idx] = (cur & std::byte{0xF0})
                        | std::byte{band};
    } else {
        const auto cur = out[byte_idx];
        out[byte_idx] = (cur & std::byte{0x0F})
                        | std::byte{static_cast<uint8_t>(band << 4)};
    }
}

void compute_tile(TileBuffer& out,
                  int tile_id,
                  double pan_x,
                  double pan_y,
                  int zoom,
                  int max_iter,
                  const std::string& fractal_type,
                  double julia_c_real,
                  double julia_c_imag,
                  bool preview) {
    const bool is_julia        = (fractal_type == "julia");
    const bool is_burning_ship = (fractal_type == "burning_ship");

    // pixel_size = complex-plane width of one pixel. window is the
    // *visible* viewport's complex span (VISIBLE_PIXELS = 1024). The
    // rendered image is larger (IMAGE_PIXELS) and its extra pixels
    // extend outward as pan margin. centre_off centres the *image*
    // (not the visible region) on the pan point so the visible centre
    // ends up exactly at (pan_x, pan_y).
    const double window     = WINDOW_AT_ZOOM_0 / std::pow(2.0, zoom);
    const double pixel_size = window / VISIBLE_PIXELS;
    const double centre_off = IMAGE_PIXELS / 2.0;

    const int tile_col   = tile_id % TILES_PER_SIDE;
    const int tile_row   = tile_id / TILES_PER_SIDE;
    const int col_origin = tile_col * TILE_PIXELS;
    const int row_origin = tile_row * TILE_PIXELS;

    // Stride: full quality = 1 pixel per cell; preview = 1 pixel per
    // 2x2 block, broadcast.
    const int stride = preview ? 2 : 1;

    for (int py = 0; py < TILE_PIXELS; py += stride) {
        const double y_complex = (row_origin + py - centre_off) * pixel_size + pan_y;

        for (int px = 0; px < TILE_PIXELS; px += stride) {
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

            if (stride == 1) {
                write_pixel(out, px, py, band);
            } else {
                // Preview: broadcast to the 2x2 super-pixel block.
                write_pixel(out, px,     py,     band);
                write_pixel(out, px + 1, py,     band);
                write_pixel(out, px,     py + 1, band);
                write_pixel(out, px + 1, py + 1, band);
            }
        }
    }
}

}  // namespace fractal_sim
