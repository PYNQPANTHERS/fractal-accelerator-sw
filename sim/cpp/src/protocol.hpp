// Stdio protocol types and parsing.
//
// Commands arrive as JSON lines on stdin. Each line is parsed into a
// Command. Unknown commands or malformed input become ParseError.

#pragma once

#include <optional>
#include <string>
#include <variant>

namespace fractal_sim {

// One command kind per supported request. New variants get added here as
// commands are introduced.

struct RenderTile {
    int tile_id;
    double pan_x;
    double pan_y;
    int zoom;
    std::string fractal_type;
    double julia_c_real;
    double julia_c_imag;
    int max_iter;
};

// Render the full image. Tile frames are streamed in order 0..(N-1) —
// mirrors how the real PL emits tiles as its cores complete them.
//
// `preview` switches the kernel to a subsampled path: compute one pixel
// per 2x2 block and broadcast. ~4x faster per tile, slightly fuzzy
// output. The client uses this during active drag for smoothness and
// re-requests `preview=false` on drag release for crisp final.
struct RenderImage {
    double pan_x;
    double pan_y;
    int zoom;
    std::string fractal_type;
    double julia_c_real;
    double julia_c_imag;
    int max_iter;
    bool preview;
};

struct Ping {};

struct ParseError {
    std::string message;
};

using Command = std::variant<RenderTile, RenderImage, Ping, ParseError>;

// Parse one JSON line into a Command. Returns ParseError on any failure
// (invalid JSON, missing fields, unknown cmd, wrong field types).
Command parse_command(const std::string& line);

}  // namespace fractal_sim
