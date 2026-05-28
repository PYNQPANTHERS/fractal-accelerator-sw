// fractal_sim
//
// Long-running simulator binary. Reads JSON commands from stdin, writes
// framed binary responses to stdout, logs diagnostics to stderr.

#include <iostream>
#include <string>
#include <variant>

#include "protocol.hpp"

using namespace fractal_sim;

int main() {
    std::cerr << "fractal_sim: ready" << std::endl;

    std::string line;
    while (std::getline(std::cin, line)) {
        if (line.empty()) continue;

        Command cmd = parse_command(line);

        std::visit([](auto&& c) {
            using T = std::decay_t<decltype(c)>;
            if constexpr (std::is_same_v<T, Ping>) {
                std::cerr << "fractal_sim: ping" << std::endl;
            } else if constexpr (std::is_same_v<T, RenderTile>) {
                std::cerr << "fractal_sim: render_tile id=" << c.tile_id
                          << " zoom=" << c.zoom
                          << " type=" << c.fractal_type
                          << std::endl;
            } else if constexpr (std::is_same_v<T, ParseError>) {
                std::cerr << "fractal_sim: parse error: " << c.message << std::endl;
            }
        }, cmd);
    }

    std::cerr << "fractal_sim: stdin closed, exiting" << std::endl;
    return 0;
}
