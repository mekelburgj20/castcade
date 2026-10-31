// XrApiLayer_castcade_panel: an implicit OpenXR API layer that appends the Castcade match panel to VPinballX's frames
// as one head-locked quad (D7.3, 2026-10-31; vr-layer/README.md; docs/design/alpha-match.md §5).
//
// Why a layer: on the owner's rig (and Krobs') VPX reaches Virtual Desktop's OpenXR runtime through OpenComposite, so
// no SteamVR compositor exists for the OpenVR overlay helper (vr-overlay/) to draw into. OpenComposite carries the
// Khronos loader (built statically from OpenXR-SDK sources), which reads the implicit layer list from the registry, so
// this dll loads inside VPX's process whatever the runtime.
//
// Rules:
//   - active only when the host exe is VPinballX*.exe; anywhere else every function passes straight through;
//   - hooks xrCreateSession (learns the graphics binding: D3D11 or OpenGL on Win32; any other → that session passes
//     through, logged with the binding's name), xrDestroySession, xrEndFrame, xrDestroyInstance;
//   - frames come over \\.\pipe\castcade-panel (panel_pipe.cpp); the first one creates our VIEW space and swapchain;
//   - xrEndFrame with a live frame: the app's layers plus our quad, unless the app is at maxLayerCount;
//   - never throws across the API: an exception (or, with /EHa, a structured exception) turns the panel off for the
//     process; an OpenXR call of ours that fails turns it off for that session. Each logs once.
#include <windows.h>

#include <d3d11.h>

#define XR_NO_PROTOTYPES  // every OpenXR call goes to the next layer's function pointers; the loader is not linked
#define XR_USE_PLATFORM_WIN32
#define XR_USE_GRAPHICS_API_D3D11
#define XR_USE_GRAPHICS_API_OPENGL
#include <openxr/openxr.h>
#include <openxr/openxr_loader_negotiation.h>
#include <openxr/openxr_platform.h>

#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <cwctype>
#include <iterator>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "layer_log.h"
#include "panel_pipe.h"

namespace castcade {
namespace {

constexpr const char* kLayerName = "XR_APILAYER_CASTCADE_panel";

// The SteamVR helper's defaults (VR_OVERLAY_DEFAULTS in companion/src/media/match-media-types.ts): 0.55 m wide, in the
// head's space 0.28 m below and 0.9 m ahead of the eyes. OpenXR's VIEW space has the same axes as OpenVR's HMD space
// (+X right, +Y up, -Z ahead).
constexpr float kPanelWidthM = 0.55f;
constexpr float kPanelOffset[3] = {0.0f, -0.28f, -0.9f};

// ---- OpenGL without linking it ---------------------------------------------------------------------------------------
// GL 1.1 entry points and wgl* come from the opengl32.dll the app has loaded (GetProcAddress), glBindBuffer from
// wglGetProcAddress. Enum values from the OpenGL registry (gl.xml); typed here so <GL/gl.h> is not needed.
using GLenum = unsigned int;
using GLint = int;
using GLuint = unsigned int;
using GLsizei = int;
constexpr GLenum GL_TEXTURE_2D_ = 0x0DE1;
constexpr GLenum GL_TEXTURE_BINDING_2D_ = 0x8069;
constexpr GLenum GL_UNPACK_ROW_LENGTH_ = 0x0CF2;
constexpr GLenum GL_UNPACK_SKIP_ROWS_ = 0x0CF3;
constexpr GLenum GL_UNPACK_SKIP_PIXELS_ = 0x0CF4;
constexpr GLenum GL_UNPACK_ALIGNMENT_ = 0x0CF5;
constexpr GLenum GL_UNSIGNED_BYTE_ = 0x1401;
constexpr GLenum GL_BGRA_ = 0x80E1;
constexpr GLenum GL_RGBA8_ = 0x8058;
constexpr GLenum GL_SRGB8_ALPHA8_ = 0x8C43;
constexpr GLenum GL_PIXEL_UNPACK_BUFFER_ = 0x88EC;
constexpr GLenum GL_PIXEL_UNPACK_BUFFER_BINDING_ = 0x88EF;

struct Gl {
  void(WINAPI* bindTexture)(GLenum, GLuint) = nullptr;
  void(WINAPI* texSubImage2D)(GLenum, GLint, GLint, GLint, GLsizei, GLsizei, GLenum, GLenum, const void*) = nullptr;
  void(WINAPI* getIntegerv)(GLenum, GLint*) = nullptr;
  void(WINAPI* pixelStorei)(GLenum, GLint) = nullptr;
  void(WINAPI* bindBuffer)(GLenum, GLuint) = nullptr;  // GL 1.5; null on a context without it (then no PBO can be bound)
  HGLRC(WINAPI* getCurrentContext)() = nullptr;
  HDC(WINAPI* getCurrentDC)() = nullptr;
  BOOL(WINAPI* makeCurrent)(HDC, HGLRC) = nullptr;
  PROC(WINAPI* getProcAddress)(LPCSTR) = nullptr;
  bool ok() const { return bindTexture && texSubImage2D && getIntegerv && pixelStorei && getCurrentContext && getCurrentDC && makeCurrent && getProcAddress; }
};

template <typename T>
void resolve(HMODULE m, const char* name, T& out) {
  out = reinterpret_cast<T>(reinterpret_cast<void*>(GetProcAddress(m, name)));
}

Gl loadGl() {
  Gl g;
  const HMODULE m = GetModuleHandleW(L"opengl32.dll");
  if (!m) return g;
  resolve(m, "glBindTexture", g.bindTexture);
  resolve(m, "glTexSubImage2D", g.texSubImage2D);
  resolve(m, "glGetIntegerv", g.getIntegerv);
  resolve(m, "glPixelStorei", g.pixelStorei);
  resolve(m, "wglGetCurrentContext", g.getCurrentContext);
  resolve(m, "wglGetCurrentDC", g.getCurrentDC);
  resolve(m, "wglMakeCurrent", g.makeCurrent);
  resolve(m, "wglGetProcAddress", g.getProcAddress);
  return g;
}

// ---- dispatch ---------------------------------------------------------------------------------------------------------

struct Next {
  PFN_xrGetInstanceProcAddr getInstanceProcAddr = nullptr;
  PFN_xrDestroyInstance destroyInstance = nullptr;
  PFN_xrResultToString resultToString = nullptr;
  PFN_xrGetSystemProperties getSystemProperties = nullptr;
  PFN_xrCreateSession createSession = nullptr;
  PFN_xrDestroySession destroySession = nullptr;
  PFN_xrEndFrame endFrame = nullptr;
  PFN_xrCreateReferenceSpace createReferenceSpace = nullptr;
  PFN_xrEnumerateSwapchainFormats enumerateSwapchainFormats = nullptr;
  PFN_xrCreateSwapchain createSwapchain = nullptr;
  PFN_xrDestroySwapchain destroySwapchain = nullptr;
  PFN_xrEnumerateSwapchainImages enumerateSwapchainImages = nullptr;
  PFN_xrAcquireSwapchainImage acquireSwapchainImage = nullptr;
  PFN_xrWaitSwapchainImage waitSwapchainImage = nullptr;
  PFN_xrReleaseSwapchainImage releaseSwapchainImage = nullptr;
};

struct Instance {
  XrInstance handle = XR_NULL_HANDLE;
  Next next;
  bool hooked = false;  // VPX, and every function we need resolved
};

enum class Api { None, D3D11, OpenGL };

struct Session {
  XrSession handle = XR_NULL_HANDLE;
  XrInstance instance = XR_NULL_HANDLE;
  Next next;
  Api api = Api::None;
  bool off = false;  // one of our OpenXR calls failed in this session: pass-through from then on
  uint32_t maxLayers = XR_MIN_COMPOSITION_LAYERS_SUPPORTED;
  uint32_t maxWidth = 4096, maxHeight = 4096;
  ID3D11Device* device = nullptr;  // the app's; not AddRef'd (it outlives the session by the spec's rules)
  HDC dc = nullptr;
  HGLRC rc = nullptr;
  Gl gl;
  XrSpace space = XR_NULL_HANDLE;
  XrSwapchain swapchain = XR_NULL_HANDLE;
  int64_t format = 0;
  bool swapRedBlue = false;  // D3D11 RGBA format: the BGRA frame needs R and B swapped
  uint32_t width = 0, height = 0;
  std::vector<XrSwapchainImageD3D11KHR> d3dImages;
  std::vector<XrSwapchainImageOpenGLKHR> glImages;
  bool released = false;  // an image has been released, so a quad may reference the swapchain (XR_ERROR_LAYER_INVALID otherwise)
  std::vector<uint8_t> frame, staging;
  uint32_t frameW = 0, frameH = 0;
  XrCompositionLayerQuad quad{};
  std::vector<const XrCompositionLayerBaseHeader*> layers;
};

std::mutex g_mutex;
std::map<XrInstance, std::shared_ptr<Instance>> g_instances;
std::map<XrSession, std::shared_ptr<Session>> g_sessions;
PFN_xrGetInstanceProcAddr g_lastNextGipa = nullptr;  // for calls on XR_NULL_HANDLE (one runtime per process)
std::atomic<bool> g_disabled{false};

// VPinballX*.exe, case-insensitive; read once. Everything else (other OpenXR apps on this PC) gets a pure pass-through.
bool hostIsVpx() {
  static const bool vpx = [] {
    wchar_t path[MAX_PATH * 2];
    const DWORD n = GetModuleFileNameW(nullptr, path, static_cast<DWORD>(sizeof path / sizeof path[0]));
    if (n == 0 || n >= sizeof path / sizeof path[0]) return false;
    std::wstring name(path, n);
    const size_t slash = name.find_last_of(L"\\/");
    if (slash != std::wstring::npos) name = name.substr(slash + 1);
    for (wchar_t& c : name) c = static_cast<wchar_t>(std::towlower(c));
    return name.size() >= 13 && name.compare(0, 9, L"vpinballx") == 0 && name.compare(name.size() - 4, 4, L".exe") == 0;
  }();
  return vpx;
}

std::string exeName() {
  char path[MAX_PATH * 2];
  const DWORD n = GetModuleFileNameA(nullptr, path, static_cast<DWORD>(sizeof path));
  std::string s(path, n < sizeof path ? n : 0);
  const size_t slash = s.find_last_of("\\/");
  return slash == std::string::npos ? s : s.substr(slash + 1);
}

void disable(const std::string& why) {
  if (!g_disabled.exchange(true)) logLine("off for the rest of this process: " + why);
}

std::string resultName(const Next& n, XrInstance instance, XrResult r) {
  char buf[XR_MAX_RESULT_STRING_SIZE] = {};
  if (n.resultToString && instance != XR_NULL_HANDLE && XR_SUCCEEDED(n.resultToString(instance, r, buf))) return buf;
  return "XrResult " + std::to_string(static_cast<int>(r));
}

const char* bindingName(XrStructureType t) {
  switch (static_cast<int>(t)) {
    case XR_TYPE_GRAPHICS_BINDING_D3D11_KHR: return "D3D11";
    case XR_TYPE_GRAPHICS_BINDING_OPENGL_WIN32_KHR: return "OpenGL (Win32)";
    case XR_TYPE_GRAPHICS_BINDING_D3D12_KHR: return "D3D12";
    case XR_TYPE_GRAPHICS_BINDING_VULKAN_KHR: return "Vulkan";  // = XR_TYPE_GRAPHICS_BINDING_VULKAN2_KHR
    default: return nullptr;
  }
}

// ---- placement --------------------------------------------------------------------------------------------------------

// The quad at kPanelOffset turned so its front (+Z) faces the eye, kept upright: the SteamVR helper's facingOrigin()
// (vr-overlay/src/main.cpp) as a quaternion. At the default offset that is a ~17° tilt back.
XrPosef panelPose() {
  XrPosef p{};
  p.position = {kPanelOffset[0], kPanelOffset[1], kPanelOffset[2]};
  p.orientation = {0.0f, 0.0f, 0.0f, 1.0f};
  const float tx = -kPanelOffset[0], ty = -kPanelOffset[1], tz = -kPanelOffset[2];
  const float tl = std::sqrt(tx * tx + ty * ty + tz * tz);
  if (tl < 1e-4f) return p;
  const float nx = tx / tl, ny = ty / tl, nz = tz / tl;  // front
  float rx = nz, ry = 0.0f, rz = -nx;                    // right = up(0,1,0) x front
  const float rl = std::sqrt(rx * rx + rz * rz);
  if (rl < 1e-4f) rx = 1.0f, rz = 0.0f;
  else rx /= rl, rz /= rl;
  const float ux = ny * rz - nz * ry, uy = nz * rx - nx * rz, uz = nx * ry - ny * rx;  // up = front x right
  // Columns right, up, front → quaternion (Shepperd).
  const float m00 = rx, m01 = ux, m02 = nx, m10 = ry, m11 = uy, m12 = ny, m20 = rz, m21 = uz, m22 = nz;
  const float tr = m00 + m11 + m22;
  XrQuaternionf q{};
  if (tr > 0.0f) {
    const float s = std::sqrt(tr + 1.0f) * 2.0f;
    q.w = 0.25f * s, q.x = (m21 - m12) / s, q.y = (m02 - m20) / s, q.z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const float s = std::sqrt(1.0f + m00 - m11 - m22) * 2.0f;
    q.w = (m21 - m12) / s, q.x = 0.25f * s, q.y = (m01 + m10) / s, q.z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const float s = std::sqrt(1.0f + m11 - m00 - m22) * 2.0f;
    q.w = (m02 - m20) / s, q.x = (m01 + m10) / s, q.y = 0.25f * s, q.z = (m12 + m21) / s;
  } else {
    const float s = std::sqrt(1.0f + m22 - m00 - m11) * 2.0f;
    q.w = (m10 - m01) / s, q.x = (m02 + m20) / s, q.y = (m12 + m21) / s, q.z = 0.25f * s;
  }
  p.orientation = q;
  return p;
}

// ---- the panel in one session -----------------------------------------------------------------------------------------

// Fails the session (pass-through from now on) with one log line naming the call.
bool check(Session& s, XrResult r, const char* what) {
  if (XR_SUCCEEDED(r)) return true;
  s.off = true;
  logLine(std::string("session: ") + what + " failed (" + resultName(s.next, s.instance, r) + "); the panel is off for this session");
  return false;
}

// The app's GL context current on this thread for the duration (the spec lets the runtime's swapchain calls and ours
// run with it bound here, never bound elsewhere, during xrEndFrame), then whatever was current before.
class GlContextScope {
 public:
  explicit GlContextScope(Session& s) : s_(s) {
    prevRc_ = s.gl.getCurrentContext();
    prevDc_ = s.gl.getCurrentDC();
    ok_ = prevRc_ == s.rc || s.gl.makeCurrent(s.dc, s.rc) != FALSE;
  }
  ~GlContextScope() {
    if (prevRc_ != s_.rc) s_.gl.makeCurrent(prevDc_, prevRc_);
  }
  bool ok() const { return ok_; }
  GlContextScope(const GlContextScope&) = delete;
  GlContextScope& operator=(const GlContextScope&) = delete;

 private:
  Session& s_;
  HGLRC prevRc_ = nullptr;
  HDC prevDc_ = nullptr;
  bool ok_ = false;
};

// sRGB first: Chromium's pixels are sRGB-encoded, and an _SRGB swapchain tells the compositor so (in a UNORM one most
// runtimes would read them as linear and show the panel washed out).
int64_t pickFormat(Session& s, const std::vector<int64_t>& have) {
  std::vector<int64_t> want;
  if (s.api == Api::D3D11)
    want = {DXGI_FORMAT_R8G8B8A8_UNORM_SRGB, DXGI_FORMAT_B8G8R8A8_UNORM_SRGB, DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_FORMAT_B8G8R8A8_UNORM};
  else
    want = {GL_SRGB8_ALPHA8_, GL_RGBA8_};
  for (int64_t f : want)
    for (int64_t h : have)
      if (f == h) return f;
  return 0;
}

bool ensureSwapchain(Session& s, uint32_t w, uint32_t h) {
  if (s.swapchain != XR_NULL_HANDLE && s.width == w && s.height == h) return true;
  if (w > s.maxWidth || h > s.maxHeight) {
    logOnce("frame_too_big", "session: a " + std::to_string(w) + "x" + std::to_string(h) + " frame is larger than the runtime's " +
                                 std::to_string(s.maxWidth) + "x" + std::to_string(s.maxHeight) + " swapchain limit; frames that size are skipped");
    return false;
  }
  if (s.space == XR_NULL_HANDLE) {
    XrReferenceSpaceCreateInfo si{XR_TYPE_REFERENCE_SPACE_CREATE_INFO};
    si.referenceSpaceType = XR_REFERENCE_SPACE_TYPE_VIEW;
    si.poseInReferenceSpace.orientation.w = 1.0f;
    if (!check(s, s.next.createReferenceSpace(s.handle, &si, &s.space), "xrCreateReferenceSpace(VIEW)")) return false;
  }
  if (s.swapchain != XR_NULL_HANDLE) {  // the panel changed size: a new swapchain at the new size
    s.next.destroySwapchain(s.swapchain);
    s.swapchain = XR_NULL_HANDLE;
    s.released = false;
    s.d3dImages.clear();
    s.glImages.clear();
  }
  uint32_t count = 0;
  if (!check(s, s.next.enumerateSwapchainFormats(s.handle, 0, &count, nullptr), "xrEnumerateSwapchainFormats")) return false;
  std::vector<int64_t> formats(count);
  if (!check(s, s.next.enumerateSwapchainFormats(s.handle, count, &count, formats.data()), "xrEnumerateSwapchainFormats")) return false;
  formats.resize(count);
  s.format = pickFormat(s, formats);
  if (s.format == 0) {
    s.off = true;
    logLine("session: the runtime offers no RGBA8 / BGRA8 swapchain format; the panel is off for this session");
    return false;
  }
  s.swapRedBlue = s.api == Api::D3D11 && (s.format == DXGI_FORMAT_R8G8B8A8_UNORM_SRGB || s.format == DXGI_FORMAT_R8G8B8A8_UNORM);
  XrSwapchainCreateInfo ci{XR_TYPE_SWAPCHAIN_CREATE_INFO};
  ci.usageFlags = XR_SWAPCHAIN_USAGE_SAMPLED_BIT | XR_SWAPCHAIN_USAGE_COLOR_ATTACHMENT_BIT | XR_SWAPCHAIN_USAGE_TRANSFER_DST_BIT;
  ci.format = s.format;
  ci.sampleCount = 1;
  ci.width = w;
  ci.height = h;
  ci.faceCount = 1;
  ci.arraySize = 1;
  ci.mipCount = 1;
  if (!check(s, s.next.createSwapchain(s.handle, &ci, &s.swapchain), "xrCreateSwapchain")) return false;
  if (!check(s, s.next.enumerateSwapchainImages(s.swapchain, 0, &count, nullptr), "xrEnumerateSwapchainImages")) return false;
  if (s.api == Api::D3D11) {
    s.d3dImages.assign(count, XrSwapchainImageD3D11KHR{XR_TYPE_SWAPCHAIN_IMAGE_D3D11_KHR});
    if (!check(s, s.next.enumerateSwapchainImages(s.swapchain, count, &count, reinterpret_cast<XrSwapchainImageBaseHeader*>(s.d3dImages.data())),
               "xrEnumerateSwapchainImages"))
      return false;
  } else {
    s.glImages.assign(count, XrSwapchainImageOpenGLKHR{XR_TYPE_SWAPCHAIN_IMAGE_OPENGL_KHR});
    if (!check(s, s.next.enumerateSwapchainImages(s.swapchain, count, &count, reinterpret_cast<XrSwapchainImageBaseHeader*>(s.glImages.data())),
               "xrEnumerateSwapchainImages"))
      return false;
  }
  s.width = w;
  s.height = h;
  logLine("session: swapchain " + std::to_string(w) + "x" + std::to_string(h) + ", format " + std::to_string(s.format) + ", " +
          std::to_string(count) + " images");
  return true;
}

// The frame as the swapchain wants it: D3D11 top-down (R/B swapped for an RGBA format, as the SteamVR helper does),
// OpenGL bottom-up (the spec puts a GL swapchain image's origin at its bottom-left; uploaded as GL_BGRA, no swap).
const uint8_t* prepared(Session& s) {
  const uint32_t w = s.frameW, h = s.frameH;
  const size_t row = static_cast<size_t>(w) * 4;
  const bool flip = s.api == Api::OpenGL;
  if (!flip && !s.swapRedBlue) return s.frame.data();
  s.staging.resize(row * h);
  for (uint32_t y = 0; y < h; y++) {
    const uint8_t* src = s.frame.data() + row * y;
    uint8_t* dst = s.staging.data() + row * (flip ? h - 1 - y : y);
    if (!s.swapRedBlue) {
      std::memcpy(dst, src, row);
      continue;
    }
    for (size_t i = 0; i < row; i += 4) {
      dst[i] = src[i + 2];
      dst[i + 1] = src[i + 1];
      dst[i + 2] = src[i];
      dst[i + 3] = src[i + 3];
    }
  }
  return s.staging.data();
}

void uploadGl(Session& s, GLuint texture, const uint8_t* px) {
  const Gl& gl = s.gl;
  GLint prevTex = 0, prevRow = 0, prevSkipRows = 0, prevSkipPixels = 0, prevAlign = 4, prevPbo = 0;
  gl.getIntegerv(GL_TEXTURE_BINDING_2D_, &prevTex);
  gl.getIntegerv(GL_UNPACK_ROW_LENGTH_, &prevRow);
  gl.getIntegerv(GL_UNPACK_SKIP_ROWS_, &prevSkipRows);
  gl.getIntegerv(GL_UNPACK_SKIP_PIXELS_, &prevSkipPixels);
  gl.getIntegerv(GL_UNPACK_ALIGNMENT_, &prevAlign);
  // A pixel-unpack buffer the app left bound would turn our pointer into an offset into it.
  if (gl.bindBuffer) gl.getIntegerv(GL_PIXEL_UNPACK_BUFFER_BINDING_, &prevPbo);
  if (prevPbo) gl.bindBuffer(GL_PIXEL_UNPACK_BUFFER_, 0);
  gl.pixelStorei(GL_UNPACK_ROW_LENGTH_, 0);
  gl.pixelStorei(GL_UNPACK_SKIP_ROWS_, 0);
  gl.pixelStorei(GL_UNPACK_SKIP_PIXELS_, 0);
  gl.pixelStorei(GL_UNPACK_ALIGNMENT_, 4);
  gl.bindTexture(GL_TEXTURE_2D_, texture);
  gl.texSubImage2D(GL_TEXTURE_2D_, 0, 0, 0, static_cast<GLsizei>(s.frameW), static_cast<GLsizei>(s.frameH), GL_BGRA_, GL_UNSIGNED_BYTE_, px);
  gl.bindTexture(GL_TEXTURE_2D_, static_cast<GLuint>(prevTex));
  gl.pixelStorei(GL_UNPACK_ROW_LENGTH_, prevRow);
  gl.pixelStorei(GL_UNPACK_SKIP_ROWS_, prevSkipRows);
  gl.pixelStorei(GL_UNPACK_SKIP_PIXELS_, prevSkipPixels);
  gl.pixelStorei(GL_UNPACK_ALIGNMENT_, prevAlign);
  if (prevPbo) gl.bindBuffer(GL_PIXEL_UNPACK_BUFFER_, static_cast<GLuint>(prevPbo));
}

// A new frame (if any) into the next swapchain image. Inside xrEndFrame, so on the thread and with the guarantees the
// app gives for its own frame submission.
void uploadNewFrame(Session& s) {
  if (!panelPipeTake(s.frame, s.frameW, s.frameH)) return;
  std::unique_ptr<GlContextScope> scope;
  if (s.api == Api::OpenGL) {
    scope = std::make_unique<GlContextScope>(s);
    if (!scope->ok()) {
      s.off = true;
      logLine("session: wglMakeCurrent on the app's context failed (error " + std::to_string(GetLastError()) + "); the panel is off for this session");
      return;
    }
    if (!s.gl.bindBuffer) {
      // wglGetProcAddress answers 1, 2, 3 or -1 instead of null on some drivers.
      const auto p = reinterpret_cast<intptr_t>(s.gl.getProcAddress("glBindBuffer"));
      if (p != 0 && p != 1 && p != 2 && p != 3 && p != -1) s.gl.bindBuffer = reinterpret_cast<decltype(s.gl.bindBuffer)>(p);
    }
  }
  if (!ensureSwapchain(s, s.frameW, s.frameH)) return;
  uint32_t index = 0;
  XrSwapchainImageAcquireInfo ai{XR_TYPE_SWAPCHAIN_IMAGE_ACQUIRE_INFO};
  if (!check(s, s.next.acquireSwapchainImage(s.swapchain, &ai, &index), "xrAcquireSwapchainImage")) return;
  XrSwapchainImageWaitInfo wi{XR_TYPE_SWAPCHAIN_IMAGE_WAIT_INFO};
  wi.timeout = XR_INFINITE_DURATION;
  if (!check(s, s.next.waitSwapchainImage(s.swapchain, &wi), "xrWaitSwapchainImage")) return;
  const uint8_t* px = prepared(s);
  if (s.api == Api::D3D11) {
    ID3D11DeviceContext* ctx = nullptr;
    s.device->GetImmediateContext(&ctx);
    if (ctx) {
      ctx->UpdateSubresource(s.d3dImages.at(index).texture, 0, nullptr, px, s.frameW * 4, s.frameW * s.frameH * 4);
      ctx->Release();
    }
  } else {
    uploadGl(s, s.glImages.at(index).image, px);
  }
  XrSwapchainImageReleaseInfo ri{XR_TYPE_SWAPCHAIN_IMAGE_RELEASE_INFO};
  if (!check(s, s.next.releaseSwapchainImage(s.swapchain, &ri), "xrReleaseSwapchainImage")) return;
  if (!s.released) logLine("session: the panel is up");
  s.released = true;
}

// Our quad for this frame, or null (no live frame, nothing uploaded yet, or the session is off).
const XrCompositionLayerBaseHeader* panelLayer(Session& s) {
  uploadNewFrame(s);
  if (s.off || !s.released || !panelPipeLive()) return nullptr;
  XrCompositionLayerQuad& q = s.quad;
  q = XrCompositionLayerQuad{XR_TYPE_COMPOSITION_LAYER_QUAD};
  // Chromium's offscreen bitmap is premultiplied BGRA: blend by its alpha, premultiplied (no UNPREMULTIPLIED bit).
  q.layerFlags = XR_COMPOSITION_LAYER_BLEND_TEXTURE_SOURCE_ALPHA_BIT;
  q.space = s.space;
  q.eyeVisibility = XR_EYE_VISIBILITY_BOTH;
  q.subImage.swapchain = s.swapchain;
  q.subImage.imageRect.offset = {0, 0};
  q.subImage.imageRect.extent = {static_cast<int32_t>(s.width), static_cast<int32_t>(s.height)};
  q.subImage.imageArrayIndex = 0;
  static const XrPosef pose = panelPose();
  q.pose = pose;
  q.size = {kPanelWidthM, kPanelWidthM * static_cast<float>(s.height) / static_cast<float>(s.width)};
  return reinterpret_cast<const XrCompositionLayerBaseHeader*>(&q);
}

// ---- hooks ------------------------------------------------------------------------------------------------------------

std::shared_ptr<Instance> findInstance(XrInstance i) {
  std::lock_guard<std::mutex> lk(g_mutex);
  auto it = g_instances.find(i);
  return it == g_instances.end() ? nullptr : it->second;
}

std::shared_ptr<Session> findSession(XrSession s) {
  std::lock_guard<std::mutex> lk(g_mutex);
  auto it = g_sessions.find(s);
  return it == g_sessions.end() ? nullptr : it->second;
}

void onSessionCreated(const Instance& inst, const XrSessionCreateInfo* info, XrSession handle) {
  auto s = std::make_shared<Session>();
  s->handle = handle;
  s->instance = inst.handle;
  s->next = inst.next;
  const auto* b = info ? reinterpret_cast<const XrBaseInStructure*>(info->next) : nullptr;
  std::string binding = "none";
  for (; b; b = b->next) {
    if (b->type == XR_TYPE_GRAPHICS_BINDING_D3D11_KHR) {
      s->api = Api::D3D11;
      s->device = reinterpret_cast<const XrGraphicsBindingD3D11KHR*>(b)->device;
      break;
    }
    if (b->type == XR_TYPE_GRAPHICS_BINDING_OPENGL_WIN32_KHR) {
      const auto* g = reinterpret_cast<const XrGraphicsBindingOpenGLWin32KHR*>(b);
      s->api = Api::OpenGL;
      s->dc = g->hDC;
      s->rc = g->hGLRC;
      break;
    }
    const char* n = bindingName(b->type);
    binding = n ? std::string(n) : "type " + std::to_string(static_cast<int>(b->type));
  }
  if (s->api == Api::D3D11 && !s->device) s->api = Api::None, binding = "D3D11 without a device";
  if (s->api == Api::OpenGL) {
    s->gl = loadGl();
    if (!s->gl.ok() || !s->dc || !s->rc) s->api = Api::None, binding = "OpenGL, but opengl32.dll's entry points or the context are missing";
  }
  XrSystemProperties props{XR_TYPE_SYSTEM_PROPERTIES};
  std::string system;
  if (info && XR_SUCCEEDED(s->next.getSystemProperties(inst.handle, info->systemId, &props))) {
    if (props.graphicsProperties.maxLayerCount) s->maxLayers = props.graphicsProperties.maxLayerCount;
    if (props.graphicsProperties.maxSwapchainImageWidth) s->maxWidth = props.graphicsProperties.maxSwapchainImageWidth;
    if (props.graphicsProperties.maxSwapchainImageHeight) s->maxHeight = props.graphicsProperties.maxSwapchainImageHeight;
    system = props.systemName;
  }
  const char* api = s->api == Api::D3D11 ? "D3D11" : s->api == Api::OpenGL ? "OpenGL (Win32)" : nullptr;
  logLine("session created on '" + system + "' (max " + std::to_string(s->maxLayers) + " layers): graphics binding " + (api ? std::string(api) : binding) +
          (api ? "; the panel is drawn in this session" : "; not supported, this session passes through"));
  std::lock_guard<std::mutex> lk(g_mutex);
  g_sessions[handle] = std::move(s);
}

XrResult XRAPI_CALL Hook_xrCreateSession(XrInstance instance, const XrSessionCreateInfo* createInfo, XrSession* session) {
  const auto inst = findInstance(instance);
  if (!inst) return XR_ERROR_HANDLE_INVALID;  // only handed out for instances we created
  const XrResult r = inst->next.createSession(instance, createInfo, session);
  if (XR_FAILED(r) || g_disabled.load() || !session) return r;
  try {
    onSessionCreated(*inst, createInfo, *session);
  } catch (...) {
    disable("a fault while recording the new session");
  }
  return r;
}

XrResult XRAPI_CALL Hook_xrDestroySession(XrSession session) {
  std::shared_ptr<Session> s;
  PFN_xrDestroySession next = nullptr;
  {
    std::lock_guard<std::mutex> lk(g_mutex);
    auto it = g_sessions.find(session);
    if (it != g_sessions.end()) {
      s = it->second;
      g_sessions.erase(it);
    }
    if (s) next = s->next.destroySession;
    else if (!g_instances.empty()) next = g_instances.begin()->second->next.destroySession;
  }
  if (!next) return XR_ERROR_HANDLE_INVALID;
  // Our space and swapchain are the session's children: destroying the session destroys them.
  return next(session);
}

XrResult XRAPI_CALL Hook_xrEndFrame(XrSession session, const XrFrameEndInfo* frameEndInfo) {
  const auto s = findSession(session);
  if (!s) {
    std::shared_ptr<Instance> any;
    {
      std::lock_guard<std::mutex> lk(g_mutex);
      if (!g_instances.empty()) any = g_instances.begin()->second;
    }
    return any ? any->next.endFrame(session, frameEndInfo) : XR_ERROR_HANDLE_INVALID;
  }
  const PFN_xrEndFrame next = s->next.endFrame;
  if (g_disabled.load() || s->api == Api::None || s->off || !frameEndInfo) return next(session, frameEndInfo);
  const XrCompositionLayerBaseHeader* quad = nullptr;
  try {
    quad = panelLayer(*s);
    // Only over the app's own picture: a frame without layers (not visible, loading) stays as the app sent it.
    if (quad && (frameEndInfo->layerCount == 0 || !frameEndInfo->layers)) quad = nullptr;
    if (quad && frameEndInfo->layerCount >= s->maxLayers) {
      logOnce("layer_limit", "xrEndFrame: the app already submits " + std::to_string(frameEndInfo->layerCount) + " of the runtime's " +
                                 std::to_string(s->maxLayers) + " layers; the panel is left out while that holds");
      quad = nullptr;
    }
    if (quad) {
      s->layers.assign(frameEndInfo->layers, frameEndInfo->layers + frameEndInfo->layerCount);
      s->layers.push_back(quad);
    }
  } catch (...) {
    disable("a fault while preparing the panel in xrEndFrame");
    quad = nullptr;
  }
  if (!quad) return next(session, frameEndInfo);
  XrFrameEndInfo mine = *frameEndInfo;
  mine.layerCount = static_cast<uint32_t>(s->layers.size());
  mine.layers = s->layers.data();
  const XrResult r = next(session, &mine);
  if (r == XR_ERROR_LAYER_INVALID || r == XR_ERROR_LAYER_LIMIT_EXCEEDED || r == XR_ERROR_SWAPCHAIN_RECT_INVALID || r == XR_ERROR_POSE_INVALID ||
      r == XR_ERROR_VALIDATION_FAILURE) {
    // Validation errors come before the runtime ends the frame, so the app's own frame can still go: once, without us.
    s->off = true;
    logLine("xrEndFrame refused the frame with the panel (" + resultName(s->next, s->instance, r) + "); the panel is off for this session");
    const XrResult again = next(session, frameEndInfo);
    return XR_SUCCEEDED(again) ? again : r;
  }
  return r;
}

XrResult XRAPI_CALL Hook_xrDestroyInstance(XrInstance instance) {
  std::shared_ptr<Instance> inst;
  {
    std::lock_guard<std::mutex> lk(g_mutex);
    auto it = g_instances.find(instance);
    if (it != g_instances.end()) {
      inst = it->second;
      g_instances.erase(it);
    }
    for (auto s = g_sessions.begin(); s != g_sessions.end();) s = s->second->instance == instance ? g_sessions.erase(s) : std::next(s);
  }
  return inst ? inst->next.destroyInstance(instance) : XR_ERROR_HANDLE_INVALID;
}

XrResult XRAPI_CALL Hook_xrGetInstanceProcAddr(XrInstance instance, const char* name, PFN_xrVoidFunction* function) {
  if (!name || !function) return XR_ERROR_VALIDATION_FAILURE;
  if (std::strcmp(name, "xrGetInstanceProcAddr") == 0) {
    *function = reinterpret_cast<PFN_xrVoidFunction>(&Hook_xrGetInstanceProcAddr);
    return XR_SUCCESS;
  }
  PFN_xrGetInstanceProcAddr next = nullptr;
  bool hooked = false;
  {
    std::lock_guard<std::mutex> lk(g_mutex);
    auto it = g_instances.find(instance);
    if (it != g_instances.end()) {
      next = it->second->next.getInstanceProcAddr;
      hooked = it->second->hooked;
    } else {
      next = g_lastNextGipa;
    }
  }
  if (hooked) {
    PFN_xrVoidFunction mine = nullptr;
    if (std::strcmp(name, "xrCreateSession") == 0) mine = reinterpret_cast<PFN_xrVoidFunction>(&Hook_xrCreateSession);
    else if (std::strcmp(name, "xrDestroySession") == 0) mine = reinterpret_cast<PFN_xrVoidFunction>(&Hook_xrDestroySession);
    else if (std::strcmp(name, "xrEndFrame") == 0) mine = reinterpret_cast<PFN_xrVoidFunction>(&Hook_xrEndFrame);
    else if (std::strcmp(name, "xrDestroyInstance") == 0) mine = reinterpret_cast<PFN_xrVoidFunction>(&Hook_xrDestroyInstance);
    if (mine) {
      *function = mine;
      return XR_SUCCESS;
    }
  }
  if (!next) {
    *function = nullptr;
    return XR_ERROR_FUNCTION_UNSUPPORTED;
  }
  return next(instance, name, function);
}

template <typename T>
bool nextFn(const Next& n, XrInstance i, const char* name, T& out) {
  PFN_xrVoidFunction f = nullptr;
  if (XR_FAILED(n.getInstanceProcAddr(i, name, &f)) || !f) return false;
  out = reinterpret_cast<T>(f);
  return true;
}

bool resolveNext(Instance& inst) {
  Next& n = inst.next;
  const XrInstance i = inst.handle;
  return nextFn(n, i, "xrDestroyInstance", n.destroyInstance) && nextFn(n, i, "xrResultToString", n.resultToString) &&
         nextFn(n, i, "xrGetSystemProperties", n.getSystemProperties) && nextFn(n, i, "xrCreateSession", n.createSession) &&
         nextFn(n, i, "xrDestroySession", n.destroySession) && nextFn(n, i, "xrEndFrame", n.endFrame) &&
         nextFn(n, i, "xrCreateReferenceSpace", n.createReferenceSpace) && nextFn(n, i, "xrEnumerateSwapchainFormats", n.enumerateSwapchainFormats) &&
         nextFn(n, i, "xrCreateSwapchain", n.createSwapchain) && nextFn(n, i, "xrDestroySwapchain", n.destroySwapchain) &&
         nextFn(n, i, "xrEnumerateSwapchainImages", n.enumerateSwapchainImages) && nextFn(n, i, "xrAcquireSwapchainImage", n.acquireSwapchainImage) &&
         nextFn(n, i, "xrWaitSwapchainImage", n.waitSwapchainImage) && nextFn(n, i, "xrReleaseSwapchainImage", n.releaseSwapchainImage);
}

void onInstanceCreated(XrInstance handle, PFN_xrGetInstanceProcAddr nextGipa) {
  auto inst = std::make_shared<Instance>();
  inst->handle = handle;
  inst->next.getInstanceProcAddr = nextGipa;
  if (hostIsVpx() && !g_disabled.load()) {
    if (resolveNext(*inst)) {
      inst->hooked = true;
      logLine(std::string(kLayerName) + " " CASTCADE_VR_LAYER_VERSION " (OpenXR headers " CASTCADE_OPENXR_SDK_TAG ") loaded in " + exeName());
      panelPipeStart();
    } else {
      logLine("a core OpenXR function is missing below this layer; passing through");
    }
  }
  std::lock_guard<std::mutex> lk(g_mutex);
  g_lastNextGipa = nextGipa;
  g_instances[handle] = std::move(inst);
}

XrResult XRAPI_CALL Hook_xrCreateApiLayerInstance(const XrInstanceCreateInfo* info, const XrApiLayerCreateInfo* apiLayerInfo, XrInstance* instance) {
  // The checks the Khronos sample layers make before trusting the chain (OpenXR-SDK-Source src/api_layers/api_dump.cpp).
  if (!apiLayerInfo || apiLayerInfo->structType != XR_LOADER_INTERFACE_STRUCT_API_LAYER_CREATE_INFO ||
      apiLayerInfo->structVersion < XR_API_LAYER_CREATE_INFO_STRUCT_VERSION || apiLayerInfo->structSize < sizeof(XrApiLayerCreateInfo) ||
      !apiLayerInfo->nextInfo || apiLayerInfo->nextInfo->structType != XR_LOADER_INTERFACE_STRUCT_API_LAYER_NEXT_INFO ||
      apiLayerInfo->nextInfo->structVersion < XR_API_LAYER_NEXT_INFO_STRUCT_VERSION || apiLayerInfo->nextInfo->structSize < sizeof(XrApiLayerNextInfo) ||
      !apiLayerInfo->nextInfo->nextGetInstanceProcAddr || !apiLayerInfo->nextInfo->nextCreateApiLayerInstance) {
    if (hostIsVpx()) logLine("the loader handed this layer a malformed chain; xrCreateInstance fails");
    return XR_ERROR_INITIALIZATION_FAILED;
  }
  // The next layer (or the runtime) gets the chain one link further on.
  XrApiLayerCreateInfo nextInfo = *apiLayerInfo;
  nextInfo.nextInfo = apiLayerInfo->nextInfo->next;
  const PFN_xrGetInstanceProcAddr nextGipa = apiLayerInfo->nextInfo->nextGetInstanceProcAddr;
  const XrResult r = apiLayerInfo->nextInfo->nextCreateApiLayerInstance(info, &nextInfo, instance);
  if (XR_FAILED(r) || !instance) return r;
  try {
    onInstanceCreated(*instance, nextGipa);
  } catch (...) {
    disable("a fault while recording the new instance");
  }
  return r;
}

}  // namespace
}  // namespace castcade

// The one export the loader looks up (OpenXR loader spec, "API Layer Negotiation"). The API version check is lenient
// on purpose: OpenComposite carries its own copy of the loader, possibly older than these headers, and an implicit
// layer that refuses negotiation can fail the app's xrCreateInstance (the loader's LoadApiLayers keeps the error when
// no layer loaded), which would take VR away from VPX.
extern "C" __declspec(dllexport) XrResult XRAPI_CALL xrNegotiateLoaderApiLayerInterface(const XrNegotiateLoaderInfo* loaderInfo,
                                                                                          const char* /*layerName*/,
                                                                                          XrNegotiateApiLayerRequest* apiLayerRequest) {
  if (!loaderInfo || loaderInfo->structType != XR_LOADER_INTERFACE_STRUCT_LOADER_INFO || loaderInfo->structVersion != XR_LOADER_INFO_STRUCT_VERSION ||
      loaderInfo->structSize != sizeof(XrNegotiateLoaderInfo))
    return XR_ERROR_INITIALIZATION_FAILED;
  if (loaderInfo->minInterfaceVersion > XR_CURRENT_LOADER_API_LAYER_VERSION || loaderInfo->maxInterfaceVersion < XR_CURRENT_LOADER_API_LAYER_VERSION)
    return XR_ERROR_INITIALIZATION_FAILED;
  if (loaderInfo->maxApiVersion < XR_MAKE_VERSION(1, 0, 0) || loaderInfo->minApiVersion > XR_CURRENT_API_VERSION) return XR_ERROR_INITIALIZATION_FAILED;
  if (!apiLayerRequest || apiLayerRequest->structType != XR_LOADER_INTERFACE_STRUCT_API_LAYER_REQUEST ||
      apiLayerRequest->structVersion != XR_API_LAYER_INFO_STRUCT_VERSION || apiLayerRequest->structSize != sizeof(XrNegotiateApiLayerRequest))
    return XR_ERROR_INITIALIZATION_FAILED;
  apiLayerRequest->layerInterfaceVersion = XR_CURRENT_LOADER_API_LAYER_VERSION;
  apiLayerRequest->layerApiVersion = loaderInfo->maxApiVersion < XR_CURRENT_API_VERSION ? loaderInfo->maxApiVersion : XR_CURRENT_API_VERSION;
  apiLayerRequest->getInstanceProcAddr = castcade::Hook_xrGetInstanceProcAddr;
  apiLayerRequest->createApiLayerInstance = castcade::Hook_xrCreateApiLayerInstance;
  return XR_SUCCESS;
}
