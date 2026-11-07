// castcade-video: the rung controller (D10.5; docs/design/spectator-video-native.md §3 item 5), one per sending peer.
// A pure function of sampled inputs and its own state (no clock, no libwebrtc: `--controller-selftest` scripts it).
//
// Sampled every 200 ms: the sent fps against the rung's (bounded by what the source delivers), the RTCP receiver
// report's loss and RTT, the stack's bandwidth estimate (the selected pair's available outgoing bitrate), the
// receiver's decode fps and freeze time (over the castcade-feedback data channel; unknown when it is not open, and
// unknown never counts). Trouble = loss > 2 %, or RTT more than 100 ms above its 10 s minimum, or BWE < 0.9 × the
// rung's kbps, or sent fps < 0.9 × the rung's fps, or the receiver's decode fps < 0.9 × the rung's fps, or a receiver
// freeze > 500 ms in its last second.
//
// Rules: down one rung after 3 s of continuous trouble (any input); up one rung after 30 s clean when BWE ≥ 1.2 × the
// next rung's kbps. Start-up probe: the first 5 s of a peer's first sending stint run at rung 3, then the rung jumps
// to the highest whose kbps ≤ BWE / 1.2; later stints (the next ball) start where the last one ended, with a 2 s grace
// in which only loss, RTT and BWE count (the pipeline has to fill before fps and the receiver mean anything). A pin
// overrides everything (the controller is off until the pin is cleared); the ceiling (`max_kbps`) bounds the rung.
#pragma once

#include <cstdint>
#include <deque>
#include <optional>
#include <string>

struct ControllerConfig {
  int probe_rung = 3;
  int64_t probe_ms = 5000;
  int64_t down_ms = 3000;
  int64_t up_ms = 30000;
  int64_t grace_ms = 2000;       // after a later stint's send-on: fps and receiver inputs ignored
  int64_t rtt_window_ms = 10000;  // the RTT minimum's window
  double loss_pct = 2.0;
  double rtt_delta_ms = 100.0;
  double bwe_ratio = 0.9;        // trouble when BWE < bwe_ratio × rung kbps
  double fps_ratio = 0.9;
  double freeze_ms = 500.0;
  double up_bwe_ratio = 1.2;     // up when BWE ≥ up_bwe_ratio × the next rung's kbps
};

struct ControllerInputs {
  int64_t now_ms = 0;
  bool sending = false;              // send on and the peer connected: frames are flowing to this peer
  double source_fps = 0;             // what the source delivers (0 = unknown: the fps checks use the rung's fps alone)
  std::optional<double> sent_fps;    // frames sent in the last second (libwebrtc outbound-rtp)
  std::optional<double> loss_pct;    // remote-inbound-rtp fraction lost × 100
  std::optional<double> rtt_ms;      // remote-inbound-rtp round trip
  std::optional<double> bwe_kbps;    // the selected pair's available outgoing bitrate
  std::optional<double> decode_fps;  // the receiver's, over the feedback channel (unknown when it is not open or stale)
  std::optional<double> freeze_ms;   // the receiver's freeze time in its last second
  std::optional<int> pin;            // 1..6: the manual pin
  int max_kbps = 20000;              // the ceiling
};

struct ControllerDecision {
  bool changed = false;
  int rung = 0;
  // "probe" | "down:loss" | "down:rtt" | "down:bwe" | "down:fps" | "down:receiver" | "up" | "pin" | "ceiling" | "start"
  std::string reason;
};

class RungController {
 public:
  explicit RungController(ControllerConfig cfg = ControllerConfig());
  ControllerDecision Step(const ControllerInputs& in);
  int rung() const { return rung_; }
  bool pinned() const { return pinned_; }
  // For the readout: the trouble kinds in the last sample ("" when clean) and whether the probe is running.
  const std::string& trouble() const { return trouble_; }
  bool probing() const { return phase_ == Phase::kProbe; }

 private:
  enum class Phase { kStart, kProbe, kRun };
  std::string TroubleIn(const ControllerInputs& in, bool full) const;
  ControllerDecision Change(int rung, const std::string& reason, int64_t now_ms);

  ControllerConfig cfg_;
  int rung_ = 0;
  bool pinned_ = false;
  Phase phase_ = Phase::kStart;
  bool was_sending_ = false;
  bool ever_sent_ = false;
  int64_t stint_start_ms_ = 0, probe_start_ms_ = 0;
  int64_t trouble_since_ms_ = 0, clean_since_ms_ = 0, last_change_ms_ = 0;
  std::string trouble_;
  std::deque<std::pair<int64_t, double>> rtt_;  // (ms, rtt) within the window
};
