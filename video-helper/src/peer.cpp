#include "peer.h"

#include <winsock2.h>
#include <windows.h>
#include <mmsystem.h>

#include <map>

#include "api/audio/audio_device.h"
#include "api/audio/create_audio_device_module.h"
#include "api/audio_codecs/builtin_audio_decoder_factory.h"
#include "api/audio_codecs/builtin_audio_encoder_factory.h"
#include "api/candidate.h"
#include "api/create_modular_peer_connection_factory.h"
#include "api/enable_media.h"
#include "api/environment/environment_factory.h"
#include "api/field_trials_view.h"
#include "api/jsep.h"
#include "api/make_ref_counted.h"
#include "api/media_stream_interface.h"
#include "api/media_types.h"
#include "api/rtp_parameters.h"
#include "api/rtp_transceiver_interface.h"
#include "api/set_local_description_observer_interface.h"
#include "api/set_remote_description_observer_interface.h"
#include "api/stats/rtc_stats_collector_callback.h"
#include "api/stats/rtc_stats_report.h"
#include "api/stats/rtcstats_objects.h"
#include "api/video/video_frame.h"
#include "media/base/video_broadcaster.h"
#include "p2p/base/port.h"
#include "pc/video_track_source.h"
#include "rtc_base/logging.h"
#include "rtc_base/ssl_adapter.h"
#include "rtc_base/time_utils.h"

#include "sdp.h"
#include "util.h"

namespace {

// "Key/Value/Key2/Value2/" as a FieldTrialsView (webrtc::FieldTrials itself is not in the LiveKit archive).
class FieldTrials final : public webrtc::FieldTrialsView {
 public:
  explicit FieldTrials(const std::string& s) {
    size_t pos = 0;
    while (pos < s.size()) {
      size_t a = s.find('/', pos);
      if (a == std::string::npos) break;
      size_t b = s.find('/', a + 1);
      if (b == std::string::npos) break;
      map_[s.substr(pos, a - pos)] = s.substr(a + 1, b - a - 1);
      pos = b + 1;
    }
  }
  std::string Lookup(absl::string_view key) const override {
    auto it = map_.find(std::string(key));
    return it == map_.end() ? std::string() : it->second;
  }
  std::unique_ptr<webrtc::FieldTrialsView> CreateCopy() const override { return std::make_unique<FieldTrials>(*this); }

 private:
  std::map<std::string, std::string> map_;
};

// libwebrtc's own log, warnings and errors only, through our stderr line (its LS_INFO stream ignores LogToDebug in
// this build; a sink is the way to filter it).
class StderrLogSink final : public webrtc::LogSink {
 public:
  void OnLogMessage(const std::string& message) override {
    // Known chatter that says nothing about this match: DSCP on Windows sockets, pings between address families
    // or adapters that cannot reach each other (every ICE run has some), the dummy audio device.
    static const char* const kNoise[] = {"OPT_DSCP", "Failed to send STUN ping", "UDP send of", "Unable to set playout device",
                                         "aecdump", "Transmitting payload type without picture ID",
                                         "Discarding candidate because port is already done gathering"};
    for (const char* n : kNoise)
      if (message.find(n) != std::string::npos) return;
    std::string m = message;
    while (!m.empty() && (m.back() == '\n' || m.back() == '\r')) m.pop_back();
    LogLine("webrtc: %s", m.c_str());
  }
};
StderrLogSink* g_log_sink = nullptr;

// The frames the senders push: a VideoTrackSource fed from the source thread.
class PushSource : public webrtc::VideoTrackSource {
 public:
  PushSource() : webrtc::VideoTrackSource(/*remote=*/false) {}
  void Push(const webrtc::VideoFrame& f) { broadcaster_.OnFrame(f); }

 protected:
  webrtc::VideoSourceInterface<webrtc::VideoFrame>* source() override { return &broadcaster_; }

 private:
  webrtc::VideoBroadcaster broadcaster_;
};

const char* IceName(webrtc::PeerConnectionInterface::IceConnectionState s) {
  using S = webrtc::PeerConnectionInterface;
  switch (s) {
    case S::kIceConnectionNew: return "new";
    case S::kIceConnectionChecking: return "checking";
    case S::kIceConnectionConnected: return "connected";
    case S::kIceConnectionCompleted: return "completed";
    case S::kIceConnectionFailed: return "failed";
    case S::kIceConnectionDisconnected: return "disconnected";
    case S::kIceConnectionClosed: return "closed";
    default: return "?";
  }
}

Json CandidateJson(const webrtc::Candidate& c) {
  Json j = Json::Object();
  j.Set("type", Json::String(std::string(webrtc::IceCandidateTypeToString(c.type()))));
  j.Set("protocol", Json::String(c.protocol()));
  if (!c.relay_protocol().empty()) j.Set("relay_protocol", Json::String(c.relay_protocol()));
  j.Set("address", Json::String(c.address().ToString()));
  return j;
}

// Observers: ref-counted by libwebrtc, each holding a weak Peer so a late callback after Close() does nothing.
class CreateSdpObserver : public webrtc::CreateSessionDescriptionObserver {
 public:
  CreateSdpObserver(std::weak_ptr<Peer> p, std::function<void(std::unique_ptr<webrtc::SessionDescriptionInterface>, std::string)> cb)
      : peer_(std::move(p)), cb_(std::move(cb)) {}
  void OnSuccess(webrtc::SessionDescriptionInterface* desc) override {
    std::unique_ptr<webrtc::SessionDescriptionInterface> d(desc);
    if (peer_.lock()) cb_(std::move(d), "");
  }
  void OnFailure(webrtc::RTCError error) override {
    if (peer_.lock()) cb_(nullptr, error.message());
  }

 private:
  std::weak_ptr<Peer> peer_;
  std::function<void(std::unique_ptr<webrtc::SessionDescriptionInterface>, std::string)> cb_;
};

class SetLocalObserver : public webrtc::SetLocalDescriptionObserverInterface {
 public:
  SetLocalObserver(std::weak_ptr<Peer> p, std::function<void(std::string)> cb) : peer_(std::move(p)), cb_(std::move(cb)) {}
  void OnSetLocalDescriptionComplete(webrtc::RTCError error) override {
    if (peer_.lock()) cb_(error.ok() ? "" : error.message());
  }

 private:
  std::weak_ptr<Peer> peer_;
  std::function<void(std::string)> cb_;
};

class SetRemoteObserver : public webrtc::SetRemoteDescriptionObserverInterface {
 public:
  SetRemoteObserver(std::weak_ptr<Peer> p, std::function<void(std::string)> cb) : peer_(std::move(p)), cb_(std::move(cb)) {}
  void OnSetRemoteDescriptionComplete(webrtc::RTCError error) override {
    if (peer_.lock()) cb_(error.ok() ? "" : error.message());
  }

 private:
  std::weak_ptr<Peer> peer_;
  std::function<void(std::string)> cb_;
};

class StatsObserver : public webrtc::RTCStatsCollectorCallback {
 public:
  StatsObserver(std::weak_ptr<Peer> p, std::function<void(const StatsSnapshot&)> cb) : peer_(std::move(p)), cb_(std::move(cb)) {}
  void OnStatsDelivered(const webrtc::scoped_refptr<const webrtc::RTCStatsReport>& report) override {
    if (!peer_.lock()) return;
    StatsSnapshot s;
    s.valid = true;
    for (const auto* o : report->GetStatsOfType<webrtc::RTCOutboundRtpStreamStats>()) {
      if (o->kind.value_or("") != "video") continue;
      s.bytes_sent = o->bytes_sent.value_or(0);
      s.header_bytes_sent = o->header_bytes_sent.value_or(0);
      s.frames_sent = o->frames_sent.value_or(0);
      s.frames_encoded = o->frames_encoded.value_or(0);
      s.out_width = o->frame_width.value_or(0);
      s.out_height = o->frame_height.value_or(0);
      s.total_encode_time_s = o->total_encode_time.value_or(0);
      s.target_bitrate_bps = o->target_bitrate.value_or(0);
      s.encoder_implementation = o->encoder_implementation.value_or("");
      s.quality_limitation_reason = o->quality_limitation_reason.value_or("");
    }
    for (const auto* r : report->GetStatsOfType<webrtc::RTCRemoteInboundRtpStreamStats>()) {
      if (r->kind.value_or("") != "video") continue;
      s.rtt_s = r->round_trip_time;
      s.fraction_lost = r->fraction_lost;
    }
    uint64_t best = 0;
    bool have = false;
    for (const auto* p : report->GetStatsOfType<webrtc::RTCIceCandidatePairStats>()) {
      const bool nominated = p->nominated.value_or(false);
      const uint64_t b = p->bytes_sent.value_or(0) + p->bytes_received.value_or(0);
      if (!have || (nominated && b >= best)) {
        have = true;
        best = b;
        s.available_outgoing_bitrate_bps = p->available_outgoing_bitrate;
      }
    }
    for (const auto* i : report->GetStatsOfType<webrtc::RTCInboundRtpStreamStats>()) {
      if (i->kind.value_or("") != "video") continue;
      s.bytes_received = i->bytes_received.value_or(0);
      s.header_bytes_received = i->header_bytes_received.value_or(0);
      s.frames_decoded = i->frames_decoded.value_or(0);
      s.frames_received = i->frames_received.value_or(0);
      s.in_width = i->frame_width.value_or(0);
      s.in_height = i->frame_height.value_or(0);
      s.freeze_count = i->freeze_count.value_or(0);
      s.in_packets_lost = i->packets_lost.value_or(0);
      s.in_packets_received = i->packets_received.value_or(0);
      s.total_decode_time_s = i->total_decode_time.value_or(0);
      s.total_freezes_duration_s = i->total_freezes_duration.value_or(0);
      s.jitter_buffer_delay_s = i->jitter_buffer_delay.value_or(0);
      s.jitter_buffer_emitted_count = i->jitter_buffer_emitted_count.value_or(0);
      s.decoder_implementation = i->decoder_implementation.value_or("");
    }
    cb_(s);
  }

 private:
  std::weak_ptr<Peer> peer_;
  std::function<void(const StatsSnapshot&)> cb_;
};

}  // namespace

// ---------------------------------------------------------------- PeerFactory

bool PeerFactory::Init(const CodecOptions& codecs, bool allow_loopback, std::string* error) {
  WSADATA wsa;
  WSAStartup(MAKEWORD(2, 2), &wsa);
  timeBeginPeriod(1);
  if (!g_log_sink) {
    webrtc::LogMessage::LogToDebug(webrtc::LS_NONE);
    webrtc::LogMessage::SetLogToStderr(false);
    g_log_sink = new StderrLogSink();
    webrtc::LogMessage::AddLogToStream(g_log_sink, webrtc::LS_WARNING);
  }
  webrtc::InitializeSSL();
  ssl_ = true;

  net_ = webrtc::Thread::CreateWithSocketServer();
  net_->SetName("video-net", nullptr);
  net_->Start();
  worker_ = webrtc::Thread::Create();
  worker_->SetName("video-worker", nullptr);
  worker_->Start();
  sig_ = webrtc::Thread::Create();
  sig_->SetName("video-signaling", nullptr);
  sig_->Start();

  // The receiver renders as soon as a frame is complete (no playout delay added by the jitter buffer's target).
  env_ = webrtc::CreateEnvironment(std::make_unique<FieldTrials>("WebRTC-ForcePlayoutDelay/min_ms:0,max_ms:0/"));

  codecs_ = codecs;
  allow_loopback_ = allow_loopback;
  factory_ = CreateFactory(nullptr, error);
  if (!factory_) return false;
  source_ = webrtc::make_ref_counted<PushSource>();
  static_cast<PushSource*>(source_.get())->SetState(webrtc::MediaSourceInterface::kLive);
  return true;
}

webrtc::scoped_refptr<webrtc::PeerConnectionFactoryInterface> PeerFactory::CreateFactory(std::shared_ptr<RungTarget> target, std::string* error) {
  CodecOptions codecs = codecs_;
  codecs.target = std::move(target);
  webrtc::PeerConnectionFactoryDependencies deps;
  deps.network_thread = net_.get();
  deps.worker_thread = worker_.get();
  deps.signaling_thread = sig_.get();
  deps.socket_factory = net_->socketserver();
  deps.env = env_;
  deps.adm = worker_->BlockingCall([&] {
    return webrtc::CreateAudioDeviceModule(*env_, webrtc::AudioDeviceModule::kDummyAudio, false);
  });
  deps.audio_encoder_factory = webrtc::CreateBuiltinAudioEncoderFactory();
  deps.audio_decoder_factory = webrtc::CreateBuiltinAudioDecoderFactory();
  deps.video_encoder_factory = CreateEncoderFactory(codecs);
  deps.video_decoder_factory = CreateDecoderFactory(codecs);
  webrtc::EnableMedia(deps);
  auto factory = webrtc::CreateModularPeerConnectionFactory(std::move(deps));
  if (!factory) {
    if (error) *error = "CreateModularPeerConnectionFactory returned null";
    return nullptr;
  }
  if (allow_loopback_) {
    webrtc::PeerConnectionFactoryInterface::Options opts;
    opts.network_ignore_mask = 0;
    factory->SetOptions(opts);
  }
  return factory;
}

webrtc::scoped_refptr<webrtc::VideoTrackSourceInterface> PeerFactory::source() { return source_; }

void PeerFactory::PushFrame(const webrtc::scoped_refptr<webrtc::NV12Buffer>& nv12) {
  if (!source_) return;
  webrtc::VideoFrame frame = webrtc::VideoFrame::Builder().set_video_frame_buffer(nv12).set_timestamp_us(webrtc::TimeMicros()).build();
  static_cast<PushSource*>(source_.get())->Push(frame);
}

void PeerFactory::Shutdown() {
  source_ = nullptr;
  factory_ = nullptr;
  sig_.reset();
  worker_.reset();
  net_.reset();
  if (ssl_) {
    webrtc::CleanupSSL();
    ssl_ = false;
    timeEndPeriod(1);
  }
}

// ---------------------------------------------------------------- Peer

Peer::Peer(PeerFactory& pf, std::string id, bool initiator, std::vector<IceServerSpec> servers, PeerLimits limits, PeerEvents events)
    : pf_(pf), id_(std::move(id)), initiator_(initiator), servers_(std::move(servers)), limits_(limits), ev_(std::move(events)),
      target_(std::make_shared<RungTarget>()) {}

Peer::~Peer() { Close(); }

bool Peer::Start(std::string* error) {
  pcf_ = pf_.CreateFactory(target_, error);
  if (!pcf_) return false;
  webrtc::PeerConnectionInterface::RTCConfiguration config;
  config.sdp_semantics = webrtc::SdpSemantics::kUnifiedPlan;
  config.bundle_policy = webrtc::PeerConnectionInterface::kBundlePolicyMaxBundle;
  config.rtcp_mux_policy = webrtc::PeerConnectionInterface::kRtcpMuxPolicyRequire;
  for (const auto& s : servers_) {
    webrtc::PeerConnectionInterface::IceServer is;
    is.urls = s.urls;
    is.username = s.username;
    is.password = s.credential;
    config.servers.push_back(is);
  }
  webrtc::PeerConnectionDependencies pc_deps(this);
  auto result = pcf_->CreatePeerConnectionOrError(config, std::move(pc_deps));
  if (!result.ok()) {
    *error = std::string("CreatePeerConnection: ") + result.error().message();
    return false;
  }
  pc_ = result.MoveValue();

  auto track = pcf_->CreateVideoTrack(pf_.source(), "castcade-video-" + id_);
  webrtc::RtpTransceiverInit init;
  init.direction = webrtc::RtpTransceiverDirection::kSendRecv;
  init.stream_ids = {"castcade"};
  webrtc::RtpEncodingParameters enc;
  enc.max_bitrate_bps = limits_.max_kbps * 1000;
  enc.min_bitrate_bps = limits_.min_kbps * 1000;
  enc.max_framerate = limits_.max_fps;
  enc.active = false;  // `send on` activates it
  init.send_encodings.push_back(enc);
  auto r = pc_->AddTransceiver(track, init);
  if (!r.ok()) {
    *error = std::string("AddTransceiver: ") + r.error().message();
    return false;
  }
  auto transceiver = r.value();
  sender_ = transceiver->sender();
  // H264 only (plus RTX for retransmission); the factories offer nothing else anyway.
  auto caps = pcf_->GetRtpSenderCapabilities(webrtc::MediaType::VIDEO);
  std::vector<webrtc::RtpCodecCapability> prefs;
  for (const auto& c : caps.codecs)
    if (c.name == "H264" || c.name == "rtx") prefs.push_back(c);
  if (!prefs.empty()) {
    auto e = transceiver->SetCodecPreferences(prefs);
    if (!e.ok()) LogLine("peer %s: SetCodecPreferences: %s", id_.c_str(), e.message());
  }
  webrtc::RtpParameters params = sender_->GetParameters();
  params.degradation_preference = webrtc::DegradationPreference::DISABLED;  // the ladder is ours (D10.5)
  auto e = sender_->SetParameters(params);
  if (!e.ok()) LogLine("peer %s: SetParameters: %s", id_.c_str(), e.message());

  // D10.5: the feedback channel, made by the initiator (the other side gets OnDataChannel); unordered and without
  // retransmission: a stale report is worth nothing.
  if (initiator_) {
    webrtc::DataChannelInit init;
    init.ordered = false;
    init.maxRetransmits = 0;
    auto dc = pc_->CreateDataChannelOrError("castcade-feedback", &init);
    if (dc.ok()) AdoptChannel(dc.MoveValue());
    else LogLine("peer %s: CreateDataChannel: %s", id_.c_str(), dc.error().message());
  }

  LogLine("peer %s: created (%s, %zu ice servers)", id_.c_str(), initiator_ ? "initiator" : "answerer", servers_.size());
  if (initiator_) CreateLocal(true);
  return true;
}

void Peer::AdoptChannel(webrtc::scoped_refptr<webrtc::DataChannelInterface> channel) {
  if (dc_) dc_->UnregisterObserver();
  dc_ = std::move(channel);
  dc_->RegisterObserver(this);
  OnStateChange();
}

void Peer::OnDataChannel(webrtc::scoped_refptr<webrtc::DataChannelInterface> channel) {
  if (channel->label() != "castcade-feedback") {
    LogLine("peer %s: ignoring data channel %s", id_.c_str(), channel->label().c_str());
    return;
  }
  AdoptChannel(std::move(channel));
}

void Peer::OnStateChange() {
  if (!dc_) return;
  const bool open = dc_->state() == webrtc::DataChannelInterface::kOpen;
  bool changed;
  {
    std::lock_guard<std::mutex> l(mu_);
    changed = open != dc_open_;
    dc_open_ = open;
  }
  if (changed) LogLine("peer %s: feedback channel %s", id_.c_str(), open ? "open" : "closed");
}

void Peer::OnMessage(const webrtc::DataBuffer& buffer) {
  if (buffer.binary) return;
  std::string err;
  const Json j = Json::Parse(std::string(buffer.data.data<char>(), buffer.data.size()), &err);
  if (!j.is_object()) return;
  std::lock_guard<std::mutex> l(mu_);
  feedback_.at_us = NowUs();
  const Json* d = j.Get("decode_fps");
  feedback_.decode_fps = d && d->is_number() ? std::optional<double>(d->as_number()) : std::nullopt;
  const Json* f = j.Get("freeze_ms");
  feedback_.freeze_ms = f && f->is_number() ? std::optional<double>(f->as_number()) : std::nullopt;
  const Json* pr = j.Get("presented_fps");
  feedback_.presented_fps = pr && pr->is_number() ? std::optional<double>(pr->as_number()) : std::nullopt;
}

PeerFeedback Peer::feedback() {
  std::lock_guard<std::mutex> l(mu_);
  return feedback_;
}

bool Peer::feedback_open() {
  std::lock_guard<std::mutex> l(mu_);
  return dc_open_;
}

void Peer::SendFeedback(double decode_fps, double freeze_ms, std::optional<double> presented_fps) {
  if (closed_ || !dc_ || !feedback_open()) return;
  Json j = Json::Object();
  j.Set("decode_fps", Json::Number(decode_fps)).Set("freeze_ms", Json::Number(freeze_ms));
  if (presented_fps) j.Set("presented_fps", Json::Number(*presented_fps));
  dc_->SendAsync(webrtc::DataBuffer(j.Dump()), [](webrtc::RTCError) {});
}

bool Peer::connected() {
  std::lock_guard<std::mutex> l(mu_);
  return ice_state_ == "connected" || ice_state_ == "completed";
}

std::string Peer::RemoteSdpWithLimits(const std::string& sdp) const {
  return AddFmtpExtras(sdp, "H264",
                       {{"x-google-start-bitrate", std::to_string(limits_.start_kbps)},
                        {"x-google-min-bitrate", std::to_string(limits_.min_kbps)},
                        {"x-google-max-bitrate", std::to_string(limits_.sdp_max_kbps)}});
}

void Peer::CreateLocal(bool offer) {
  std::weak_ptr<Peer> weak = weak_from_this();
  const std::string kind = offer ? "offer" : "answer";
  auto obs = webrtc::make_ref_counted<CreateSdpObserver>(weak, [weak, kind](std::unique_ptr<webrtc::SessionDescriptionInterface> desc, std::string err) {
    auto self = weak.lock();
    if (!self) return;
    if (!desc) {
      self->ev_.on_error(self->id_, "negotiation_failed", "Create" + kind + ": " + err);
      return;
    }
    self->SetLocal(std::move(desc), kind);
  });
  webrtc::PeerConnectionInterface::RTCOfferAnswerOptions options;
  if (offer) pc_->CreateOffer(obs.get(), options);
  else pc_->CreateAnswer(obs.get(), options);
}

void Peer::SetLocal(std::unique_ptr<webrtc::SessionDescriptionInterface> desc, const std::string& kind) {
  std::string sdp;
  desc->ToString(&sdp);
  std::weak_ptr<Peer> weak = weak_from_this();
  auto obs = webrtc::make_ref_counted<SetLocalObserver>(weak, [weak, kind, sdp](std::string err) {
    auto self = weak.lock();
    if (!self) return;
    if (!err.empty()) {
      self->ev_.on_error(self->id_, "negotiation_failed", "SetLocalDescription(" + kind + "): " + err);
      return;
    }
    self->ev_.on_sdp(self->id_, kind, sdp);
  });
  pc_->SetLocalDescription(std::move(desc), obs);
}

void Peer::OnRemoteSdp(const std::string& kind, const std::string& sdp) {
  if (!pc_ || closed_) return;
  const bool offer = kind == "offer";
  if (offer == initiator_) {
    ev_.on_error(id_, "bad_signal", initiator_ ? "an offer for the initiator" : "an answer for the answerer");
    return;
  }
  webrtc::SdpParseError parse;
  auto desc = webrtc::CreateSessionDescription(offer ? webrtc::SdpType::kOffer : webrtc::SdpType::kAnswer, RemoteSdpWithLimits(sdp), &parse);
  if (!desc) {
    ev_.on_error(id_, "bad_signal", "SDP parse error at '" + parse.line + "': " + parse.description);
    return;
  }
  std::weak_ptr<Peer> weak = weak_from_this();
  auto obs = webrtc::make_ref_counted<SetRemoteObserver>(weak, [weak, offer](std::string err) {
    auto self = weak.lock();
    if (!self) return;
    if (!err.empty()) {
      self->ev_.on_error(self->id_, "negotiation_failed", std::string("SetRemoteDescription(") + (offer ? "offer" : "answer") + "): " + err);
      return;
    }
    {
      std::lock_guard<std::mutex> l(self->mu_);
      self->remote_set_ = true;
    }
    self->DrainCandidates();
    if (offer) self->CreateLocal(false);
  });
  pc_->SetRemoteDescription(std::move(desc), obs);
}

void Peer::OnRemoteCandidate(const std::string& candidate, const std::string& mid, int mline) {
  if (!pc_ || closed_) return;
  bool drain;
  {
    std::lock_guard<std::mutex> l(mu_);
    queued_.push_back({candidate, mid, mline});
    drain = remote_set_;
  }
  if (drain) DrainCandidates();
}

void Peer::DrainCandidates() {
  for (;;) {
    Cand c;
    {
      std::lock_guard<std::mutex> l(mu_);
      if (queued_.empty()) return;
      c = queued_.front();
      queued_.pop_front();
    }
    webrtc::SdpParseError err;
    std::unique_ptr<webrtc::IceCandidate> ice(webrtc::CreateIceCandidate(c.mid, c.mline, c.candidate, &err));
    if (!ice) {
      ev_.on_error(id_, "bad_signal", "ICE candidate parse error: " + err.description);
      continue;
    }
    std::string id = id_;
    PeerEvents ev = ev_;
    pc_->AddIceCandidate(std::move(ice), [id, ev](webrtc::RTCError e) {
      if (!e.ok()) ev.on_error(id, "bad_signal", std::string("AddIceCandidate: ") + e.message());
    });
  }
}

void Peer::SetSendActive(bool on) {
  if (!sender_ || closed_) return;
  webrtc::RtpParameters p = sender_->GetParameters();
  if (p.encodings.empty()) return;
  if (p.encodings[0].active == on) return;
  p.encodings[0].active = on;
  auto e = sender_->SetParameters(p);
  if (!e.ok()) LogLine("peer %s: SetParameters(active=%d): %s", id_.c_str(), on ? 1 : 0, e.message());
  else LogLine("peer %s: send %s", id_.c_str(), on ? "on" : "off");
}

void Peer::SetMaxKbps(int max_kbps) {
  limits_.max_kbps = max_kbps;
  if (!sender_ || closed_) return;
  webrtc::RtpParameters p = sender_->GetParameters();
  if (p.encodings.empty()) return;
  p.encodings[0].max_bitrate_bps = max_kbps * 1000;
  auto e = sender_->SetParameters(p);
  if (!e.ok()) LogLine("peer %s: SetParameters(max %d kbps): %s", id_.c_str(), max_kbps, e.message());
}

void Peer::GetStats(std::function<void(const StatsSnapshot&)> cb) {
  if (!pc_ || closed_) return;
  auto obs = webrtc::make_ref_counted<StatsObserver>(weak_from_this(), std::move(cb));
  pc_->GetStats(obs.get());
}

void Peer::Close() {
  if (closed_) return;
  closed_ = true;
  if (dc_) {
    dc_->UnregisterObserver();
    dc_ = nullptr;
  }
  if (pc_) pc_->Close();
  sender_ = nullptr;
  pc_ = nullptr;
  pcf_ = nullptr;
}

std::string Peer::ice_state() {
  std::lock_guard<std::mutex> l(mu_);
  return ice_state_;
}

Json Peer::pair() {
  std::lock_guard<std::mutex> l(mu_);
  return pair_;
}

void Peer::OnIceCandidate(const webrtc::IceCandidate* candidate) {
  std::string sdp;
  candidate->ToString(&sdp);
  ev_.on_candidate(id_, sdp, candidate->sdp_mid(), candidate->sdp_mline_index());
}

void Peer::OnIceCandidateError(const std::string& address, int port, const std::string& url, int error_code, const std::string& error_text) {
  LogLine("peer %s: ICE candidate error %d from %s (%s:%d): %s", id_.c_str(), error_code, url.c_str(), address.c_str(), port, error_text.c_str());
}

void Peer::OnStandardizedIceConnectionChange(webrtc::PeerConnectionInterface::IceConnectionState state) {
  Json pair;
  {
    std::lock_guard<std::mutex> l(mu_);
    ice_state_ = IceName(state);
    pair = pair_;
  }
  LogLine("peer %s: ice %s", id_.c_str(), IceName(state));
  ev_.on_ice(id_, IceName(state), pair);
}

void Peer::OnConnectionChange(webrtc::PeerConnectionInterface::PeerConnectionState state) {
  using S = webrtc::PeerConnectionInterface::PeerConnectionState;
  if (state == S::kFailed) LogLine("peer %s: connection failed", id_.c_str());
}

void Peer::OnIceSelectedCandidatePairChanged(const webrtc::CandidatePairChangeEvent& event) {
  Json pair = Json::Object();
  pair.Set("local", CandidateJson(event.selected_candidate_pair.local_candidate()));
  pair.Set("remote", CandidateJson(event.selected_candidate_pair.remote_candidate()));
  std::string state;
  {
    std::lock_guard<std::mutex> l(mu_);
    pair_ = pair;
    state = ice_state_;
  }
  LogLine("peer %s: pair %s %s -> %s %s (%s)", id_.c_str(),
          std::string(webrtc::IceCandidateTypeToString(event.selected_candidate_pair.local_candidate().type())).c_str(),
          event.selected_candidate_pair.local_candidate().address().ToString().c_str(),
          std::string(webrtc::IceCandidateTypeToString(event.selected_candidate_pair.remote_candidate().type())).c_str(),
          event.selected_candidate_pair.remote_candidate().address().ToString().c_str(), event.reason.c_str());
  ev_.on_ice(id_, state, pair);
}

void Peer::OnTrack(webrtc::scoped_refptr<webrtc::RtpTransceiverInterface> transceiver) {
  auto track = transceiver->receiver()->track();
  if (track) LogLine("peer %s: remote %s track %s", id_.c_str(), track->kind().c_str(), track->id().c_str());
}
