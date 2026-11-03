// D7.5 (2026-11-02): the camera's wire encoding, one baseline JPEG per eye (vr-layer/README.md "The camera"; the
// encoder is the vendored stb_image_write, third_party/stb, THIRD-PARTY.md). Kept in its own translation unit so the
// single-header implementation is compiled once, with its warnings silenced, away from the layer's /W4 code.
#pragma once

#include <cstdint>
#include <vector>

namespace castcade {

// `rgba`: width * height * 4 bytes, packed rows, top-down; the alpha byte is ignored. `quality` 1..100 (85 is the
// camera's: 4:2:0 chroma below 91). The JPEG replaces `out`'s contents. Thread-safe (no shared state). False when the
// encoder refused (a zero or absurd size).
bool encodeJpeg(const uint8_t* rgba, uint32_t width, uint32_t height, int quality, std::vector<uint8_t>& out);

}  // namespace castcade
