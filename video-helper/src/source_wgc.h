// castcade-video: the non-VR sender's source (WORK D10.6; docs/design/spectator-video-native.md §3 point 1): Windows
// Graphics Capture of the VPX player window itself. The companion names the window (`source wgc`: the VPX pid and the
// title words `pickCaptureWindow` matches, the fit box and the fps the Electron capture would have used); the helper
// finds the window, captures it through a Direct3D11CaptureFramePool on its own D3D11 device, copies each frame to a
// staging texture, maps it and hands the BGRA rows to the one conversion path (source.cpp): scaled with libyuv to fit
// inside the box (never upscaled, aspect kept: a portrait playfield window stays portrait), decimated to the fps by the
// push clock, converted to NV12. WGC composes the window from the DWM, so it does not care whether VPX renders with
// OpenGL or D3D11 and does not need the window in front; a minimised window, one on another virtual desktop, and a
// DRM-protected one give nothing (README.md).
//
// Written against the WinRT ABI (`windows.graphics.capture.h` + WRL), not C++/WinRT: the helper is built without C++
// exceptions (`_HAS_EXCEPTIONS=0`, `/EHs-c-`, libwebrtc's toolchain shape) and C++/WinRT reports every failure by
// throwing, which would end the process exactly on the paths this source must survive (a window that closed between
// the find and the item, a session Windows refuses).
#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <string>

class Json;
struct SourceConfig;

// A top-level window as the finder sees it: client area in physical pixels.
struct WgcWindow {
  uintptr_t hwnd = 0;
  int pid = 0;
  std::string title;
  int width = 0, height = 0;
};

// EnumWindows: the largest visible, uncloaked, unminimised top-level window of `pid` (0: any process) whose title
// contains `title` (case-insensitive; empty: any title) and whose client area is not empty. false when there is none.
bool FindWgcWindow(int pid, const std::string& title, WgcWindow* out);

// GraphicsCaptureSession::IsSupported() behind the activation factories: false (with why) where WGC cannot run
// (Windows before 1903, or no desktop session to compose from: CI).
bool WgcSupported(std::string* why);

// One capture of one window. `Start` makes the item for the HWND (IGraphicsCaptureItemInterop), a free-threaded
// B8G8R8A8 pool of two buffers on a fresh D3D11 device, cursor off, the yellow border off where the API exists
// (checked with ApiInformation::IsPropertyPresent), and runs; every `FrameArrived` reaches `on_frame` on the pool's
// thread with the window's client area as BGRA rows (the title bar and frame of a windowed VPX are cropped away by the
// DWM frame bounds; a borderless or fullscreen window is handed over whole). A resized window recreates the pool at
// the new size behind the frame. `Stop` closes the session and the pool; no callback runs after it returns.
class WgcCapture {
 public:
  using FrameFn = std::function<void(const uint8_t* bgra, int stride, int width, int height)>;
  WgcCapture();
  ~WgcCapture();
  WgcCapture(const WgcCapture&) = delete;
  WgcCapture& operator=(const WgcCapture&) = delete;

  bool Start(uintptr_t hwnd, FrameFn on_frame, std::string* err);
  void Stop();
  // The item's Closed event fired: the window is gone.
  bool closed() const;
  // Frames handed to on_frame, and the mean texture copy + map time per frame in microseconds.
  int64_t frames() const;
  double copy_map_us() const;

 private:
  struct Impl;
  std::shared_ptr<Impl> impl_;
};

// The `source wgc` command's fields into `cfg` (kind, pid, title, width, height, fps): one of pid / title, a fit box of
// at least 64x64, fps 1..120. false with the reason for `error bad_command`.
bool ParseWgcSource(const Json& c, SourceConfig* cfg, std::string* err);

// `--wgc-selftest [--pid n | --title "..."] [--seconds 5]`: captures the window (default: any "Visual Pinball Player",
// else this process's console window) for `seconds` and prints frames, size, mean copy + map µs. Prints `skipped: no
// capture session` and returns 0 where WGC is not supported or the item cannot be made (CI); 1 when a window was
// captured and no frame came.
int RunWgcSelftest(int pid, const std::string& title, int seconds);
