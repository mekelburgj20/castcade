#include "sink.h"

#include "libyuv/convert_argb.h"

#include "util.h"

const char* SinkKindName(SinkConfig::Kind k) {
  switch (k) {
    case SinkConfig::Kind::kRing: return "ring";
    case SinkConfig::Kind::kWindow: return "window";
    default: return "none";
  }
}

bool Sink::Configure(const SinkConfig& cfg, std::string* error) {
  std::lock_guard<std::mutex> l(mu_);
  ring_.Close();
  // Closing the window joins its thread; its `closed` callback never takes mu_ (it only forwards to the session), so
  // holding mu_ here cannot deadlock with a user close that races this command.
  if (window_) {
    window_->Close();
    window_.reset();
  }
  cfg_ = cfg;
  warned_size_ = false;
  if (cfg.kind == SinkConfig::Kind::kRing) {
    if (!ring_.Create("recv", cfg.token, cfg.max_width, cfg.max_height, error)) {
      cfg_.kind = SinkConfig::Kind::kNone;
      return false;
    }
    LogLine("sink: recv ring %s created (%ux%u box)", cfg.token.c_str(), cfg.max_width, cfg.max_height);
  } else if (cfg.kind == SinkConfig::Kind::kWindow) {
    auto w = std::make_unique<WindowSink>();
    WindowSink* raw = w.get();
    WindowEventFn ev = window_event_;
    if (!w->Open(cfg.window, [ev, raw](const WindowPlacement& last) {
          LogLine("sink: window closed by the user");
          if (ev) ev("closed", last, raw->driver());
        }, error)) {
      cfg_.kind = SinkConfig::Kind::kNone;
      return false;
    }
    window_ = std::move(w);
    if (window_event_) window_event_("open", window_->placement(), window_->driver());
  } else {
    LogLine("sink: %s", SinkKindName(cfg.kind));
  }
  win_start_us_ = NowUs();
  return true;
}

SinkConfig Sink::config() {
  std::lock_guard<std::mutex> l(mu_);
  if (cfg_.kind == SinkConfig::Kind::kWindow && window_ && !window_->alive()) cfg_.kind = SinkConfig::Kind::kNone;
  return cfg_;
}

void Sink::OnDecoded(const DecodedPicture& p, int64_t dec_us) {
  std::lock_guard<std::mutex> l(mu_);
  width_ = p.width;
  height_ = p.height;
  int64_t conv = 0;
  // One conversion, into whichever sink is on: the ring slot or the window's pending buffer.
  uint8_t* dst = nullptr;
  uint32_t stride = 0;
  bool to_ring = false, to_window = false;
  if (cfg_.kind == SinkConfig::Kind::kRing && ring_.open()) {
    if (!ring_.Begin((uint32_t)p.width, (uint32_t)p.height, &dst, &stride)) {
      dst = nullptr;
      dropped_++;
      if (!warned_size_) {
        warned_size_ = true;
        LogLine("sink: decoded %dx%d does not fit the recv ring's %ux%u box: dropping (a new sink command with a bigger box fixes it)",
                p.width, p.height, ring_.maxWidth(), ring_.maxHeight());
      }
    } else {
      to_ring = true;
    }
  } else if (cfg_.kind == SinkConfig::Kind::kWindow && window_) {
    to_window = window_->Begin((uint32_t)p.width, (uint32_t)p.height, &dst, &stride);
    if (!to_window) dst = nullptr;
  }
  if (dst) {
    const int64_t t0 = NowUs();
    if (p.nv12) libyuv::NV12ToARGB(p.y, p.stride_y, p.uv, p.stride_uv, dst, (int)stride, p.width, p.height);
    else libyuv::I420ToARGB(p.y, p.stride_y, p.uv, p.stride_uv, p.v, p.stride_v, dst, (int)stride, p.width, p.height);
    conv = NowUs() - t0;
    if (to_ring) ring_.Commit(NowUs());
    if (to_window) window_->Commit();
  }
  win_frames_++;
  win_convert_us_ += conv;
  win_dec_us_ += dec_us;
  frames_total_++;
}

Sink::Readout Sink::Snapshot() {
  std::lock_guard<std::mutex> l(mu_);
  Readout r;
  const int64_t now = NowUs();
  const double secs = win_start_us_ ? (now - win_start_us_) / 1e6 : 0;
  r.fps = secs > 0 ? win_frames_ / secs : 0;
  r.convert_us = win_frames_ ? (double)win_convert_us_ / win_frames_ : 0;
  r.dec_us = win_frames_ ? (double)win_dec_us_ / win_frames_ : 0;
  r.width = width_;
  r.height = height_;
  r.frames_total = frames_total_;
  r.dropped_too_big = dropped_;
  if (window_) {
    const WindowSink::Readout w = window_->Snapshot();
    r.presented_fps = secs > 0 ? w.presented / secs : 0;
    r.present_us = w.present_us;
  }
  win_frames_ = win_convert_us_ = win_dec_us_ = 0;
  win_start_us_ = now;
  return r;
}
