// See camera.h.
#include "camera.h"
#include "eye_crop.h"

#include "jpeg_encode.h"
#include "layer_log.h"

#include <d3d11.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>

namespace castcade {
namespace {

constexpr int kJpegQuality = 85;
constexpr int kSlots = 2;  // one copy in flight on the GPU, one mapped for the worker
constexpr uint64_t kLogFirst = 10, kLogEvery = 300;
constexpr uint32_t kMaxFrameBytes = 32u << 20;  // the companion's limit for one CVF1 (vr-layer.ts FRAME_MAX_BYTES)
constexpr DWORD kShutdownWaitMs = 300;
constexpr uint64_t kNoViewLogAfterMs = 3000;

// ---- OpenGL without linking it (camera.h: the layer links neither opengl32 nor d3d11) ---------------------------------
using GLenum = unsigned int;
using GLint = int;
using GLuint = unsigned int;
using GLsizei = int;
using GLbitfield = unsigned int;
using GLboolean = unsigned char;
using GLintptr = ptrdiff_t;
using GLsizeiptr = ptrdiff_t;
using GLsync = struct __GLsync*;

constexpr GLenum GL_NO_ERROR_ = 0;
constexpr GLenum GL_SCISSOR_TEST_ = 0x0C11;
constexpr GLenum GL_PACK_ROW_LENGTH_ = 0x0D02;
constexpr GLenum GL_PACK_SKIP_ROWS_ = 0x0D03;
constexpr GLenum GL_PACK_SKIP_PIXELS_ = 0x0D04;
constexpr GLenum GL_PACK_ALIGNMENT_ = 0x0D05;
constexpr GLenum GL_TEXTURE_2D_ = 0x0DE1;
constexpr GLenum GL_UNSIGNED_BYTE_ = 0x1401;
constexpr GLenum GL_RGBA_ = 0x1908;
constexpr GLenum GL_NEAREST_ = 0x2600;
constexpr GLenum GL_LINEAR_ = 0x2601;
constexpr GLenum GL_TEXTURE_MAG_FILTER_ = 0x2800;
constexpr GLenum GL_TEXTURE_MIN_FILTER_ = 0x2801;
constexpr GLenum GL_COLOR_BUFFER_BIT_ = 0x00004000;
constexpr GLenum GL_TEXTURE_BINDING_2D_ = 0x8069;
constexpr GLenum GL_RGB8_ = 0x8051;
constexpr GLenum GL_RGBA8_ = 0x8058;
constexpr GLenum GL_PIXEL_PACK_BUFFER_ = 0x88EB;
constexpr GLenum GL_PIXEL_PACK_BUFFER_BINDING_ = 0x88ED;
constexpr GLenum GL_STREAM_READ_ = 0x88E1;
constexpr GLenum GL_READ_FRAMEBUFFER_ = 0x8CA8;
constexpr GLenum GL_DRAW_FRAMEBUFFER_ = 0x8CA9;
constexpr GLenum GL_DRAW_FRAMEBUFFER_BINDING_ = 0x8CA6;
constexpr GLenum GL_READ_FRAMEBUFFER_BINDING_ = 0x8CAA;
constexpr GLenum GL_FRAMEBUFFER_COMPLETE_ = 0x8CD5;
constexpr GLenum GL_COLOR_ATTACHMENT0_ = 0x8CE0;
constexpr GLenum GL_SRGB8_ = 0x8C41;
constexpr GLenum GL_SRGB8_ALPHA8_ = 0x8C43;
constexpr GLenum GL_FRAMEBUFFER_SRGB_ = 0x8DB9;
constexpr GLenum GL_SYNC_STATUS_ = 0x9114;
constexpr GLenum GL_SYNC_GPU_COMMANDS_COMPLETE_ = 0x9117;
constexpr GLenum GL_SIGNALED_ = 0x9119;
constexpr GLbitfield GL_MAP_READ_BIT_ = 0x0001;

struct Gl {
  // GL 1.1, from opengl32.dll
  GLenum(WINAPI* getError)() = nullptr;
  void(WINAPI* getIntegerv)(GLenum, GLint*) = nullptr;
  GLboolean(WINAPI* isEnabled)(GLenum) = nullptr;
  void(WINAPI* enable)(GLenum) = nullptr;
  void(WINAPI* disable)(GLenum) = nullptr;
  void(WINAPI* pixelStorei)(GLenum, GLint) = nullptr;
  void(WINAPI* genTextures)(GLsizei, GLuint*) = nullptr;
  void(WINAPI* deleteTextures)(GLsizei, const GLuint*) = nullptr;
  void(WINAPI* bindTexture)(GLenum, GLuint) = nullptr;
  void(WINAPI* texImage2D)(GLenum, GLint, GLint, GLsizei, GLsizei, GLint, GLenum, GLenum, const void*) = nullptr;
  void(WINAPI* texParameteri)(GLenum, GLenum, GLint) = nullptr;
  void(WINAPI* readBuffer)(GLenum) = nullptr;
  void(WINAPI* readPixels)(GLint, GLint, GLsizei, GLsizei, GLenum, GLenum, void*) = nullptr;
  void(WINAPI* flush)() = nullptr;
  HGLRC(WINAPI* getCurrentContext)() = nullptr;
  BOOL(WINAPI* makeCurrent)(HDC, HGLRC) = nullptr;
  PROC(WINAPI* getProcAddress)(LPCSTR) = nullptr;
  // GL 3.0 / ARB_sync, through wglGetProcAddress (a context must be current)
  void(WINAPI* genFramebuffers)(GLsizei, GLuint*) = nullptr;
  void(WINAPI* deleteFramebuffers)(GLsizei, const GLuint*) = nullptr;
  void(WINAPI* bindFramebuffer)(GLenum, GLuint) = nullptr;
  void(WINAPI* framebufferTexture2D)(GLenum, GLenum, GLenum, GLuint, GLint) = nullptr;
  void(WINAPI* framebufferTexture)(GLenum, GLenum, GLuint, GLint) = nullptr;  // GL 3.2: any texture target
  void(WINAPI* framebufferTextureLayer)(GLenum, GLenum, GLuint, GLint, GLint) = nullptr;
  GLenum(WINAPI* checkFramebufferStatus)(GLenum) = nullptr;
  void(WINAPI* blitFramebuffer)(GLint, GLint, GLint, GLint, GLint, GLint, GLint, GLint, GLbitfield, GLenum) = nullptr;
  void(WINAPI* genBuffers)(GLsizei, GLuint*) = nullptr;
  void(WINAPI* deleteBuffers)(GLsizei, const GLuint*) = nullptr;
  void(WINAPI* bindBuffer)(GLenum, GLuint) = nullptr;
  void(WINAPI* bufferData)(GLenum, GLsizeiptr, const void*, GLenum) = nullptr;
  void*(WINAPI* mapBufferRange)(GLenum, GLintptr, GLsizeiptr, GLbitfield) = nullptr;
  GLboolean(WINAPI* unmapBuffer)(GLenum) = nullptr;
  GLsync(WINAPI* fenceSync)(GLenum, GLbitfield) = nullptr;
  void(WINAPI* getSynciv)(GLsync, GLenum, GLsizei, GLsizei*, GLint*) = nullptr;
  void(WINAPI* deleteSync)(GLsync) = nullptr;
  bool loaded = false;

  bool core() const {
    return getError && getIntegerv && isEnabled && enable && disable && pixelStorei && genTextures && deleteTextures && bindTexture && texImage2D &&
           texParameteri && readBuffer && readPixels && flush && getCurrentContext && makeCurrent && getProcAddress;
  }
  bool ext() const {
    return genFramebuffers && deleteFramebuffers && bindFramebuffer && framebufferTexture2D && framebufferTextureLayer && checkFramebufferStatus &&
           blitFramebuffer && genBuffers && deleteBuffers && bindBuffer && bufferData && mapBufferRange && unmapBuffer && fenceSync && getSynciv && deleteSync &&
           framebufferTexture;
  }
};

template <typename T>
void fromModule(HMODULE m, const char* name, T& out) {
  out = reinterpret_cast<T>(reinterpret_cast<void*>(GetProcAddress(m, name)));
}

// wglGetProcAddress answers 1, 2, 3 or -1 instead of null on some drivers.
template <typename T>
void fromWgl(const Gl& g, const char* name, T& out) {
  const auto p = reinterpret_cast<intptr_t>(g.getProcAddress(name));
  out = (p != 0 && p != 1 && p != 2 && p != 3 && p != -1) ? reinterpret_cast<T>(p) : nullptr;
}

// Needs the app's context current (the wgl entry points answer for it).
Gl loadGl() {
  Gl g;
  const HMODULE m = GetModuleHandleW(L"opengl32.dll");
  if (!m) return g;
  fromModule(m, "glGetError", g.getError);
  fromModule(m, "glGetIntegerv", g.getIntegerv);
  fromModule(m, "glIsEnabled", g.isEnabled);
  fromModule(m, "glEnable", g.enable);
  fromModule(m, "glDisable", g.disable);
  fromModule(m, "glPixelStorei", g.pixelStorei);
  fromModule(m, "glGenTextures", g.genTextures);
  fromModule(m, "glDeleteTextures", g.deleteTextures);
  fromModule(m, "glBindTexture", g.bindTexture);
  fromModule(m, "glTexImage2D", g.texImage2D);
  fromModule(m, "glTexParameteri", g.texParameteri);
  fromModule(m, "glReadBuffer", g.readBuffer);
  fromModule(m, "glReadPixels", g.readPixels);
  fromModule(m, "glFlush", g.flush);
  fromModule(m, "wglGetCurrentContext", g.getCurrentContext);
  fromModule(m, "wglMakeCurrent", g.makeCurrent);
  fromModule(m, "wglGetProcAddress", g.getProcAddress);
  if (!g.core()) return g;
  fromWgl(g, "glGenFramebuffers", g.genFramebuffers);
  fromWgl(g, "glDeleteFramebuffers", g.deleteFramebuffers);
  fromWgl(g, "glBindFramebuffer", g.bindFramebuffer);
  fromWgl(g, "glFramebufferTexture2D", g.framebufferTexture2D);
  fromWgl(g, "glFramebufferTexture", g.framebufferTexture);
  fromWgl(g, "glFramebufferTextureLayer", g.framebufferTextureLayer);
  fromWgl(g, "glCheckFramebufferStatus", g.checkFramebufferStatus);
  fromWgl(g, "glBlitFramebuffer", g.blitFramebuffer);
  fromWgl(g, "glGenBuffers", g.genBuffers);
  fromWgl(g, "glDeleteBuffers", g.deleteBuffers);
  fromWgl(g, "glBindBuffer", g.bindBuffer);
  fromWgl(g, "glBufferData", g.bufferData);
  fromWgl(g, "glMapBufferRange", g.mapBufferRange);
  fromWgl(g, "glUnmapBuffer", g.unmapBuffer);
  fromWgl(g, "glFenceSync", g.fenceSync);
  fromWgl(g, "glGetSynciv", g.getSynciv);
  fromWgl(g, "glDeleteSync", g.deleteSync);
  g.loaded = true;
  return g;
}

// ---- time -------------------------------------------------------------------------------------------------------------

int64_t qpcFreq() {
  static const int64_t f = [] {
    LARGE_INTEGER li{};
    QueryPerformanceFrequency(&li);
    return li.QuadPart > 0 ? li.QuadPart : 1;
  }();
  return f;
}

int64_t qpc() {
  LARGE_INTEGER li{};
  QueryPerformanceCounter(&li);
  return li.QuadPart;
}

uint64_t usBetween(int64_t from, int64_t to) {
  if (to <= from) return 0;
  return static_cast<uint64_t>((to - from) * 1000000 / qpcFreq());
}

// ---- formats ----------------------------------------------------------------------------------------------------------

struct FormatInfo {
  bool ok = false;
  bool srgb = false;
  bool bgra = false;  // D3D11 B8G8R8A8 / B8G8R8X8: red and blue swapped on the way out
  const char* name = "";
};

FormatInfo glFormat(int64_t f) {
  switch (f) {
    case GL_SRGB8_ALPHA8_: return {true, true, false, "GL_SRGB8_ALPHA8"};
    case GL_RGBA8_: return {true, false, false, "GL_RGBA8"};
    case GL_SRGB8_: return {true, true, false, "GL_SRGB8"};
    case GL_RGB8_: return {true, false, false, "GL_RGB8"};
    default: return {};
  }
}

FormatInfo dxgiFormat(int64_t f) {
  switch (f) {
    case DXGI_FORMAT_R8G8B8A8_TYPELESS: return {true, false, false, "R8G8B8A8_TYPELESS"};
    case DXGI_FORMAT_R8G8B8A8_UNORM: return {true, false, false, "R8G8B8A8_UNORM"};
    case DXGI_FORMAT_R8G8B8A8_UNORM_SRGB: return {true, true, false, "R8G8B8A8_UNORM_SRGB"};
    case DXGI_FORMAT_B8G8R8A8_TYPELESS: return {true, false, true, "B8G8R8A8_TYPELESS"};
    case DXGI_FORMAT_B8G8R8A8_UNORM: return {true, false, true, "B8G8R8A8_UNORM"};
    case DXGI_FORMAT_B8G8R8A8_UNORM_SRGB: return {true, true, true, "B8G8R8A8_UNORM_SRGB"};
    case DXGI_FORMAT_B8G8R8X8_TYPELESS: return {true, false, true, "B8G8R8X8_TYPELESS"};
    case DXGI_FORMAT_B8G8R8X8_UNORM: return {true, false, true, "B8G8R8X8_UNORM"};
    case DXGI_FORMAT_B8G8R8X8_UNORM_SRGB: return {true, true, true, "B8G8R8X8_UNORM_SRGB"};
    default: return {};
  }
}

std::string hex(int64_t v) {
  char buf[32];
  std::snprintf(buf, sizeof buf, "0x%llx", static_cast<unsigned long long>(v));
  return buf;
}

// ---- geometry ---------------------------------------------------------------------------------------------------------

struct Crop {
  int32_t x = 0, y = 0, w = 0, h = 0;
};

// The largest rect of aspect arW:arH in the view's rect (VPX's own preview rule: crop, never stretch), centred on the
// eye's optical axis horizontally and in the rect vertically (eye_crop.h, D7.5.8, 0.5.1; 0.5.0 took the rect's centre,
// which stood the two windows 15 degrees apart on a Quest 3). With `whole` (D7.5.10, 0.5.2) no crop at all: the view's
// whole rect, for both eyes, so the receiver gets everything the eye rendered and the window's frame falls where the
// headset's own view ends, outside what the two eyes share (the frame of a crop stood inside it and doubled against
// the table: layer.cpp "the stereo window"). The frame header's `rect` tells the receiver what was done either way.
Crop cropFor(const CameraView& v, uint32_t arW, uint32_t arH, bool whole) {
  Crop c;
  const int64_t rw = v.rectW > 0 ? v.rectW : 1, rh = v.rectH > 0 ? v.rectH : 1;
  if (whole) {
    c.x = v.rectX, c.y = v.rectY, c.w = static_cast<int32_t>(rw), c.h = static_cast<int32_t>(rh);
    return c;
  }
  if (rw * static_cast<int64_t>(arH) > rh * static_cast<int64_t>(arW)) {
    c.h = static_cast<int32_t>(rh);
    c.w = static_cast<int32_t>(std::max<int64_t>(1, rh * arW / arH));
  } else {
    c.w = static_cast<int32_t>(rw);
    c.h = static_cast<int32_t>(std::max<int64_t>(1, rw * arH / arW));
  }
  c.x = v.rectX + static_cast<int32_t>(std::lround(axisCropX(static_cast<double>(rw), static_cast<double>(c.w), std::tan(v.fovLeft), std::tan(v.fovRight))));
  c.y = v.rectY + static_cast<int32_t>((rh - c.h) / 2);
  return c;
}

uint32_t even(double v) {
  uint32_t n = static_cast<uint32_t>(std::lround(v));
  n &= ~1u;
  return n < 2 ? 2 : n;
}

// The output size per eye: the box's aspect cropped from eye 0 (or, `whole`, eye 0's whole rect), scaled into the box,
// never up, even sides (a 3072x3264 whole render in a 1440x1440 box gives 1354x1440).
void planOutput(const CameraView& eye0, const CameraRequest& req, uint32_t& ow, uint32_t& oh) {
  const Crop c = cropFor(eye0, req.width, req.height, req.whole);
  const double scale = std::min(1.0, std::min(static_cast<double>(req.width) / c.w, static_cast<double>(req.height) / c.h));
  ow = even(c.w * scale);
  oh = even(c.h * scale);
}

// Locale-free fixed-point text (snprintf's %f follows the process's locale; VPX's may carry a decimal comma).
std::string fixed(double v, int decimals) {
  if (!std::isfinite(v)) return "0";
  const bool neg = v < 0;
  if (neg) v = -v;
  long long scale = 1;
  for (int i = 0; i < decimals; i++) scale *= 10;
  long long whole = static_cast<long long>(v);
  long long frac = static_cast<long long>((v - static_cast<double>(whole)) * static_cast<double>(scale) + 0.5);
  if (frac >= scale) whole++, frac -= scale;
  char buf[64];
  std::snprintf(buf, sizeof buf, "%s%lld.%0*lld", neg ? "-" : "", whole, decimals, frac);
  return buf;
}

// ---- the shared state between the render thread and the worker ---------------------------------------------------------

enum SlotState : int { Free = 0, Issued = 1, Mapped = 2, Consumed = 3 };

struct EyeMeta {
  float fov[4] = {0, 0, 0, 0};    // left, right, up, down (radians)
  int32_t rect[4] = {0, 0, 0, 0};  // the crop in the view's rect, y from the top
  int32_t render[2] = {0, 0};      // the view's rect size
};

struct Slot {
  std::atomic<int> state{Free};
  uint64_t n = 0;
  int64_t issuedQpc = 0;
  uint64_t issueUs = 0, mapUs = 0;
  uint32_t late = 0;  // ticks the fence / Map was not ready
  uint32_t outW = 0, outH = 0;
  // D8.1 (0.5.3): how many eyes this frame carries (2: left then right at index 0 and 1, as before; 1: one eye at index
  // 0 only, the second index unused) and which view index 0 holds (0 = left, 1 = right).
  int eyes = 2, eye0 = 0;
  EyeMeta eye[2];
  // What the worker reads once `state` is Mapped: per eye, rows of dataW pixels at `pitch` bytes.
  const uint8_t* data[2] = {nullptr, nullptr};
  size_t pitch[2] = {0, 0};
  uint32_t dataW[2] = {0, 0}, dataH[2] = {0, 0};
  bool bottomUp = false, swapRB = false;
  // OpenGL
  GLuint pbo = 0;
  size_t pboBytes = 0;
  GLsync fence = nullptr;
  // D3D11
  ID3D11Texture2D* staging[2] = {nullptr, nullptr};
  uint32_t stagingW[2] = {0, 0}, stagingH[2] = {0, 0};
  DXGI_FORMAT stagingFormat[2] = {DXGI_FORMAT_UNKNOWN, DXGI_FORMAT_UNKNOWN};
  bool mapped[2] = {false, false};
};

struct Shared {
  std::mutex m;
  std::condition_variable cv;
  std::atomic<bool> stop{false};
  Slot slots[kSlots];
  int64_t startQpc = 0;
  // The helper (the right eye's encoder).
  std::mutex hm;
  std::condition_variable hcv;
  bool helperJob = false, helperDone = false;
  uint32_t helperW = 0, helperH = 0;
  std::vector<uint8_t> packed[2], jpeg[2];
  // Counters: the worker's, read by the render thread at stop.
  std::atomic<uint64_t> sent{0}, droppedRing{0}, droppedBehind{0}, droppedWrite{0};
  std::atomic<uint64_t> sumIssue{0}, sumMap{0}, sumCopy{0}, sumEnc{0}, sumWrite{0}, sumBytes{0};
};

// The mapped rows of one eye as packed top-down RGBA at the output size: a straight (flipped, swapped) copy when the
// sizes match (OpenGL: the blit already scaled), a box average when they do not (D3D11: the staging copy is the crop
// at full size).
void packRgba(const uint8_t* src, size_t pitch, uint32_t sw, uint32_t sh, bool bottomUp, bool swapRB, uint32_t dw, uint32_t dh, std::vector<uint8_t>& out) {
  out.resize(static_cast<size_t>(dw) * dh * 4);
  if (sw == dw && sh == dh) {
    for (uint32_t y = 0; y < dh; y++) {
      const uint8_t* row = src + pitch * (bottomUp ? sh - 1 - y : y);
      uint8_t* o = out.data() + static_cast<size_t>(y) * dw * 4;
      if (!swapRB) {
        std::memcpy(o, row, static_cast<size_t>(dw) * 4);
        continue;
      }
      for (uint32_t x = 0; x < dw; x++, row += 4, o += 4) o[0] = row[2], o[1] = row[1], o[2] = row[0], o[3] = 255;
    }
    return;
  }
  const int ri = swapRB ? 2 : 0, bi = swapRB ? 0 : 2;
  for (uint32_t y = 0; y < dh; y++) {
    const uint32_t y0 = static_cast<uint32_t>(static_cast<uint64_t>(y) * sh / dh);
    const uint32_t y1 = std::max(y0 + 1, static_cast<uint32_t>(static_cast<uint64_t>(y + 1) * sh / dh));
    uint8_t* o = out.data() + static_cast<size_t>(y) * dw * 4;
    for (uint32_t x = 0; x < dw; x++, o += 4) {
      const uint32_t x0 = static_cast<uint32_t>(static_cast<uint64_t>(x) * sw / dw);
      const uint32_t x1 = std::max(x0 + 1, static_cast<uint32_t>(static_cast<uint64_t>(x + 1) * sw / dw));
      uint32_t r = 0, g = 0, b = 0, n = 0;
      for (uint32_t yy = y0; yy < y1 && yy < sh; yy++) {
        const uint8_t* row = src + pitch * (bottomUp ? sh - 1 - yy : yy);
        for (uint32_t xx = x0; xx < x1 && xx < sw; xx++) {
          const uint8_t* p = row + static_cast<size_t>(xx) * 4;
          r += p[ri], g += p[1], b += p[bi], n++;
        }
      }
      if (n == 0) n = 1;
      o[0] = static_cast<uint8_t>(r / n), o[1] = static_cast<uint8_t>(g / n), o[2] = static_cast<uint8_t>(b / n), o[3] = 255;
    }
  }
}

void put16(uint8_t* p, uint32_t v) {
  p[0] = static_cast<uint8_t>(v & 0xff);
  p[1] = static_cast<uint8_t>((v >> 8) & 0xff);
}

void put32(uint8_t* p, uint32_t v) {
  for (int i = 0; i < 4; i++) p[i] = static_cast<uint8_t>((v >> (8 * i)) & 0xff);
}

const char* eyeName(int e) { return e == 0 ? "left" : "right"; }

// The CVF1 header: see vr-layer/README.md "The camera". Integers and locale-free fixed-point only. `eyes` entries
// (2, or 1 for a one-eye frame, D8.1), each with its payload length.
std::string frameJson(uint64_t n, uint64_t tUs, uint32_t w, uint32_t h, const EyeMeta eye[2], const size_t len[2], int eyes, uint64_t issueUs,
                      uint64_t mapUs, uint64_t copyUs, uint64_t encUs) {
  std::string j = "{\"n\":" + std::to_string(n) + ",\"t\":" + std::to_string(tUs) + ",\"enc\":\"jpeg\",\"w\":" + std::to_string(w) + ",\"h\":" +
                  std::to_string(h) + ",\"us\":{\"issue\":" + std::to_string(issueUs) + ",\"map\":" + std::to_string(mapUs) + ",\"copy\":" +
                  std::to_string(copyUs) + ",\"enc\":" + std::to_string(encUs) + "},\"eyes\":[";
  for (int e = 0; e < eyes; e++) {
    const EyeMeta& m = eye[e];
    j += std::string(e == 0 ? "{" : ",{") + "\"fov\":[" + fixed(m.fov[0], 6) + "," + fixed(m.fov[1], 6) + "," + fixed(m.fov[2], 6) + "," + fixed(m.fov[3], 6) +
         "],\"rect\":[" + std::to_string(m.rect[0]) + "," + std::to_string(m.rect[1]) + "," + std::to_string(m.rect[2]) + "," + std::to_string(m.rect[3]) +
         "],\"render\":[" + std::to_string(m.render[0]) + "," + std::to_string(m.render[1]) + "],\"len\":" + std::to_string(len[e]) + "}";
  }
  j += "]}";
  return j;
}

void helperMain(std::shared_ptr<Shared> sh) {
  try {
    for (;;) {
      std::unique_lock<std::mutex> lk(sh->hm);
      sh->hcv.wait(lk, [&] { return sh->helperJob || sh->stop.load(); });
      if (sh->stop.load()) break;
      sh->helperJob = false;
      const uint32_t w = sh->helperW, h = sh->helperH;
      lk.unlock();
      encodeJpeg(sh->packed[1].data(), w, h, kJpegQuality, sh->jpeg[1]);
      lk.lock();
      sh->helperDone = true;
      lk.unlock();
      sh->hcv.notify_all();
    }
  } catch (...) {
    logOnce("camera_helper_fault", "camera: an internal fault in the right eye's encoder; the camera stalls until it is asked again");
  }
}

void workerMain(std::shared_ptr<Shared> sh) {
  try {
    std::vector<uint8_t> msg;
    for (;;) {
      Slot* slot = nullptr;
      {
        std::unique_lock<std::mutex> lk(sh->m);
        sh->cv.wait(lk, [&] {
          if (sh->stop.load()) return true;
          for (Slot& s : sh->slots)
            if (s.state.load() == Mapped) return true;
          return false;
        });
        if (sh->stop.load()) break;
        // The newest mapped slot; any older one still mapped is behind: dropped unread.
        for (Slot& s : sh->slots)
          if (s.state.load() == Mapped && (!slot || s.n > slot->n)) slot = &s;
        for (Slot& s : sh->slots)
          if (&s != slot && s.state.load() == Mapped) {
            s.state.store(Consumed);
            sh->droppedBehind++;
          }
      }
      if (!slot) continue;
      // Out of the mapped memory first (the render thread may then unmap it), then the slow work on our own copies.
      const int64_t t0 = qpc();
      const int eyes = slot->eyes, eye0 = slot->eye0;
      for (int e = 0; e < eyes; e++) packRgba(slot->data[e], slot->pitch[e], slot->dataW[e], slot->dataH[e], slot->bottomUp, slot->swapRB, slot->outW, slot->outH, sh->packed[e]);
      const uint64_t n = slot->n, issueUs = slot->issueUs, mapUs = slot->mapUs, late = slot->late;
      const uint32_t ow = slot->outW, oh = slot->outH;
      const uint64_t tUs = usBetween(sh->startQpc, slot->issuedQpc);
      EyeMeta eye[2] = {slot->eye[0], slot->eye[1]};
      slot->state.store(Consumed);
      const int64_t t1 = qpc();
      // The second eye to the helper (D8.1: none for a one-eye frame; the helper was not started).
      if (eyes == 2) {
        {
          std::lock_guard<std::mutex> lk(sh->hm);
          sh->helperW = ow;
          sh->helperH = oh;
          sh->helperJob = true;
          sh->helperDone = false;
        }
        sh->hcv.notify_all();
      }
      const bool firstOk = encodeJpeg(sh->packed[0].data(), ow, oh, kJpegQuality, sh->jpeg[0]);
      if (eyes == 2) {
        std::unique_lock<std::mutex> lk(sh->hm);
        sh->hcv.wait(lk, [&] { return sh->helperDone || sh->stop.load(); });
      }
      if (sh->stop.load()) break;
      const int64_t t2 = qpc();
      if (!firstOk || (eyes == 2 && sh->jpeg[1].empty())) {
        logOnce("camera_encode_failed", "camera: the JPEG encoder refused a " + std::to_string(ow) + "x" + std::to_string(oh) + " eye; frames are dropped");
        continue;
      }
      const size_t len[2] = {sh->jpeg[0].size(), eyes == 2 ? sh->jpeg[1].size() : 0};
      const std::string json = frameJson(n, tUs, ow, oh, eye, len, eyes, issueUs, mapUs, usBetween(t0, t1), usBetween(t1, t2));
      const size_t body = 2 + json.size() + len[0] + len[1];
      if (json.size() > 0xffff || body > kMaxFrameBytes) {
        logOnce("camera_frame_too_big", "camera: a frame of " + std::to_string(body) + " bytes is over the pipe's limit; frames are dropped");
        continue;
      }
      msg.resize(8 + body);
      std::memcpy(msg.data(), "CVF1", 4);
      put32(msg.data() + 4, static_cast<uint32_t>(body));
      put16(msg.data() + 8, static_cast<uint32_t>(json.size()));
      std::memcpy(msg.data() + 10, json.data(), json.size());
      std::memcpy(msg.data() + 10 + json.size(), sh->jpeg[0].data(), len[0]);
      if (eyes == 2) std::memcpy(msg.data() + 10 + json.size() + len[0], sh->jpeg[1].data(), len[1]);
      const bool wrote = panelPipeSend(msg.data(), msg.size());
      const int64_t t3 = qpc();
      if (!wrote) {
        sh->droppedWrite++;
        continue;
      }
      const uint64_t sent = ++sh->sent;
      sh->sumIssue += issueUs;
      sh->sumMap += mapUs;
      sh->sumCopy += usBetween(t0, t1);
      sh->sumEnc += usBetween(t1, t2);
      sh->sumWrite += usBetween(t2, t3);
      sh->sumBytes += body;
      if (sent <= kLogFirst || sent % kLogEvery == 0) {
        logLine("camera: frame " + std::to_string(n) + ": issue " + std::to_string(issueUs) + " us, ready after " + std::to_string(late) + " tick(s), map " +
                std::to_string(mapUs) + " us, copy " + std::to_string(usBetween(t0, t1)) + " us, encode " + std::to_string(usBetween(t1, t2)) + " us (" +
                (eyes == 2 ? "L " + std::to_string(len[0]) + " B, R " + std::to_string(len[1]) + " B" : std::string(eyeName(eye0)) + " " + std::to_string(len[0]) + " B") +
                "), write " + std::to_string(usBetween(t2, t3)) + " us; " + std::to_string(ow) + "x" + std::to_string(oh) + " per eye");
      }
    }
  } catch (...) {
    logOnce("camera_worker_fault", "camera: an internal fault in the worker; the camera stalls until it is asked again");
  }
}

}  // namespace

// ---- the render-thread side -------------------------------------------------------------------------------------------

struct Camera::Impl {
  std::shared_ptr<Shared> sh;
  CameraRequest req;
  bool running = false, refused = false;
  CameraApi api = CameraApi::OpenGL;
  Gl gl;
  bool glLoadTried = false;
  GLuint readFbo = 0, drawFbo = 0, tex = 0;
  uint32_t texW = 0, texH = 0;
  int64_t texFormat = 0;
  bool fboChecked = false;
  uint32_t outW = 0, outH = 0;
  // D8.1 (0.5.3): the eyes sent, as view indices (0 = left, 1 = right) in slot order: {0, 1} for both, {req.eye} for one.
  int nEyes = 2;
  int eyeView[2] = {0, 1};
  bool srcBgra = false;
  int64_t nextDueQpc = 0, intervalQpc = 0, startedQpc = 0;
  uint64_t frameNo = 0;
  uint64_t noViewSince = 0;
  std::string apiName;

  void refuse(const std::string& why) {
    refused = true;
    logLine("camera: refused: " + why + "; the companion falls back to the screen capture");
    panelPipeSendStatus("refused", why, "");
  }

  // ---- OpenGL ----

  bool ensureTexture(const FormatInfo& f) {
    const uint32_t w = outW * static_cast<uint32_t>(nEyes), h = outH;
    const int64_t fmt = f.srgb ? GL_SRGB8_ALPHA8_ : GL_RGBA8_;
    if (tex && texW == w && texH == h && texFormat == fmt) return true;
    GLint prevTex = 0;
    gl.getIntegerv(GL_TEXTURE_BINDING_2D_, &prevTex);
    if (!tex) gl.genTextures(1, &tex);
    gl.bindTexture(GL_TEXTURE_2D_, tex);
    gl.texImage2D(GL_TEXTURE_2D_, 0, static_cast<GLint>(fmt), static_cast<GLsizei>(w), static_cast<GLsizei>(h), 0, GL_RGBA_, GL_UNSIGNED_BYTE_, nullptr);
    gl.texParameteri(GL_TEXTURE_2D_, GL_TEXTURE_MIN_FILTER_, static_cast<GLint>(GL_NEAREST_));
    gl.texParameteri(GL_TEXTURE_2D_, GL_TEXTURE_MAG_FILTER_, static_cast<GLint>(GL_NEAREST_));
    gl.bindTexture(GL_TEXTURE_2D_, static_cast<GLuint>(prevTex));
    texW = w, texH = h, texFormat = fmt;
    fboChecked = false;
    GLint prevDraw = 0;
    gl.getIntegerv(GL_DRAW_FRAMEBUFFER_BINDING_, &prevDraw);
    gl.bindFramebuffer(GL_DRAW_FRAMEBUFFER_, drawFbo);
    gl.framebufferTexture2D(GL_DRAW_FRAMEBUFFER_, GL_COLOR_ATTACHMENT0_, GL_TEXTURE_2D_, tex, 0);
    gl.bindFramebuffer(GL_DRAW_FRAMEBUFFER_, static_cast<GLuint>(prevDraw));
    return gl.getError() == GL_NO_ERROR_;
  }

  void unmapGl(Slot& s) {
    GLint prev = 0;
    gl.getIntegerv(GL_PIXEL_PACK_BUFFER_BINDING_, &prev);
    gl.bindBuffer(GL_PIXEL_PACK_BUFFER_, s.pbo);
    gl.unmapBuffer(GL_PIXEL_PACK_BUFFER_);
    gl.bindBuffer(GL_PIXEL_PACK_BUFFER_, static_cast<GLuint>(prev));
  }

  void freeGlSlot(Slot& s) {
    const int st = s.state.load();
    if (s.pbo && (st == Mapped || st == Consumed)) unmapGl(s);
    if (s.fence) gl.deleteSync(s.fence), s.fence = nullptr;
    if (s.pbo) gl.deleteBuffers(1, &s.pbo), s.pbo = 0;
    s.pboBytes = 0;
    s.state.store(Free);
  }

  bool issueGl(Slot& slot, const CameraView* views) {
    GLint prevRead = 0, prevDraw = 0, prevPbo = 0, prevAlign = 4, prevRow = 0, prevSkipRows = 0, prevSkipPixels = 0;
    gl.getIntegerv(GL_READ_FRAMEBUFFER_BINDING_, &prevRead);
    gl.getIntegerv(GL_DRAW_FRAMEBUFFER_BINDING_, &prevDraw);
    gl.getIntegerv(GL_PIXEL_PACK_BUFFER_BINDING_, &prevPbo);
    gl.getIntegerv(GL_PACK_ALIGNMENT_, &prevAlign);
    gl.getIntegerv(GL_PACK_ROW_LENGTH_, &prevRow);
    gl.getIntegerv(GL_PACK_SKIP_ROWS_, &prevSkipRows);
    gl.getIntegerv(GL_PACK_SKIP_PIXELS_, &prevSkipPixels);
    const bool srgbOn = gl.isEnabled(GL_FRAMEBUFFER_SRGB_) != 0, scissorOn = gl.isEnabled(GL_SCISSOR_TEST_) != 0;
    // Raw values either way (the JPEG takes them as encoded), and no scissor on the blit.
    if (srgbOn) gl.disable(GL_FRAMEBUFFER_SRGB_);
    if (scissorOn) gl.disable(GL_SCISSOR_TEST_);
    // Errors the app left pending are not ours: drained before the copy, so the check after it means something.
    for (int i = 0; i < 16 && gl.getError() != GL_NO_ERROR_; i++) {
    }
    bool ok = true;
    const uint32_t stripW = outW * static_cast<uint32_t>(nEyes);  // the texture: the eyes side by side (one eye: just it)
    const size_t bytes = static_cast<size_t>(stripW) * outH * 4;
    if (!slot.pbo) gl.genBuffers(1, &slot.pbo);
    gl.bindBuffer(GL_PIXEL_PACK_BUFFER_, slot.pbo);
    if (slot.pboBytes != bytes) {
      gl.bufferData(GL_PIXEL_PACK_BUFFER_, static_cast<GLsizeiptr>(bytes), nullptr, GL_STREAM_READ_);
      slot.pboBytes = bytes;
    }
    for (int e = 0; e < nEyes && ok; e++) {
      const CameraView& v = views[eyeView[e]];
      const AppSwapchain& sc = v.swapchain;
      if (sc.lastReleased < 0 || static_cast<size_t>(sc.lastReleased) >= sc.glImages.size()) {
        ok = false;
        break;
      }
      const GLuint src = sc.glImages[static_cast<size_t>(sc.lastReleased)];
      gl.bindFramebuffer(GL_READ_FRAMEBUFFER_, readFbo);
      // The swapchain image's target is the runtime's choice (2D, or an array even of one layer): glFramebufferTexture takes any.
      if (sc.arraySize > 1) gl.framebufferTextureLayer(GL_READ_FRAMEBUFFER_, GL_COLOR_ATTACHMENT0_, src, 0, static_cast<GLint>(v.arrayIndex));
      else gl.framebufferTexture(GL_READ_FRAMEBUFFER_, GL_COLOR_ATTACHMENT0_, src, 0);
      gl.readBuffer(GL_COLOR_ATTACHMENT0_);
      gl.bindFramebuffer(GL_DRAW_FRAMEBUFFER_, drawFbo);
      if (!fboChecked) {
        const GLenum rs = gl.checkFramebufferStatus(GL_READ_FRAMEBUFFER_), ds = gl.checkFramebufferStatus(GL_DRAW_FRAMEBUFFER_);
        if (rs != GL_FRAMEBUFFER_COMPLETE_ || ds != GL_FRAMEBUFFER_COMPLETE_) {
          refuse("the framebuffers for the eye copy are incomplete (read " + hex(rs) + ", draw " + hex(ds) + ")");
          ok = false;
          break;
        }
        fboChecked = true;
      }
      const Crop c = cropFor(v, outW, outH, req.whole);
      gl.blitFramebuffer(c.x, c.y, c.x + c.w, c.y + c.h, static_cast<GLint>(e * outW), 0, static_cast<GLint>((e + 1) * outW), static_cast<GLint>(outH),
                         GL_COLOR_BUFFER_BIT_, GL_LINEAR_);
      EyeMeta& m = slot.eye[e];
      m.fov[0] = v.fovLeft, m.fov[1] = v.fovRight, m.fov[2] = v.fovUp, m.fov[3] = v.fovDown;
      // OpenGL rows run bottom-up: the crop's y from the top of the view's rect.
      m.rect[0] = c.x - v.rectX, m.rect[1] = v.rectH - (c.y - v.rectY) - c.h, m.rect[2] = c.w, m.rect[3] = c.h;
      m.render[0] = v.rectW, m.render[1] = v.rectH;
    }
    if (ok) {
      gl.bindFramebuffer(GL_READ_FRAMEBUFFER_, drawFbo);
      gl.readBuffer(GL_COLOR_ATTACHMENT0_);
      gl.pixelStorei(GL_PACK_ALIGNMENT_, 4);
      gl.pixelStorei(GL_PACK_ROW_LENGTH_, 0);
      gl.pixelStorei(GL_PACK_SKIP_ROWS_, 0);
      gl.pixelStorei(GL_PACK_SKIP_PIXELS_, 0);
      gl.readPixels(0, 0, static_cast<GLsizei>(stripW), static_cast<GLsizei>(outH), GL_RGBA_, GL_UNSIGNED_BYTE_, nullptr);
      slot.fence = gl.fenceSync(GL_SYNC_GPU_COMMANDS_COMPLETE_, 0);
      gl.flush();
      const GLenum err = gl.getError();
      if (err != GL_NO_ERROR_) {
        logOnce("camera_gl_error", "camera: OpenGL reported error " + hex(err) + " while copying the eyes; the frames may be wrong");
        if (frameNo == 0) {
          ok = false;
          refuse("OpenGL error " + hex(err) + " on the first eye copy");
        }
      }
    }
    gl.bindBuffer(GL_PIXEL_PACK_BUFFER_, static_cast<GLuint>(prevPbo));
    gl.pixelStorei(GL_PACK_ALIGNMENT_, prevAlign);
    gl.pixelStorei(GL_PACK_ROW_LENGTH_, prevRow);
    gl.pixelStorei(GL_PACK_SKIP_ROWS_, prevSkipRows);
    gl.pixelStorei(GL_PACK_SKIP_PIXELS_, prevSkipPixels);
    gl.bindFramebuffer(GL_READ_FRAMEBUFFER_, static_cast<GLuint>(prevRead));
    gl.bindFramebuffer(GL_DRAW_FRAMEBUFFER_, static_cast<GLuint>(prevDraw));
    if (srgbOn) gl.enable(GL_FRAMEBUFFER_SRGB_);
    if (scissorOn) gl.enable(GL_SCISSOR_TEST_);
    if (!ok) {
      if (slot.fence) gl.deleteSync(slot.fence), slot.fence = nullptr;
      return false;
    }
    for (int e = 0; e < nEyes; e++) {
      slot.dataW[e] = outW, slot.dataH[e] = outH;
      slot.pitch[e] = static_cast<size_t>(stripW) * 4;
    }
    slot.bottomUp = true;
    slot.swapRB = false;
    return true;
  }

  // The oldest issued slot's copy is done → mapped for the worker. One per tick.
  void mapReadyGl() {
    Slot* oldest = nullptr;
    for (Slot& s : sh->slots)
      if (s.state.load() == Issued && (!oldest || s.n < oldest->n)) oldest = &s;
    if (!oldest) return;
    Slot& s = *oldest;
    GLint status = 0;
    GLsizei len = 0;
    if (s.fence) gl.getSynciv(s.fence, GL_SYNC_STATUS_, 1, &len, &status);
    if (s.fence && status != static_cast<GLint>(GL_SIGNALED_)) {
      s.late++;
      return;
    }
    const int64_t t0 = qpc();
    if (s.fence) gl.deleteSync(s.fence), s.fence = nullptr;
    GLint prev = 0;
    gl.getIntegerv(GL_PIXEL_PACK_BUFFER_BINDING_, &prev);
    gl.bindBuffer(GL_PIXEL_PACK_BUFFER_, s.pbo);
    const auto* base = static_cast<const uint8_t*>(gl.mapBufferRange(GL_PIXEL_PACK_BUFFER_, 0, static_cast<GLsizeiptr>(s.pboBytes), GL_MAP_READ_BIT_));
    gl.bindBuffer(GL_PIXEL_PACK_BUFFER_, static_cast<GLuint>(prev));
    if (!base) {
      logOnce("camera_map_failed", "camera: glMapBufferRange failed (error " + hex(gl.getError()) + "); frames are dropped");
      s.state.store(Free);
      return;
    }
    for (int e = 0; e < 2; e++) s.data[e] = e < nEyes ? base + static_cast<size_t>(e) * outW * 4 : nullptr;
    s.mapUs = usBetween(t0, qpc());
    handOver(s);
  }

  // The slot to the worker: the state changes under the worker's mutex so its wait cannot miss the wake-up (the lock
  // is held for a store, never for GPU work).
  void handOver(Slot& s) {
    {
      std::lock_guard<std::mutex> lk(sh->m);
      s.state.store(Mapped);
    }
    sh->cv.notify_all();
  }

  // ---- D3D11 ----

  void releaseStaging(Slot& s, ID3D11DeviceContext* ctx) {
    for (int e = 0; e < 2; e++) {
      if (s.staging[e]) {
        if (s.mapped[e] && ctx) ctx->Unmap(s.staging[e], 0);
        s.staging[e]->Release();
      }
      s.staging[e] = nullptr;
      s.mapped[e] = false;
      s.stagingW[e] = s.stagingH[e] = 0;
    }
    s.state.store(Free);
  }

  bool ensureStaging(Slot& s, int e, ID3D11Device* device, uint32_t w, uint32_t h, DXGI_FORMAT f) {
    if (s.staging[e] && s.stagingW[e] == w && s.stagingH[e] == h && s.stagingFormat[e] == f) return true;
    if (s.staging[e]) s.staging[e]->Release(), s.staging[e] = nullptr;
    D3D11_TEXTURE2D_DESC d{};
    d.Width = w;
    d.Height = h;
    d.MipLevels = 1;
    d.ArraySize = 1;
    d.Format = f;
    d.SampleDesc.Count = 1;
    d.Usage = D3D11_USAGE_STAGING;
    d.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    if (FAILED(device->CreateTexture2D(&d, nullptr, &s.staging[e]))) {
      s.staging[e] = nullptr;
      return false;
    }
    s.stagingW[e] = w, s.stagingH[e] = h, s.stagingFormat[e] = f;
    return true;
  }

  bool issueD3d(Slot& slot, ID3D11Device* device, const CameraView* views) {
    ID3D11DeviceContext* ctx = nullptr;
    device->GetImmediateContext(&ctx);
    if (!ctx) return false;
    bool ok = true;
    for (int e = 0; e < nEyes && ok; e++) {
      const CameraView& v = views[eyeView[e]];
      const AppSwapchain& sc = v.swapchain;
      if (sc.lastReleased < 0 || static_cast<size_t>(sc.lastReleased) >= sc.d3dImages.size() || !sc.d3dImages[static_cast<size_t>(sc.lastReleased)]) {
        ok = false;
        break;
      }
      ID3D11Texture2D* src = sc.d3dImages[static_cast<size_t>(sc.lastReleased)];
      D3D11_TEXTURE2D_DESC sd{};
      src->GetDesc(&sd);
      const Crop c = cropFor(v, outW, outH, req.whole);
      if (!ensureStaging(slot, e, device, static_cast<uint32_t>(c.w), static_cast<uint32_t>(c.h), sd.Format)) {
        refuse("CreateTexture2D for the staging copy failed");
        ok = false;
        break;
      }
      D3D11_BOX box{};
      box.left = static_cast<UINT>(std::max(0, c.x));
      box.top = static_cast<UINT>(std::max(0, c.y));
      box.front = 0;
      box.right = box.left + static_cast<UINT>(c.w);
      box.bottom = box.top + static_cast<UINT>(c.h);
      box.back = 1;
      ctx->CopySubresourceRegion(slot.staging[e], 0, 0, 0, 0, src, D3D11CalcSubresource(0, v.arrayIndex, sd.MipLevels), &box);
      EyeMeta& m = slot.eye[e];
      m.fov[0] = v.fovLeft, m.fov[1] = v.fovRight, m.fov[2] = v.fovUp, m.fov[3] = v.fovDown;
      m.rect[0] = c.x - v.rectX, m.rect[1] = c.y - v.rectY, m.rect[2] = c.w, m.rect[3] = c.h;
      m.render[0] = v.rectW, m.render[1] = v.rectH;
      slot.dataW[e] = static_cast<uint32_t>(c.w), slot.dataH[e] = static_cast<uint32_t>(c.h);
    }
    ctx->Release();
    if (!ok) return false;
    slot.bottomUp = false;
    slot.swapRB = srcBgra;
    return true;
  }

  void mapReadyD3d(ID3D11Device* device) {
    Slot* oldest = nullptr;
    for (Slot& s : sh->slots)
      if (s.state.load() == Issued && (!oldest || s.n < oldest->n)) oldest = &s;
    if (!oldest) return;
    Slot& s = *oldest;
    ID3D11DeviceContext* ctx = nullptr;
    device->GetImmediateContext(&ctx);
    if (!ctx) return;
    const int64_t t0 = qpc();
    bool all = true;
    for (int e = 0; e < nEyes && all; e++) {
      if (s.mapped[e]) continue;
      D3D11_MAPPED_SUBRESOURCE m{};
      const HRESULT hr = ctx->Map(s.staging[e], 0, D3D11_MAP_READ, D3D11_MAP_FLAG_DO_NOT_WAIT, &m);
      if (hr == DXGI_ERROR_WAS_STILL_DRAWING) {
        s.late++;
        all = false;
        break;
      }
      if (FAILED(hr)) {
        logOnce("camera_d3d_map_failed", "camera: Map of the staging copy failed (" + hex(hr) + "); frames are dropped");
        for (int k = 0; k < 2; k++)
          if (s.mapped[k]) ctx->Unmap(s.staging[k], 0), s.mapped[k] = false;
        s.state.store(Free);
        all = false;
        break;
      }
      s.mapped[e] = true;
      s.data[e] = static_cast<const uint8_t*>(m.pData);
      s.pitch[e] = m.RowPitch;
    }
    ctx->Release();
    if (!all) return;
    s.mapUs = usBetween(t0, qpc());
    handOver(s);
  }

  // ---- both ----

  void reap(ID3D11Device* device) {
    for (Slot& s : sh->slots) {
      if (s.state.load() != Consumed) continue;
      if (api == CameraApi::OpenGL) {
        unmapGl(s);
      } else if (device) {
        ID3D11DeviceContext* ctx = nullptr;
        device->GetImmediateContext(&ctx);
        for (int e = 0; e < 2; e++)
          if (s.mapped[e] && ctx) ctx->Unmap(s.staging[e], 0), s.mapped[e] = false;
        if (ctx) ctx->Release();
      }
      s.state.store(Free);
    }
  }

  bool start(ID3D11Device* device, const CameraView* views) {
    std::string source;
    FormatInfo f;
    // D8.1: one eye (the request's) or both; the first slot index holds the eye everything below is planned from.
    nEyes = req.eye >= 0 ? 1 : 2;
    eyeView[0] = req.eye == 1 ? 1 : 0;
    eyeView[1] = 1;
    const CameraView& v0 = views[eyeView[0]];
    if (api == CameraApi::OpenGL) {
      if (!glLoadTried) gl = loadGl(), glLoadTried = true;
      if (!gl.loaded || !gl.ext()) {
        refuse("this OpenGL context has no framebuffer objects, pixel-pack buffers or fences (OpenGL 3.2 is needed)");
        return false;
      }
      f = glFormat(v0.swapchain.format);
      apiName = "OpenGL";
    } else {
      if (!device) {
        refuse("the D3D11 session has no device");
        return false;
      }
      const AppSwapchain& sc = v0.swapchain;
      if (sc.lastReleased < 0 || static_cast<size_t>(sc.lastReleased) >= sc.d3dImages.size() || !sc.d3dImages[static_cast<size_t>(sc.lastReleased)]) {
        refuse("the D3D11 swapchain's images are not known to the layer");
        return false;
      }
      D3D11_TEXTURE2D_DESC sd{};
      sc.d3dImages[static_cast<size_t>(sc.lastReleased)]->GetDesc(&sd);
      if (sd.SampleDesc.Count > 1) {
        refuse("VPX renders into a multisampled swapchain (" + std::to_string(sd.SampleDesc.Count) + " samples); the layer camera reads single-sampled ones");
        return false;
      }
      f = dxgiFormat(sd.Format);
      srcBgra = f.bgra;
      apiName = "D3D11";
    }
    for (int e = 0; e < 2; e++) {
      const AppSwapchain& sc = views[e].swapchain;
      if (sc.sampleCount > 1) {
        refuse("VPX renders into a multisampled swapchain (" + std::to_string(sc.sampleCount) + " samples); the layer camera reads single-sampled ones");
        return false;
      }
      if (views[e].rectW < 2 || views[e].rectH < 2) {
        refuse("the projection view's rect is empty");
        return false;
      }
    }
    if (!f.ok) {
      refuse("swapchain format " + hex(v0.swapchain.format) + " is not an 8-bit RGBA format the layer camera reads");
      return false;
    }
    planOutput(v0, req, outW, outH);
    if (api == CameraApi::OpenGL) {
      if (!readFbo) gl.genFramebuffers(1, &readFbo);
      if (!drawFbo) gl.genFramebuffers(1, &drawFbo);
      if (!readFbo || !drawFbo || !ensureTexture(f)) {
        refuse("could not create the framebuffers or the " + std::to_string(outW * static_cast<uint32_t>(nEyes)) + "x" + std::to_string(outH) +
               " texture for the eye copy (OpenGL error " + hex(gl.getError()) + ")");
        return false;
      }
    }
    sh = std::make_shared<Shared>();
    sh->startQpc = qpc();
    std::thread(workerMain, sh).detach();
    if (nEyes == 2) std::thread(helperMain, sh).detach();  // the right eye's encoder: nothing for it with one eye (D8.1)
    intervalQpc = qpcFreq() / static_cast<int64_t>(req.fps > 0 ? req.fps : 30);
    nextDueQpc = qpc();
    startedQpc = nextDueQpc;
    frameNo = 0;
    fboChecked = false;
    running = true;
    refused = false;
    const Crop c = cropFor(v0, outW, outH, req.whole);
    const CameraView& v = v0;
    const std::string eyesText = nEyes == 2 ? std::string("both eyes") : std::string("one eye (") + eyeName(eyeView[0]) + ")";
    logLine("camera: on (" + apiName + "): eye render " + std::to_string(v.rectW) + "x" + std::to_string(v.rectH) + " (rect " + std::to_string(v.rectX) + "," +
            std::to_string(v.rectY) + " of a " + std::to_string(v.swapchain.width) + "x" + std::to_string(v.swapchain.height) + " swapchain, format " +
            hex(v.swapchain.format) + " " + f.name + (f.srgb ? ", sRGB" : ", linear-tagged") + "), crop " + std::to_string(c.w) + "x" + std::to_string(c.h) +
            " at " + std::to_string(c.x) + "," + std::to_string(c.y) + (req.whole ? " (whole)" : "") + " -> " + std::to_string(outW) + "x" +
            std::to_string(outH) + " per eye at " + std::to_string(req.fps) + " fps, " + eyesText + ", JPEG quality " + std::to_string(kJpegQuality) +
            "; frame times follow (the first " + std::to_string(kLogFirst) + ", then every " + std::to_string(kLogEvery) + "th)");
    panelPipeSendStatus("on", "", ",\"api\":\"" + apiName + "\",\"source\":[" + std::to_string(v.rectW) + "," + std::to_string(v.rectH) + "],\"size\":[" +
                                    std::to_string(outW) + "," + std::to_string(outH) + "],\"fps\":" + std::to_string(req.fps) +
                                    ",\"whole\":" + (req.whole ? "true" : "false") +
                                    (nEyes == 1 ? std::string(",\"eye\":\"") + eyeName(eyeView[0]) + "\"" : std::string()));
    return true;
  }

  // Stops the worker and frees the slots. OpenGL: the context must be current here.
  void stop(const std::string& why, ID3D11Device* device, bool freeGpu) {
    if (!running) return;
    running = false;
    std::shared_ptr<Shared> s = sh;
    {
      std::lock_guard<std::mutex> lk(s->m);
      std::lock_guard<std::mutex> lh(s->hm);
      s->stop.store(true);
    }
    s->cv.notify_all();
    s->hcv.notify_all();
    // The worker lets go of mapped memory within a copy's time; wait for that (bounded), never for its encode or write.
    const uint64_t until = GetTickCount64() + kShutdownWaitMs;
    for (;;) {
      bool mapped = false;
      for (Slot& sl : s->slots)
        if (sl.state.load() == Mapped) mapped = true;
      if (!mapped || GetTickCount64() >= until) break;
      Sleep(1);
    }
    ID3D11DeviceContext* ctx = nullptr;
    if (api == CameraApi::D3D11 && device) device->GetImmediateContext(&ctx);
    for (Slot& sl : s->slots) {
      if (api == CameraApi::OpenGL) {
        if (freeGpu) freeGlSlot(sl);
      } else {
        releaseStaging(sl, ctx);
      }
    }
    if (ctx) ctx->Release();
    if (api == CameraApi::OpenGL && freeGpu) {
      if (tex) gl.deleteTextures(1, &tex), tex = 0;
      if (readFbo) gl.deleteFramebuffers(1, &readFbo), readFbo = 0;
      if (drawFbo) gl.deleteFramebuffers(1, &drawFbo), drawFbo = 0;
      texW = texH = 0;
    }
    const uint64_t sent = s->sent.load(), ring = s->droppedRing.load(), behind = s->droppedBehind.load(), writes = s->droppedWrite.load();
    const double secs = static_cast<double>(usBetween(startedQpc, qpc())) / 1e6;
    const auto avg = [&](const std::atomic<uint64_t>& sum) { return sent ? std::to_string(sum.load() / sent) : std::string("-"); };
    logLine("camera: off (" + why + "): " + std::to_string(sent) + " frames sent in " + fixed(secs, 1) + " s" +
            (secs > 0.5 && sent ? " (" + fixed(static_cast<double>(sent) / secs, 1) + " fps)" : std::string()) + ", " + std::to_string(ring + behind + writes) +
            " dropped (ring full " + std::to_string(ring) + ", worker behind " + std::to_string(behind) + ", write failed " + std::to_string(writes) +
            "); average issue " + avg(s->sumIssue) + " us, map " + avg(s->sumMap) + " us, copy " + avg(s->sumCopy) + " us, encode " + avg(s->sumEnc) +
            " us, write " + avg(s->sumWrite) + " us, " + (sent ? std::to_string(s->sumBytes.load() / sent / 1024) : std::string("-")) + " KB a frame");
    panelPipeSendStatus("off", why, "");
    sh.reset();
  }
};

Camera::Camera() : impl_(std::make_unique<Impl>()) {}

Camera::~Camera() = default;

void Camera::tick(const CameraRequest& req, CameraApi api, ID3D11Device* device, const CameraView* views, size_t viewCount) {
  Impl& I = *impl_;
  if (!req.on) {
    if (I.running) I.stop("the companion turned it off", device, true);
    I.refused = false;
    I.noViewSince = 0;
    return;
  }
  if (I.running && (req != I.req || api != I.api)) I.stop("a new request", device, true);
  if (I.refused && req == I.req) return;
  I.req = req;
  I.api = api;
  const bool haveViews = viewCount >= 2 && views && views[0].known && views[1].known && views[0].swapchain.lastReleased >= 0 && views[1].swapchain.lastReleased >= 0;
  if (!I.running) {
    if (!haveViews) {
      const uint64_t now = GetTickCount64();
      if (I.noViewSince == 0) I.noViewSince = now;
      else if (now - I.noViewSince >= kNoViewLogAfterMs) {
        I.noViewSince = now;
        logOnce("camera_no_view", "camera: asked, but VPX submits no projection layer whose swapchain the layer saw created; waiting (a VPX started before the layer cannot be read)");
      }
      return;
    }
    I.noViewSince = 0;
    if (!I.start(device, views)) return;
  }
  I.reap(device);
  if (I.api == CameraApi::OpenGL) I.mapReadyGl();
  else I.mapReadyD3d(device);
  if (!haveViews) return;
  const int64_t now = qpc();
  if (now < I.nextDueQpc) return;
  // The next due time: on the grid, or now when behind by more than a frame (a stalled loop never bursts).
  I.nextDueQpc += I.intervalQpc;
  if (I.nextDueQpc < now) I.nextDueQpc = now + I.intervalQpc;
  Slot* slot = nullptr;
  for (Slot& s : I.sh->slots)
    if (s.state.load() == Free) {
      slot = &s;
      break;
    }
  if (!slot) {
    I.sh->droppedRing++;
    return;
  }
  const int64_t t0 = qpc();
  slot->outW = I.outW, slot->outH = I.outH;
  slot->eyes = I.nEyes, slot->eye0 = I.eyeView[0];
  slot->late = 0;
  slot->mapUs = 0;
  const bool ok = I.api == CameraApi::OpenGL ? I.issueGl(*slot, views) : I.issueD3d(*slot, device, views);
  if (!ok) {
    if (I.refused) I.stop("refused", device, true);
    return;
  }
  slot->n = ++I.frameNo;
  slot->issuedQpc = t0;
  slot->issueUs = usBetween(t0, qpc());
  slot->state.store(Issued);
}

void Camera::shutdown(HDC dc, HGLRC rc) {
  Impl& I = *impl_;
  if (!I.running) return;
  bool freeGpu = true;
  if (I.api == CameraApi::OpenGL) {
    freeGpu = I.gl.loaded && rc && I.gl.getCurrentContext() == rc;
    if (!freeGpu && I.gl.loaded && dc && rc && I.gl.makeCurrent(dc, rc)) freeGpu = true;
  }
  I.stop("the session ended", nullptr, freeGpu);
}

}  // namespace castcade
