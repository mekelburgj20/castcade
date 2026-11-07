// D10.0.1 libwebrtc candidate: the harness encoder and decoder behind libwebrtc's factory interfaces.
// The encoder takes the NV12 frames the sender pushes (no conversion when the buffer is a contiguous
// NV12Buffer), hands them to spike_encoder_encode, and returns the Annex B access unit as an
// EncodedImage with H264 packetization mode 1 (libwebrtc's packetizer splits the NAL units itself).
#pragma once

#include <atomic>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "api/video_codecs/video_decoder_factory.h"
#include "api/video_codecs/video_encoder_factory.h"

#include "harness.h"

// Counters the CSV loop reads once a second. Written from libwebrtc's encoder / decoder queues.
struct EncoderStats {
  std::atomic<int64_t> frames_in{0};
  std::atomic<int64_t> frames_out{0};
  std::atomic<int64_t> keyframes{0};
  std::atomic<int64_t> errors{0};
  std::atomic<int64_t> cost_us_total{0};
  std::atomic<int64_t> bytes_out{0};
  std::atomic<int> target_kbps{0};
  std::atomic<int> set_rates_calls{0};
  std::atomic<int> keyframe_requests{0};
  std::atomic<int> reinits{0};
  std::string name = "none";  // set once at InitEncode, read after
};

struct DecoderStats {
  std::atomic<int64_t> decoded{0};
  std::atomic<int64_t> errors{0};
  std::atomic<int64_t> counter_read{0};
  std::atomic<int64_t> last_counter{-1};
  std::atomic<int64_t> g2g_us_total{0};
  std::atomic<int64_t> g2g_samples{0};
  std::atomic<int64_t> g2g_us_max{0};
  std::string name = "none";
};

// Frame n was produced at t0_us + n * period_us (harness clock); the receiver reads n from the strip.
struct FrameClock {
  std::atomic<int64_t> t0_us{0};
  int64_t period_us = 16667;
  const Harness* harness = nullptr;
};

struct HarnessCodecOptions {
  const Harness* harness = nullptr;
  const char* force_encoder = nullptr;  // spike_encoder_config.force
  const char* force_decoder = nullptr;  // spike_decoder_open(force)
  bool trusted_rate_controller = true;
  int fps = 60;
  int start_kbps = 8000;
  FrameClock* clock = nullptr;
  EncoderStats* enc_stats = nullptr;
  DecoderStats* dec_stats = nullptr;
};

std::unique_ptr<webrtc::VideoEncoderFactory> CreateHarnessEncoderFactory(const HarnessCodecOptions& o);
std::unique_ptr<webrtc::VideoDecoderFactory> CreateHarnessDecoderFactory(const HarnessCodecOptions& o);

// libwebrtc's own software codecs (OpenH264, libvpx VP8/VP9, libaom AV1 / dav1d) through the
// header-only factory templates: CreateBuiltinVideo{En,De}coderFactory are not in the LiveKit archive.
std::unique_ptr<webrtc::VideoEncoderFactory> CreateBuiltinEncoderFactory();
std::unique_ptr<webrtc::VideoDecoderFactory> CreateBuiltinDecoderFactory();

// The H264 formats we advertise (packetization-mode 1, level-asymmetry-allowed).
std::vector<webrtc::SdpVideoFormat> HarnessH264Formats();
