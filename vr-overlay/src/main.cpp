// castcade-vr-overlay: draws the Castcade match panel in the headset as an OpenVR overlay (D7, 2026-10-30;
// docs/design/alpha-match.md §5). The companion renders the panel offscreen and pipes its frames here; this process
// only places a quad and uploads pixels, so a crash here never takes the companion (or VPX's VR session) down.
//
//   castcade-vr-overlay.exe [--width-m 0.55] [--anchor hmd|world] [--offset 0,-0.28,-0.9] [--alpha 0.95]
//                           [--key castcade.panel] [--name Castcade]
//
// stdin: frames, each a 16-byte little-endian header ("CVO1", u32 width, u32 height, u32 byteLength = w*h*4) then
// byteLength bytes of BGRA, top-down. stdout: one JSON line per event. Exit codes: 0 stdin EOF or SteamVR quit,
// 2 SteamVR not running, 3 OpenVR error, 4 bad frame header, 64 bad arguments.
#include <windows.h>

#include <openvr.h>

#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace {

constexpr int kExitOk = 0;
constexpr int kExitNoSteamVr = 2;
constexpr int kExitOpenVr = 3;
constexpr int kExitBadFrame = 4;
constexpr int kExitBadArgs = 64;

constexpr uint32_t kMaxSide = 4096;
// No frame for this long → hide (the companion re-sends its last frame every 2 s while the panel is still, so a hide
// means the companion stopped feeding, not that nothing changed).
constexpr auto kHideAfter = std::chrono::seconds(5);
// Main-loop tick: how often SteamVR events and the hide timer are looked at when no frame arrives.
constexpr auto kTick = std::chrono::milliseconds(20);

std::string jsonEscape(const std::string& s) {
  std::string out;
  out.reserve(s.size());
  for (unsigned char c : s) {
    if (c == '"' || c == '\\') {
      out += '\\';
      out += static_cast<char>(c);
    } else if (c < 0x20) {
      char buf[8];
      std::snprintf(buf, sizeof buf, "\\u%04x", c);
      out += buf;
    } else {
      out += static_cast<char>(c);
    }
  }
  return out;
}

// stdout is the companion's event channel: one JSON object per line, flushed at once. Only the main thread writes it.
void emit(const std::string& event, const std::string& reason = {}, const std::string& detail = {}) {
  std::string line = "{\"event\":\"" + event + "\"";
  if (!reason.empty()) line += ",\"reason\":\"" + jsonEscape(reason) + "\"";
  if (!detail.empty()) line += ",\"detail\":\"" + jsonEscape(detail) + "\"";
  line += "}\n";
  std::fputs(line.c_str(), stdout);
  std::fflush(stdout);
}

struct Options {
  float widthM = 0.55f;
  bool world = false;
  // Metres from the head: right, up, forward negative (OpenVR's HMD space: +X right, +Y up, -Z ahead).
  float offset[3] = {0.0f, -0.28f, -0.9f};
  float alpha = 0.95f;
  std::string key = "castcade.panel";
  std::string name = "Castcade";
};

bool parseFloat(const std::string& s, float& out) {
  if (s.empty()) return false;
  char* end = nullptr;
  const double v = std::strtod(s.c_str(), &end);
  if (end != s.c_str() + s.size() || !std::isfinite(v)) return false;
  out = static_cast<float>(v);
  return true;
}

bool parseArgs(int argc, char** argv, Options& o, std::string& err) {
  auto bad = [&err](const char* why) {
    err = why;
    return false;
  };
  for (int i = 1; i < argc; i++) {
    const std::string a = argv[i];
    if (i + 1 >= argc) {
      err = a + " needs a value";
      return false;
    }
    const std::string v = argv[++i];
    if (a == "--width-m") {
      if (!parseFloat(v, o.widthM) || o.widthM <= 0.0f || o.widthM > 10.0f) return bad("--width-m must be in (0, 10]");
    } else if (a == "--anchor") {
      if (v == "hmd") o.world = false;
      else if (v == "world") o.world = true;
      else return bad("--anchor must be hmd or world");
    } else if (a == "--offset") {
      const size_t c1 = v.find(','), c2 = c1 == std::string::npos ? c1 : v.find(',', c1 + 1);
      if (c2 == std::string::npos || v.find(',', c2 + 1) != std::string::npos || !parseFloat(v.substr(0, c1), o.offset[0]) ||
          !parseFloat(v.substr(c1 + 1, c2 - c1 - 1), o.offset[1]) || !parseFloat(v.substr(c2 + 1), o.offset[2]))
        return bad("--offset must be x,y,z in metres");
    } else if (a == "--alpha") {
      if (!parseFloat(v, o.alpha) || o.alpha < 0.0f || o.alpha > 1.0f) return bad("--alpha must be in [0, 1]");
    } else if (a == "--key") {
      if (v.empty() || v.size() >= vr::k_unVROverlayMaxKeyLength) return bad("--key must be 1-127 characters");
      o.key = v;
    } else if (a == "--name") {
      if (v.empty() || v.size() >= vr::k_unVROverlayMaxNameLength) return bad("--name must be 1-127 characters");
      o.name = v;
    } else {
      err = "unknown argument " + a;
      return false;
    }
  }
  return true;
}

// The init errors that mean "no SteamVR to talk to" (not installed, not running, no headset), as opposed to a fault.
bool steamVrMissing(vr::EVRInitError e) {
  switch (e) {
    case vr::VRInitError_Init_InstallationNotFound:
    case vr::VRInitError_Init_VRClientDLLNotFound:
    case vr::VRInitError_Init_HmdNotFound:
    case vr::VRInitError_Init_PathRegistryNotFound:
    case vr::VRInitError_Init_NoServerForBackgroundApp:
    case vr::VRInitError_Init_HmdNotFoundPresenceFailed:
    case vr::VRInitError_IPC_ConnectFailed:
    case vr::VRInitError_IPC_ConnectFailedAfterMultipleAttempts:
    case vr::VRInitError_IPC_ConnectFailedAfterTargetExited:
      return true;
    default:
      return false;
  }
}

// ---- placement ----------------------------------------------------------------------------------------------------

struct V3 {
  float x, y, z;
};
V3 cross(V3 a, V3 b) { return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x}; }
float len(V3 a) { return std::sqrt(a.x * a.x + a.y * a.y + a.z * a.z); }
V3 norm(V3 a) {
  const float l = len(a);
  return {a.x / l, a.y / l, a.z / l};
}

vr::HmdMatrix34_t identity() {
  vr::HmdMatrix34_t m{};
  m.m[0][0] = m.m[1][1] = m.m[2][2] = 1.0f;
  return m;
}

// A quad at `p` (in its reference space) turned so its front (+Z) faces the reference origin (the eye), kept upright
// (+Y up as far as the tilt allows). At the default offset this is a ~17° tilt back, so a panel below the line of
// sight reads square-on when the player glances down instead of foreshortened.
vr::HmdMatrix34_t facingOrigin(const float p[3]) {
  vr::HmdMatrix34_t m = identity();
  m.m[0][3] = p[0];
  m.m[1][3] = p[1];
  m.m[2][3] = p[2];
  const V3 toEye{-p[0], -p[1], -p[2]};
  if (len(toEye) < 1e-4f) return m;
  const V3 n = norm(toEye);
  V3 r = cross(V3{0.0f, 1.0f, 0.0f}, n);
  r = len(r) < 1e-4f ? V3{1.0f, 0.0f, 0.0f} : norm(r);  // straight above/below: any right will do
  const V3 u = cross(n, r);
  // Columns are the quad's axes: right, up, front.
  m.m[0][0] = r.x, m.m[0][1] = u.x, m.m[0][2] = n.x;
  m.m[1][0] = r.y, m.m[1][1] = u.y, m.m[1][2] = n.y;
  m.m[2][0] = r.z, m.m[2][1] = u.z, m.m[2][2] = n.z;
  return m;
}

// a * b for affine 3x4 transforms.
vr::HmdMatrix34_t mul(const vr::HmdMatrix34_t& a, const vr::HmdMatrix34_t& b) {
  vr::HmdMatrix34_t m{};
  for (int r = 0; r < 3; r++) {
    for (int c = 0; c < 4; c++) {
      float s = c == 3 ? a.m[r][3] : 0.0f;
      for (int k = 0; k < 3; k++) s += a.m[r][k] * b.m[k][c];
      m.m[r][c] = s;
    }
  }
  return m;
}

// `--anchor world`: the panel stays where the head-relative offset put it when the helper started, upright (yaw of the
// head only, so a tilted head at start does not tilt the panel). Standing space; falls back to 1.6 m eye height at the
// standing origin, facing -Z, when the HMD pose is not valid within 2 s.
vr::HmdMatrix34_t worldPlacement(const Options& o) {
  vr::HmdMatrix34_t head = identity();
  head.m[1][3] = 1.6f;
  for (int i = 0; i < 40; i++) {
    vr::TrackedDevicePose_t pose{};
    vr::VRSystem()->GetDeviceToAbsoluteTrackingPose(vr::TrackingUniverseStanding, 0.0f, &pose, 1);
    if (pose.bPoseIsValid) {
      const vr::HmdMatrix34_t& d = pose.mDeviceToAbsoluteTracking;
      V3 back{d.m[0][2], 0.0f, d.m[2][2]};  // the head's +Z flattened onto the floor
      back = len(back) < 1e-4f ? V3{0.0f, 0.0f, 1.0f} : norm(back);
      const V3 right = cross(V3{0.0f, 1.0f, 0.0f}, back);
      head = identity();
      head.m[0][0] = right.x, head.m[0][2] = back.x;
      head.m[1][1] = 1.0f;
      head.m[2][0] = right.z, head.m[2][2] = back.z;
      head.m[0][3] = d.m[0][3], head.m[1][3] = d.m[1][3], head.m[2][3] = d.m[2][3];
      return mul(head, facingOrigin(o.offset));
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
  }
  std::fputs("castcade-vr-overlay: no valid HMD pose in 2 s; world anchor at the standing origin\n", stderr);
  return mul(head, facingOrigin(o.offset));
}

// ---- frame reader (its own thread: ReadFile blocks) -----------------------------------------------------------------

struct Inbox {
  std::mutex m;
  std::condition_variable cv;
  std::vector<uint8_t> pixels;  // the newest complete frame not yet uploaded (an older one is overwritten: newest wins)
  uint32_t width = 0, height = 0;
  bool hasFrame = false;
  bool eof = false;
  std::string error;  // a bad header: the reason for the exit-4 line
};

uint32_t le32(const uint8_t* p) {
  return static_cast<uint32_t>(p[0]) | static_cast<uint32_t>(p[1]) << 8 | static_cast<uint32_t>(p[2]) << 16 |
         static_cast<uint32_t>(p[3]) << 24;
}

// Raw ReadFile, not the CRT: no text-mode translation, and no CRT stream lock held while blocked, so the main thread
// can exit while this thread waits.
bool readExact(HANDLE in, uint8_t* p, size_t n) {
  while (n > 0) {
    DWORD got = 0;
    const DWORD want = static_cast<DWORD>(n > (1u << 20) ? (1u << 20) : n);
    if (!ReadFile(in, p, want, &got, nullptr) || got == 0) return false;  // EOF or the pipe broke
    p += got;
    n -= got;
  }
  return true;
}

void readFrames(Inbox* box) {
  const HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
  std::vector<uint8_t> buf;
  for (;;) {
    uint8_t hdr[16];
    std::string bad;
    if (!readExact(in, hdr, sizeof hdr)) break;
    const uint32_t w = le32(hdr + 4), h = le32(hdr + 8), n = le32(hdr + 12);
    if (std::memcmp(hdr, "CVO1", 4) != 0) bad = "bad_magic";
    else if (w == 0 || h == 0 || w > kMaxSide || h > kMaxSide) bad = "bad_size:" + std::to_string(w) + "x" + std::to_string(h);
    else if (static_cast<uint64_t>(n) != static_cast<uint64_t>(w) * h * 4) bad = "bad_length:" + std::to_string(n);
    if (!bad.empty()) {
      std::lock_guard<std::mutex> lk(box->m);
      box->error = bad;
      box->cv.notify_one();
      return;
    }
    buf.resize(n);
    if (!readExact(in, buf.data(), n)) break;  // EOF mid-frame: the partial frame is dropped
    std::lock_guard<std::mutex> lk(box->m);
    box->pixels.swap(buf);
    box->width = w;
    box->height = h;
    box->hasFrame = true;
    box->cv.notify_one();
  }
  std::lock_guard<std::mutex> lk(box->m);
  box->eof = true;
  box->cv.notify_one();
}

// SetOverlayRaw takes RGBA; the companion sends Chromium's BGRA as-is, so swap R and B here, one pass, in place.
void bgraToRgba(std::vector<uint8_t>& px) {
  uint8_t* p = px.data();
  for (size_t i = 0, n = px.size(); i + 3 < n; i += 4) {
    const uint8_t b = p[i];
    p[i] = p[i + 2];
    p[i + 2] = b;
  }
}

}  // namespace

int main(int argc, char** argv) {
  Options o;
  std::string err;
  if (!parseArgs(argc, argv, o, err)) {
    emit("error", "bad_args", err);
    return kExitBadArgs;
  }

  vr::EVRInitError ie = vr::VRInitError_None;
  vr::VR_Init(&ie, vr::VRApplication_Overlay);
  if (ie != vr::VRInitError_None) {
    const std::string detail = std::string(vr::VR_GetVRInitErrorAsSymbol(ie)) + ": " + vr::VR_GetVRInitErrorAsEnglishDescription(ie);
    if (steamVrMissing(ie)) {
      emit("unavailable", "steamvr_not_running", detail);
      return kExitNoSteamVr;
    }
    emit("error", "openvr_init", detail);
    return kExitOpenVr;
  }
  vr::IVROverlay* ov = vr::VROverlay();
  vr::VROverlayHandle_t h = vr::k_ulOverlayHandleInvalid;
  auto fail = [&](const char* what, vr::EVROverlayError e) {
    emit("error", what, ov ? ov->GetOverlayErrorNameFromEnum(e) : "no IVROverlay");
    if (ov && h != vr::k_ulOverlayHandleInvalid) ov->DestroyOverlay(h);
    vr::VR_Shutdown();
    return kExitOpenVr;
  };
  if (!ov) return fail("overlay_interface", vr::VROverlayError_None);
  vr::EVROverlayError oe = ov->CreateOverlay(o.key.c_str(), o.name.c_str(), &h);
  if (oe != vr::VROverlayError_None) return fail("overlay_create", oe);
  if ((oe = ov->SetOverlayWidthInMeters(h, o.widthM)) != vr::VROverlayError_None) return fail("overlay_width", oe);
  if ((oe = ov->SetOverlayAlpha(h, o.alpha)) != vr::VROverlayError_None) return fail("overlay_alpha", oe);
  if ((oe = ov->SetOverlayInputMethod(h, vr::VROverlayInputMethod_None)) != vr::VROverlayError_None) return fail("overlay_input", oe);
  if (o.world) {
    const vr::HmdMatrix34_t m = worldPlacement(o);
    oe = ov->SetOverlayTransformAbsolute(h, vr::TrackingUniverseStanding, &m);
  } else {
    const vr::HmdMatrix34_t m = facingOrigin(o.offset);
    oe = ov->SetOverlayTransformTrackedDeviceRelative(h, vr::k_unTrackedDeviceIndex_Hmd, &m);
  }
  if (oe != vr::VROverlayError_None) return fail("overlay_transform", oe);
  std::fprintf(stderr, "castcade-vr-overlay %s (OpenVR %s): overlay %s, %s anchor, %.2f m wide, offset %.2f,%.2f,%.2f\n",
               CASTCADE_VR_OVERLAY_VERSION, CASTCADE_OPENVR_TAG, o.key.c_str(), o.world ? "world" : "hmd", o.widthM,
               o.offset[0], o.offset[1], o.offset[2]);

  // Never freed: the reader thread may still be blocked in ReadFile when main returns (the process ends it).
  Inbox* box = new Inbox();
  std::thread(readFrames, box).detach();

  std::vector<uint8_t> frame;
  bool everShown = false, visible = false;
  auto lastFrame = std::chrono::steady_clock::now();
  auto finish = [&](int code) {
    ov->DestroyOverlay(h);
    vr::VR_Shutdown();
    return code;
  };
  for (;;) {
    uint32_t w = 0, fh = 0;
    bool got = false, eof = false;
    std::string bad;
    {
      std::unique_lock<std::mutex> lk(box->m);
      box->cv.wait_for(lk, kTick, [&] { return box->hasFrame || box->eof || !box->error.empty(); });
      if (box->hasFrame) {
        frame.swap(box->pixels);
        w = box->width;
        fh = box->height;
        box->hasFrame = false;
        got = true;
      }
      eof = box->eof;
      bad = box->error;
    }
    if (!bad.empty()) {
      emit("error", "bad_frame", bad);
      return finish(kExitBadFrame);
    }
    const auto now = std::chrono::steady_clock::now();
    if (got) {
      bgraToRgba(frame);
      oe = ov->SetOverlayRaw(h, frame.data(), w, fh, 4);
      if (oe != vr::VROverlayError_None) std::fprintf(stderr, "castcade-vr-overlay: SetOverlayRaw %ux%u: %s\n", w, fh, ov->GetOverlayErrorNameFromEnum(oe));
      lastFrame = now;
      if (!visible) {
        ov->ShowOverlay(h);
        visible = true;
        emit(everShown ? "showing" : "ready");
        everShown = true;
      }
    }
    if (eof) {
      emit("eof");
      return finish(kExitOk);
    }
    if (visible && now - lastFrame > kHideAfter) {
      ov->HideOverlay(h);
      visible = false;
      emit("hidden");
    }
    // VREvent_Quit (SteamVR closing) arrives on the system queue; overlay events are drained so they do not pile up.
    vr::VREvent_t ev{};
    bool quit = false;
    while (vr::VRSystem()->PollNextEvent(&ev, sizeof ev)) quit = quit || ev.eventType == static_cast<uint32_t>(vr::VREvent_Quit);
    while (ov->PollNextOverlayEvent(h, &ev, sizeof ev)) quit = quit || ev.eventType == static_cast<uint32_t>(vr::VREvent_Quit);
    if (quit) {
      emit("quit");
      vr::VRSystem()->AcknowledgeQuit_Exiting();
      return finish(kExitOk);
    }
  }
}
