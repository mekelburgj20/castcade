// XrApiLayer_castcade_panel: an implicit OpenXR API layer that puts the Castcade match in VPinballX's frames
// (D7.3, 2026-10-31: the panel as one head-locked quad; D7.4, 2026-10-31: three modes, theater among them;
// vr-layer/README.md; docs/design/alpha-match.md §5).
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
//   - input comes over \\.\pipe\castcade-panel (panel_pipe.cpp): panel frames, video frames, the mode;
//   - everything of ours (spaces, swapchains, the theater screen's place, the fade) belongs to ONE session: the owner's
//     log (0.2.26) shows OpenComposite creating a D3D11 session 2 s before the real OpenGL one, so nothing is per process;
//   - modes (D7.4): hidden = VPX's frame untouched (the player's own turn); panel = VPX's frame plus the panel quad,
//     low in the view; theater = VPX's projection layers removed, the opponent's video fixed in the room, black around
//     it. A side-by-side (stereo) video is a WINDOW onto the sender's view since D7.4.5 (2026-11-02): one quad per eye,
//     each pixel where the sender's eye saw it, so the opponent's playfield appears life size where the player's own
//     was ("the stereo window", above placeWindows); a mono video (or the panel frame) is one 2.4 m screen 2.6 m
//     ahead. Into or out of theater the view dips to black over 300 ms; with no frame from the companion for 5 s the
//     mode falls back to hidden;
//   - never throws across the API: an exception (or, with /EHa, a structured exception) turns the layer off for the
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

#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstdio>
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

// Placement in the head's space. OpenXR's VIEW space has the same axes as OpenVR's HMD space (+X right, +Y up, -Z
// ahead). D7.4 (2026-10-31, the owner's first run of the layer): the D7.3 panel (0.55 m at 0, -0.28, -0.9, the SteamVR
// helper's default) sat in the direct line of sight over the playfield. "low" is the default now, below that line;
// "center" (panelPos) is the D7.3 placement.
constexpr float kPanelLowWidthM = 0.40f;
constexpr float kPanelLowOffset[3] = {0.0f, -0.42f, -0.9f};
constexpr float kPanelCentreWidthM = 0.55f;
constexpr float kPanelCentreOffset[3] = {0.0f, -0.28f, -0.9f};

// Theater (D7.4): "I want to see his playfield where my playfield was". A 2.4 m screen 2.6 m ahead (~50° wide, about
// what a playfield fills in the headset), fixed in LOCAL space so it stays put when the head turns, placed in front of
// wherever the player faces when theater begins. D7.4.3 (2026-11-01): 2.4 m is the screen's LONGER side. VPX's "both
// eyes" preview centre-crops each eye to its half of the window, so a window about as wide as it is tall gives two
// portrait eyes (540x1080 on a 1080p monitor): width-led sizing made that a 4.8 m tall screen; a portrait eye is now
// height-led, 2.4 m tall and as wide as its aspect says. D7.4.5 (2026-11-02): this sizing is the MONO screen's only (a
// mono sender, or the panel frame in theater). A side-by-side picture at one shared pose did not fuse (the owner: "you
// see them as separate views"); it is now sized and placed per eye from the fov (placeWindows), life size by default,
// kScreenDistanceM its distance and Control::theaterScale its scale.
constexpr float kScreenWidthM = 2.4f;
constexpr float kScreenHeightM = 2.4f;
constexpr float kScreenDistanceM = 2.6f;
// The black around it: a head-locked opaque quad far larger than any field of view (30 m at 3 m: ±78°), submitted
// first so the screen is drawn over it. Runtimes may already show black where no layer covers; this makes it sure.
constexpr float kBackdropSizeM = 30.0f;
constexpr float kBackdropDistanceM = 3.0f;
// The fade: a head-locked black quad over everything, its alpha ramped 0 → 1 → 0, the mode switched at the dark
// middle. XR_KHR_composition_layer_color_scale_bias would fade layers directly, but only an app that enabled it at
// xrCreateInstance may use it; VPX and OpenComposite do not.
constexpr float kShadeSizeM = 12.0f;
constexpr float kShadeDistanceM = 1.0f;
constexpr double kFadeHalfMs = 150.0;  // 150 ms to black, 150 ms back: 300 ms per change
constexpr uint32_t kShadeSide = 8;
constexpr int kShadeLevels = 64;  // the shade's alpha is uploaded in 1/64 steps (an upload per step, not per frame)
// A stalled frame loop must not jump a fade; one frame advances it by at most this much time.
constexpr double kMaxFadeStepMs = 50.0;

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
constexpr GLenum GL_RGBA_ = 0x1908;
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
  PFN_xrLocateSpace locateSpace = nullptr;
  PFN_xrLocateViews locateViews = nullptr;  // D7.4.5; optional: without it the stereo window uses assumed eyes
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

// The byte order of what goes into a swapchain: the panel page's paint is BGRA (Chromium), the video frames RGBA
// (canvas getImageData, so the companion converts nothing; D7.4).
enum class Order { BGRA, RGBA };

// One swapchain of ours and what we know about it. Each session has three: the panel, the video, the shade (8x8 black,
// alpha = the fade; also the backdrop, drawn without its alpha).
struct Surface {
  const char* name = "";
  Order order = Order::BGRA;
  XrSwapchain swapchain = XR_NULL_HANDLE;
  int64_t format = 0;
  bool swapRedBlue = false;  // D3D11: the data's order is not the format's, R and B are swapped on upload
  uint32_t width = 0, height = 0;
  std::vector<XrSwapchainImageD3D11KHR> d3dImages;
  std::vector<XrSwapchainImageOpenGLKHR> glImages;
  bool released = false;  // an image has been released, so a quad may reference the swapchain (XR_ERROR_LAYER_INVALID otherwise)
};

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
  XrSpace view = XR_NULL_HANDLE;   // head-locked: the panel, the backdrop, the shade
  XrSpace local = XR_NULL_HANDLE;  // fixed in the room: the theater screen (D7.4)
  Surface panel, video, shade;
  std::vector<uint8_t> pixels, staging;
  uint32_t pixelsW = 0, pixelsH = 0;
  // D7.4: the mode on screen, the fade (0 clear .. 1 black), the shade's uploaded level, the screen's place.
  ViewMode shown = ViewMode::Hidden;
  double fade = 0.0;
  uint64_t lastTick = 0;
  int shadeLevel = -1;
  XrPosef screenPose{};
  // D7.4.5, the stereo window: what VPX submits (each eye's fov and render size, from its projection layer, recorded
  // every frame), each eye's pose in head space (xrLocateViews at the recentre), the recentre's head position and frame
  // (its yaw then pitch, no roll: D7.4.7), and the two eye quads placed from them (recomputed when an input changes,
  // logged when the result does).
  bool appViewsSeen = false;
  std::array<XrFovf, 2> appFov{};
  std::array<XrExtent2Di, 2> appRect{};
  bool eyesLocated = false;
  std::array<XrPosef, 2> eyePose{};
  std::array<XrFovf, 2> locatedFov{};
  XrVector3f theaterHead{0.0f, 0.0f, 0.0f};
  XrQuaternionf theaterFrame{0.0f, 0.0f, 0.0f, 1.0f};
  bool windowDirty = true;
  uint32_t windowW = 0, windowH = 0;
  float windowScale = 0.0f;
  std::array<XrPosef, 2> windowPose{};
  std::array<XrExtent2Df, 2> windowSize{};
  std::string windowLog;
  int windowLogs = 0;
  std::array<XrCompositionLayerQuad, 5> quads{};
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

// A quad at `offset` (head space) turned so its front (+Z) faces the eye, kept upright: the SteamVR helper's
// facingOrigin() (vr-overlay/src/main.cpp) as a quaternion. At the low offset that is a ~25° tilt back.
XrPosef facingEye(const float offset[3]) {
  XrPosef p{};
  p.position = {offset[0], offset[1], offset[2]};
  p.orientation = {0.0f, 0.0f, 0.0f, 1.0f};
  const float tx = -offset[0], ty = -offset[1], tz = -offset[2];
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

// Straight ahead in head space at `distance`, facing the eye (identity: a quad's front is +Z, the eye is at +Z of it).
XrPosef ahead(float distance) {
  XrPosef p{};
  p.position = {0.0f, 0.0f, -distance};
  p.orientation = {0.0f, 0.0f, 0.0f, 1.0f};
  return p;
}

// ---- one session ------------------------------------------------------------------------------------------------------

// Fails the session (pass-through from now on) with one log line naming the call.
bool check(Session& s, XrResult r, const char* what) {
  if (XR_SUCCEEDED(r)) return true;
  s.off = true;
  logLine(std::string("session: ") + what + " failed (" + resultName(s.next, s.instance, r) + "); the layer is off for this session");
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

// For an OpenGL session: the app's context current for the rest of this xrEndFrame (made once, on the first upload).
bool glReady(Session& s, std::unique_ptr<GlContextScope>& scope) {
  if (s.api != Api::OpenGL) return true;
  if (scope) return scope->ok();
  scope = std::make_unique<GlContextScope>(s);
  if (!scope->ok()) {
    s.off = true;
    logLine("session: wglMakeCurrent on the app's context failed (error " + std::to_string(GetLastError()) + "); the layer is off for this session");
    return false;
  }
  if (!s.gl.bindBuffer) {
    // wglGetProcAddress answers 1, 2, 3 or -1 instead of null on some drivers.
    const auto p = reinterpret_cast<intptr_t>(s.gl.getProcAddress("glBindBuffer"));
    if (p != 0 && p != 1 && p != 2 && p != 3 && p != -1) s.gl.bindBuffer = reinterpret_cast<decltype(s.gl.bindBuffer)>(p);
  }
  return true;
}

// Our two spaces, made on first need (in this session; the D3D11 session OpenComposite makes first gets its own).
// VIEW and LOCAL are the two reference spaces every runtime must support.
bool ensureSpaces(Session& s) {
  if (s.view == XR_NULL_HANDLE) {
    XrReferenceSpaceCreateInfo si{XR_TYPE_REFERENCE_SPACE_CREATE_INFO};
    si.referenceSpaceType = XR_REFERENCE_SPACE_TYPE_VIEW;
    si.poseInReferenceSpace.orientation.w = 1.0f;
    if (!check(s, s.next.createReferenceSpace(s.handle, &si, &s.view), "xrCreateReferenceSpace(VIEW)")) return false;
  }
  if (s.local == XR_NULL_HANDLE) {
    XrReferenceSpaceCreateInfo si{XR_TYPE_REFERENCE_SPACE_CREATE_INFO};
    si.referenceSpaceType = XR_REFERENCE_SPACE_TYPE_LOCAL;
    si.poseInReferenceSpace.orientation.w = 1.0f;
    if (!check(s, s.next.createReferenceSpace(s.handle, &si, &s.local), "xrCreateReferenceSpace(LOCAL)")) return false;
  }
  return true;
}

bool isRgbaFormat(int64_t f) { return f == DXGI_FORMAT_R8G8B8A8_UNORM_SRGB || f == DXGI_FORMAT_R8G8B8A8_UNORM; }

// sRGB first: Chromium's pixels (the paint and the canvas) are sRGB-encoded, and an _SRGB swapchain tells the
// compositor so (in a UNORM one most runtimes would read them as linear and show them washed out). On D3D11 the format
// of the data's own byte order first, so the upload copies without swapping.
int64_t pickFormat(const Session& s, Order order, const std::vector<int64_t>& have) {
  std::vector<int64_t> want;
  if (s.api == Api::D3D11) {
    if (order == Order::RGBA)
      want = {DXGI_FORMAT_R8G8B8A8_UNORM_SRGB, DXGI_FORMAT_B8G8R8A8_UNORM_SRGB, DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_FORMAT_B8G8R8A8_UNORM};
    else
      want = {DXGI_FORMAT_B8G8R8A8_UNORM_SRGB, DXGI_FORMAT_R8G8B8A8_UNORM_SRGB, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_R8G8B8A8_UNORM};
  } else {
    want = {GL_SRGB8_ALPHA8_, GL_RGBA8_};
  }
  for (int64_t f : want)
    for (int64_t h : have)
      if (f == h) return f;
  return 0;
}

void dropSwapchain(Session& s, Surface& surf) {
  if (surf.swapchain != XR_NULL_HANDLE) s.next.destroySwapchain(surf.swapchain);
  surf.swapchain = XR_NULL_HANDLE;
  surf.released = false;
  surf.width = surf.height = 0;
  surf.d3dImages.clear();
  surf.glImages.clear();
}

// A swapchain at this size for the surface (a new size makes a new one). False: skipped (too big) or the session is off.
bool ensureSwapchain(Session& s, Surface& surf, uint32_t w, uint32_t h) {
  if (surf.swapchain != XR_NULL_HANDLE && surf.width == w && surf.height == h) return true;
  if (w > s.maxWidth || h > s.maxHeight) {
    logOnce(std::string("frame_too_big_") + surf.name, std::string("session: a ") + std::to_string(w) + "x" + std::to_string(h) + " " + surf.name +
                                                          " frame is larger than the runtime's " + std::to_string(s.maxWidth) + "x" +
                                                          std::to_string(s.maxHeight) + " swapchain limit; frames that size are skipped");
    return false;
  }
  if (!ensureSpaces(s)) return false;
  dropSwapchain(s, surf);
  uint32_t count = 0;
  if (!check(s, s.next.enumerateSwapchainFormats(s.handle, 0, &count, nullptr), "xrEnumerateSwapchainFormats")) return false;
  std::vector<int64_t> formats(count);
  if (!check(s, s.next.enumerateSwapchainFormats(s.handle, count, &count, formats.data()), "xrEnumerateSwapchainFormats")) return false;
  formats.resize(count);
  surf.format = pickFormat(s, surf.order, formats);
  if (surf.format == 0) {
    s.off = true;
    logLine("session: the runtime offers no RGBA8 / BGRA8 swapchain format; the layer is off for this session");
    return false;
  }
  surf.swapRedBlue = s.api == Api::D3D11 && isRgbaFormat(surf.format) != (surf.order == Order::RGBA);
  XrSwapchainCreateInfo ci{XR_TYPE_SWAPCHAIN_CREATE_INFO};
  ci.usageFlags = XR_SWAPCHAIN_USAGE_SAMPLED_BIT | XR_SWAPCHAIN_USAGE_COLOR_ATTACHMENT_BIT | XR_SWAPCHAIN_USAGE_TRANSFER_DST_BIT;
  ci.format = surf.format;
  ci.sampleCount = 1;
  ci.width = w;
  ci.height = h;
  ci.faceCount = 1;
  ci.arraySize = 1;
  ci.mipCount = 1;
  if (!check(s, s.next.createSwapchain(s.handle, &ci, &surf.swapchain), "xrCreateSwapchain")) return false;
  if (!check(s, s.next.enumerateSwapchainImages(surf.swapchain, 0, &count, nullptr), "xrEnumerateSwapchainImages")) return false;
  if (s.api == Api::D3D11) {
    surf.d3dImages.assign(count, XrSwapchainImageD3D11KHR{XR_TYPE_SWAPCHAIN_IMAGE_D3D11_KHR});
    if (!check(s, s.next.enumerateSwapchainImages(surf.swapchain, count, &count, reinterpret_cast<XrSwapchainImageBaseHeader*>(surf.d3dImages.data())),
               "xrEnumerateSwapchainImages"))
      return false;
  } else {
    surf.glImages.assign(count, XrSwapchainImageOpenGLKHR{XR_TYPE_SWAPCHAIN_IMAGE_OPENGL_KHR});
    if (!check(s, s.next.enumerateSwapchainImages(surf.swapchain, count, &count, reinterpret_cast<XrSwapchainImageBaseHeader*>(surf.glImages.data())),
               "xrEnumerateSwapchainImages"))
      return false;
  }
  surf.width = w;
  surf.height = h;
  logLine(std::string("session: ") + surf.name + " swapchain " + std::to_string(w) + "x" + std::to_string(h) + ", format " + std::to_string(surf.format) +
          ", " + std::to_string(count) + " images");
  return true;
}

// The pixels as the swapchain wants them: D3D11 top-down (R/B swapped when the data's order is not the format's),
// OpenGL bottom-up (the spec puts a GL swapchain image's origin at its bottom-left; uploaded in the data's own order).
const uint8_t* prepared(Session& s, const Surface& surf, const uint8_t* src, uint32_t w, uint32_t h) {
  const size_t row = static_cast<size_t>(w) * 4;
  const bool flip = s.api == Api::OpenGL;
  if (!flip && !surf.swapRedBlue) return src;
  s.staging.resize(row * h);
  for (uint32_t y = 0; y < h; y++) {
    const uint8_t* in = src + row * y;
    uint8_t* out = s.staging.data() + row * (flip ? h - 1 - y : y);
    if (!surf.swapRedBlue) {
      std::memcpy(out, in, row);
      continue;
    }
    for (size_t i = 0; i < row; i += 4) {
      out[i] = in[i + 2];
      out[i + 1] = in[i + 1];
      out[i + 2] = in[i];
      out[i + 3] = in[i + 3];
    }
  }
  return s.staging.data();
}

void uploadGl(Session& s, GLuint texture, GLenum order, uint32_t w, uint32_t h, const uint8_t* px) {
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
  gl.texSubImage2D(GL_TEXTURE_2D_, 0, 0, 0, static_cast<GLsizei>(w), static_cast<GLsizei>(h), order, GL_UNSIGNED_BYTE_, px);
  gl.bindTexture(GL_TEXTURE_2D_, static_cast<GLuint>(prevTex));
  gl.pixelStorei(GL_UNPACK_ROW_LENGTH_, prevRow);
  gl.pixelStorei(GL_UNPACK_SKIP_ROWS_, prevSkipRows);
  gl.pixelStorei(GL_UNPACK_SKIP_PIXELS_, prevSkipPixels);
  gl.pixelStorei(GL_UNPACK_ALIGNMENT_, prevAlign);
  if (prevPbo) gl.bindBuffer(GL_PIXEL_UNPACK_BUFFER_, static_cast<GLuint>(prevPbo));
}

// `px` (top-down, the surface's byte order, w*h*4) into the surface's next image. Inside xrEndFrame, so on the thread
// and with the guarantees the app gives for its own frame submission.
void upload(Session& s, Surface& surf, std::unique_ptr<GlContextScope>& scope, const uint8_t* px, uint32_t w, uint32_t h) {
  if (!glReady(s, scope)) return;
  if (!ensureSwapchain(s, surf, w, h)) return;
  uint32_t index = 0;
  XrSwapchainImageAcquireInfo ai{XR_TYPE_SWAPCHAIN_IMAGE_ACQUIRE_INFO};
  if (!check(s, s.next.acquireSwapchainImage(surf.swapchain, &ai, &index), "xrAcquireSwapchainImage")) return;
  XrSwapchainImageWaitInfo wi{XR_TYPE_SWAPCHAIN_IMAGE_WAIT_INFO};
  wi.timeout = XR_INFINITE_DURATION;
  if (!check(s, s.next.waitSwapchainImage(surf.swapchain, &wi), "xrWaitSwapchainImage")) return;
  const uint8_t* data = prepared(s, surf, px, w, h);
  if (s.api == Api::D3D11) {
    ID3D11DeviceContext* ctx = nullptr;
    s.device->GetImmediateContext(&ctx);
    if (ctx) {
      ctx->UpdateSubresource(surf.d3dImages.at(index).texture, 0, nullptr, data, w * 4, w * h * 4);
      ctx->Release();
    }
  } else {
    uploadGl(s, surf.glImages.at(index).image, surf.order == Order::RGBA ? GL_RGBA_ : GL_BGRA_, w, h, data);
  }
  XrSwapchainImageReleaseInfo ri{XR_TYPE_SWAPCHAIN_IMAGE_RELEASE_INFO};
  if (!check(s, s.next.releaseSwapchainImage(surf.swapchain, &ri), "xrReleaseSwapchainImage")) return;
  if (!surf.released) logLine(std::string("session: the ") + surf.name + " is up");
  surf.released = true;
}

// The newest frame of a stream (if any) into its surface.
void uploadStream(Session& s, Surface& surf, Stream stream, std::unique_ptr<GlContextScope>& scope) {
  if (!panelPipeTake(stream, s.pixels, s.pixelsW, s.pixelsH)) return;
  upload(s, surf, scope, s.pixels.data(), s.pixelsW, s.pixelsH);
}

// The shade at `level` / kShadeLevels alpha, premultiplied black (0, 0, 0, a): only when the level changed.
void uploadShade(Session& s, int level, std::unique_ptr<GlContextScope>& scope) {
  if (level == s.shadeLevel && s.shade.released) return;
  std::array<uint8_t, kShadeSide * kShadeSide * 4> px{};
  const auto a = static_cast<uint8_t>((level * 255 + kShadeLevels / 2) / kShadeLevels);
  for (size_t i = 3; i < px.size(); i += 4) px[i] = a;
  upload(s, s.shade, scope, px.data(), kShadeSide, kShadeSide);
  if (s.shade.released) s.shadeLevel = level;
}

// ---- the stereo window (D7.4.5) ---------------------------------------------------------------------------------------
//
// A side-by-side picture is the sender's VPX "both eyes" preview: each half is what one of the sender's eyes rendered.
// VPX 10.8.0 (Player::PrepareVideoBuffers, ShrinkPreview off) fills each half with a CENTRE CROP of that eye's whole
// render, cut to the half's aspect and scaled to it: render w x h, half aspect outAr; ar = w / h > outAr crops the
// sides (fw = h * outAr, x = (w - fw) / 2, full height), else top and bottom (fh = w / outAr, y = (h - fh) / 2, full
// width). The eye render covers that eye's frustum, which is asymmetric (wider on the outer side), so the render's
// pixel centre is not straight ahead and is not the same direction for the two eyes. Two quads at one pose (D7.4 ..
// D7.4.4) therefore added a crossed disparity of that asymmetry and showed the playfield's own disparities at about
// half their angle: it did not fuse at normal convergence (the owner, 2026-11-02: "if I cross my eyes ... there is a
// point where it is in the right position").
//
// So each half is shown as a WINDOW: one quad per eye, placed so that every pixel is seen from the receiver's eye in
// the direction the sender's eye rendered it. Derivation, in one eye's frame (+X right, +Y up, -Z ahead):
//   1. A perspective render with fov tangents (tL, tR, tD, tU) (OpenXR angleLeft / angleDown are negative, so tL, tD
//      are) maps pixel column u in [0, w] linearly to the tangent tL + (u / w) (tR - tL), and rows likewise to
//      tD .. tU. That is exact: on a plane perpendicular to the axis, tangent is linear in position.
//   2. VPX's crop (x, y, fw, fh) is therefore the tangent rect tL' = tL + (x / w)(tR - tL), tR' = tL + ((x + fw) / w)
//      (tR - tL), tD' = tD + (y / h)(tU - tD), tU' = tD + ((y + fh) / h)(tU - tD). The crop is centred, so whether a
//      render's row 0 is its top (D3D) or bottom (GL) does not matter.
//   3. A quad at distance D on the eye's -Z axis, centred at (D cx, D cy) with cx = (tL' + tR') / 2, cy = (tD' + tU')
//      / 2, sized D (tR' - tL') x D (tU' - tD'), puts the crop's pixel (u, v) at tangent (tL' + u (tR' - tL'), ...)
//      from the eye: the direction the sender's eye rendered it. Each eye sees only its own quad (eyeVisibility), so
//      both eyes get the sender's rays, and the playfield fuses where it stood for the sender: life size. D is free
//      (kScreenDistanceM); the scale S (Control::theaterScale, 1 by default) multiplies the quad's size and centre
//      offset together, which scales the picture's angles about the eye's axis.
//   4. Into LOCAL: the eye's pose in head space (xrLocateViews in VIEW space at the recentre: about ±IPD / 2 in x,
//      identity orientation on parallel-view headsets) then the recentre's head position and frame R_f (the head's
//      yaw then pitch, never its roll, as the mono screen: D7.4.7). Position = head + R_f (eye + R_eye (S D cx, S D
//      cy, -D)); orientation = R_f R_eye; size =
//      (S D (tR' - tL'), S D (tU' - tD')).
// Assumptions: the sender's eyes had the receiver's fov and render aspect (the video carries neither; the same headset
// model on both ends makes it exact), and the receiver's head stays about where it was at the recentre (the window is
// fixed in the room, so moving the head moves the eyes against it, as with a real window).
// Fallbacks, never dark: no fov from VPX → the fov xrLocateViews gave; neither → ±45° each way; no eye poses → ±0.0315 m.

constexpr float kDegPerRad = 57.29578f;
constexpr float kFallbackHalfFovRad = 0.7853982f;  // 45°
constexpr float kFallbackHalfIpdM = 0.0315f;
constexpr float kFovMismatchRad = 0.01745329f;     // 1°
constexpr int kMaxWindowLogs = 20;                 // per session; a picture whose size keeps changing logs no more

XrQuaternionf quatMul(const XrQuaternionf& a, const XrQuaternionf& b) {
  return {a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y, a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x, a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
          a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z};
}

// v rotated by the unit quaternion q: v + w t + q.xyz x t, t = 2 q.xyz x v.
XrVector3f quatRotate(const XrQuaternionf& q, const XrVector3f& v) {
  const float tx = 2.0f * (q.y * v.z - q.z * v.y), ty = 2.0f * (q.z * v.x - q.x * v.z), tz = 2.0f * (q.x * v.y - q.y * v.x);
  return {v.x + q.w * tx + (q.y * tz - q.z * ty), v.y + q.w * ty + (q.z * tx - q.x * tz), v.z + q.w * tz + (q.x * ty - q.y * tx)};
}

bool fovUsable(const XrFovf& f) {
  const float lim = 1.553343f;  // 89°: a tangent beyond that is no picture
  const float a[4] = {f.angleLeft, f.angleRight, f.angleDown, f.angleUp};
  for (float v : a)
    if (!std::isfinite(v) || std::fabs(v) > lim) return false;
  return f.angleLeft < f.angleRight && f.angleDown < f.angleUp;
}

XrFovf fallbackFov() { return {-kFallbackHalfFovRad, kFallbackHalfFovRad, kFallbackHalfFovRad, -kFallbackHalfFovRad}; }

bool sameFov(const XrFovf& a, const XrFovf& b, float tol) {
  return std::fabs(a.angleLeft - b.angleLeft) <= tol && std::fabs(a.angleRight - b.angleRight) <= tol && std::fabs(a.angleUp - b.angleUp) <= tol &&
         std::fabs(a.angleDown - b.angleDown) <= tol;
}

std::string fmt(const char* f, double a = 0, double b = 0, double c = 0, double d = 0) {
  char buf[160];
  std::snprintf(buf, sizeof buf, f, a, b, c, d);
  return buf;
}

std::string fovText(const XrFovf& f) {
  return fmt("left %+.1f right %+.1f down %+.1f up %+.1f deg", f.angleLeft * kDegPerRad, f.angleRight * kDegPerRad, f.angleDown * kDegPerRad, f.angleUp * kDegPerRad);
}

// Every frame, before anything is dropped: each eye's fov and render size from the app's projection layer (VPX keeps
// rendering the receiver's own table in theater, so this stays current there too).
void noteProjection(Session& s, const XrFrameEndInfo& info) {
  for (uint32_t i = 0; i < info.layerCount; i++) {
    const XrCompositionLayerBaseHeader* l = info.layers[i];
    if (!l || l->type != XR_TYPE_COMPOSITION_LAYER_PROJECTION) continue;
    const auto* p = reinterpret_cast<const XrCompositionLayerProjection*>(l);
    if (p->viewCount < 2 || !p->views) return;
    for (size_t e = 0; e < 2; e++) {
      const XrFovf& f = p->views[e].fov;
      const XrExtent2Di& r = p->views[e].subImage.imageRect.extent;
      if (!s.appViewsSeen || !sameFov(f, s.appFov[e], 1e-4f) || r.width != s.appRect[e].width || r.height != s.appRect[e].height) s.windowDirty = true;
      s.appFov[e] = f;
      s.appRect[e] = r;
    }
    s.appViewsSeen = true;
    return;
  }
}

// At the recentre: each eye's pose relative to the head and the runtime's fov for it.
void locateEyes(Session& s, XrTime when) {
  s.eyesLocated = false;
  s.windowDirty = true;
  if (!s.next.locateViews) {
    logOnce("views_missing", "theater: xrLocateViews is not available below this layer; the stereo window assumes eyes 63 mm apart");
    return;
  }
  XrViewLocateInfo li{XR_TYPE_VIEW_LOCATE_INFO};
  li.viewConfigurationType = XR_VIEW_CONFIGURATION_TYPE_PRIMARY_STEREO;
  li.displayTime = when;
  li.space = s.view;
  XrViewState vs{XR_TYPE_VIEW_STATE};
  std::array<XrView, 2> v{};
  for (XrView& x : v) x = XrView{XR_TYPE_VIEW};
  uint32_t n = 0;
  const XrResult r = s.next.locateViews(s.handle, &li, &vs, static_cast<uint32_t>(v.size()), &n, v.data());
  if (XR_FAILED(r) || n < 2) {
    logOnce("views_failed", "theater: xrLocateViews failed (" + (XR_FAILED(r) ? resultName(s.next, s.instance, r) : std::to_string(n) + " view(s)") +
                                "); the stereo window assumes eyes 63 mm apart");
    return;
  }
  for (size_t e = 0; e < 2; e++) {
    const float side = e == 0 ? -1.0f : 1.0f;
    s.eyePose[e].position = (vs.viewStateFlags & XR_VIEW_STATE_POSITION_VALID_BIT) ? v[e].pose.position : XrVector3f{side * kFallbackHalfIpdM, 0.0f, 0.0f};
    XrQuaternionf q{0.0f, 0.0f, 0.0f, 1.0f};
    if (vs.viewStateFlags & XR_VIEW_STATE_ORIENTATION_VALID_BIT) {
      // Renormalised (our quads must carry unit quaternions or xrEndFrame refuses them); a degenerate one is ignored.
      const XrQuaternionf& o = v[e].pose.orientation;
      const float len = std::sqrt(o.x * o.x + o.y * o.y + o.z * o.z + o.w * o.w);
      if (std::isfinite(len) && len > 0.5f) q = {o.x / len, o.y / len, o.z / len, o.w / len};
    }
    s.eyePose[e].orientation = q;
    if (!std::isfinite(s.eyePose[e].position.x) || !std::isfinite(s.eyePose[e].position.y) || !std::isfinite(s.eyePose[e].position.z) ||
        std::fabs(s.eyePose[e].position.x) > 0.2f)
      s.eyePose[e].position = {side * kFallbackHalfIpdM, 0.0f, 0.0f};
    s.locatedFov[e] = v[e].fov;
  }
  s.eyesLocated = true;
  if (s.appViewsSeen)
    for (size_t e = 0; e < 2; e++)
      if (fovUsable(s.appFov[e]) && fovUsable(s.locatedFov[e]) && !sameFov(s.appFov[e], s.locatedFov[e], kFovMismatchRad))
        logOnce("fov_differs", std::string("theater: the ") + (e == 0 ? "left" : "right") + " eye's fov in VPX's frame (" + fovText(s.appFov[e]) +
                                   ") differs from xrLocateViews' (" + fovText(s.locatedFov[e]) + "); the stereo window uses VPX's");
}

// The two eye quads for a side-by-side picture of picW x picH (each eye picW / 2 wide), at scale `scale`.
void placeWindows(Session& s, uint32_t picW, uint32_t picH, float scale) {
  s.windowDirty = false;
  s.windowW = picW, s.windowH = picH, s.windowScale = scale;
  const float outAr = static_cast<float>(picW / 2) / static_cast<float>(picH > 0 ? picH : 1);
  const float D = kScreenDistanceM, SD = scale * kScreenDistanceM;
  std::string eyes[2];
  for (size_t e = 0; e < 2; e++) {
    XrFovf f = fallbackFov();
    const char* fovFrom = "assumed";
    if (s.appViewsSeen && fovUsable(s.appFov[e])) f = s.appFov[e], fovFrom = "VPX's frame";
    else if (s.eyesLocated && fovUsable(s.locatedFov[e])) f = s.locatedFov[e], fovFrom = "xrLocateViews";
    else logOnce("fov_assumed", "theater: no field of view from VPX's frame or xrLocateViews; the stereo window assumes 45 degrees each way");
    const float tL = std::tan(f.angleLeft), tR = std::tan(f.angleRight), tD = std::tan(f.angleDown), tU = std::tan(f.angleUp);
    XrPosef eye{};
    eye.orientation = {0.0f, 0.0f, 0.0f, 1.0f};
    eye.position = {(e == 0 ? -1.0f : 1.0f) * kFallbackHalfIpdM, 0.0f, 0.0f};
    if (s.eyesLocated) eye = s.eyePose[e];
    // The render's size: VPX's (only its aspect matters); unknown → square pixels in tangent space.
    const bool rectKnown = s.appViewsSeen && s.appRect[e].width > 0 && s.appRect[e].height > 0;
    const float w = rectKnown ? static_cast<float>(s.appRect[e].width) : (tR - tL) * 1000.0f;
    const float h = rectKnown ? static_cast<float>(s.appRect[e].height) : (tU - tD) * 1000.0f;
    // VPX's crop, ShrinkPreview off (see above).
    float x = 0.0f, y = 0.0f, fw = w, fh = h;
    if (w / h > outAr) fw = h * outAr, x = (w - fw) * 0.5f;
    else fh = w / outAr, y = (h - fh) * 0.5f;
    const float l = tL + (x / w) * (tR - tL), r = tL + ((x + fw) / w) * (tR - tL);
    const float d = tD + (y / h) * (tU - tD), u = tD + ((y + fh) / h) * (tU - tD);
    const float cx = (l + r) * 0.5f, cy = (d + u) * 0.5f;
    const XrVector3f onAxis = quatRotate(eye.orientation, {SD * cx, SD * cy, -D});
    const XrVector3f inHead = {eye.position.x + onAxis.x, eye.position.y + onAxis.y, eye.position.z + onAxis.z};
    const XrVector3f inLocal = quatRotate(s.theaterFrame, inHead);
    s.windowPose[e].position = {s.theaterHead.x + inLocal.x, s.theaterHead.y + inLocal.y, s.theaterHead.z + inLocal.z};
    s.windowPose[e].orientation = quatMul(s.theaterFrame, eye.orientation);
    s.windowSize[e] = {SD * (r - l), SD * (u - d)};
    eyes[e] = std::string(e == 0 ? "left" : "right") + " eye: fov " + fovText(f) + " (" + fovFrom + ")" + fmt(", eye at x %+.4f y %+.4f z %+.4f m", eye.position.x, eye.position.y, eye.position.z) +
              (rectKnown ? fmt(", render %.0fx%.0f", w, h) : std::string(", render size unknown")) + fmt(", crop %.0fx%.0f at %.0f,%.0f", fw, fh, x, y) +
              fmt(", quad %.2f x %.2f m", s.windowSize[e].width, s.windowSize[e].height) + fmt(" centred %+.2f, %+.2f m off the eye's axis", SD * cx, SD * cy);
  }
  const XrVector3f a = s.eyesLocated ? s.eyePose[0].position : XrVector3f{-kFallbackHalfIpdM, 0.0f, 0.0f};
  const XrVector3f b = s.eyesLocated ? s.eyePose[1].position : XrVector3f{kFallbackHalfIpdM, 0.0f, 0.0f};
  const float ipd = std::sqrt((b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y) + (b.z - a.z) * (b.z - a.z));
  const std::string line = "theater: stereo window, scale " + fmt("%.2f", scale) + (scale == 1.0f ? " (life size)" : "") + ", " + fmt("%.2f", D) +
                           " m ahead, video eye " + std::to_string(picW / 2) + "x" + std::to_string(picH) + ", eyes from " +
                           (s.eyesLocated ? "xrLocateViews" : "assumed") + fmt(", IPD %.1f mm", ipd * 1000.0f) + "; " + eyes[0] + "; " + eyes[1];
  if (line == s.windowLog) return;
  s.windowLog = line;
  if (s.windowLogs < kMaxWindowLogs) {
    s.windowLogs++;
    logLine(line);
  } else {
    logOnce("window_log_limit", "theater: the stereo window keeps changing (the video's size, most likely); further changes are not logged");
  }
}

// D7.4: theater begins: the screen goes 2.6 m in front of where the head points now, in LOCAL space, where it then
// stays. D7.4.7 (2026-11-02): turned by the head's yaw AND pitch, never its roll, the pitch clamped to ±75° (never
// overhead or underfoot). The receiver is looking down at his own playfield when the other player's ball starts, about
// where the sender looks at his, so the window lands where the eyes already are; turned by the yaw only (level, at eye
// height), the sender's low playfield fell up to 55° below a level gaze, beyond the headset's view (fourth run). A
// location the runtime cannot give puts it in front of LOCAL's origin (the head at the session's start, by the spec).
constexpr float kMaxTheaterPitchRad = 1.308997f;  // 75°

void recentre(Session& s, XrTime when) {
  float yaw = 0.0f, pitch = 0.0f;
  XrVector3f head{0.0f, 0.0f, 0.0f};
  XrSpaceLocation loc{XR_TYPE_SPACE_LOCATION};
  const XrResult r = s.next.locateSpace(s.view, s.local, when, &loc);
  if (XR_SUCCEEDED(r)) {
    if (loc.locationFlags & XR_SPACE_LOCATION_ORIENTATION_VALID_BIT) {
      const XrQuaternionf& q = loc.pose.orientation;
      // The head's forward (-Z) in LOCAL: minus the rotation matrix's third column.
      const float fx = -2.0f * (q.x * q.z + q.w * q.y);
      const float fy = -2.0f * (q.y * q.z - q.w * q.x);
      const float fz = -(1.0f - 2.0f * (q.x * q.x + q.y * q.y));
      // A turn of `pitch` about +X, then of `yaw` about +Y, takes (0, 0, -1) to (-sin yaw cos pitch, sin pitch,
      // -cos yaw cos pitch): yaw from the forward's x and z, pitch from its y against its horizontal length. Looking
      // straight up or down: keep yaw 0 (the pitch, clamped, still holds).
      const float horiz2 = fx * fx + fz * fz;
      if (horiz2 > 0.01f) yaw = std::atan2(-fx, -fz);
      pitch = std::atan2(fy, std::sqrt(horiz2));
      if (!std::isfinite(pitch)) pitch = 0.0f;
      pitch = std::fmax(-kMaxTheaterPitchRad, std::fmin(kMaxTheaterPitchRad, pitch));
    }
    if (loc.locationFlags & XR_SPACE_LOCATION_POSITION_VALID_BIT) head = loc.pose.position;
  } else {
    logOnce("locate_failed", "theater: xrLocateSpace(VIEW in LOCAL) failed (" + resultName(s.next, s.instance, r) + "); the screen goes ahead of LOCAL's origin");
  }
  // The frame R_yaw R_pitch (the pitch turns in the head's own frame first; no roll). The mono screen and the stereo
  // window's eye quads (placeWindows) both use it, so they agree.
  const XrQuaternionf qYaw{0.0f, std::sin(yaw * 0.5f), 0.0f, std::cos(yaw * 0.5f)};
  const XrQuaternionf qPitch{std::sin(pitch * 0.5f), 0.0f, 0.0f, std::cos(pitch * 0.5f)};
  s.theaterFrame = quatMul(qYaw, qPitch);
  const XrVector3f fwd = quatRotate(s.theaterFrame, {0.0f, 0.0f, -kScreenDistanceM});
  s.screenPose.position = {head.x + fwd.x, head.y + fwd.y, head.z + fwd.z};
  s.screenPose.orientation = s.theaterFrame;
  s.theaterHead = head;
  logLine("theater: the screen is placed 2.6 m ahead, yaw " + std::to_string(static_cast<int>(yaw * kDegPerRad)) + " degrees, pitch " +
          std::to_string(static_cast<int>(pitch * kDegPerRad)) + " degrees in LOCAL space");
  locateEyes(s, when);
}

// What the companion's mode means now, given what has arrived: theater needs a picture (the video, else the panel
// frame on the screen), panel needs the panel; nothing live for 5 s → hidden, whatever was asked (a crashed
// companion never leaves a player in the dark).
ViewMode wantedMode(const Session& s, const Control& c) {
  const bool panelUp = s.panel.released && panelPipeLive(Stream::Panel);
  const bool videoUp = s.video.released && panelPipeLive(Stream::Video);
  switch (c.mode) {
    case ViewMode::Theater: return videoUp || panelUp ? ViewMode::Theater : ViewMode::Hidden;
    case ViewMode::Panel: return panelUp ? ViewMode::Panel : ViewMode::Hidden;
    default: return ViewMode::Hidden;
  }
}

const char* modeName(ViewMode m) { return m == ViewMode::Hidden ? "hidden" : m == ViewMode::Panel ? "panel" : "theater"; }

// One step of the mode machine. Into or out of theater the world changes: dip to black (fade up to 1, switch at the
// dark middle, fade back). Hidden <-> panel keep VPX's world and only show or drop the small panel: at once.
void stepMode(Session& s, ViewMode wanted, XrTime when) {
  const uint64_t now = GetTickCount64();
  double dt = s.lastTick == 0 ? 0.0 : static_cast<double>(now - s.lastTick);
  if (dt > kMaxFadeStepMs) dt = kMaxFadeStepMs;
  s.lastTick = now;
  const double step = dt / kFadeHalfMs;
  if (wanted == s.shown) {
    s.fade = s.fade - step < 0.0 ? 0.0 : s.fade - step;
    return;
  }
  const bool worldChanges = (wanted == ViewMode::Theater) != (s.shown == ViewMode::Theater);
  if (!worldChanges && s.fade == 0.0) {
    logLine(std::string("mode: ") + modeName(s.shown) + " -> " + modeName(wanted));
    s.shown = wanted;
    return;
  }
  s.fade += step;
  if (s.fade < 1.0) return;
  s.fade = 1.0;
  logLine(std::string("mode: ") + modeName(s.shown) + " -> " + modeName(wanted) + " (through black)");
  s.shown = wanted;
  if (wanted == ViewMode::Theater) recentre(s, when);
}

XrCompositionLayerQuad& quadAt(Session& s, size_t i, XrSpace space, const Surface& surf, XrEyeVisibility eye, int32_t x, int32_t w, XrPosef pose,
                               XrExtent2Df size, bool alpha) {
  XrCompositionLayerQuad& q = s.quads.at(i);
  q = XrCompositionLayerQuad{XR_TYPE_COMPOSITION_LAYER_QUAD};
  // Our pixels are premultiplied (Chromium's paint, the canvas' opaque video, the shade's black): blend by the source
  // alpha as premultiplied (no UNPREMULTIPLIED bit); without the bit the layer is opaque.
  q.layerFlags = alpha ? XR_COMPOSITION_LAYER_BLEND_TEXTURE_SOURCE_ALPHA_BIT : 0;
  q.space = space;
  q.eyeVisibility = eye;
  q.subImage.swapchain = surf.swapchain;
  q.subImage.imageRect.offset = {x, 0};
  q.subImage.imageRect.extent = {w, static_cast<int32_t>(surf.height)};
  q.subImage.imageArrayIndex = 0;
  q.pose = pose;
  q.size = size;
  return q;
}

// The layers of this frame into s.layers. False: send the app's frame as it is.
bool compose(Session& s, const XrFrameEndInfo& info, const Control& c) {
  static const XrPosef lowPose = facingEye(kPanelLowOffset), centrePose = facingEye(kPanelCentreOffset);
  static const XrPosef backdropPose = ahead(kBackdropDistanceM), shadePose = ahead(kShadeDistanceM);
  std::unique_ptr<GlContextScope> scope;
  noteProjection(s, info);
  uploadStream(s, s.panel, Stream::Panel, scope);
  // Video frames only matter in theater; one that arrives meanwhile is still taken (newest wins), not uploaded.
  if (c.mode == ViewMode::Theater) uploadStream(s, s.video, Stream::Video, scope);
  else panelPipeTake(Stream::Video, s.pixels, s.pixelsW, s.pixelsH);
  if (s.off) return false;
  stepMode(s, wantedMode(s, c), info.displayTime);
  const int level = static_cast<int>(s.fade * kShadeLevels + 0.5);
  if (s.shown == ViewMode::Theater || level > 0) uploadShade(s, level, scope);
  if (s.off) return false;
  if (s.shown == ViewMode::Hidden && level == 0) return false;

  s.layers.clear();
  size_t used = 0;
  uint32_t dropped = 0;
  for (uint32_t i = 0; i < info.layerCount; i++) {
    const XrCompositionLayerBaseHeader* l = info.layers[i];
    // Theater: the app's own world goes (OpenComposite submits VPX's two eyes as one XrCompositionLayerProjection);
    // anything else it submits (a quad of its own UI) stays.
    if (s.shown == ViewMode::Theater && l && l->type == XR_TYPE_COMPOSITION_LAYER_PROJECTION) {
      dropped++;
      continue;
    }
    s.layers.push_back(l);
  }
  if (dropped) logOnce("theater_dropped", "theater: removed " + std::to_string(dropped) + " projection layer(s) of the app's " + std::to_string(info.layerCount) + " layer(s)");
  const auto add = [&](XrCompositionLayerQuad& q) { s.layers.push_back(reinterpret_cast<const XrCompositionLayerBaseHeader*>(&q)); };
  const auto w = [](const Surface& surf) { return static_cast<int32_t>(surf.width); };
  if (s.shown == ViewMode::Panel && s.panel.released) {
    const float width = c.panelCentre ? kPanelCentreWidthM : kPanelLowWidthM;
    add(quadAt(s, used++, s.view, s.panel, XR_EYE_VISIBILITY_BOTH, 0, w(s.panel), c.panelCentre ? centrePose : lowPose,
               {width, width * static_cast<float>(s.panel.height) / static_cast<float>(s.panel.width)}, true));
  } else if (s.shown == ViewMode::Theater && s.shade.released) {
    add(quadAt(s, used++, s.view, s.shade, XR_EYE_VISIBILITY_BOTH, 0, w(s.shade), backdropPose, {kBackdropSizeM, kBackdropSizeM}, false));
    const bool videoUp = s.video.released && panelPipeLive(Stream::Video);
    const Surface& pic = videoUp ? s.video : s.panel;
    if (pic.released) {
      // Side by side (VPX's VR preview on "both eyes": left eye | right eye): one swapchain, each half to its eye as its
      // own quad, the stereo window (D7.4.5, above placeWindows; XrSwapchainSubImage::imageRect may be any rect inside
      // the image).
      const bool sbs = videoUp && c.sbs && pic.width >= 2;
      const int32_t half = w(pic) / 2;
      const float eyeW = static_cast<float>(sbs ? half : w(pic));
      const float eyeH = static_cast<float>(pic.height > 0 ? pic.height : 1);
      // D7.4.3: landscape (or square) eyes are width-led as before; portrait eyes height-led (see kScreenHeightM).
      const XrExtent2Df size = eyeW >= eyeH ? XrExtent2Df{kScreenWidthM, kScreenWidthM * eyeH / eyeW} : XrExtent2Df{kScreenHeightM * eyeW / eyeH, kScreenHeightM};
      if (sbs) {
        if (s.windowDirty || s.windowW != pic.width || s.windowH != pic.height || s.windowScale != c.theaterScale) placeWindows(s, pic.width, pic.height, c.theaterScale);
        add(quadAt(s, used++, s.local, pic, XR_EYE_VISIBILITY_LEFT, 0, half, s.windowPose[0], s.windowSize[0], false));
        add(quadAt(s, used++, s.local, pic, XR_EYE_VISIBILITY_RIGHT, half, w(pic) - half, s.windowPose[1], s.windowSize[1], false));
      } else {
        // The panel frame has transparent corners (Chromium's paint): blended over the black; the video is opaque.
        add(quadAt(s, used++, s.local, pic, XR_EYE_VISIBILITY_BOTH, 0, w(pic), s.screenPose, size, !videoUp));
      }
    }
  }
  if (level > 0 && s.shade.released) add(quadAt(s, used++, s.view, s.shade, XR_EYE_VISIBILITY_BOTH, 0, w(s.shade), shadePose, {kShadeSizeM, kShadeSizeM}, true));
  if (s.layers.size() > s.maxLayers) {
    logOnce("layer_limit", "xrEndFrame: the app's " + std::to_string(info.layerCount) + " layer(s) and ours exceed the runtime's " + std::to_string(s.maxLayers) +
                               "; the app's frame goes as it is while that holds");
    return false;
  }
  return true;
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
  s->panel.name = "panel";
  s->panel.order = Order::BGRA;
  s->video.name = "video";
  s->video.order = Order::RGBA;
  s->shade.name = "shade";
  s->screenPose = ahead(kScreenDistanceM);  // until the first recentre (a quad's pose must be a unit quaternion)
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
          (api ? "; the panel and theater are drawn in this session" : "; not supported, this session passes through"));
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
  // Only over the app's own picture: a frame without layers (not visible, loading) stays as the app sent it.
  if (frameEndInfo->layerCount == 0 || !frameEndInfo->layers) return next(session, frameEndInfo);
  bool mine = false;
  try {
    mine = compose(*s, *frameEndInfo, panelPipeControl());
  } catch (...) {
    disable("a fault while preparing the frame in xrEndFrame");
    mine = false;
  }
  if (!mine) return next(session, frameEndInfo);
  XrFrameEndInfo ours = *frameEndInfo;
  ours.layerCount = static_cast<uint32_t>(s->layers.size());
  ours.layers = s->layers.data();
  const XrResult r = next(session, &ours);
  if (r == XR_ERROR_LAYER_INVALID || r == XR_ERROR_LAYER_LIMIT_EXCEEDED || r == XR_ERROR_SWAPCHAIN_RECT_INVALID || r == XR_ERROR_POSE_INVALID ||
      r == XR_ERROR_VALIDATION_FAILURE) {
    // Validation errors come before the runtime ends the frame, so the app's own frame can still go: once, without us.
    s->off = true;
    logLine(std::string("xrEndFrame refused the frame with our layers in mode ") + modeName(s->shown) + " (" + resultName(s->next, s->instance, r) +
            "); the layer is off for this session");
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
         nextFn(n, i, "xrCreateReferenceSpace", n.createReferenceSpace) && nextFn(n, i, "xrLocateSpace", n.locateSpace) &&
         nextFn(n, i, "xrEnumerateSwapchainFormats", n.enumerateSwapchainFormats) &&
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
      // Core, so always there in practice; still optional: the stereo window has a fallback, the rest needs none of it.
      if (!nextFn(inst->next, handle, "xrLocateViews", inst->next.locateViews)) inst->next.locateViews = nullptr;
      // D7.3.3: the build id names the exact dll (a release tag or a commit), so an older one kept by a running VPX shows.
      logLine(std::string(kLayerName) + " " CASTCADE_VR_LAYER_VERSION " build " CASTCADE_BUILD_ID " (OpenXR headers " CASTCADE_OPENXR_SDK_TAG ") loaded in " + exeName());
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
