// castcade-video: one libwebrtc PeerConnection per remote player (§6.2 `peer`): one sendrecv H.264 transceiver, the
// initiator offers at creation, trickle ICE both ways through the companion's MEDIA_SIGNAL, real ICE (host + srflx
// from the `ice` command's STUN, relay when a TURN entry is given) over the filtered adapter list of network_filter.h.
// One PC per pair for the match; the only renegotiation is an ICE restart (D10.3.5): the initiator offers again
// whenever libwebrtc says negotiation is needed, the answerer answers any offer, and the initiator's watchdog restarts
// ICE on a stuck connection after 10 s, 20 s more and 40 s more (the companion's D2.9 cadence), then gives up with
// `restarts_exhausted`. PeerFactory is the process-wide part: libwebrtc's threads, the environment and the one
// VideoTrackSource every peer's sender track reads. D10.5: each Peer gets its own PeerConnectionFactory on the shared
// threads, so its encoder factory is bound to that peer's RungTarget (the rung the controller chose for it), and a
// `castcade-feedback` data channel on the same connection carries the receiver's decode fps and freeze time back.
#pragma once

#include <atomic>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

#include "api/data_channel_interface.h"
#include "api/environment/environment.h"
#include "api/peer_connection_interface.h"
#include "api/scoped_refptr.h"
#include "api/video/nv12_buffer.h"
#include "rtc_base/thread.h"

#include "controller.h"
#include "factories.h"
#include "json.h"
#include "ladder.h"

struct IceServerSpec {
  std::vector<std::string> urls;
  std::string username, credential;
};

// What a peer tells its owner (called on libwebrtc's signaling thread; the owner must not block on it).
struct PeerEvents {
  std::function<void(const std::string& id, const std::string& kind, const std::string& sdp)> on_sdp;  // offer | answer
  std::function<void(const std::string& id, const std::string& candidate, const std::string& mid, int mline)> on_candidate;
  // pair: object or null. extra: an object of additive `peer` event fields (D10.3.5: `restarts` once a restart
  // happened in this stuck spell, `restarts_exhausted: true` with the final `failed`), or null.
  std::function<void(const std::string& id, const std::string& ice_state, const Json& pair, const Json& extra)> on_ice;
  std::function<void(const std::string& id, const std::string& code, const std::string& text)> on_error;
};

// D10.3.5: the initiator's ICE restart cadence, the companion's D2.9 (panel-page.ts ICE_WATCH): a restart after
// 10 s stuck, the next 20 s after that, the next 40 s after that; 40 s after the third it gives up. The tick is 1 s.
constexpr int kIceRestartBackoffMs[] = {10000, 20000, 40000};
constexpr int kIceRestartMax = 3;
constexpr int kIceWatchTickMs = 1000;
// The answerer never restarts (the lead does); it gives up 5 s after the lead's whole budget, so both companions
// can fall back at about the same time.
constexpr int kIceAnswererGiveUpMs = 10000 + 20000 + 40000 + 40000 + 5000;

// The bitrate envelope handed to libwebrtc with each new peer (x-google-*-bitrate in the remote SDP's H264 fmtp and
// the encoding's max_bitrate_bps). `rungs` moves max_kbps (the ceiling) on the live peers; the rung's own kbps is the
// encoder's clamp (ladder.h), below the ceiling, so the stack's estimate can still probe above the rung (D10.1.3).
struct PeerLimits {
  int start_kbps = 4000;
  int min_kbps = 500;
  int max_kbps = 20000;
  int sdp_max_kbps = 50000;  // the fmtp ceiling: generous, the encoding parameter is the live clamp
  double max_fps = 60;
};

// Cumulative counters from one GetStats, flattened to what the `stats` events need.
struct StatsSnapshot {
  bool valid = false;
  // outbound-rtp (video)
  uint64_t bytes_sent = 0, header_bytes_sent = 0;
  uint32_t frames_sent = 0, frames_encoded = 0, out_width = 0, out_height = 0;
  double total_encode_time_s = 0, target_bitrate_bps = 0;
  std::string encoder_implementation, quality_limitation_reason;
  // remote-inbound-rtp (video)
  std::optional<double> rtt_s, fraction_lost;
  // candidate-pair (selected)
  std::optional<double> available_outgoing_bitrate_bps;
  // inbound-rtp (video)
  uint64_t bytes_received = 0, header_bytes_received = 0;
  uint32_t frames_decoded = 0, frames_received = 0, in_width = 0, in_height = 0, freeze_count = 0;
  uint64_t in_packets_received = 0;
  int32_t in_packets_lost = 0;
  double total_decode_time_s = 0, total_freezes_duration_s = 0, jitter_buffer_delay_s = 0;
  uint64_t jitter_buffer_emitted_count = 0;
  std::string decoder_implementation;
};

// What the other side says about the picture it gets from us (the `castcade-feedback` channel, once a second).
struct PeerFeedback {
  std::optional<double> decode_fps, freeze_ms, presented_fps;
  int64_t at_us = 0;  // NowUs() of the last message; 0 = never
};

class PeerFactory {
 public:
  ~PeerFactory() { Shutdown(); }
  // Starts libwebrtc (threads, SSL, the environment) and builds one factory as the smoke test of the codecs. allow_loopback
  // lets the 127.0.0.1 adapter gather candidates (the in-process self test only; a match never needs it).
  bool Init(const CodecOptions& codecs, bool allow_loopback, std::string* error);
  void Shutdown();
  // A PeerConnectionFactory on the shared threads whose encoder factory applies `target` (null: frames as they come).
  // `peer_tag` non-empty: the factory's network manager is the adapter filter of network_filter.h (D10.3.5), logging
  // its verdict under that peer id; empty: libwebrtc's default (the codec smoke-test factory never gathers).
  webrtc::scoped_refptr<webrtc::PeerConnectionFactoryInterface> CreateFactory(std::shared_ptr<RungTarget> target, const std::string& peer_tag, std::string* error);
  webrtc::PeerConnectionFactoryInterface* factory() { return factory_.get(); }
  webrtc::scoped_refptr<webrtc::VideoTrackSourceInterface> source();
  // D10.3.5: where a peer's renegotiation and watchdog tasks run.
  webrtc::Thread* signaling_thread() { return sig_.get(); }
  // The source's frames, to every peer's sender track (encoded by each active sender's own encoder).
  void PushFrame(const webrtc::scoped_refptr<webrtc::NV12Buffer>& nv12);

 private:
  std::unique_ptr<webrtc::Thread> net_, worker_, sig_;
  std::optional<webrtc::Environment> env_;
  webrtc::scoped_refptr<webrtc::PeerConnectionFactoryInterface> factory_;
  webrtc::scoped_refptr<webrtc::VideoTrackSourceInterface> source_;
  CodecOptions codecs_;
  bool allow_loopback_ = false;
  bool ssl_ = false;
};

class Peer final : public webrtc::PeerConnectionObserver, public webrtc::DataChannelObserver, public std::enable_shared_from_this<Peer> {
 public:
  Peer(PeerFactory& pf, std::string id, bool initiator, std::vector<IceServerSpec> servers, PeerLimits limits, PeerEvents events);
  ~Peer() override;

  const std::string& id() const { return id_; }
  bool initiator() const { return initiator_; }

  // Creates the factory, the PC and the transceiver; the initiator also makes the feedback channel and offers now
  // (the offer arrives through on_sdp), and starts the ICE watchdog.
  bool Start(std::string* error);
  // The remote side's signals (§6.2 `signal`), in arrival order; candidates before the remote description wait. The
  // answerer answers every offer, also on an established connection (an ICE restart is an ordinary renegotiation);
  // the initiator logs and ignores an offer (our protocol never sends it one).
  void OnRemoteSdp(const std::string& kind, const std::string& sdp);
  void OnRemoteCandidate(const std::string& candidate, const std::string& mid, int mline);
  // `send`: the sender's encoding active or not (off = the track is paused, the transceiver stays).
  void SetSendActive(bool on);
  // `rungs`: the live ceiling on the encoding (max_bitrate_bps).
  void SetMaxKbps(int max_kbps);
  // Asynchronous GetStats; the callback runs on the signaling thread.
  void GetStats(std::function<void(const StatsSnapshot&)> cb);
  void Close();

  std::string ice_state();
  bool connected();  // ice connected or completed
  Json pair();  // the selected candidate pair as the `peer` event carries it, or null
  int restarts();  // D10.3.5: ICE restarts in the current stuck spell (0 once connected)

  // D10.5: the rung this peer's encoder applies (the controller or the pin writes it).
  const std::shared_ptr<RungTarget>& target() const { return target_; }
  // What the other side reports about our picture; `at_us` 0 until the channel carried something.
  PeerFeedback feedback();
  // Our report about their picture, once a second from the stats loop; dropped when the channel is not open.
  void SendFeedback(double decode_fps, double freeze_ms, std::optional<double> presented_fps);
  bool feedback_open();

  // Bookkeeping the session keeps per peer (the stats loop's threads only).
  StatsSnapshot prev;                                   // the previous 1 Hz snapshot
  RungController ctrl;                                  // the controller for the frames we send this peer
  std::deque<std::pair<int64_t, uint32_t>> ctrl_win;    // (ms, frames_sent) over the last second
  bool ctrl_sending = false;
  RungGeometry applied;                                 // the rung geometry last announced for this peer

  // PeerConnectionObserver (signaling thread)
  void OnSignalingChange(webrtc::PeerConnectionInterface::SignalingState state) override;
  void OnRenegotiationNeeded() override;
  void OnDataChannel(webrtc::scoped_refptr<webrtc::DataChannelInterface> channel) override;
  void OnIceGatheringChange(webrtc::PeerConnectionInterface::IceGatheringState) override {}
  void OnIceCandidate(const webrtc::IceCandidate* candidate) override;
  void OnIceCandidateError(const std::string& address, int port, const std::string& url, int error_code, const std::string& error_text) override;
  void OnIceConnectionChange(webrtc::PeerConnectionInterface::IceConnectionState) override {}
  void OnStandardizedIceConnectionChange(webrtc::PeerConnectionInterface::IceConnectionState state) override;
  void OnConnectionChange(webrtc::PeerConnectionInterface::PeerConnectionState state) override;
  void OnIceSelectedCandidatePairChanged(const webrtc::CandidatePairChangeEvent& event) override;
  void OnTrack(webrtc::scoped_refptr<webrtc::RtpTransceiverInterface> transceiver) override;
  // DataChannelObserver (the feedback channel; called on the network thread: a lock and a parse, nothing that blocks)
  void OnStateChange() override;
  void OnMessage(const webrtc::DataBuffer& buffer) override;
  bool IsOkToCallOnTheNetworkThread() override { return true; }

 private:
  void CreateLocal(bool offer);
  void SetLocal(std::unique_ptr<webrtc::SessionDescriptionInterface> desc, const std::string& kind);
  void DrainCandidates();
  std::string RemoteSdpWithLimits(const std::string& sdp) const;
  void AdoptChannel(webrtc::scoped_refptr<webrtc::DataChannelInterface> channel);
  // D10.3.5 (signaling thread): an offer now if the connection is stable and none is in flight, else one is queued
  // for the next return to stable.
  void OfferWhenStable();
  // D10.3.5 (signaling thread, every kIceWatchTickMs from Start): the restart cadence.
  void ScheduleWatch();
  void WatchTick();
  void EmitIce(const std::string& state, const Json& pair, int restarts, bool exhausted);

  PeerFactory& pf_;
  const std::string id_;
  const bool initiator_;
  std::vector<IceServerSpec> servers_;
  PeerLimits limits_;
  PeerEvents ev_;
  std::shared_ptr<RungTarget> target_;
  webrtc::scoped_refptr<webrtc::PeerConnectionFactoryInterface> pcf_;
  webrtc::scoped_refptr<webrtc::PeerConnectionInterface> pc_;
  webrtc::scoped_refptr<webrtc::RtpSenderInterface> sender_;
  webrtc::scoped_refptr<webrtc::DataChannelInterface> dc_;
  bool remote_set_ = false;
  std::atomic<bool> closed_{false};
  struct Cand { std::string candidate, mid; int mline; };
  std::deque<Cand> queued_;
  std::mutex mu_;
  std::string ice_state_ = "new";
  Json pair_;
  PeerFeedback feedback_;
  bool dc_open_ = false;
  // D10.3.5, signaling thread only: renegotiation and the watchdog.
  bool started_ = false;        // Start() done: OnRenegotiationNeeded counts from here (the first offer is explicit)
  bool making_offer_ = false;   // an offer between CreateOffer and SetLocalDescription's completion
  bool offer_pending_ = false;  // negotiation was needed while not stable: offer at the next stable
  bool offer_due_ = false;      // RestartIce() was called and no offer followed yet (the next tick offers if still so)
  struct IceWatch {
    int64_t since_us = 0;        // when the connection got stuck (0 = not stuck)
    int64_t last_restart_us = 0;
    int restarts = 0;
    bool gave_up = false;
  } watch_;
  std::atomic<int> restarts_{0};  // watch_.restarts, readable from any thread
};
