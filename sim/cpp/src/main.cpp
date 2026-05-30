// fractal_sim
//
// Long-running simulator binary. Reads JSON commands from stdin, writes
// framed binary responses to stdout, logs diagnostics to stderr.

#include <iostream>
#include <condition_variable>
#include <mutex>
#include <queue>
#include <string>
#include <thread>
#include <variant>
#include <vector>

#include "iterate.hpp"
#include "mariani_silver.hpp"
#include "protocol.hpp"
#include "response.hpp"

using namespace fractal_sim;

int main() {
    std::cerr << "fractal_sim: ready" << std::endl;

    // One buffer per tile for parallel rendering. Allocated once, reused.
    const int N_TILES = TILES_PER_SIDE * TILES_PER_SIDE;
    std::vector<TileBuffer> tile_bufs(N_TILES);

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
                          << " type=" << c.fractal_type << std::endl;
                compute_tile(tile_bufs[c.tile_id], c.tile_id,
                             c.pan_x, c.pan_y, c.zoom, c.max_iter,
                             c.fractal_type, c.julia_c_real, c.julia_c_imag);
                write_frame(MessageType::Tile,
                            static_cast<uint8_t>(c.tile_id),
                            tile_bufs[c.tile_id].data(),
                            static_cast<uint32_t>(tile_bufs[c.tile_id].size()));

            } else if constexpr (std::is_same_v<T, RenderImage>) {
                std::cerr << "fractal_sim: render_image zoom=" << c.zoom
                          << " type=" << c.fractal_type << std::endl;

                // Compute all tiles in parallel — each tile is independent.
                // One thread per tile; tiles are small so 16 threads is fine.
                // Workers notify the main thread as each tile completes. The
                // main thread remains the only stdout writer, matching the
                // future FPGA shape: tile-done events arrive independently,
                // but the PS-side driver serialises them onto the wire.
                std::mutex done_mutex;
                std::condition_variable done_cv;
                std::queue<int> done_tiles;

                std::vector<std::thread> threads;
                threads.reserve(N_TILES);
                for (int tile_id = 0; tile_id < N_TILES; ++tile_id) {
                    threads.emplace_back([&, tile_id]() {
                        // Full quality goes through Mariani-Silver; preview
                        // stays on the brute-force subsampled path because
                        // M-S only helps on uniform regions and preview is
                        // already so cheap that quadtree overhead would
                        // erode the gain.
                        if (c.preview) {
                            compute_tile(tile_bufs[tile_id], tile_id,
                                         c.pan_x, c.pan_y, c.zoom, c.max_iter,
                                         c.fractal_type,
                                         c.julia_c_real, c.julia_c_imag,
                                         true);
                        } else {
                            compute_tile_mariani(tile_bufs[tile_id], tile_id,
                                                 c.pan_x, c.pan_y, c.zoom,
                                                 c.max_iter,
                                                 c.fractal_type,
                                                 c.julia_c_real,
                                                 c.julia_c_imag);
                        }
                        {
                            std::lock_guard<std::mutex> lock(done_mutex);
                            done_tiles.push(tile_id);
                        }
                        done_cv.notify_one();
                    });
                }

                for (int written = 0; written < N_TILES; ++written) {
                    std::unique_lock<std::mutex> lock(done_mutex);
                    done_cv.wait(lock, [&]() { return !done_tiles.empty(); });
                    const int tile_id = done_tiles.front();
                    done_tiles.pop();
                    lock.unlock();

                    write_frame(MessageType::Tile,
                                static_cast<uint8_t>(tile_id),
                                tile_bufs[tile_id].data(),
                                static_cast<uint32_t>(tile_bufs[tile_id].size()));
                }
                for (auto& t : threads) t.join();

            } else if constexpr (std::is_same_v<T, ParseError>) {
                std::cerr << "fractal_sim: parse error: " << c.message << std::endl;
                write_error(c.message);
            }
        }, cmd);
    }

    std::cerr << "fractal_sim: stdin closed, exiting" << std::endl;
    return 0;
}
