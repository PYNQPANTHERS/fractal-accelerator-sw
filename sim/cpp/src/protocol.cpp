#include "protocol.hpp"

#include <nlohmann/json.hpp>

namespace fractal_sim {

using json = nlohmann::json;

Command parse_command(const std::string& line) {
    json j;
    try {
        j = json::parse(line);
    } catch (const json::parse_error& e) {
        return ParseError{std::string("invalid JSON: ") + e.what()};
    }

    if (!j.is_object() || !j.contains("cmd") || !j["cmd"].is_string()) {
        return ParseError{"missing or non-string 'cmd' field"};
    }

    const std::string cmd = j["cmd"].get<std::string>();

    if (cmd == "ping") {
        return Ping{};
    }

    if (cmd == "render_chunk") {
        // Required numeric fields.
        try {
            RenderChunk r;
            r.chunk_id       = j.at("chunk_id").get<int>();
            r.pan_x         = j.at("pan_x").get<double>();
            r.pan_y         = j.at("pan_y").get<double>();
            r.zoom          = j.at("zoom").get<int>();
            r.fractal_type  = j.at("fractal_type").get<std::string>();
            r.julia_c_real  = j.value("julia_c_real", 0.0);
            r.julia_c_imag  = j.value("julia_c_imag", 0.0);
            r.max_iter      = j.value("max_iter", 256);

            if (r.chunk_id < 0 || r.chunk_id > 15) {
                return ParseError{"chunk_id must be 0..15"};
            }
            if (r.fractal_type != "mandelbrot" &&
                r.fractal_type != "julia" &&
                r.fractal_type != "burning_ship") {
                return ParseError{"unknown fractal_type"};
            }
            return r;
        } catch (const json::exception& e) {
            return ParseError{std::string("render_chunk fields: ") + e.what()};
        }
    }

    if (cmd == "render_image") {
        try {
            RenderImage r;
            r.pan_x        = j.at("pan_x").get<double>();
            r.pan_y        = j.at("pan_y").get<double>();
            r.zoom         = j.at("zoom").get<int>();
            r.fractal_type = j.at("fractal_type").get<std::string>();
            r.julia_c_real = j.value("julia_c_real", 0.0);
            r.julia_c_imag = j.value("julia_c_imag", 0.0);
            r.max_iter     = j.value("max_iter", 256);
            r.preview      = j.value("preview", false);
            if (r.fractal_type != "mandelbrot" &&
                r.fractal_type != "julia" &&
                r.fractal_type != "burning_ship") {
                return ParseError{"unknown fractal_type"};
            }
            return r;
        } catch (const json::exception& e) {
            return ParseError{std::string("render_image fields: ") + e.what()};
        }
    }

    return ParseError{"unknown cmd: " + cmd};
}

}  // namespace fractal_sim
