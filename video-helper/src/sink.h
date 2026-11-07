// castcade-video: where decoded pictures go (§6.2 `sink`): the `recv` ring (this helper is its producer, the layer
// draws it), a window the helper opens itself (D10.4, desktop watchers), or nowhere. The decoder's NV12 / I420 picture
// is converted to BGRA with libyuv once, straight into the ring slot or the window's pending buffer (timed). The last
// `sink` command wins: a window closes the ring and the other way round.
#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>

#include "factories.h"
#include "frame_ring.h"
#include "sink_window.h"

struct SinkConfig {
  enum class Kind { kNone, kRing, kWindow };
  Kind kind = Kind::kNone;
  std::string token;
  // The box the recv ring is sized for (the decoded picture must fit; larger pictures are dropped and counted). The
  // `sink` command may set it (`width`, `height`); the default holds any eye up to 2048x2048 (50 MB of section).
  uint32_t max_width = 2048, max_height = 2048;
  WindowOptions window;  // the window kind's title, placement, topmost
};
const char* SinkKindName(SinkConfig::Kind k);

class Sink final : public DecodedSink {
 public:
  // The window's state changes (`open` on Configure, `closed` when the user closes it; the latter on the window
  // thread). The session turns them into `sink` events.
  using WindowEventFn = std::function<void(const std::string& state, const WindowPlacement& placement, const std::string& driver)>;
  void SetWindowEvents(WindowEventFn fn) { window_event_ = std::move(fn); }

  bool Configure(const SinkConfig& cfg, std::string* error);
  SinkConfig config();  // kind reads `none` once the user has closed the window
  void OnDecoded(const DecodedPicture& p, int64_t dec_us) override;

  struct Readout {
    double fps = 0;           // pictures decoded in the window (whatever the kind)
    double convert_us = 0;    // average YUV → BGRA time (ring or window kind)
    double dec_us = 0;        // average decoder cost
    int width = 0, height = 0;
    int64_t frames_total = 0, dropped_too_big = 0;
    double presented_fps = 0; // window kind: frames presented per second in the window
    double present_us = 0;    // window kind: mean upload + present per presented frame
  };
  Readout Snapshot();
  // D10.5: the running count of decoded pictures, without touching the window (the loopback selftest's size check).
  int64_t frames_total() {
    std::lock_guard<std::mutex> l(mu_);
    return frames_total_;
  }

 private:
  std::mutex mu_;
  SinkConfig cfg_;
  RingProducer ring_;
  std::unique_ptr<WindowSink> window_;
  WindowEventFn window_event_;
  int64_t win_frames_ = 0, win_convert_us_ = 0, win_dec_us_ = 0, win_start_us_ = 0;
  int64_t frames_total_ = 0, dropped_ = 0;
  int width_ = 0, height_ = 0;
  bool warned_size_ = false;
};
