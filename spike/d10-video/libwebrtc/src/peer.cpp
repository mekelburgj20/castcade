#include "peer.h"

#include <algorithm>
#include <map>
#include <cctype>
#include <chrono>
#include <cstdio>
#include <vector>

#include "api/audio/audio_device.h"
#include "api/audio/create_audio_device_module.h"
#include "api/audio_codecs/builtin_audio_decoder_factory.h"
#include "api/audio_codecs/builtin_audio_encoder_factory.h"
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
#include "p2p/base/port_allocator.h"
#include "rtc_base/ip_address.h"
#include "rtc_base/network.h"
#include "rtc_base/network_constants.h"

namespace {

// "Key/Value/Key2/Value2/" as a FieldTrialsView. (webrtc::FieldTrials itself is not in the LiveKit
// archive; LiveKit's own glue does the same.)
class SpikeFieldTrials final : public webrtc::FieldTrialsView {
 public:
  explicit SpikeFieldTrials(const std::string& s) {
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
  std::unique_ptr<webrtc::FieldTrialsView> CreateCopy() const override {
    return std::make_unique<SpikeFieldTrials>(*this);
  }

 private:
  std::map<std::string, std::string> map_;
};

std::string Lower(std::string s) {
  for (auto& c : s) c = static_cast<char>(tolower(static_cast<unsigned char>(c)));
  return s;
}

// One network, 127.0.0.1/8, nothing else: the port allocator then binds exactly one UDP socket and the
// SDP carries exactly one host candidate. (BasicNetworkManager would enumerate every adapter and
// ignore loopback by default.)
class LoopbackNetworkManager final : public webrtc::NetworkManagerBase {
 public:
  void StartUpdating() override {
    if (!populated_) {
      populated_ = true;
      const webrtc::IPAddress ip(INADDR_LOOPBACK);
      std::vector<std::unique_ptr<webrtc::Network>> list;
      auto net = CreateNetwork("lo", "spike loopback", webrtc::TruncateIP(ip, 8), 8,
                               webrtc::ADAPTER_TYPE_ETHERNET);
      net->AddIP(ip);
      list.push_back(std::move(net));
      bool changed = false;
      MergeNetworkList(std::move(list), &changed);
      set_default_local_addresses(ip, webrtc::IPAddress());
    }
    NotifyNetworksChanged();
  }
  void StopUpdating() override {}

 private:
  bool populated_ = false;
};

// Blocking adapters over libwebrtc's callback observers (the main thread is not a libwebrtc thread,
// so waiting here is allowed).
class Waiter {
 public:
  void Done(const std::string& err) {
    std::lock_guard<std::mutex> l(mu_);
    error_ = err;
    done_ = true;
    cv_.notify_all();
  }
  bool Wait(int timeout_ms, std::string* error) {
    std::unique_lock<std::mutex> l(mu_);
    if (!cv_.wait_for(l, std::chrono::milliseconds(timeout_ms), [&] { return done_; })) {
      *error = "timeout";
      return false;
    }
    *error = error_;
    return error_.empty();
  }

 private:
  std::mutex mu_;
  std::condition_variable cv_;
  bool done_ = false;
  std::string error_;
};

class CreateSdpObserver : public webrtc::CreateSessionDescriptionObserver {
 public:
  void OnSuccess(webrtc::SessionDescriptionInterface* desc) override {
    desc_.reset(desc);
    waiter.Done("");
  }
  void OnFailure(webrtc::RTCError error) override { waiter.Done(error.message()); }
  std::unique_ptr<webrtc::SessionDescriptionInterface> desc_;
  Waiter waiter;
};

class SetLocalObserver : public webrtc::SetLocalDescriptionObserverInterface {
 public:
  void OnSetLocalDescriptionComplete(webrtc::RTCError error) override {
    waiter.Done(error.ok() ? "" : error.message());
  }
  Waiter waiter;
};

class SetRemoteObserver : public webrtc::SetRemoteDescriptionObserverInterface {
 public:
  void OnSetRemoteDescriptionComplete(webrtc::RTCError error) override {
    waiter.Done(error.ok() ? "" : error.message());
  }
  Waiter waiter;
};

class StatsObserver : public webrtc::RTCStatsCollectorCallback {
 public:
  void OnStatsDelivered(const webrtc::scoped_refptr<const webrtc::RTCStatsReport>& report) override {
    StatsSnapshot s;
    s.valid = true;
    for (const auto* o : report->GetStatsOfType<webrtc::RTCOutboundRtpStreamStats>()) {
      if (o->kind.value_or("") != "video") continue;
      s.bytes_sent = o->bytes_sent.value_or(0);
      s.header_bytes_sent = o->header_bytes_sent.value_or(0);
      s.retransmitted_bytes_sent = o->retransmitted_bytes_sent.value_or(0);
      s.frames_encoded = o->frames_encoded.value_or(0);
      s.frames_sent = o->frames_sent.value_or(0);
      s.key_frames_encoded = o->key_frames_encoded.value_or(0);
      s.huge_frames_sent = o->huge_frames_sent.value_or(0);
      s.total_encode_time_s = o->total_encode_time.value_or(0);
      s.target_bitrate_bps = o->target_bitrate.value_or(0);
      s.out_fps = o->frames_per_second.value_or(0);
      s.encoder_implementation = o->encoder_implementation.value_or("");
      s.quality_limitation_reason = o->quality_limitation_reason.value_or("");
      s.power_efficient_encoder = o->power_efficient_encoder;
      s.out_nack = o->nack_count.value_or(0);
      s.out_pli = o->pli_count.value_or(0);
      if (o->codec_id.has_value()) {
        if (const auto* c = report->GetAs<webrtc::RTCCodecStats>(*o->codec_id))
          s.out_codec = c->mime_type.value_or("");
      }
    }
    for (const auto* r : report->GetStatsOfType<webrtc::RTCRemoteInboundRtpStreamStats>()) {
      if (r->kind.value_or("") != "video") continue;
      s.rtt_s = r->round_trip_time;
      s.fraction_lost = r->fraction_lost;
      s.remote_packets_lost = r->packets_lost.value_or(0);
    }
    uint64_t best_bytes = 0;
    bool have_pair = false;
    for (const auto* p : report->GetStatsOfType<webrtc::RTCIceCandidatePairStats>()) {
      const bool nominated = p->nominated.value_or(false);
      const uint64_t b = p->bytes_sent.value_or(0) + p->bytes_received.value_or(0);
      if (!have_pair || (nominated && b >= best_bytes)) {
        have_pair = true;
        best_bytes = b;
        s.available_outgoing_bitrate_bps = p->available_outgoing_bitrate;
        s.pair_rtt_s = p->current_round_trip_time;
        s.pair_local = p->local_candidate_id.value_or("");
        s.pair_remote = p->remote_candidate_id.value_or("");
      }
    }
    for (const auto* i : report->GetStatsOfType<webrtc::RTCInboundRtpStreamStats>()) {
      if (i->kind.value_or("") != "video") continue;
      s.bytes_received = i->bytes_received.value_or(0);
      s.header_bytes_received = i->header_bytes_received.value_or(0);
      s.frames_received = i->frames_received.value_or(0);
      s.frames_decoded = i->frames_decoded.value_or(0);
      s.frames_dropped = i->frames_dropped.value_or(0);
      s.key_frames_decoded = i->key_frames_decoded.value_or(0);
      s.freeze_count = i->freeze_count.value_or(0);
      s.total_freezes_duration_s = i->total_freezes_duration.value_or(0);
      s.jitter_buffer_delay_s = i->jitter_buffer_delay.value_or(0);
      s.jitter_buffer_emitted_count = i->jitter_buffer_emitted_count.value_or(0);
      s.in_fps = i->frames_per_second.value_or(0);
      s.in_nack = i->nack_count.value_or(0);
      s.in_pli = i->pli_count.value_or(0);
      s.in_packets_lost = i->packets_lost.value_or(0);
      s.decoder_implementation = i->decoder_implementation.value_or("");
      s.power_efficient_decoder = i->power_efficient_decoder;
      if (i->codec_id.has_value()) {
        if (const auto* c = report->GetAs<webrtc::RTCCodecStats>(*i->codec_id))
          s.in_codec = c->mime_type.value_or("");
      }
    }
    snapshot = s;
    waiter.Done("");
  }
  StatsSnapshot snapshot;
  Waiter waiter;
};

const char* StateName(webrtc::PeerConnectionInterface::PeerConnectionState s) {
  using S = webrtc::PeerConnectionInterface::PeerConnectionState;
  switch (s) {
    case S::kNew: return "new";
    case S::kConnecting: return "connecting";
    case S::kConnected: return "connected";
    case S::kDisconnected: return "disconnected";
    case S::kFailed: return "failed";
    case S::kClosed: return "closed";
  }
  return "?";
}

}  // namespace

Peer::Peer(PeerConfig cfg) : cfg_(std::move(cfg)) {}

Peer::~Peer() { Close(); }

bool Peer::Init(std::string* error) {
  net_ = webrtc::Thread::CreateWithSocketServer();
  net_->SetName(cfg_.name + "-net", nullptr);
  net_->Start();
  worker_ = webrtc::Thread::Create();
  worker_->SetName(cfg_.name + "-worker", nullptr);
  worker_->Start();
  sig_ = webrtc::Thread::Create();
  sig_->SetName(cfg_.name + "-signaling", nullptr);
  sig_->Start();

  if (cfg_.field_trials.empty()) {
    env_ = webrtc::CreateEnvironment();
  } else {
    env_ = webrtc::CreateEnvironment(std::make_unique<SpikeFieldTrials>(cfg_.field_trials));
  }

  webrtc::PeerConnectionFactoryDependencies deps;
  deps.network_thread = net_.get();
  deps.worker_thread = worker_.get();
  deps.signaling_thread = sig_.get();
  deps.socket_factory = net_->socketserver();
  deps.env = env_;
  deps.network_manager = std::make_unique<LoopbackNetworkManager>();
  deps.adm = worker_->BlockingCall([&] {
    return webrtc::CreateAudioDeviceModule(*env_, webrtc::AudioDeviceModule::kDummyAudio, false);
  });
  deps.audio_encoder_factory = webrtc::CreateBuiltinAudioEncoderFactory();
  deps.audio_decoder_factory = webrtc::CreateBuiltinAudioDecoderFactory();
  deps.video_encoder_factory = std::move(cfg_.encoder_factory);
  deps.video_decoder_factory = std::move(cfg_.decoder_factory);
  webrtc::EnableMedia(deps);
  factory_ = webrtc::CreateModularPeerConnectionFactory(std::move(deps));
  if (!factory_) {
    *error = "CreateModularPeerConnectionFactory returned null";
    return false;
  }
  webrtc::PeerConnectionFactoryInterface::Options opts;
  opts.network_ignore_mask = 0;  // our only network is loopback-shaped; do not ignore it
  factory_->SetOptions(opts);

  webrtc::PeerConnectionInterface::RTCConfiguration config;
  config.sdp_semantics = webrtc::SdpSemantics::kUnifiedPlan;
  config.bundle_policy = webrtc::PeerConnectionInterface::kBundlePolicyMaxBundle;
  config.rtcp_mux_policy = webrtc::PeerConnectionInterface::kRtcpMuxPolicyRequire;
  config.tcp_candidate_policy = webrtc::PeerConnectionInterface::kTcpCandidatePolicyDisabled;
  config.set_min_port(cfg_.udp_port);
  config.set_max_port(cfg_.udp_port);
  config.set_port_allocator_flags(webrtc::PORTALLOCATOR_DISABLE_STUN |
                                  webrtc::PORTALLOCATOR_DISABLE_RELAY |
                                  webrtc::PORTALLOCATOR_DISABLE_TCP);
  webrtc::PeerConnectionDependencies pc_deps(this);
  auto result = factory_->CreatePeerConnectionOrError(config, std::move(pc_deps));
  if (!result.ok()) {
    *error = std::string("CreatePeerConnectionOrError: ") + result.error().message();
    return false;
  }
  pc_ = result.MoveValue();
  return true;
}

bool Peer::AddSendVideo(webrtc::scoped_refptr<webrtc::VideoTrackSourceInterface> source,
                        const std::string& codec, int max_kbps, int min_kbps, double max_fps,
                        std::string* error) {
  auto track = factory_->CreateVideoTrack(source, "spike-video");
  webrtc::RtpTransceiverInit init;
  init.direction = webrtc::RtpTransceiverDirection::kSendOnly;
  init.stream_ids = {"spike"};
  webrtc::RtpEncodingParameters enc;
  enc.max_bitrate_bps = max_kbps * 1000;
  enc.min_bitrate_bps = min_kbps * 1000;
  enc.max_framerate = max_fps;
  init.send_encodings.push_back(enc);
  auto r = pc_->AddTransceiver(track, init);
  if (!r.ok()) {
    *error = std::string("AddTransceiver: ") + r.error().message();
    return false;
  }
  auto transceiver = r.value();
  sender_ = transceiver->sender();

  auto caps = factory_->GetRtpSenderCapabilities(webrtc::MediaType::VIDEO);
  std::vector<webrtc::RtpCodecCapability> prefs;
  std::string available;
  bool has_codec = false;
  for (const auto& c : caps.codecs) {
    const std::string n = Lower(c.name);
    if (n == Lower(codec)) has_codec = true;
    if (n == Lower(codec) || n == "rtx" || n == "red" || n == "ulpfec" || n == "flexfec-03")
      prefs.push_back(c);
    if (n != "rtx" && n != "red" && n != "ulpfec" && available.find(c.name) == std::string::npos)
      available += (available.empty() ? "" : " ") + c.name;
  }
  fprintf(stderr, "[%s] sender video codecs available: %s\n", cfg_.name.c_str(), available.c_str());
  if (has_codec) {
    auto e = transceiver->SetCodecPreferences(prefs);
    if (!e.ok()) fprintf(stderr, "[%s] SetCodecPreferences(%s) failed: %s\n", cfg_.name.c_str(),
                         codec.c_str(), e.message());
  } else {
    fprintf(stderr, "[%s] WARNING: codec %s not offered by this factory; default order applies\n",
            cfg_.name.c_str(), codec.c_str());
  }

  webrtc::RtpParameters params = sender_->GetParameters();
  params.degradation_preference = webrtc::DegradationPreference::DISABLED;
  auto e = sender_->SetParameters(params);
  if (!e.ok()) fprintf(stderr, "[%s] SetParameters failed: %s\n", cfg_.name.c_str(), e.message());
  return true;
}

bool Peer::CreateLocal(bool offer, std::string* sdp_out, std::string* error) {
  {
    std::lock_guard<std::mutex> l(mu_);
    gathering_complete_ = false;
  }
  auto create = webrtc::make_ref_counted<CreateSdpObserver>();
  webrtc::PeerConnectionInterface::RTCOfferAnswerOptions options;
  if (offer) {
    pc_->CreateOffer(create.get(), options);
  } else {
    pc_->CreateAnswer(create.get(), options);
  }
  if (!create->waiter.Wait(5000, error)) {
    *error = std::string(offer ? "CreateOffer: " : "CreateAnswer: ") + *error;
    return false;
  }
  auto set_local = webrtc::make_ref_counted<SetLocalObserver>();
  pc_->SetLocalDescription(std::move(create->desc_), set_local);
  if (!set_local->waiter.Wait(5000, error)) {
    *error = "SetLocalDescription: " + *error;
    return false;
  }
  {
    std::unique_lock<std::mutex> l(mu_);
    if (!cv_.wait_for(l, std::chrono::seconds(10), [&] { return gathering_complete_; })) {
      *error = "ICE gathering did not complete in 10 s";
      return false;
    }
  }
  std::string sdp;
  const bool ok = sig_->BlockingCall([&] {
    const webrtc::SessionDescriptionInterface* d = pc_->local_description();
    return d != nullptr && d->ToString(&sdp);
  });
  if (!ok) {
    *error = "local_description()->ToString failed";
    return false;
  }
  *sdp_out = sdp;
  return true;
}

bool Peer::SetRemote(bool offer, const std::string& sdp, std::string* error) {
  webrtc::SdpParseError parse;
  auto desc = webrtc::CreateSessionDescription(
      offer ? webrtc::SdpType::kOffer : webrtc::SdpType::kAnswer, sdp, &parse);
  if (!desc) {
    *error = "SDP parse error at '" + parse.line + "': " + parse.description;
    return false;
  }
  auto obs = webrtc::make_ref_counted<SetRemoteObserver>();
  pc_->SetRemoteDescription(std::move(desc), obs);
  if (!obs->waiter.Wait(5000, error)) {
    *error = "SetRemoteDescription: " + *error;
    return false;
  }
  return true;
}

bool Peer::WaitConnected(int timeout_ms) {
  std::unique_lock<std::mutex> l(mu_);
  return cv_.wait_for(l, std::chrono::milliseconds(timeout_ms), [&] {
    return state_ == webrtc::PeerConnectionInterface::PeerConnectionState::kConnected;
  });
}

bool Peer::GetStats(StatsSnapshot* out, int timeout_ms) {
  auto obs = webrtc::make_ref_counted<StatsObserver>();
  pc_->GetStats(obs.get());
  std::string err;
  if (!obs->waiter.Wait(timeout_ms, &err)) return false;
  *out = obs->snapshot;
  return true;
}

std::string Peer::ConnectionStateName() {
  std::lock_guard<std::mutex> l(mu_);
  return StateName(state_);
}

void Peer::Close() {
  if (pc_) pc_->Close();
  sender_ = nullptr;
  pc_ = nullptr;
  factory_ = nullptr;
  sig_.reset();
  worker_.reset();
  net_.reset();
}

void Peer::OnIceGatheringChange(webrtc::PeerConnectionInterface::IceGatheringState state) {
  if (state != webrtc::PeerConnectionInterface::kIceGatheringComplete) return;
  std::lock_guard<std::mutex> l(mu_);
  gathering_complete_ = true;
  cv_.notify_all();
}

void Peer::OnConnectionChange(webrtc::PeerConnectionInterface::PeerConnectionState state) {
  fprintf(stderr, "[%s] connection state: %s\n", cfg_.name.c_str(), StateName(state));
  std::lock_guard<std::mutex> l(mu_);
  state_ = state;
  cv_.notify_all();
}

void Peer::OnTrack(webrtc::scoped_refptr<webrtc::RtpTransceiverInterface> transceiver) {
  auto track = transceiver->receiver()->track();
  if (!track || track->kind() != webrtc::MediaStreamTrackInterface::kVideoKind) return;
  fprintf(stderr, "[%s] remote video track %s\n", cfg_.name.c_str(), track->id().c_str());
  if (cfg_.remote_sink) {
    static_cast<webrtc::VideoTrackInterface*>(track.get())
        ->AddOrUpdateSink(cfg_.remote_sink, webrtc::VideoSinkWants());
  }
}
