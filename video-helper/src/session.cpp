// castcade-video: the stdio protocol loop (§6.2, README.md): the commands from the companion on stdin, the events on
// stdout, the peers, the source and the sink it owns, and the 1 Hz stats. One helper per companion; it exits 0 on
// `quit` or stdin EOF.

#include <algorithm>
#include <chrono>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <thread>

#include "codecs.h"
#include "controller.h"
#include "ipc.h"
#include "json.h"
#include "ladder.h"
#include "peer.h"
#include "sink.h"
#include "source.h"
#include "util.h"

namespace {

// D10.5: the controller's sampling period and how long the receiver's last feedback counts as current.
const int kControlTickMs = 200;
const int64_t kFeedbackFreshUs = 3000000;

class Session {
 public:
  explicit Session(const ProbeResult& probe) : probe_(probe) {}

  int Run() {
    CodecOptions codecs;
    codecs.encoder = probe_.encoder;
    codecs.decoder = probe_.decoder;
    codecs.policy = RatePolicy::kLimited;
    codecs.sink = &sink_;
    std::string err;
    if (!pf_.Init(codecs, false, &err)) {
      LogLine("libwebrtc did not start: %s", err.c_str());
      return 2;
    }
    source_ = std::make_unique<Source>(
        [this](const webrtc::scoped_refptr<webrtc::NV12Buffer>& buf, int64_t) { pf_.PushFrame(buf); },
        [this](const std::string& state) { EmitSource(state); });
    {
      Json j = Json::Object();
      j.Set("event", Json::String("ready")).Set("version", Json::String(CASTCADE_VIDEO_VERSION));
      j.Set("encoder", Json::String(probe_.encoder)).Set("decoder", Json::String(probe_.decoder));
      ipc_.Emit(j);
    }
    LogLine("castcade-video %s ready: encoder %s, decoder %s", CASTCADE_VIDEO_VERSION, probe_.encoder.c_str(), probe_.decoder.c_str());
    stats_thread_ = std::thread([this] { StatsLoop(); });

    std::string line;
    while (!quit_ && ipc_.ReadLine(&line)) {
      std::string perr;
      Json cmd = Json::Parse(line, &perr);
      if (!cmd.is_object()) {
        ipc_.EmitError("bad_command", "not a JSON object: " + perr);
        continue;
      }
      Handle(cmd);
      if (ipc_.stdout_broken()) break;
    }
    LogLine(quit_ ? "quit: closing" : "stdin closed: closing");
    Shutdown();
    return 0;
  }

 private:
  void Handle(const Json& c) {
    const std::string cmd = c.GetString("cmd");
    if (cmd == "ice") return CmdIce(c);
    if (cmd == "peer") return CmdPeer(c);
    if (cmd == "signal") return CmdSignal(c);
    if (cmd == "close") return CmdClose(c);
    if (cmd == "source") return CmdSource(c);
    if (cmd == "send") return CmdSend(c);
    if (cmd == "rungs") return CmdRungs(c);
    if (cmd == "sink") return CmdSink(c);
    if (cmd == "quit") { quit_ = true; return; }
    ipc_.EmitError("bad_command", cmd.empty() ? "no cmd" : "unknown cmd " + cmd);
  }

  void CmdIce(const Json& c) {
    const Json* servers = c.Get("servers");
    if (!servers || !servers->is_array()) return ipc_.EmitError("bad_command", "ice: servers must be an array");
    std::vector<IceServerSpec> out;
    for (const Json& s : servers->items()) {
      if (!s.is_object()) continue;
      IceServerSpec spec;
      const Json* urls = s.Get("urls");
      if (urls && urls->is_string()) spec.urls.push_back(urls->as_string());
      else if (urls && urls->is_array())
        for (const Json& u : urls->items()) if (u.is_string()) spec.urls.push_back(u.as_string());
      spec.username = s.GetString("username");
      spec.credential = s.GetString("credential");
      if (!spec.urls.empty()) out.push_back(spec);
    }
    std::string summary;
    for (const auto& s : out) for (const auto& u : s.urls) summary += (summary.empty() ? "" : " ") + u.substr(0, u.find('?'));
    LogLine("ice: %zu servers (%s)", out.size(), summary.c_str());
    std::lock_guard<std::mutex> l(mu_);
    ice_ = std::move(out);
  }

  void CmdPeer(const Json& c) {
    const std::string id = c.GetString("id");
    const Json* init = c.Get("initiator");
    if (id.empty() || !init || !init->is_bool()) return ipc_.EmitError("bad_command", "peer: id and initiator required");
    std::shared_ptr<Peer> old;
    std::shared_ptr<Peer> peer;
    PeerLimits limits;
    limits.max_kbps = EffectiveMaxKbps();
    {
      std::lock_guard<std::mutex> l(mu_);
      auto it = peers_.find(id);
      if (it != peers_.end()) {
        old = it->second;
        peers_.erase(it);
      }
      PeerEvents ev;
      ev.on_sdp = [this](const std::string& id, const std::string& kind, const std::string& sdp) {
        Json j = Json::Object();
        j.Set("event", Json::String("signal")).Set("id", Json::String(id)).Set("kind", Json::String(kind)).Set("sdp", Json::String(sdp));
        ipc_.Emit(j);
      };
      ev.on_candidate = [this](const std::string& id, const std::string& cand, const std::string& mid, int mline) {
        Json cj = Json::Object();
        cj.Set("candidate", Json::String(cand)).Set("sdpMid", Json::String(mid)).Set("sdpMLineIndex", Json::Int(mline));
        Json j = Json::Object();
        j.Set("event", Json::String("signal")).Set("id", Json::String(id)).Set("kind", Json::String("ice")).Set("candidate", cj);
        ipc_.Emit(j);
      };
      ev.on_ice = [this](const std::string& id, const std::string& state, const Json& pair) {
        Json j = Json::Object();
        j.Set("event", Json::String("peer")).Set("id", Json::String(id)).Set("ice", Json::String(state));
        if (pair.is_object()) j.Set("pair", pair);
        ipc_.Emit(j);
      };
      ev.on_error = [this](const std::string& id, const std::string& code, const std::string& text) {
        Json j = Json::Object();
        j.Set("event", Json::String("error")).Set("code", Json::String(code)).Set("id", Json::String(id)).Set("text", Json::String(text));
        ipc_.Emit(j);
        LogLine("peer %s: %s: %s", id.c_str(), code.c_str(), text.c_str());
      };
      peer = std::make_shared<Peer>(pf_, id, init->as_bool(), ice_, limits, ev);
      peers_[id] = peer;
    }
    if (old) {
      LogLine("peer %s: replaced", id.c_str());
      old->Close();
    }
    std::string err;
    if (!peer->Start(&err)) {
      std::lock_guard<std::mutex> l(mu_);
      peers_.erase(id);
      Json j = Json::Object();
      j.Set("event", Json::String("error")).Set("code", Json::String("peer_failed")).Set("id", Json::String(id)).Set("text", Json::String(err));
      ipc_.Emit(j);
      return;
    }
    peer->SetSendActive(send_on_);
    InitRung(*peer);
  }

  std::shared_ptr<Peer> Find(const std::string& id) {
    std::lock_guard<std::mutex> l(mu_);
    auto it = peers_.find(id);
    return it == peers_.end() ? nullptr : it->second;
  }

  void CmdSignal(const Json& c) {
    const std::string id = c.GetString("id"), kind = c.GetString("kind");
    auto peer = Find(id);
    if (!peer) return ipc_.EmitError("peer_unknown", "signal for unknown peer " + id);
    if (kind == "offer" || kind == "answer") {
      const std::string sdp = c.GetString("sdp");
      if (sdp.empty()) return ipc_.EmitError("bad_command", "signal: sdp missing");
      peer->OnRemoteSdp(kind, sdp);
    } else if (kind == "ice") {
      const Json* cand = c.Get("candidate");
      if (!cand || !cand->is_object()) return ipc_.EmitError("bad_command", "signal: candidate missing");
      const std::string s = cand->GetString("candidate");
      if (s.empty()) return;  // end-of-candidates from a browser-shaped sender: nothing to add
      peer->OnRemoteCandidate(s, cand->GetString("sdpMid"), cand->GetInt("sdpMLineIndex", 0));
    } else {
      ipc_.EmitError("bad_command", "signal: kind is offer, answer or ice");
    }
  }

  void CmdClose(const Json& c) {
    const std::string id = c.GetString("id");
    std::shared_ptr<Peer> peer;
    {
      std::lock_guard<std::mutex> l(mu_);
      auto it = peers_.find(id);
      if (it == peers_.end()) {
        ipc_.EmitError("peer_unknown", "close for unknown peer " + id);
        return;
      }
      peer = it->second;
      peers_.erase(it);
    }
    peer->Close();
    LogLine("peer %s: closed", id.c_str());
    Json j = Json::Object();
    j.Set("event", Json::String("peer")).Set("id", Json::String(id)).Set("ice", Json::String("closed"));
    ipc_.Emit(j);
  }

  void CmdSource(const Json& c) {
    const std::string kind = c.GetString("kind");
    SourceConfig cfg;
    if (kind == "ring") cfg.kind = SourceConfig::Kind::kRing;
    else if (kind == "bench") cfg.kind = SourceConfig::Kind::kBench;
    else if (kind == "none") cfg.kind = SourceConfig::Kind::kNone;
    else return ipc_.EmitError("bad_command", "source: kind is ring, bench or none");
    cfg.token = c.GetString("token");
    cfg.width = c.GetInt("width", 1354);
    cfg.height = c.GetInt("height", 1440);
    cfg.fps = c.GetInt("fps", 60);
    if (cfg.kind == SourceConfig::Kind::kRing && cfg.token.empty()) return ipc_.EmitError("bad_command", "source ring: token missing");
    if (cfg.kind == SourceConfig::Kind::kBench && (cfg.width < 480 || cfg.height < 300 || (cfg.width & 1) || (cfg.height & 1) || cfg.fps < 1 || cfg.fps > 120))
      return ipc_.EmitError("bad_command", "source bench: bad width / height / fps");
    LogLine("source: %s%s %dx%d @%d", kind.c_str(), cfg.token.empty() ? "" : (" " + cfg.token).c_str(), cfg.width, cfg.height, cfg.fps);
    source_->Configure(cfg);
    source_->SetEnabled(send_on_);
    EmitSource(source_->state());
  }

  void CmdSend(const Json& c) {
    const Json* on = c.Get("on");
    if (!on || !on->is_bool()) return ipc_.EmitError("bad_command", "send: on must be a bool");
    send_on_ = on->as_bool();
    LogLine("send %s", send_on_ ? "on" : "off");
    source_->SetEnabled(send_on_);
    for (auto& p : Peers()) p->SetSendActive(send_on_);
  }

  void CmdRungs(const Json& c) {
    const Json* max = c.Get("max_kbps");
    if (!max || !max->is_number() || max->as_number() <= 0) return ipc_.EmitError("bad_command", "rungs: max_kbps must be a positive number");
    const Json* pin = c.Get("pin");
    std::optional<int> pinned;
    if (pin && pin->is_number()) {
      const int r = static_cast<int>(pin->as_number());
      if (r < 1 || r > 6) return ipc_.EmitError("bad_command", "rungs: pin is 1..6");
      pinned = r;
    }
    {
      std::lock_guard<std::mutex> l(mu_);
      max_kbps_ = static_cast<int>(max->as_number());
      pin_ = pinned;
    }
    const int eff = EffectiveMaxKbps();
    LogLine("rungs: ceiling %d kbps (rung %d or below)%s", eff, CeilingRung(eff), pinned ? (", pin " + std::to_string(*pinned)).c_str() : ", auto");
    for (auto& p : Peers()) {
      p->SetMaxKbps(eff);
      StepController(*p, StatsSnapshot{}, NowUs() / 1000);  // the pin or the ceiling applies now, not at the next tick
    }
  }

  void CmdSink(const Json& c) {
    const std::string kind = c.GetString("kind");
    SinkConfig cfg;
    if (kind == "ring") cfg.kind = SinkConfig::Kind::kRing;
    else if (kind == "window") return ipc_.EmitError("not_yet", "window");
    else if (kind == "none") cfg.kind = SinkConfig::Kind::kNone;
    else return ipc_.EmitError("bad_command", "sink: kind is ring, window or none");
    cfg.token = c.GetString("token");
    if (c.Has("width")) cfg.max_width = static_cast<uint32_t>(c.GetInt("width", 2048));
    if (c.Has("height")) cfg.max_height = static_cast<uint32_t>(c.GetInt("height", 2048));
    if (cfg.kind == SinkConfig::Kind::kRing && cfg.token.empty()) return ipc_.EmitError("bad_command", "sink ring: token missing");
    std::string err;
    if (!sink_.Configure(cfg, &err)) ipc_.EmitError("ring_open_failed", "recv ring " + cfg.token + ": " + err);
  }

  // The ceiling: libwebrtc's max_bitrate_bps. The pin is the controller's business (the encoder's clamp is the
  // rung's kbps, below this), so the stack's estimate keeps room to probe above the rung.
  int EffectiveMaxKbps() {
    std::lock_guard<std::mutex> l(mu_);
    return max_kbps_;
  }

  // ---- D10.5: the ladder and the controller, per sending peer ----

  // A new peer's first rung before any measurement: the pin, else rung 3 (the probe's), bounded by the ceiling.
  void InitRung(Peer& peer) { StepController(peer, StatsSnapshot{}, NowUs() / 1000); }

  // One controller sample for a peer: the inputs from the stats snapshot (an invalid one = no stats yet), the
  // source's fps, the receiver's feedback, the pin and the ceiling; the decision goes to the peer's RungTarget and,
  // on a change, out as a `rung` event. Runs on the signaling thread (GetStats callbacks) or the stdin thread
  // (`rungs`, `peer`): the controller itself is only ever stepped under the session lock.
  void StepController(Peer& peer, const StatsSnapshot& s, int64_t now_ms) {
    std::lock_guard<std::mutex> l(ctrl_mu_);
    ControllerInputs in;
    in.now_ms = now_ms;
    in.sending = send_on_ && peer.connected();
    in.source_fps = source_ ? source_->last_fps_in() : 0;
    if (in.sending != peer.ctrl_sending) {
      peer.ctrl_sending = in.sending;
      peer.ctrl_win.clear();
    }
    if (s.valid) {
      peer.ctrl_win.emplace_back(now_ms, s.frames_sent);
      while (peer.ctrl_win.size() > 1 && now_ms - peer.ctrl_win.front().first > 1100) peer.ctrl_win.pop_front();
      const int64_t span = peer.ctrl_win.back().first - peer.ctrl_win.front().first;
      if (span >= 800) in.sent_fps = (static_cast<double>(peer.ctrl_win.back().second) - peer.ctrl_win.front().second) * 1000.0 / span;
      if (s.fraction_lost) in.loss_pct = *s.fraction_lost * 100;
      if (s.rtt_s) in.rtt_ms = *s.rtt_s * 1000;
      if (s.available_outgoing_bitrate_bps) in.bwe_kbps = *s.available_outgoing_bitrate_bps / 1000;
    }
    const PeerFeedback fb = peer.feedback();
    if (fb.at_us && NowUs() - fb.at_us < kFeedbackFreshUs) {
      in.decode_fps = fb.decode_fps;
      in.freeze_ms = fb.freeze_ms;
    }
    {
      std::lock_guard<std::mutex> l2(mu_);
      in.pin = pin_;
      in.max_kbps = max_kbps_;
    }
    const ControllerDecision d = peer.ctrl.Step(in);
    if (d.rung <= 0) return;
    const SourceConfig cfg = source_ ? source_->config() : SourceConfig{};
    const RungGeometry g = RungFor(d.rung, cfg.width, cfg.height);
    if (d.changed || g != peer.applied) {
      peer.target()->Set(g.rung, g.fps, g.kbps);
      peer.applied = g;
      EmitRung(peer, g, d.reason.empty() ? "start" : d.reason);
    }
  }

  void EmitRung(Peer& peer, const RungGeometry& g, const std::string& reason) {
    Json j = Json::Object();
    j.Set("event", Json::String("rung")).Set("id", Json::String(peer.id())).Set("rung", Json::Int(g.rung));
    j.Set("width", Json::Int(g.width)).Set("height", Json::Int(g.height)).Set("fps", Json::Int(g.fps)).Set("kbps", Json::Int(g.kbps));
    j.Set("reason", Json::String(reason));
    ipc_.Emit(j);
    LogLine("peer %s: rung %d (%dx%d @%d, %d kbps): %s", peer.id().c_str(), g.rung, g.width, g.height, g.fps, g.kbps, reason.c_str());
  }

  std::vector<std::shared_ptr<Peer>> Peers() {
    std::lock_guard<std::mutex> l(mu_);
    std::vector<std::shared_ptr<Peer>> v;
    for (auto& kv : peers_) v.push_back(kv.second);
    return v;
  }

  void EmitSource(const std::string& state) {
    const SourceConfig cfg = source_->config();
    const Source::Readout r = source_->Snapshot();
    Json j = Json::Object();
    j.Set("event", Json::String("source")).Set("kind", Json::String(SourceKindName(cfg.kind))).Set("state", Json::String(state));
    j.Set("fps_in", Json::Number(std::round(r.fps_in * 10) / 10)).Set("convert_us", Json::Int(static_cast<int64_t>(r.convert_us)));
    if (r.skipped_total) j.Set("skipped", Json::Int(r.skipped_total));
    ipc_.Emit(j);
  }

  // Every 100 ms; every second tick samples the controller for each peer (one GetStats, D10.5), every tenth also
  // emits the 1 Hz `stats` and `source` events from the same snapshot.
  void StatsLoop() {
    int tick = 0;
    while (!stop_stats_) {
      std::this_thread::sleep_for(std::chrono::milliseconds(100));
      if (++tick % (kControlTickMs / 100) != 0) continue;
      const bool emit = tick >= 10;
      if (emit) tick = 0;
      Sink::Readout sr;
      SinkConfig scfg;
      if (emit) {
        if (source_ && source_->config().kind != SourceConfig::Kind::kNone) EmitSource(source_->state());
        sr = sink_.Snapshot();
        scfg = sink_.config();
      }
      for (auto& p : Peers()) {
        std::weak_ptr<Peer> weak = p;
        p->GetStats([this, weak, sr, scfg, emit](const StatsSnapshot& s) {
          auto peer = weak.lock();
          if (!peer) return;
          StepController(*peer, s, NowUs() / 1000);
          if (emit) EmitStats(*peer, s, sr, scfg);
        });
      }
    }
  }

  void EmitStats(Peer& peer, const StatsSnapshot& s, const Sink::Readout& sr, const SinkConfig& scfg) {
    const StatsSnapshot& p = peer.prev;
    if (p.valid) {
      // send
      Json j = Json::Object();
      j.Set("event", Json::String("stats")).Set("id", Json::String(peer.id())).Set("dir", Json::String("send"));
      j.Set("fps", Json::Int(static_cast<int64_t>(s.frames_sent) - p.frames_sent));
      j.Set("kbps", Json::Int(static_cast<int64_t>(((s.bytes_sent + s.header_bytes_sent) - (p.bytes_sent + p.header_bytes_sent)) * 8 / 1000)));
      j.Set("width", Json::Int(s.out_width)).Set("height", Json::Int(s.out_height));
      if (s.rtt_s) j.Set("rtt_ms", Json::Number(std::round(*s.rtt_s * 10000) / 10));
      if (s.fraction_lost) j.Set("loss_pct", Json::Number(std::round(*s.fraction_lost * 1000) / 10));
      if (s.available_outgoing_bitrate_bps) j.Set("bwe_kbps", Json::Int(static_cast<int64_t>(*s.available_outgoing_bitrate_bps / 1000)));
      if (s.frames_encoded > p.frames_encoded)
        j.Set("enc_us", Json::Int(static_cast<int64_t>((s.total_encode_time_s - p.total_encode_time_s) * 1e6 / (s.frames_encoded - p.frames_encoded))));
      j.Set("target_kbps", Json::Int(static_cast<int64_t>(s.target_bitrate_bps / 1000)));
      if (!s.encoder_implementation.empty()) j.Set("encoder", Json::String(s.encoder_implementation));
      if (!s.quality_limitation_reason.empty()) j.Set("quality_limitation", Json::String(s.quality_limitation_reason));
      AddRungStats(peer, j);
      ipc_.Emit(j);
      // recv
      Json r = Json::Object();
      r.Set("event", Json::String("stats")).Set("id", Json::String(peer.id())).Set("dir", Json::String("recv"));
      r.Set("fps", Json::Int(static_cast<int64_t>(s.frames_decoded) - p.frames_decoded));
      r.Set("kbps", Json::Int(static_cast<int64_t>(((s.bytes_received + s.header_bytes_received) - (p.bytes_received + p.header_bytes_received)) * 8 / 1000)));
      // libwebrtc only sees the 16x16 bookkeeping frame: the size comes from the sink's last decoded picture.
      r.Set("width", Json::Int(sr.width)).Set("height", Json::Int(sr.height));
      if (s.frames_decoded > p.frames_decoded)
        r.Set("dec_us", Json::Int(static_cast<int64_t>((s.total_decode_time_s - p.total_decode_time_s) * 1e6 / (s.frames_decoded - p.frames_decoded))));
      r.Set("freeze_ms", Json::Int(static_cast<int64_t>((s.total_freezes_duration_s - p.total_freezes_duration_s) * 1000)));
      {
        const double lost = static_cast<double>(s.in_packets_lost - p.in_packets_lost);
        const double got = static_cast<double>(s.in_packets_received - p.in_packets_received);
        if (lost > 0 && got + lost > 0) r.Set("loss_pct", Json::Number(std::round(lost * 1000 / (got + lost)) / 10));
        else r.Set("loss_pct", Json::Number(0));
      }
      if (s.jitter_buffer_emitted_count > p.jitter_buffer_emitted_count)
        r.Set("jitter_ms", Json::Number(std::round((s.jitter_buffer_delay_s - p.jitter_buffer_delay_s) * 1e4 / (s.jitter_buffer_emitted_count - p.jitter_buffer_emitted_count)) / 10));
      if (!s.decoder_implementation.empty()) r.Set("decoder", Json::String(s.decoder_implementation));
      if (scfg.kind == SinkConfig::Kind::kRing) r.Set("conv_us", Json::Int(static_cast<int64_t>(sr.convert_us)));
      ipc_.Emit(r);
      // D10.5: what we see of their picture, back to them over the feedback channel (their controller's receiver inputs).
      peer.SendFeedback(static_cast<double>(s.frames_decoded) - p.frames_decoded, (s.total_freezes_duration_s - p.total_freezes_duration_s) * 1000,
                        s.frames_decoded > p.frames_decoded ? std::optional<double>(std::round(sr.fps * 10) / 10) : std::nullopt);
    }
    peer.prev = s;
  }

  // D10.5: the send stats' rung fields: the rung applied, the controller's state and the encoder's own counters.
  void AddRungStats(Peer& peer, Json& j) {
    const RungTarget::Readout r = peer.target()->Snapshot();
    const RungGeometry g = peer.applied;
    if (g.rung) j.Set("rung", Json::Int(g.rung)).Set("rung_kbps", Json::Int(g.kbps)).Set("rung_fps", Json::Int(g.fps));
    j.Set("queue_ms", Json::Number(std::round(r.queue_us_max / 100.0) / 10));
    if (r.frames_dropped) j.Set("dropped", Json::Int(r.frames_dropped));
    std::lock_guard<std::mutex> l(ctrl_mu_);
    if (peer.ctrl.pinned()) j.Set("ctrl", Json::String("pin"));
    else if (peer.ctrl.probing()) j.Set("ctrl", Json::String("probe"));
    else if (!peer.ctrl.trouble().empty()) j.Set("ctrl", Json::String("trouble:" + peer.ctrl.trouble()));
    else j.Set("ctrl", Json::String("auto"));
    const PeerFeedback fb = peer.feedback();
    if (fb.at_us && NowUs() - fb.at_us < kFeedbackFreshUs && fb.decode_fps) j.Set("peer_decode_fps", Json::Number(*fb.decode_fps));
  }

  void Shutdown() {
    stop_stats_ = true;
    if (stats_thread_.joinable()) stats_thread_.join();
    std::vector<std::shared_ptr<Peer>> peers = Peers();
    {
      std::lock_guard<std::mutex> l(mu_);
      peers_.clear();
    }
    for (auto& p : peers) p->Close();
    peers.clear();
    if (source_) source_->Stop();
    std::string err;
    sink_.Configure(SinkConfig{}, &err);
    pf_.Shutdown();
    source_.reset();
  }

  ProbeResult probe_;
  Ipc ipc_;
  PeerFactory pf_;
  Sink sink_;
  std::unique_ptr<Source> source_;
  std::mutex mu_;
  std::mutex ctrl_mu_;  // D10.5: the controllers are stepped one at a time
  std::map<std::string, std::shared_ptr<Peer>> peers_;
  std::vector<IceServerSpec> ice_;
  int max_kbps_ = 20000;
  std::optional<int> pin_;
  bool send_on_ = false;
  bool quit_ = false;
  std::atomic<bool> stop_stats_{false};
  std::thread stats_thread_;
};

}  // namespace

int RunProtocol(const ProbeResult& probe) {
  Session s(probe);
  return s.Run();
}
