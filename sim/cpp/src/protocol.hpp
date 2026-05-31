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

struct RenderChunk {
    int chunk_id;
    double pan_x;
    double pan_y;
    int zoom;
    std::string fractal_type;
    double julia_c_real;
    double julia_c_imag;
    int max_iter;
};

// Render the full image. Chunk frames are streamed in completion order,
// mirroring the PS-side unit that will be built from finer PL microtile
// completions.
//
// `preview` switches the kernel to a subsampled path: compute one pixel
// per 2x2 block and broadcast. ~4x faster per chunk, slightly fuzzy
// output. Performance mode uses this during active pan/zoom for
// smoothness and re-requests `preview=false` on settle for crisp final.
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

using Command = std::variant<RenderChunk, RenderImage, Ping, ParseError>;

// Parse one JSON line into a Command. Returns ParseError on any failure
// (invalid JSON, missing fields, unknown cmd, wrong field types).
Command parse_command(const std::string& line);

}  // namespace fractal_sim
