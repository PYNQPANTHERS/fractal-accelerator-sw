// fractal_sim
//
// Long-running simulator binary. Reads JSON commands from stdin, writes
// framed binary responses to stdout, logs diagnostics to stderr.

#include <array>
#include <cstddef>
#include <iostream>
#include <string>
#include <variant>

#include "protocol.hpp"
#include "response.hpp"

using namespace fractal_sim;

// One tile is 256x256 nibble-packed pixels = 32768 bytes.
constexpr std::size_t TILE_BYTES = 256 * 256 / 2;

int main() {
    std::cerr << "fractal_sim: ready" << std::endl;

    // Placeholder payload — real iteration math arrives in commit 7.
    std::array<std::byte, TILE_BYTES> placeholder{};

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
                write_frame(MessageType::Tile,
                            static_cast<uint8_t>(c.tile_id),
                            placeholder.data(),
                            static_cast<uint32_t>(placeholder.size()));
            } else if constexpr (std::is_same_v<T, ParseError>) {
                std::cerr << "fractal_sim: parse error: " << c.message << std::endl;
                write_error(c.message);
            }
        }, cmd);
    }

    std::cerr << "fractal_sim: stdin closed, exiting" << std::endl;
    return 0;
}
