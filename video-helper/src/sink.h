// castcade-video: where decoded pictures go (§6.2 `sink`): the `recv` ring (this helper is its producer, the layer
// draws it), a window the helper opens itself (D10.4, not yet), or nowhere. The decoder's NV12 / I420 picture is
// converted to BGRA with libyuv straight into the ring slot (timed).
#pragma once

#include <cstdint>
#include <mutex>
#include <string>

#include "factories.h"
#include "frame_ring.h"

struct SinkConfig {
  enum class Kind { kNone, kRing, kWindow };
  Kind kind = Kind::kNone;
  std::string token;
  // The box the recv ring is sized for (the decoded picture must fit; larger pictures are dropped and counted). The
  // `sink` command may set it (`width`, `height`); the default holds any eye up to 2048x2048 (50 MB of section).
  uint32_t max_width = 2048, max_height = 2048;
};
const char* SinkKindName(SinkConfig::Kind k);

class Sink final : public DecodedSink {
 public:
  bool Configure(const SinkConfig& cfg, std::string* error);
  SinkConfig config();
  void OnDecoded(const DecodedPicture& p, int64_t dec_us) override;

  struct Readout {
    double fps = 0;           // pictures decoded in the window (whatever the kind)
    double convert_us = 0;    // average YUV → BGRA time (ring kind)
    double dec_us = 0;        // average decoder cost
    int width = 0, height = 0;
    int64_t frames_total = 0, dropped_too_big = 0;
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
  int64_t win_frames_ = 0, win_convert_us_ = 0, win_dec_us_ = 0, win_start_us_ = 0;
  int64_t frames_total_ = 0, dropped_ = 0;
  int width_ = 0, height_ = 0;
  bool warned_size_ = false;
};
