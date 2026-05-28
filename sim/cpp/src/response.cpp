#include "response.hpp"

#include <cstdio>
#include <string>

namespace fractal_sim {

void write_frame(MessageType type,
                 uint8_t tile_id,
                 const std::byte* payload,
                 uint32_t payload_len) {
    // 6-byte header: type, tile_id, length (LE uint32).
    const uint8_t header[6] = {
        static_cast<uint8_t>(type),
        tile_id,
        static_cast<uint8_t>( payload_len        & 0xFF),
        static_cast<uint8_t>((payload_len >>  8) & 0xFF),
        static_cast<uint8_t>((payload_len >> 16) & 0xFF),
        static_cast<uint8_t>((payload_len >> 24) & 0xFF),
    };

    std::fwrite(header, 1, sizeof(header), stdout);
    if (payload_len > 0 && payload != nullptr) {
        std::fwrite(payload, 1, payload_len, stdout);
    }
    std::fflush(stdout);
}

void write_error(const std::string& message) {
    write_frame(MessageType::Error,
                0,
                reinterpret_cast<const std::byte*>(message.data()),
                static_cast<uint32_t>(message.size()));
}

}  // namespace fractal_sim
