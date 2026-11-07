#include "source.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <vector>

#include "libyuv/convert_from_argb.h"

#include "frame_ring.h"
#include "util.h"

// ---------------------------------------------------------------- the bench picture

namespace {
const int STRIP_MARGIN = 16, STRIP_BLOCK = 24, STRIP_BITS = 16;
const int QUIET_W = STRIP_MARGIN * 2 + STRIP_BLOCK * STRIP_BITS, QUIET_H = STRIP_MARGIN * 2 + STRIP_BLOCK;
const int NOISE = 128;

inline uint32_t Gray(int v) { return 0xFF000000u | ((uint32_t)v << 16) | ((uint32_t)v << 8) | (uint32_t)v; }
inline uint32_t Bgra(int b, int g, int r) { return 0xFF000000u | ((uint32_t)r << 16) | ((uint32_t)g << 8) | (uint32_t)b; }
}  // namespace

void BenchPattern(uint64_t n, int w, int h, uint8_t* bgra, int stride) {
  const int scroll = (int)(n * 3 % 64);
  const double cx = w / 2.0 + (w / 2.0 - 60) * std::sin(n * 0.071), cy = h / 2.0 + (h / 2.0 - 60) * std::sin(n * 0.113);
  const int r = 28;
  // Checker + grid + gradient, with a mild tint per checker cell (what the harness put in the chroma planes).
  for (int y = 0; y < h; y++) {
    uint32_t* row = reinterpret_cast<uint32_t*>(bgra + (size_t)y * stride);
    const int cy64 = (y / 64) & 1;
    const int gradient = y * 40 / h;
    const bool grid_row = (y & 63) == 0;
    for (int x = 0; x < w; x++) {
      const int xs = x + scroll;
      const bool cell = ((((xs / 64) & 1) ^ cy64) != 0);
      int v = 48 + gradient + (cell ? 36 : 0);
      if (grid_row || (xs & 63) == 0) v = 200;
      row[x] = cell ? Bgra(std::min(255, v + 12), v, std::max(0, v - 8)) : Bgra(std::max(0, v - 10), v, std::min(255, v + 10));
    }
  }
  // Ball: bright, red-ish, fast, with a dark rim.
  for (int y = std::max(0, (int)cy - r); y <= std::min(h - 1, (int)cy + r); y++) {
    uint32_t* row = reinterpret_cast<uint32_t*>(bgra + (size_t)y * stride);
    for (int x = std::max(0, (int)cx - r); x <= std::min(w - 1, (int)cx + r); x++) {
      const double d = std::hypot(x - cx, y - cy);
      if (d > r) continue;
      row[x] = d > r - 3 ? Gray(16) : Bgra(40, 60, 240);
    }
  }
  // Noise block, bottom right: fresh pseudo-random every frame.
  uint32_t rng = (uint32_t)(n * 2654435761u + 0x9e3779b9u) | 1u;
  for (int y = h - 16 - NOISE; y < h - 16; y++) {
    uint32_t* row = reinterpret_cast<uint32_t*>(bgra + (size_t)y * stride);
    for (int x = w - 16 - NOISE; x < w - 16; x++) {
      rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5;
      row[x] = Gray(16 + (int)(((rng >> 8) & 0xFF) * 200 / 255));
    }
  }
  // Quiet zone + counter strip, top left.
  if (w >= QUIET_W && h >= QUIET_H) {
    for (int y = 0; y < QUIET_H; y++) {
      uint32_t* row = reinterpret_cast<uint32_t*>(bgra + (size_t)y * stride);
      for (int x = 0; x < QUIET_W; x++) row[x] = Gray(128);
    }
    for (int i = 0; i < STRIP_BITS; i++) {
      const int bit = (int)((n >> (STRIP_BITS - 1 - i)) & 1);
      for (int y = STRIP_MARGIN; y < STRIP_MARGIN + STRIP_BLOCK; y++) {
        uint32_t* row = reinterpret_cast<uint32_t*>(bgra + (size_t)y * stride) + STRIP_MARGIN + i * STRIP_BLOCK;
        for (int x = 0; x < STRIP_BLOCK; x++) row[x] = Gray(bit ? 235 : 16);
      }
    }
  }
}

int64_t ConvertBgraToNv12(const uint8_t* bgra, int stride, int width, int height, webrtc::NV12Buffer* dst) {
  const int64_t t0 = NowUs();
  libyuv::ARGBToNV12(bgra, stride, dst->MutableDataY(), dst->StrideY(), dst->MutableDataUV(), dst->StrideUV(), width, height);
  return NowUs() - t0;
}

// ---------------------------------------------------------------- the source

const char* SourceKindName(SourceConfig::Kind k) {
  switch (k) {
    case SourceConfig::Kind::kRing: return "ring";
    case SourceConfig::Kind::kBench: return "bench";
    default: return "none";
  }
}

Source::Source(FrameFn on_frame, StateFn on_state) : on_frame_(std::move(on_frame)), on_state_(std::move(on_state)) {}

Source::~Source() { Stop(); }

void Source::Configure(const SourceConfig& cfg) {
  Stop();
  {
    std::lock_guard<std::mutex> l(mu_);
    cfg_ = cfg;
    state_ = cfg.kind == SourceConfig::Kind::kNone ? "none" : (cfg.kind == SourceConfig::Kind::kRing ? "missing" : "ok");
    win_frames_ = win_convert_us_ = 0;
    win_start_us_ = NowUs();
  }
  if (cfg.kind == SourceConfig::Kind::kNone) return;
  const uint64_t gen = ++generation_;
  thread_ = std::thread([this, cfg, gen] { Run(cfg, gen); });
}

SourceConfig Source::config() const {
  std::lock_guard<std::mutex> l(mu_);
  return cfg_;
}

void Source::SetEnabled(bool on) { enabled_ = on; }

std::string Source::state() const {
  std::lock_guard<std::mutex> l(mu_);
  return state_;
}

void Source::SetState(const std::string& s) {
  {
    std::lock_guard<std::mutex> l(mu_);
    if (state_ == s) return;
    state_ = s;
  }
  LogLine("source: %s", s.c_str());
  if (on_state_) on_state_(s);
}

void Source::Count(int64_t convert_us) {
  std::lock_guard<std::mutex> l(mu_);
  win_frames_++;
  win_convert_us_ += convert_us;
  frames_total_++;
}

Source::Readout Source::Snapshot() {
  std::lock_guard<std::mutex> l(mu_);
  Readout r;
  const int64_t now = NowUs();
  const double secs = (now - win_start_us_) / 1e6;
  r.fps_in = secs > 0 ? win_frames_ / secs : 0;
  r.convert_us = win_frames_ ? (double)win_convert_us_ / win_frames_ : 0;
  r.frames_total = frames_total_;
  r.skipped_total = skipped_total_.load();
  win_frames_ = win_convert_us_ = 0;
  win_start_us_ = now;
  return r;
}

void Source::Stop() {
  ++generation_;
  if (thread_.joinable()) thread_.join();
}

void Source::Run(SourceConfig cfg, uint64_t gen) {
  auto live = [&] { return generation_.load() == gen; };
  if (cfg.kind == SourceConfig::Kind::kBench) {
    const int stride = cfg.width * 4;
    std::vector<uint8_t> bgra((size_t)stride * cfg.height);
    const int64_t period_us = 1000000 / std::max(1, cfg.fps);
    const int64_t t0 = NowUs();
    for (uint64_t n = 0; live(); n++) {
      const int64_t due = t0 + (int64_t)n * period_us;
      for (;;) {
        const int64_t wait = due - NowUs();
        if (wait <= 0) break;
        std::this_thread::sleep_for(std::chrono::microseconds(std::min<int64_t>(wait, 2000)));
        if (!live()) return;
      }
      if (!enabled_) continue;
      BenchPattern(n, cfg.width, cfg.height, bgra.data(), stride);
      auto buf = webrtc::NV12Buffer::Create(cfg.width, cfg.height);
      const int64_t conv = ConvertBgraToNv12(bgra.data(), stride, cfg.width, cfg.height, buf.get());
      Count(conv);
      on_frame_(buf, due);
    }
    return;
  }
  // The send ring, the layer as its producer.
  RingConsumer ring;
  std::string err, last_err;
  int64_t next_open_us = 0;
  while (live()) {
    if (!ring.open()) {
      const int64_t now = NowUs();
      if (now < next_open_us) {
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
        continue;
      }
      next_open_us = now + 500000;
      if (ring.Open("send", cfg.token, &err)) {
        LogLine("source: send ring %s open", cfg.token.c_str());
        SetState("ok");
        last_err.clear();
      } else {
        if (err != "missing" && err != last_err) {
          LogLine("source: send ring %s: %s", cfg.token.c_str(), err.c_str());
          last_err = err;
        }
        if (state() != "dead") SetState("missing");
      }
      continue;
    }
    RingConsumer::Frame f;
    if (ring.Acquire(100, &f)) {
      if (enabled_) {
        auto buf = webrtc::NV12Buffer::Create((int)f.width, (int)f.height);
        const int64_t conv = ConvertBgraToNv12(f.bgra, (int)f.stride, (int)f.width, (int)f.height, buf.get());
        const bool intact = ring.Release();  // the producer lapped us mid-conversion: the picture is void
        Count(conv);
        if (intact) on_frame_(buf, f.pts_us);
      } else {
        ring.Release();
        Count(0);
      }
      skipped_total_ = ring.frames_skipped();
    } else if (!ring.ProducerAlive()) {
      LogLine("source: send ring %s: producer silent for 3 s", cfg.token.c_str());
      SetState("dead");
      ring.Close();
      next_open_us = NowUs() + 500000;
    }
  }
}
