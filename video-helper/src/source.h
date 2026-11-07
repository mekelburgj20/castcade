// castcade-video: where the frames this rig sends come from (§6.2 `source`): the `send` ring the layer fills, a
// synthetic bench picture, or nothing. A worker thread takes BGRA frames, converts them to NV12 with libyuv (timed)
// and hands them on as webrtc::NV12Buffer at the source's own pace (the ring's event, or the bench's fps). When
// sending is off nothing is converted or delivered.
#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

#include "api/scoped_refptr.h"
#include "api/video/nv12_buffer.h"

// The D10.0.1 harness's synthetic playfield in BGRA (top-down, `stride` bytes a row): a scrolling checker with grid
// lines, a fast bright ball, a noise block that costs real bits and the frame counter as a 16-bit strip top-left.
// Frame n is a function of n alone.
void BenchPattern(uint64_t n, int width, int height, uint8_t* bgra, int stride);

// BGRA → NV12 (libyuv, BT.601 limited range, libyuv's "ARGB" is this byte order). Returns the microseconds it took.
int64_t ConvertBgraToNv12(const uint8_t* bgra, int stride, int width, int height, webrtc::NV12Buffer* dst);

struct SourceConfig {
  enum class Kind { kNone, kRing, kBench };
  Kind kind = Kind::kNone;
  std::string token;
  int width = 1354, height = 1440, fps = 60;  // the bench picture; for a ring the box the layer was asked for (informational)
};
const char* SourceKindName(SourceConfig::Kind k);

class Source {
 public:
  using FrameFn = std::function<void(const webrtc::scoped_refptr<webrtc::NV12Buffer>&, int64_t capture_us)>;
  using StateFn = std::function<void(const std::string& state)>;  // "ok" | "missing" | "dead" (ring only)

  Source(FrameFn on_frame, StateFn on_state);
  ~Source();

  void Configure(const SourceConfig& cfg);
  SourceConfig config() const;
  void SetEnabled(bool on);
  bool enabled() const { return enabled_.load(); }
  std::string state() const;

  struct Readout {
    double fps_in = 0;          // frames taken from the ring (or generated) in the window
    double convert_us = 0;      // average BGRA → NV12 time in the window
    int64_t frames_total = 0;
    int64_t skipped_total = 0;  // ring frames the producer lapped
  };
  Readout Snapshot();  // the last window; resets it

  void Stop();

 private:
  void Run(SourceConfig cfg, uint64_t generation);
  void SetState(const std::string& s);
  void Count(int64_t convert_us);

  FrameFn on_frame_;
  StateFn on_state_;
  mutable std::mutex mu_;
  SourceConfig cfg_;
  std::string state_ = "none";
  std::atomic<bool> enabled_{false};
  std::atomic<uint64_t> generation_{0};
  std::thread thread_;
  int64_t win_frames_ = 0, win_convert_us_ = 0, win_start_us_ = 0, frames_total_ = 0;
  std::atomic<int64_t> skipped_total_{0};
};
