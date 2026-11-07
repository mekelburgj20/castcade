// castcade-video: the `sink window` (D10.4): the picture a desktop (non-VR) watcher sees. The helper opens its own
// Win32 window on its own thread (class `CastcadeVideoWindow`), with a D3D11 flip-model swapchain on it, and draws the
// decoded BGRA frames of the player who is up letterboxed in black, aspect kept, at vsync. Double-click or F11 toggles
// borderless full screen on the window's monitor, Escape leaves it, closing the window tells the session (the
// `{"event":"sink","kind":"window","state":"closed"}` event). While no frame has come for 3 s the window shows a
// small centred "waiting for the player up". Everything D3D happens on the window thread; the decode thread only
// writes the newest frame into a pending buffer (Begin / Commit, the shape of RingProducer, so the one conversion in
// Sink::OnDecoded feeds either sink).
#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <vector>

struct WindowPlacement {
  int x = 0, y = 0, width = 0, height = 0;  // the window rect in screen pixels (outer, not the client area)
};

struct WindowOptions {
  std::string title;                          // "" = "Castcade — spectating"
  bool topmost = false;
  int monitor = 0;                            // 0 = the primary display, n = the n-th display in enumeration order
  std::optional<WindowPlacement> placement;   // a remembered rect; absent = 50 % of the display's height, centred
  std::optional<int> width, height;           // a size alone (no x, y): that size, centred on the display
  bool force_warp = false;                    // the selftest's --warp: skip the hardware device
};

class WindowSink {
 public:
  using ClosedFn = std::function<void(const WindowPlacement& last)>;  // called on the window thread, once, user close only

  WindowSink() = default;
  ~WindowSink();
  WindowSink(const WindowSink&) = delete;
  WindowSink& operator=(const WindowSink&) = delete;

  // Starts the window thread and returns once the window and the swapchain are up (false, with the reason, when
  // neither the hardware nor the WARP device could be made).
  bool Open(const WindowOptions& o, ClosedFn on_closed, std::string* error);
  // Closes the window (no `closed` callback) and joins the thread. Any thread but the window's.
  void Close();
  // The window is up and the user has not closed it.
  bool alive() const { return alive_.load(); }
  // "hardware" or "warp" once open.
  std::string driver() const;
  // The last placement outside full screen (the window rect).
  WindowPlacement placement() const;

  // The pending buffer for the next frame (stride = width * 4). false when the window is not alive.
  bool Begin(uint32_t width, uint32_t height, uint8_t** pixels, uint32_t* stride);
  // Publishes what Begin handed out: the window thread uploads and presents it (the newest frame wins).
  void Commit();

  struct Readout {
    int64_t presented = 0;   // frames presented since the last Snapshot
    double upload_us = 0;    // mean texture upload (Map + copy) per presented frame
    double present_us = 0;   // mean upload + draw + Present per presented frame (Present waits for vsync)
  };
  Readout Snapshot();

  // Toggles borderless full screen on the window's current monitor (what double-click and F11 do).
  void ToggleFullscreen();

 private:
  struct Gfx;        // the D3D11 side, window thread only (sink_window.cpp)
  struct Handshake;  // Open() waits on it until the window thread reports up / failed
  friend struct Gfx;
  friend struct WndProcDispatch;
  void ThreadMain(WindowOptions o, Handshake* hs);
  bool SetUp(const WindowOptions& o, std::string* error);
  void Render();
  void OnFirstFrameSize(uint32_t w, uint32_t h);
  void TrackPlacement();
  intptr_t WndProc(void* hwnd, unsigned msg, uintptr_t wp, intptr_t lp);

  std::thread thread_;
  ClosedFn on_closed_;
  std::atomic<bool> alive_{false};
  std::atomic<bool> closing_{false};        // Close() asked: no `closed` callback
  std::atomic<void*> hwnd_{nullptr};        // HWND, set by the window thread
  std::atomic<bool> frame_posted_{false};   // a frame message is already in the queue
  Gfx* gfx_ = nullptr;                      // owned by the window thread

  mutable std::mutex mu_;                   // pending_, placement_, driver_
  std::vector<uint8_t> pending_;
  uint32_t pending_w_ = 0, pending_h_ = 0;
  bool pending_new_ = false;
  WindowPlacement placement_;
  std::string driver_;

  std::atomic<int64_t> presented_{0}, upload_us_{0}, present_us_{0};
};
