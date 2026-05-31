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

    // One buffer per chunk for parallel rendering. Allocated once, reused.
    const int N_CHUNKS = CHUNKS_PER_SIDE * CHUNKS_PER_SIDE;
    std::vector<ChunkBuffer> chunk_bufs(N_CHUNKS);

    std::string line;
    while (std::getline(std::cin, line)) {
        if (line.empty()) continue;

        Command cmd = parse_command(line);

        std::visit([&](auto&& c) {
            using T = std::decay_t<decltype(c)>;
            if constexpr (std::is_same_v<T, Ping>) {
                std::cerr << "fractal_sim: ping" << std::endl;
                write_frame(MessageType::Pong, 0, nullptr, 0);

            } else if constexpr (std::is_same_v<T, RenderChunk>) {
                std::cerr << "fractal_sim: render_chunk id=" << c.chunk_id
                          << " zoom=" << c.zoom
                          << " type=" << c.fractal_type << std::endl;
                compute_chunk(chunk_bufs[c.chunk_id], c.chunk_id,
                             c.pan_x, c.pan_y, c.zoom, c.max_iter,
                             c.fractal_type, c.julia_c_real, c.julia_c_imag);
                write_frame(MessageType::Chunk,
                            static_cast<uint8_t>(c.chunk_id),
                            chunk_bufs[c.chunk_id].data(),
                            static_cast<uint32_t>(chunk_bufs[c.chunk_id].size()));

            } else if constexpr (std::is_same_v<T, RenderImage>) {
                std::cerr << "fractal_sim: render_image zoom=" << c.zoom
                          << " type=" << c.fractal_type << std::endl;

                // Compute all chunks in parallel; each chunk is independent.
                // One thread per chunk is fine for the current 4x4 image.
                // Workers notify the main thread as each chunk completes. The
                // main thread remains the only stdout writer, matching the
                // future PS shape: microtile completions are aggregated into
                // chunks before the image stream is serialised onto the wire.
                std::mutex done_mutex;
                std::condition_variable done_cv;
                std::queue<int> done_chunks;

                std::vector<std::thread> threads;
                threads.reserve(N_CHUNKS);
                for (int chunk_id = 0; chunk_id < N_CHUNKS; ++chunk_id) {
                    threads.emplace_back([&, chunk_id]() {
                        // Full quality goes through Mariani-Silver; preview
                        // stays on the brute-force subsampled path because
                        // M-S only helps on uniform regions and preview is
                        // already so cheap that quadtree overhead would
                        // erode the gain.
                        if (c.preview) {
                            compute_chunk(chunk_bufs[chunk_id], chunk_id,
                                         c.pan_x, c.pan_y, c.zoom, c.max_iter,
                                         c.fractal_type,
                                         c.julia_c_real, c.julia_c_imag,
                                         true);
                        } else {
                            compute_chunk_mariani(chunk_bufs[chunk_id], chunk_id,
                                                 c.pan_x, c.pan_y, c.zoom,
                                                 c.max_iter,
                                                 c.fractal_type,
                                                 c.julia_c_real,
                                                 c.julia_c_imag);
                        }
                        {
                            std::lock_guard<std::mutex> lock(done_mutex);
                            done_chunks.push(chunk_id);
                        }
                        done_cv.notify_one();
                    });
                }

                for (int written = 0; written < N_CHUNKS; ++written) {
                    std::unique_lock<std::mutex> lock(done_mutex);
                    done_cv.wait(lock, [&]() { return !done_chunks.empty(); });
                    const int chunk_id = done_chunks.front();
                    done_chunks.pop();
                    lock.unlock();

                    write_frame(MessageType::Chunk,
                                static_cast<uint8_t>(chunk_id),
                                chunk_bufs[chunk_id].data(),
                                static_cast<uint32_t>(chunk_bufs[chunk_id].size()));
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
