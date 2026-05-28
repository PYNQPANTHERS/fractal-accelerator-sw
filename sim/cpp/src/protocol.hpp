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

struct Ping {};                  // Cheap "are you alive" probe.

struct ParseError {
    std::string message;
};

using Command = std::variant<RenderTile, Ping, ParseError>;

// Parse one JSON line into a Command. Returns ParseError on any failure
// (invalid JSON, missing fields, unknown cmd, wrong field types).
Command parse_command(const std::string& line);

}  // namespace fractal_sim
