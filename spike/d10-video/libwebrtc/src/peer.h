// D10.0.1 libwebrtc candidate: one in-process peer (factory + PeerConnection + threads) with the
// blocking signalling helpers the main thread drives. Networking is pinned to one loopback network and
// one UDP port; trickle candidates are ignored (the SDP is read after gathering completes).
#pragma once

#include <condition_variable>
#include <memory>
#include <mutex>
#include <optional>
#include <string>

#include "api/environment/environment.h"
#include "api/peer_connection_interface.h"
#include "api/scoped_refptr.h"
#include "api/video/video_frame.h"
#include "api/video/video_sink_interface.h"
#include "api/video_codecs/video_decoder_factory.h"
#include "api/video_codecs/video_encoder_factory.h"
#include "rtc_base/thread.h"

struct PeerConfig {
  std::string name;  // "sender" / "receiver": thread names and log prefix
  int udp_port = 0;  // the one UDP port this side binds (allocator range of one)
  std::string field_trials;  // "WebRTC-ForcePlayoutDelay/min_ms:0,max_ms:0/" etc.
  std::unique_ptr<webrtc::VideoEncoderFactory> encoder_factory;
  std::unique_ptr<webrtc::VideoDecoderFactory> decoder_factory;
  webrtc::VideoSinkInterface<webrtc::VideoFrame>* remote_sink = nullptr;  // attached in OnTrack
};

// What GetStats returns, flattened to the fields the CSV lines need. Cumulative counters.
struct StatsSnapshot {
  bool valid = false;
  // outbound-rtp (video)
  uint64_t bytes_sent = 0, header_bytes_sent = 0, retransmitted_bytes_sent = 0;
  uint32_t frames_encoded = 0, frames_sent = 0, key_frames_encoded = 0, huge_frames_sent = 0;
  double total_encode_time_s = 0, target_bitrate_bps = 0, out_fps = 0;
  std::string encoder_implementation, quality_limitation_reason, out_codec;
  std::optional<bool> power_efficient_encoder;
  uint32_t out_nack = 0, out_pli = 0;
  // remote-inbound-rtp (video)
  std::optional<double> rtt_s, fraction_lost;
  int32_t remote_packets_lost = 0;
  // candidate-pair (selected)
  std::optional<double> available_outgoing_bitrate_bps, pair_rtt_s;
  std::string pair_local, pair_remote;
  // inbound-rtp (video)
  uint64_t bytes_received = 0, header_bytes_received = 0;
  uint32_t frames_received = 0, frames_decoded = 0, frames_dropped = 0, key_frames_decoded = 0;
  uint32_t freeze_count = 0, in_nack = 0, in_pli = 0;
  double total_freezes_duration_s = 0, jitter_buffer_delay_s = 0, in_fps = 0;
  uint64_t jitter_buffer_emitted_count = 0;
  int32_t in_packets_lost = 0;
  std::string decoder_implementation, in_codec;
  std::optional<bool> power_efficient_decoder;
};

class Peer : public webrtc::PeerConnectionObserver {
 public:
  explicit Peer(PeerConfig cfg);
  ~Peer() override;

  bool Init(std::string* error);
  // A sendonly video transceiver on `source`, preferring `codec` (name as in SDP: H264, VP8, VP9, AV1),
  // with the encoding limits and resolution/frame-rate adaptation disabled.
  bool AddSendVideo(webrtc::scoped_refptr<webrtc::VideoTrackSourceInterface> source,
                    const std::string& codec, int max_kbps, int min_kbps, double max_fps,
                    std::string* error);
  // Create{Offer,Answer} + SetLocalDescription + wait for gathering to complete; `sdp_out` is the
  // complete local description (candidates inline).
  bool CreateLocal(bool offer, std::string* sdp_out, std::string* error);
  bool SetRemote(bool offer, const std::string& sdp, std::string* error);
  bool WaitConnected(int timeout_ms);
  bool GetStats(StatsSnapshot* out, int timeout_ms);
  std::string ConnectionStateName();
  void Close();

  webrtc::PeerConnectionFactoryInterface* factory() { return factory_.get(); }

  // PeerConnectionObserver
  void OnSignalingChange(webrtc::PeerConnectionInterface::SignalingState) override {}
  void OnDataChannel(webrtc::scoped_refptr<webrtc::DataChannelInterface>) override {}
  void OnIceGatheringChange(webrtc::PeerConnectionInterface::IceGatheringState state) override;
  void OnIceCandidate(const webrtc::IceCandidate*) override {}  // trickle: dropped by design
  void OnIceConnectionChange(webrtc::PeerConnectionInterface::IceConnectionState) override {}
  void OnConnectionChange(webrtc::PeerConnectionInterface::PeerConnectionState state) override;
  void OnTrack(webrtc::scoped_refptr<webrtc::RtpTransceiverInterface> transceiver) override;

 private:
  PeerConfig cfg_;
  std::unique_ptr<webrtc::Thread> net_, worker_, sig_;
  std::optional<webrtc::Environment> env_;
  webrtc::scoped_refptr<webrtc::PeerConnectionFactoryInterface> factory_;
  webrtc::scoped_refptr<webrtc::PeerConnectionInterface> pc_;
  webrtc::scoped_refptr<webrtc::RtpSenderInterface> sender_;

  std::mutex mu_;
  std::condition_variable cv_;
  bool gathering_complete_ = false;
  webrtc::PeerConnectionInterface::PeerConnectionState state_ =
      webrtc::PeerConnectionInterface::PeerConnectionState::kNew;
};
