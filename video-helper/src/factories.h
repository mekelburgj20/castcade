// castcade-video: our libavcodec encoder and decoder behind libwebrtc's VideoEncoderFactory / VideoDecoderFactory
// (the D10.0.1 spike's codecs.cpp, lifted). The encoder takes the NV12 frames the source pushes (zero-copy for a
// contiguous NV12Buffer) and returns Annex B as an EncodedImage with H264 packetization mode 1; the decoder hands every
// decoded picture to a DecodedSink (the recv ring) and gives libwebrtc a 16x16 black frame carrying the RTP timestamp
// for its bookkeeping (the pixels never go through libwebrtc on the way out).
#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "api/video_codecs/sdp_video_format.h"
#include "api/video_codecs/video_decoder_factory.h"
#include "api/video_codecs/video_encoder_factory.h"

#include "codecs.h"

class DecodedSink {
 public:
  virtual ~DecodedSink() = default;
  // Called on libwebrtc's decoding thread for every picture, with the decoder's own cost for it.
  virtual void OnDecoded(const DecodedPicture& picture, int64_t dec_us) = 0;
};

struct CodecOptions {
  std::string encoder;  // the probe's choice, opened by name (an empty string = the probe order)
  std::string decoder;
  RatePolicy policy = RatePolicy::kLimited;
  DecodedSink* sink = nullptr;  // may be null (decoded pictures are then only counted by libwebrtc)
};

std::unique_ptr<webrtc::VideoEncoderFactory> CreateEncoderFactory(const CodecOptions& o);
std::unique_ptr<webrtc::VideoDecoderFactory> CreateDecoderFactory(const CodecOptions& o);

// The H264 formats advertised (packetization-mode 1, level-asymmetry-allowed; High, Main, Constrained Baseline at 5.1).
std::vector<webrtc::SdpVideoFormat> H264Formats();
