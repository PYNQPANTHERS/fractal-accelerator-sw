// Stdout response framing.
//
// Responses are framed binary messages. Each frame has a tiny header
// followed by an optional payload. The header layout is fixed-width and
// little-endian so the Python side can parse it with a single struct.unpack.
//
// Frame layout:
//   byte 0     : message_type
//   byte 1     : tile_id (0..15 for tile responses, 0 for non-tile)
//   bytes 2..5 : payload length, uint32 little-endian
//   bytes 6..N : payload (zero-length for non-tile responses)

#pragma once

#include <cstddef>
#include <cstdint>
#include <string>

namespace fractal_sim {

enum class MessageType : uint8_t {
    Tile  = 0x01,    // payload = tile bytes
    Pong  = 0x02,    // empty payload, in response to ping
    Error = 0xFF,    // payload = UTF-8 error message
};

// Write one frame to stdout. payload may be nullptr if length is zero.
void write_frame(MessageType type,
                 uint8_t tile_id,
                 const std::byte* payload,
                 uint32_t payload_len);

// Convenience for the error path.
void write_error(const std::string& message);

}  // namespace fractal_sim
