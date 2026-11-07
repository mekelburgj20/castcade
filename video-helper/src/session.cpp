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
#include "ipc.h"
#include "json.h"
#include "peer.h"
#include "sink.h"
#include "source.h"
#include "source_wgc.h"
#include "util.h"

namespace {

// The provisional ladder of docs/design/spectator-video-native.md §3 (the kbps of each rung; the sizes are D10.5).
const int kRungKbps[] = {20000, 10000, 8000, 5000, 4000, 2000};

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
    // The window sink's `open` / `closed` (the latter from the window thread when the watcher closes it: the
    // companion learns the sink is gone and where the window was).
    sink_.SetWindowEvents([this](const std::string& state, const WindowPlacement& p, const std::string& driver) {
      Json j = Json::Object();
      j.Set("event", Json::String("sink")).Set("kind", Json::String("window")).Set("state", Json::String(state));
      j.Set("driver", Json::String(driver));
      j.Set("x", Json::Int(p.x)).Set("y", Json::Int(p.y)).Set("width", Json::Int(p.width)).Set("height", Json::Int(p.height));
      ipc_.Emit(j);
    });
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
    else if (kind == "wgc") {  // D10.6: the VPX window itself, source_wgc.cpp
      std::string err;
      if (!ParseWgcSource(c, &cfg, &err)) return ipc_.EmitError("bad_command", err);
    } else return ipc_.EmitError("bad_command", "source: kind is ring, bench, wgc or none");
    if (cfg.kind != SourceConfig::Kind::kWgc) {
    cfg.token = c.GetString("token");
    cfg.width = c.GetInt("width", 1354);
    cfg.height = c.GetInt("height", 1440);
    cfg.fps = c.GetInt("fps", 60);
    if (cfg.kind == SourceConfig::Kind::kRing && cfg.token.empty()) return ipc_.EmitError("bad_command", "source ring: token missing");
    if (cfg.kind == SourceConfig::Kind::kBench && (cfg.width < 480 || cfg.height < 300 || (cfg.width & 1) || (cfg.height & 1) || cfg.fps < 1 || cfg.fps > 120))
      return ipc_.EmitError("bad_command", "source bench: bad width / height / fps");
    }
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
    LogLine("rungs: ceiling %d kbps%s -> max %d kbps", static_cast<int>(max->as_number()), pinned ? (" pin " + std::to_string(*pinned)).c_str() : "", eff);
    for (auto& p : Peers()) p->SetMaxKbps(eff);
  }

  void CmdSink(const Json& c) {
    const std::string kind = c.GetString("kind");
    SinkConfig cfg;
    if (kind == "ring") cfg.kind = SinkConfig::Kind::kRing;
    else if (kind == "window") cfg.kind = SinkConfig::Kind::kWindow;
    else if (kind == "none") cfg.kind = SinkConfig::Kind::kNone;
    else return ipc_.EmitError("bad_command", "sink: kind is ring, window or none");
    cfg.token = c.GetString("token");
    if (cfg.kind == SinkConfig::Kind::kRing) {
      if (c.Has("width")) cfg.max_width = static_cast<uint32_t>(c.GetInt("width", 2048));
      if (c.Has("height")) cfg.max_height = static_cast<uint32_t>(c.GetInt("height", 2048));
      if (cfg.token.empty()) return ipc_.EmitError("bad_command", "sink ring: token missing");
    } else if (cfg.kind == SinkConfig::Kind::kWindow) {
      // D10.4, all optional: title, topmost, monitor (0 = primary, n = the n-th display), and a remembered
      // placement (x, y, width, height together; width and height alone = that size, centred).
      cfg.window.title = c.GetString("title");
      const Json* top = c.Get("topmost");
      cfg.window.topmost = top && top->is_bool() && top->as_bool();
      cfg.window.monitor = c.GetInt("monitor", 0);
      if (c.Has("x") && c.Has("y") && c.Has("width") && c.Has("height"))
        cfg.window.placement = WindowPlacement{c.GetInt("x", 0), c.GetInt("y", 0), c.GetInt("width", 0), c.GetInt("height", 0)};
      else if (c.Has("width") && c.Has("height")) {
        cfg.window.width = c.GetInt("width", 0);
        cfg.window.height = c.GetInt("height", 0);
      }
    }
    std::string err;
    if (!sink_.Configure(cfg, &err)) {
      if (cfg.kind == SinkConfig::Kind::kWindow) ipc_.EmitError("window_open_failed", "window: " + err);
      else ipc_.EmitError("ring_open_failed", "recv ring " + cfg.token + ": " + err);
    }
  }

  int EffectiveMaxKbps() {
    std::lock_guard<std::mutex> l(mu_);
    int m = max_kbps_;
    if (pin_) m = std::min(m, kRungKbps[*pin_ - 1]);
    return m;
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
    const std::string window = source_->window();  // D10.6: the window a wgc source captures
    if (!window.empty()) j.Set("window", Json::String(window));
    ipc_.Emit(j);
  }

  void StatsLoop() {
    int tick = 0;
    while (!stop_stats_) {
      std::this_thread::sleep_for(std::chrono::milliseconds(100));
      if (++tick < 10) continue;
      tick = 0;
      if (source_ && source_->config().kind != SourceConfig::Kind::kNone) EmitSource(source_->state());
      const Sink::Readout sr = sink_.Snapshot();
      const SinkConfig scfg = sink_.config();
      for (auto& p : Peers()) {
        std::weak_ptr<Peer> weak = p;
        p->GetStats([this, weak, sr, scfg](const StatsSnapshot& s) {
          auto peer = weak.lock();
          if (!peer) return;
          EmitStats(*peer, s, sr, scfg);
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
      if (scfg.kind != SinkConfig::Kind::kNone) r.Set("conv_us", Json::Int(static_cast<int64_t>(sr.convert_us)));
      if (scfg.kind == SinkConfig::Kind::kWindow) {
        r.Set("presented_fps", Json::Number(std::round(sr.presented_fps * 10) / 10));
        r.Set("present_us", Json::Int(static_cast<int64_t>(sr.present_us)));
      }
      ipc_.Emit(r);
    }
    peer.prev = s;
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
