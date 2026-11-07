// castcade-video: the quality ladder (D10.5; docs/design/spectator-video-native.md §3 item 4). Six rungs, each a
// fraction of the SOURCE box (1, 0.75, 0.5 of its height, aspect kept, even sizes), a frame rate and a bitrate, ordered
// the owner's way ("we would sacrifice resolution for smoothness"): the rung below full size at 60 fps is full size
// at 30 fps, then the smaller size at 60. For a 1354x1440 eye: 1354x1440@60 20000 · 1354x1440@30 10000 ·
// 1016x1080@60 8000 · 1016x1080@30 5000 · 678x720@60 4000 · 678x720@30 2000 (the design's 677 is odd; NV12 needs even).
// A 1080-tall desktop capture gets 1920x1080 · 1440x810 · 960x540 at the same rates.
//
// Applying a rung is the encoder wrapper's job (factories.cpp), per sending peer: the NV12 frame is scaled with libyuv
// to the rung's size, decimated to the rung's fps on the source clock, the encoder target is clamped to the rung's kbps,
// and a size change re-opens the encoder on an IDR (SPS/PPS in band). The RungTarget here is the handoff: the
// controller (or the pin) writes it on the session's threads, the encoder reads it on libwebrtc's encoder queue.
#pragma once

#include <atomic>
#include <cstdint>
#include <mutex>

constexpr int kRungCount = 6;

struct RungSpec {
  double scale;  // of the source's height (and width)
  int fps;
  int kbps;
};
// Rung 1 first (index 0 = rung 1).
extern const RungSpec kLadder[kRungCount];

struct RungGeometry {
  int rung = 0;  // 1..6; 0 = not set
  int width = 0, height = 0, fps = 0, kbps = 0;
  bool operator==(const RungGeometry& o) const { return rung == o.rung && width == o.width && height == o.height && fps == o.fps && kbps == o.kbps; }
  bool operator!=(const RungGeometry& o) const { return !(*this == o); }
};

// The rung's geometry for a source of src_width x src_height: sizes rounded to the nearest even number (at least 2).
RungGeometry RungFor(int rung, int src_width, int src_height);
int RungKbps(int rung);
int RungFps(int rung);
// The highest rung (lowest index) whose kbps fits under max_kbps; rung 6 when nothing does.
int CeilingRung(int max_kbps);
// The highest rung whose kbps <= budget_kbps (the probe's choice), bounded below by `ceiling`; rung 6 when nothing fits.
int RungForBudget(int budget_kbps, int ceiling);
int ClampRung(int rung);

// What one sending peer's encoder applies next: the rung (its size comes from the frame actually handed over, so a
// source whose frames differ from the box it was announced with still gets the right fraction), its fps and kbps.
// Plus the encoder's readout for the controller: frames handed to Encode, frames encoded, frames the decimator
// dropped, and the age of the frame at Encode (push → encode latency: libwebrtc's queue in front of the encoder).
class RungTarget {
 public:
  void Set(int rung, int fps, int kbps) {
    std::lock_guard<std::mutex> l(mu_);
    rung_ = rung;
    fps_ = fps;
    kbps_ = kbps;
  }
  void Get(int* rung, int* fps, int* kbps) const {
    std::lock_guard<std::mutex> l(mu_);
    *rung = rung_;
    *fps = fps_;
    *kbps = kbps_;
  }
  int rung() const {
    std::lock_guard<std::mutex> l(mu_);
    return rung_;
  }

  struct Readout {
    int64_t frames_in = 0, frames_encoded = 0, frames_dropped = 0;  // cumulative
    int64_t queue_us_max = 0;                                       // in the window since the last Snapshot
    int out_width = 0, out_height = 0;                               // the encoder's current output size
  };
  void NoteFrame(int64_t age_us, bool encoded, int out_width, int out_height) {
    std::lock_guard<std::mutex> l(mu_);
    frames_in_++;
    if (encoded) frames_encoded_++;
    else frames_dropped_++;
    if (age_us > queue_us_max_) queue_us_max_ = age_us;
    out_width_ = out_width;
    out_height_ = out_height;
  }
  Readout Snapshot() {
    std::lock_guard<std::mutex> l(mu_);
    Readout r;
    r.frames_in = frames_in_;
    r.frames_encoded = frames_encoded_;
    r.frames_dropped = frames_dropped_;
    r.queue_us_max = queue_us_max_;
    r.out_width = out_width_;
    r.out_height = out_height_;
    queue_us_max_ = 0;
    return r;
  }

 private:
  mutable std::mutex mu_;
  int rung_ = 0, fps_ = 0, kbps_ = 0;
  int64_t frames_in_ = 0, frames_encoded_ = 0, frames_dropped_ = 0, queue_us_max_ = 0;
  int out_width_ = 0, out_height_ = 0;
};

// Steady decimation on the source clock: keeps a frame when its timestamp has reached the next due time (with a
// quarter-period tolerance), so 60 → 30 keeps every other frame and never drops two in a row; a gap longer than a
// second, or time going backwards, restarts the cadence. target_fps <= 0 keeps everything.
class FrameDecimator {
 public:
  bool Keep(int64_t ts_us, int target_fps);
  void Reset() { next_due_us_ = 0; last_ts_us_ = 0; }

 private:
  int64_t next_due_us_ = 0, last_ts_us_ = 0;
  int last_fps_ = 0;
};
