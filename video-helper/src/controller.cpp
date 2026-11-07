#include "controller.h"

#include <algorithm>

#include "ladder.h"

RungController::RungController(ControllerConfig cfg) : cfg_(cfg) {}

ControllerDecision RungController::Change(int rung, const std::string& reason, int64_t now_ms) {
  ControllerDecision d;
  d.rung = ClampRung(rung);
  d.reason = reason;
  d.changed = d.rung != rung_;
  rung_ = d.rung;
  if (d.changed) {
    last_change_ms_ = now_ms;
    trouble_since_ms_ = 0;
    clean_since_ms_ = now_ms;  // the 30 s count up from the change itself (a trouble sample resets it)
  }
  return d;
}

// The trouble kinds present in this sample, in the order they are reported; `full` = fps and receiver inputs count
// too (after the grace). Empty when clean.
std::string RungController::TroubleIn(const ControllerInputs& in, bool full) const {
  std::string t;
  auto add = [&](const char* k) { t += (t.empty() ? "" : ","); t += k; };
  if (in.loss_pct && *in.loss_pct > cfg_.loss_pct) add("loss");
  if (in.rtt_ms && !rtt_.empty()) {
    double mn = rtt_.front().second;
    for (const auto& p : rtt_) mn = std::min(mn, p.second);
    if (*in.rtt_ms > mn + cfg_.rtt_delta_ms) add("rtt");
  }
  const int kbps = RungKbps(rung_);
  if (in.bwe_kbps && *in.bwe_kbps < cfg_.bwe_ratio * kbps) add("bwe");
  if (full) {
    double want_fps = RungFps(rung_);
    if (in.source_fps > 0) want_fps = std::min(want_fps, in.source_fps);
    if (in.sent_fps && *in.sent_fps < cfg_.fps_ratio * want_fps) add("fps");
    const bool dec_low = in.decode_fps && *in.decode_fps < cfg_.fps_ratio * want_fps;
    const bool froze = in.freeze_ms && *in.freeze_ms > cfg_.freeze_ms;
    if (dec_low || froze) add("receiver");
  }
  return t;
}

ControllerDecision RungController::Step(const ControllerInputs& in) {
  const int64_t now = in.now_ms;
  const int ceiling = CeilingRung(in.max_kbps);

  // The pin: the controller is off; the rung is the pin, bounded by the ceiling.
  if (in.pin) {
    pinned_ = true;
    phase_ = Phase::kRun;  // when the pin clears, the rung carries on from here: no second probe
    trouble_.clear();
    rtt_.clear();
    const int want = std::max(ClampRung(*in.pin), ceiling);
    return Change(want, want == ClampRung(*in.pin) ? "pin" : "ceiling", now);
  }
  const bool unpinned = pinned_;
  pinned_ = false;

  // Not sending: nothing is measured; the next stint starts from the rung we hold (or the probe, the first time).
  if (!in.sending) {
    was_sending_ = false;
    trouble_.clear();
    rtt_.clear();
    trouble_since_ms_ = clean_since_ms_ = 0;
    if (rung_ == 0) return Change(std::max(cfg_.probe_rung, ceiling), "start", now);
    if (rung_ < ceiling) return Change(ceiling, "ceiling", now);
    return ControllerDecision{false, rung_, ""};
  }

  // A stint begins.
  if (!was_sending_) {
    was_sending_ = true;
    stint_start_ms_ = now;
    trouble_since_ms_ = clean_since_ms_ = 0;
    rtt_.clear();
    if (!ever_sent_ && !unpinned) {
      ever_sent_ = true;
      phase_ = Phase::kProbe;
      probe_start_ms_ = now;
      const int want = std::max(cfg_.probe_rung, ceiling);
      ControllerDecision d = Change(want, "probe", now);
      d.changed = true;  // the probe's start is always reported
      last_change_ms_ = now;
      return d;
    }
    ever_sent_ = true;
    if (phase_ == Phase::kStart) phase_ = Phase::kRun;
  }

  // The RTT minimum's window.
  if (in.rtt_ms) {
    rtt_.emplace_back(now, *in.rtt_ms);
    while (!rtt_.empty() && now - rtt_.front().first > cfg_.rtt_window_ms) rtt_.pop_front();
  }

  // The ceiling bounds the rung at all times.
  if (rung_ < ceiling) return Change(ceiling, "ceiling", now);

  const bool full = phase_ == Phase::kProbe || now - stint_start_ms_ >= cfg_.grace_ms;
  trouble_ = TroubleIn(in, full);

  // Down: 3 s of continuous trouble (any kind), in every phase.
  if (!trouble_.empty()) {
    clean_since_ms_ = 0;
    if (trouble_since_ms_ == 0) trouble_since_ms_ = now;
    if (now - trouble_since_ms_ >= cfg_.down_ms) {
      const std::string first = trouble_.substr(0, trouble_.find(','));
      if (phase_ == Phase::kProbe) phase_ = Phase::kRun;  // a link that cannot hold the probe rung: no jump after it
      if (rung_ >= kRungCount) {
        trouble_since_ms_ = now;  // already at the bottom: keep counting, nothing to do
        return ControllerDecision{false, rung_, ""};
      }
      return Change(rung_ + 1, "down:" + first, now);
    }
    return ControllerDecision{false, rung_, ""};
  }
  trouble_since_ms_ = 0;
  if (clean_since_ms_ == 0) clean_since_ms_ = now;

  // The probe's end: jump to the highest rung the estimate affords at 1.2× (bounded by the ceiling).
  if (phase_ == Phase::kProbe) {
    if (now - probe_start_ms_ < cfg_.probe_ms) return ControllerDecision{false, rung_, ""};
    phase_ = Phase::kRun;
    if (!in.bwe_kbps) return ControllerDecision{false, rung_, ""};  // no estimate yet: the 30 s rule takes over
    const int want = RungForBudget(static_cast<int>(*in.bwe_kbps / cfg_.up_bwe_ratio), ceiling);
    if (want != rung_) return Change(want, "probe", now);
    return ControllerDecision{false, rung_, ""};
  }

  // Up: 30 s clean since the last change and the estimate covers the next rung at 1.2×.
  if (rung_ > ceiling && now - std::max(last_change_ms_, clean_since_ms_) >= cfg_.up_ms && in.bwe_kbps &&
      *in.bwe_kbps >= cfg_.up_bwe_ratio * RungKbps(rung_ - 1))
    return Change(rung_ - 1, "up", now);
  return ControllerDecision{false, rung_, ""};
}
