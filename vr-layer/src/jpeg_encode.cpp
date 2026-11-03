// See jpeg_encode.h.
#include "jpeg_encode.h"

#define STB_IMAGE_WRITE_IMPLEMENTATION
#define STB_IMAGE_WRITE_STATIC  // every stb symbol internal to this translation unit
#define STBI_WRITE_NO_STDIO     // the pipe, never a file
#define STBIW_ASSERT(x) ((void)0)  // never abort VPX's process
#pragma warning(push, 0)
#include "stb_image_write.h"
#pragma warning(pop)

namespace castcade {
namespace {

void append(void* context, void* data, int size) {
  auto* out = static_cast<std::vector<uint8_t>*>(context);
  const auto* p = static_cast<const uint8_t*>(data);
  if (size > 0) out->insert(out->end(), p, p + size);
}

constexpr uint32_t kMaxSide = 1u << 15;

}  // namespace

bool encodeJpeg(const uint8_t* rgba, uint32_t width, uint32_t height, int quality, std::vector<uint8_t>& out) {
  out.clear();
  if (!rgba || width == 0 || height == 0 || width > kMaxSide || height > kMaxSide) return false;
  out.reserve(static_cast<size_t>(width) * height / 4);
  return stbi_write_jpg_to_func(append, &out, static_cast<int>(width), static_cast<int>(height), 4, rgba, quality) != 0;
}

}  // namespace castcade
