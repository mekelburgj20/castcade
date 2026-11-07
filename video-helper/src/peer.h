// castcade-video: one libwebrtc PeerConnection per remote player (§6.2 `peer`): one sendrecv H.264 transceiver, the
// initiator offers at creation, trickle ICE both ways through the companion's MEDIA_SIGNAL, real ICE (the default
// network manager: host + srflx from the `ice` command's STUN, relay when a TURN entry is given). One PC per pair for
// the match; nothing is renegotiated. PeerFactory is the process-wide part: libwebrtc's threads, the factory with our
// codec factories, and the one VideoTrackSource every peer's sender track reads.
#pragma once

#include <atomic>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

#include "api/environment/environment.h"
#include "api/peer_connection_interface.h"
#include "api/scoped_refptr.h"
#include "api/video/nv12_buffer.h"
#include "rtc_base/thread.h"

#include "factories.h"
#include "json.h"

struct IceServerSpec {
  std::vector<std::string> urls;
  std::string username, credential;
};

// What a peer tells its owner (called on libwebrtc's signaling thread; the owner must not block on it).
struct PeerEvents {
  std::function<void(const std::string& id, const std::string& kind, const std::string& sdp)> on_sdp;  // offer | answer
  std::function<void(const std::string& id, const std::string& candidate, const std::string& mid, int mline)> on_candidate;
  std::function<void(const std::string& id, const std::string& ice_state, const Json& pair)> on_ice;  // pair: object or null
  std::function<void(const std::string& id, const std::string& code, const std::string& text)> on_error;
};

// The bitrate envelope handed to libwebrtc with each new peer (x-google-*-bitrate in the remote SDP's H264 fmtp and
// the encoding's max_bitrate_bps); `rungs` moves max_kbps on the live peers.
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

class PeerFactory {
 public:
  ~PeerFactory() { Shutdown(); }
  // Starts libwebrtc (threads, SSL, the factory with our codecs). allow_loopback lets the 127.0.0.1 adapter gather
  // candidates (the in-process self test only; a match never needs it).
  bool Init(const CodecOptions& codecs, bool allow_loopback, std::string* error);
  void Shutdown();
  webrtc::PeerConnectionFactoryInterface* factory() { return factory_.get(); }
  webrtc::scoped_refptr<webrtc::VideoTrackSourceInterface> source();
  // The source's frames, to every peer's sender track (encoded by each active sender's own encoder).
  void PushFrame(const webrtc::scoped_refptr<webrtc::NV12Buffer>& nv12);

 private:
  std::unique_ptr<webrtc::Thread> net_, worker_, sig_;
  std::optional<webrtc::Environment> env_;
  webrtc::scoped_refptr<webrtc::PeerConnectionFactoryInterface> factory_;
  webrtc::scoped_refptr<webrtc::VideoTrackSourceInterface> source_;
  bool ssl_ = false;
};

class Peer final : public webrtc::PeerConnectionObserver, public std::enable_shared_from_this<Peer> {
 public:
  Peer(PeerFactory& pf, std::string id, bool initiator, std::vector<IceServerSpec> servers, PeerLimits limits, PeerEvents events);
  ~Peer() override;

  const std::string& id() const { return id_; }
  bool initiator() const { return initiator_; }

  // Creates the PC and the transceiver; the initiator also offers now (the offer arrives through on_sdp).
  bool Start(std::string* error);
  // The remote side's signals (§6.2 `signal`), in arrival order; candidates before the remote description wait.
  void OnRemoteSdp(const std::string& kind, const std::string& sdp);
  void OnRemoteCandidate(const std::string& candidate, const std::string& mid, int mline);
  // `send`: the sender's encoding active or not (off = the track is paused, the transceiver stays).
  void SetSendActive(bool on);
  // `rungs`: the live ceiling on the encoding.
  void SetMaxKbps(int max_kbps);
  // Asynchronous GetStats; the callback runs on the signaling thread.
  void GetStats(std::function<void(const StatsSnapshot&)> cb);
  void Close();

  std::string ice_state();
  Json pair();  // the selected candidate pair as the `peer` event carries it, or null
  // The previous snapshot the stats loop keeps per peer (its own bookkeeping).
  StatsSnapshot prev;

  // PeerConnectionObserver (signaling thread)
  void OnSignalingChange(webrtc::PeerConnectionInterface::SignalingState) override {}
  void OnDataChannel(webrtc::scoped_refptr<webrtc::DataChannelInterface>) override {}
  void OnIceGatheringChange(webrtc::PeerConnectionInterface::IceGatheringState) override {}
  void OnIceCandidate(const webrtc::IceCandidate* candidate) override;
  void OnIceCandidateError(const std::string& address, int port, const std::string& url, int error_code, const std::string& error_text) override;
  void OnIceConnectionChange(webrtc::PeerConnectionInterface::IceConnectionState) override {}
  void OnStandardizedIceConnectionChange(webrtc::PeerConnectionInterface::IceConnectionState state) override;
  void OnConnectionChange(webrtc::PeerConnectionInterface::PeerConnectionState state) override;
  void OnIceSelectedCandidatePairChanged(const webrtc::CandidatePairChangeEvent& event) override;
  void OnTrack(webrtc::scoped_refptr<webrtc::RtpTransceiverInterface> transceiver) override;

 private:
  void CreateLocal(bool offer);
  void SetLocal(std::unique_ptr<webrtc::SessionDescriptionInterface> desc, const std::string& kind);
  void DrainCandidates();
  std::string RemoteSdpWithLimits(const std::string& sdp) const;

  PeerFactory& pf_;
  const std::string id_;
  const bool initiator_;
  std::vector<IceServerSpec> servers_;
  PeerLimits limits_;
  PeerEvents ev_;
  webrtc::scoped_refptr<webrtc::PeerConnectionInterface> pc_;
  webrtc::scoped_refptr<webrtc::RtpSenderInterface> sender_;
  bool remote_set_ = false;
  bool closed_ = false;
  struct Cand { std::string candidate, mid; int mline; };
  std::deque<Cand> queued_;
  std::mutex mu_;
  std::string ice_state_ = "new";
  Json pair_;
};
