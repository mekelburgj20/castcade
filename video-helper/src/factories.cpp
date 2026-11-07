#include "factories.h"

#include <cstring>
#include <deque>
#include <optional>

#include "api/environment/environment.h"
#include "api/video/encoded_image.h"
#include "api/video/i420_buffer.h"
#include "api/video/nv12_buffer.h"
#include "api/video/video_frame.h"
#include "api/video_codecs/h264_profile_level_id.h"
#include "api/video_codecs/video_codec.h"
#include "api/video_codecs/video_decoder.h"
#include "api/video_codecs/video_encoder.h"
#include "libyuv/convert_from.h"
#include "media/base/media_constants.h"
#include "modules/video_coding/codecs/h264/include/h264_globals.h"
#include "modules/video_coding/codecs/interface/common_constants.h"
#include "modules/video_coding/include/video_codec_interface.h"
#include "modules/video_coding/include/video_error_codes.h"
#include "rtc_base/time_utils.h"

#include "util.h"

namespace {

webrtc::SdpVideoFormat H264Format(webrtc::H264Profile profile, webrtc::H264Level level) {
  const std::optional<std::string> id = webrtc::H264ProfileLevelIdToString(webrtc::H264ProfileLevelId(profile, level));
  return webrtc::SdpVideoFormat("H264", {{webrtc::kH264FmtpProfileLevelId, id.value_or("42e01f")},
                                         {webrtc::kH264FmtpLevelAsymmetryAllowed, "1"},
                                         {webrtc::kH264FmtpPacketizationMode, "1"}});
}

// ---------------------------------------------------------------------------------------------
// Encoder
// ---------------------------------------------------------------------------------------------
class AvEncoder final : public webrtc::VideoEncoder {
 public:
  explicit AvEncoder(const CodecOptions& o) : o_(o) {}
  ~AvEncoder() override { Release(); }

  int InitEncode(const webrtc::VideoCodec* codec, const Settings& /*settings*/) override {
    Release();
    EncoderConfig cfg;
    cfg.width = codec->width;
    cfg.height = codec->height;
    cfg.fps = codec->maxFramerate > 0 ? static_cast<int>(codec->maxFramerate) : 60;
    cfg.kbps = codec->startBitrate > 0 ? static_cast<int>(codec->startBitrate) : 4000;
    cfg.force = o_.encoder;
    cfg.policy = o_.policy;
    std::string err;
    enc_ = Encoder::Open(cfg, &err);
    if (!enc_) {
      LogLine("encoder: open failed (%dx%d @%d, %d kbps): %s", cfg.width, cfg.height, cfg.fps, cfg.kbps, err.c_str());
      return WEBRTC_VIDEO_CODEC_ERROR;
    }
    width_ = cfg.width;
    height_ = cfg.height;
    fps_ = cfg.fps;
    scratch_.assign(static_cast<size_t>(width_) * height_ * 3 / 2, 0);
    LogLine("encoder: %s %dx%d @%d fps, start %d kbps, policy %s", enc_->name().c_str(), width_, height_, fps_, cfg.kbps,
            RatePolicyName(cfg.policy));
    return WEBRTC_VIDEO_CODEC_OK;
  }

  int32_t RegisterEncodeCompleteCallback(webrtc::EncodedImageCallback* cb) override {
    callback_ = cb;
    return WEBRTC_VIDEO_CODEC_OK;
  }

  int32_t Release() override {
    enc_.reset();
    return WEBRTC_VIDEO_CODEC_OK;
  }

  int32_t Encode(const webrtc::VideoFrame& frame, const std::vector<webrtc::VideoFrameType>* frame_types) override {
    if (!enc_ || !callback_) return WEBRTC_VIDEO_CODEC_UNINITIALIZED;
    if (frame.width() != width_ || frame.height() != height_) {
      // Adaptation is off; a different size means the source changed (the layer's box). Re-open at the new size.
      webrtc::VideoCodec c{};
      c.width = static_cast<uint16_t>(frame.width());
      c.height = static_cast<uint16_t>(frame.height());
      c.maxFramerate = fps_;
      c.startBitrate = enc_->applied_kbps();
      if (InitEncode(&c, Settings(Capabilities(false), 1, 1200)) != WEBRTC_VIDEO_CODEC_OK) return WEBRTC_VIDEO_CODEC_ERROR;
    }
    bool want_key = false;
    if (frame_types)
      for (auto t : *frame_types)
        if (t == webrtc::VideoFrameType::kVideoFrameKey) want_key = true;
    if (want_key) enc_->RequestKeyframe();

    const uint8_t *y, *uv;
    int sy, suv;
    Nv12Of(frame, &y, &sy, &uv, &suv);
    const uint8_t* out = nullptr;
    size_t out_size = 0;
    bool key = false;
    const int rc = enc_->Encode(y, sy, uv, suv, frame.rtp_timestamp(), &out, &out_size, &key);
    if (rc < 0) {
      if (++errors_ == 1) LogLine("encoder: %s encode error %d", enc_->name().c_str(), rc);
      return WEBRTC_VIDEO_CODEC_ERROR;
    }
    if (rc == 1 || out_size == 0) return WEBRTC_VIDEO_CODEC_OK;  // buffered (should not happen)

    webrtc::EncodedImage image;
    image.SetEncodedData(webrtc::EncodedImageBuffer::Create(out, out_size));
    image._encodedWidth = width_;
    image._encodedHeight = height_;
    image.SetRtpTimestamp(frame.rtp_timestamp());
    image.capture_time_ms_ = frame.render_time_ms();
    image.ntp_time_ms_ = frame.ntp_time_ms();
    image._frameType = key ? webrtc::VideoFrameType::kVideoFrameKey : webrtc::VideoFrameType::kVideoFrameDelta;
    image.qp_ = -1;

    webrtc::CodecSpecificInfo info;
    info.codecType = webrtc::kVideoCodecH264;
    info.codecSpecific.H264.packetization_mode = webrtc::H264PacketizationMode::NonInterleaved;
    info.codecSpecific.H264.temporal_idx = webrtc::kNoTemporalIdx;
    info.codecSpecific.H264.base_layer_sync = false;
    info.codecSpecific.H264.idr_frame = key;
    info.end_of_picture = true;
    const auto result = callback_->OnEncodedImage(image, &info);
    return result.error == webrtc::EncodedImageCallback::Result::OK ? WEBRTC_VIDEO_CODEC_OK : WEBRTC_VIDEO_CODEC_ERROR;
  }

  void SetRates(const RateControlParameters& p) override {
    const int kbps = static_cast<int>(p.bitrate.get_sum_kbps());
    if (kbps > 0 && enc_) enc_->SetTargetKbps(kbps, NowUs());
  }

  EncoderInfo GetEncoderInfo() const override {
    EncoderInfo info;
    info.implementation_name = enc_ ? enc_->name() : (o_.encoder.empty() ? std::string("avcodec") : o_.encoder);
    info.is_hardware_accelerated = info.implementation_name != "libx264";
    info.has_trusted_rate_controller = true;  // CBR with a 50 ms VBV: no frame dropper on top
    info.supports_native_handle = false;
    info.scaling_settings = VideoEncoder::ScalingSettings::kOff;
    info.requested_resolution_alignment = 2;
    info.preferred_pixel_formats = {webrtc::VideoFrameBuffer::Type::kNV12};
    info.supports_simulcast = false;
    return info;
  }

 private:
  // The two NV12 planes of the frame; zero-copy for an NV12 buffer, a libyuv conversion otherwise.
  void Nv12Of(const webrtc::VideoFrame& frame, const uint8_t** y, int* sy, const uint8_t** uv, int* suv) {
    auto buffer = frame.video_frame_buffer();
    if (buffer->type() == webrtc::VideoFrameBuffer::Type::kNV12) {
      const webrtc::NV12BufferInterface* nv = buffer->GetNV12();
      *y = nv->DataY(); *sy = nv->StrideY(); *uv = nv->DataUV(); *suv = nv->StrideUV();
      return;
    }
    auto i420 = buffer->ToI420();
    uint8_t* dy = scratch_.data();
    uint8_t* duv = dy + static_cast<size_t>(width_) * height_;
    libyuv::I420ToNV12(i420->DataY(), i420->StrideY(), i420->DataU(), i420->StrideU(), i420->DataV(), i420->StrideV(),
                       dy, width_, duv, width_, width_, height_);
    *y = dy; *sy = width_; *uv = duv; *suv = width_;
  }

  CodecOptions o_;
  std::unique_ptr<Encoder> enc_;
  webrtc::EncodedImageCallback* callback_ = nullptr;
  int width_ = 0, height_ = 0, fps_ = 60;
  int64_t errors_ = 0;
  std::vector<uint8_t> scratch_;
};

class AvEncoderFactory final : public webrtc::VideoEncoderFactory {
 public:
  explicit AvEncoderFactory(const CodecOptions& o) : o_(o) {}
  std::vector<webrtc::SdpVideoFormat> GetSupportedFormats() const override { return H264Formats(); }
  std::unique_ptr<webrtc::VideoEncoder> Create(const webrtc::Environment&, const webrtc::SdpVideoFormat& format) override {
    if (format.name != "H264") return nullptr;
    return std::make_unique<AvEncoder>(o_);
  }

 private:
  CodecOptions o_;
};

// ---------------------------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------------------------
class AvDecoder final : public webrtc::VideoDecoder {
 public:
  explicit AvDecoder(const CodecOptions& o) : o_(o) {}
  ~AvDecoder() override { Release(); }

  bool Configure(const Settings& /*settings*/) override {
    Release();
    std::string err;
    dec_ = Decoder::Open(o_.decoder, &err);
    if (!dec_) {
      LogLine("decoder: open failed: %s", err.c_str());
      return false;
    }
    black_ = webrtc::I420Buffer::Create(16, 16);
    webrtc::I420Buffer::SetBlack(black_.get());
    LogLine("decoder: %s", dec_->name().c_str());
    return true;
  }

  int32_t Decode(const webrtc::EncodedImage& input, int64_t render_time_ms) override {
    if (!dec_ || !callback_) return WEBRTC_VIDEO_CODEC_UNINITIALIZED;
    const int64_t t_in = webrtc::TimeMillis();
    pending_.push_back({input.RtpTimestamp(), render_time_ms});
    if (pending_.size() > 64) pending_.pop_front();  // the decoder is not that deep; drop stale
    int out = 0;
    const int rc = dec_->Decode(input.data(), input.size(), input.RtpTimestamp(), [&](const DecodedPicture& p) {
      out++;
      if (o_.sink) o_.sink->OnDecoded(p, dec_->last_cost_us());
    });
    if (rc < 0) {
      if (++errors_ == 1) LogLine("decoder: %s decode error %d", dec_->name().c_str(), rc);
      return WEBRTC_VIDEO_CODEC_ERROR;
    }
    // One bookkeeping frame per picture, carrying the oldest pending RTP timestamp (a small FIFO covers the
    // decoder's latency); libwebrtc drops the stream's accounting without it.
    for (int i = 0; i < out && !pending_.empty(); i++) {
      Pending p = pending_.front();
      pending_.pop_front();
      webrtc::VideoFrame frame = webrtc::VideoFrame::Builder()
                                     .set_video_frame_buffer(black_)
                                     .set_rtp_timestamp(p.rtp_timestamp)
                                     .set_timestamp_ms(p.render_time_ms)
                                     .build();
      callback_->Decoded(frame, static_cast<int32_t>(webrtc::TimeMillis() - t_in), std::nullopt);
    }
    return WEBRTC_VIDEO_CODEC_OK;
  }

  int32_t RegisterDecodeCompleteCallback(webrtc::DecodedImageCallback* cb) override {
    callback_ = cb;
    return WEBRTC_VIDEO_CODEC_OK;
  }

  int32_t Release() override {
    dec_.reset();
    pending_.clear();
    return WEBRTC_VIDEO_CODEC_OK;
  }

  DecoderInfo GetDecoderInfo() const override {
    DecoderInfo info;
    info.implementation_name = dec_ ? dec_->name() : std::string("avcodec");
    info.is_hardware_accelerated = info.implementation_name != "h264";
    return info;
  }
  const char* ImplementationName() const override { return dec_ ? dec_->name().c_str() : "avcodec"; }

 private:
  struct Pending {
    uint32_t rtp_timestamp;
    int64_t render_time_ms;
  };
  CodecOptions o_;
  std::unique_ptr<Decoder> dec_;
  webrtc::DecodedImageCallback* callback_ = nullptr;
  std::deque<Pending> pending_;
  webrtc::scoped_refptr<webrtc::I420Buffer> black_;
  int64_t errors_ = 0;
};

class AvDecoderFactory final : public webrtc::VideoDecoderFactory {
 public:
  explicit AvDecoderFactory(const CodecOptions& o) : o_(o) {}
  std::vector<webrtc::SdpVideoFormat> GetSupportedFormats() const override { return H264Formats(); }
  std::unique_ptr<webrtc::VideoDecoder> Create(const webrtc::Environment&, const webrtc::SdpVideoFormat& format) override {
    if (format.name != "H264") return nullptr;
    return std::make_unique<AvDecoder>(o_);
  }

 private:
  CodecOptions o_;
};

}  // namespace

std::vector<webrtc::SdpVideoFormat> H264Formats() {
  // Level 5.1 covers 1354x1440 @ 60 fps; the ids are labels for negotiation. High first: NVENC's default profile.
  return {H264Format(webrtc::H264Profile::kProfileHigh, webrtc::H264Level::kLevel5_1),
          H264Format(webrtc::H264Profile::kProfileMain, webrtc::H264Level::kLevel5_1),
          H264Format(webrtc::H264Profile::kProfileConstrainedBaseline, webrtc::H264Level::kLevel5_1)};
}

std::unique_ptr<webrtc::VideoEncoderFactory> CreateEncoderFactory(const CodecOptions& o) {
  return std::make_unique<AvEncoderFactory>(o);
}

std::unique_ptr<webrtc::VideoDecoderFactory> CreateDecoderFactory(const CodecOptions& o) {
  return std::make_unique<AvDecoderFactory>(o);
}
