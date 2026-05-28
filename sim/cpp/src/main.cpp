// fractal_sim
//
// Long-running simulator binary. Reads JSON commands from stdin, writes
// framed binary responses to stdout, logs diagnostics to stderr.

#include <iostream>
#include <string>
#include <variant>

#include "iterate.hpp"
#include "protocol.hpp"
#include "response.hpp"

using namespace fractal_sim;

int main() {
    std::cerr << "fractal_sim: ready" << std::endl;

    // One reusable tile-sized output buffer. compute_tile overwrites it fully.
    TileBuffer tile_buf{};

    std::string line;
    while (std::getline(std::cin, line)) {
        if (line.empty()) continue;

        Command cmd = parse_command(line);

        std::visit([&](auto&& c) {
            using T = std::decay_t<decltype(c)>;
            if constexpr (std::is_same_v<T, Ping>) {
                std::cerr << "fractal_sim: ping" << std::endl;
                write_frame(MessageType::Pong, 0, nullptr, 0);
            } else if constexpr (std::is_same_v<T, RenderTile>) {
                std::cerr << "fractal_sim: render_tile id=" << c.tile_id
                          << " zoom=" << c.zoom
                          << " type=" << c.fractal_type
                          << std::endl;
                compute_tile(tile_buf,
                             c.tile_id,
                             c.pan_x, c.pan_y,
                             c.zoom,
                             c.fractal_type,
                             c.julia_c_real, c.julia_c_imag);
                write_frame(MessageType::Tile,
                            static_cast<uint8_t>(c.tile_id),
                            tile_buf.data(),
                            static_cast<uint32_t>(tile_buf.size()));
            } else if constexpr (std::is_same_v<T, ParseError>) {
                std::cerr << "fractal_sim: parse error: " << c.message << std::endl;
                write_error(c.message);
            }
        }, cmd);
    }

    std::cerr << "fractal_sim: stdin closed, exiting" << std::endl;
    return 0;
}
