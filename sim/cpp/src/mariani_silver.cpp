#include "mariani_silver.hpp"
#include "kernel.hpp"

#include <cstddef>
#include <cstdint>

namespace fractal_sim {

namespace {

// Per-render-request context — geometry constants and the destination
// buffer. Captured once and passed by reference into the recursion so
// the hot path stays small.
struct RenderCtx {
    ChunkBuffer&        out;
    int                chunk_col_origin;   // px-relative to image
    int                chunk_row_origin;
    double             pixel_size;        // complex-plane units per pixel
    double             centre_off;        // IMAGE_PIXELS / 2.0
    double             pan_x;
    double             pan_y;
    int                max_iter;
    bool               is_julia;
    bool               is_burning_ship;
    double             julia_c_real;
    double             julia_c_imag;
};

// Map a chunk-local pixel coordinate (0..255) to its complex-plane point.
inline void pixel_to_complex(const RenderCtx& ctx,
                             int px, int py,
                             double& cx, double& cy) {
    cx = (ctx.chunk_col_origin + px - ctx.centre_off) * ctx.pixel_size + ctx.pan_x;
    cy = (ctx.chunk_row_origin + py - ctx.centre_off) * ctx.pixel_size + ctx.pan_y;
}

// Compute one pixel's band. Mandelbrot/Julia branch is inlined here so
// the compiler can hoist invariants out of the recursive perimeter loop.
inline uint8_t pixel_band(const RenderCtx& ctx, int px, int py) {
    double cx, cy;
    pixel_to_complex(ctx, px, py, cx, cy);
    double z_re, z_im, c_re, c_im;
    if (ctx.is_julia) {
        z_re = cx;
        z_im = cy;
        c_re = ctx.julia_c_real;
        c_im = ctx.julia_c_imag;
    } else {
        z_re = 0.0;
        z_im = 0.0;
        c_re = cx;
        c_im = cy;
    }
    const int iters = iterate_z2c(z_re, z_im, c_re, c_im,
                                  ctx.max_iter, ctx.is_burning_ship);
    return band_for(iters, ctx.max_iter);
}

// Write a 4-bit band into the nibble-packed output buffer at (px, py).
// Same packing as the brute-force kernel.
inline void write_pixel(ChunkBuffer& out, int px, int py, uint8_t band) {
    const int linear = py * CHUNK_PIXELS + px;
    const std::size_t byte_idx = linear / 2;
    if (px % 2 == 0) {
        const auto cur = out[byte_idx];
        out[byte_idx] = (cur & std::byte{0xF0}) | std::byte{band};
    } else {
        const auto cur = out[byte_idx];
        out[byte_idx] = (cur & std::byte{0x0F})
                        | std::byte{static_cast<uint8_t>(band << 4)};
    }
}

// Fill a rectangle (x0, y0)..(x0+w, y0+h) with a uniform band.
inline void fill_rect(ChunkBuffer& out, int x0, int y0,
                      int w, int h, uint8_t band) {
    for (int py = y0; py < y0 + h; ++py) {
        for (int px = x0; px < x0 + w; ++px) {
            write_pixel(out, px, py, band);
        }
    }
}

// Brute-force iterate every pixel in a rectangle. The leaf of the
// recursion when the rectangle gets small enough that perimeter cost
// approaches interior cost.
void brute_force_rect(const RenderCtx& ctx, int x0, int y0, int w, int h) {
    for (int py = y0; py < y0 + h; ++py) {
        for (int px = x0; px < x0 + w; ++px) {
            write_pixel(ctx.out, px, py, pixel_band(ctx, px, py));
        }
    }
}

// Walk the perimeter of a rectangle, returning the common band if all
// perimeter pixels have the same band, or -1 if any differ. Also
// records the perimeter pixels into the output as we go (since we'd
// have to write them later anyway).
int perimeter_uniform_band(const RenderCtx& ctx, int x0, int y0, int w, int h) {
    const uint8_t first = pixel_band(ctx, x0, y0);
    write_pixel(ctx.out, x0, y0, first);

    auto check = [&](int px, int py) -> bool {
        const uint8_t b = pixel_band(ctx, px, py);
        write_pixel(ctx.out, px, py, b);
        return b == first;
    };

    // Top edge (x0+1 .. x0+w-1, y0)
    for (int px = x0 + 1; px < x0 + w; ++px) {
        if (!check(px, y0)) return -1;
    }
    // Bottom edge (x0 .. x0+w-1, y0+h-1)
    for (int px = x0; px < x0 + w; ++px) {
        if (!check(px, y0 + h - 1)) return -1;
    }
    // Left edge (x0, y0+1 .. y0+h-2)
    for (int py = y0 + 1; py < y0 + h - 1; ++py) {
        if (!check(x0, py)) return -1;
    }
    // Right edge (x0+w-1, y0+1 .. y0+h-2)
    for (int py = y0 + 1; py < y0 + h - 1; ++py) {
        if (!check(x0 + w - 1, py)) return -1;
    }
    return first;
}

// Recursive Mariani-Silver. Each call either:
//   (a) brute-forces a small rectangle (≤ LEAF on a side), or
//   (b) probes the perimeter; if all pixels share a band AND that band
//       is 0 (in-set), flood-fills the interior, or
//   (c) splits into 4 quadrants and recurses.
//
// We only flood when band == 0 because the Maximum-Modulus Principle
// for the iteration only gives a strict guarantee on in-set regions
// (every interior point fails to escape since the perimeter does).
// Outside the set, uniform perimeter is *necessary but not sufficient*
// for uniform interior — flooding there can introduce visible holes
// near features. Safer to split-and-recurse.
void recurse(const RenderCtx& ctx, int x0, int y0, int w, int h) {
    if (w <= MS_LEAF_PX || h <= MS_LEAF_PX) {
        brute_force_rect(ctx, x0, y0, w, h);
        return;
    }

    const int band = perimeter_uniform_band(ctx, x0, y0, w, h);
    if (band == 0) {
        // Interior known to be entirely in-set. Fill and done.
        // (Skip the 1-pixel-wide perimeter we already wrote.)
        fill_rect(ctx.out, x0 + 1, y0 + 1, w - 2, h - 2, 0);
        return;
    }

    // Mixed perimeter (or escape-band perimeter we won't risk flooding):
    // split into 4 quadrants. We've already written all the perimeter
    // pixels above; the recursion below re-touches them but that's
    // fine — write_pixel is idempotent for the same band.
    const int hw = w / 2;
    const int hh = h / 2;
    recurse(ctx, x0,      y0,      hw,     hh);
    recurse(ctx, x0 + hw, y0,      w - hw, hh);
    recurse(ctx, x0,      y0 + hh, hw,     h - hh);
    recurse(ctx, x0 + hw, y0 + hh, w - hw, h - hh);
}

}  // anonymous namespace

void compute_chunk_mariani(ChunkBuffer& out,
                          int chunk_id,
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
    const double pixel_size = window / VISIBLE_PIXELS;
    const double centre_off = IMAGE_PIXELS / 2.0;

    const int chunk_col   = chunk_id % CHUNKS_PER_SIDE;
    const int chunk_row   = chunk_id / CHUNKS_PER_SIDE;
    const int col_origin = chunk_col * CHUNK_PIXELS;
    const int row_origin = chunk_row * CHUNK_PIXELS;

    RenderCtx ctx {
        out,
        col_origin, row_origin,
        pixel_size, centre_off,
        pan_x, pan_y,
        max_iter,
        is_julia, is_burning_ship,
        julia_c_real, julia_c_imag,
    };

    recurse(ctx, 0, 0, CHUNK_PIXELS, CHUNK_PIXELS);
}

}  // namespace fractal_sim
