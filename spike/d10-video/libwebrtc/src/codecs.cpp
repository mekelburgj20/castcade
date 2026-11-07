#include "codecs.h"

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <deque>
#include <optional>

#include "api/environment/environment.h"
#include "api/video/encoded_image.h"
#include "api/video/i420_buffer.h"
#include "api/video/nv12_buffer.h"
#include "api/video/video_frame.h"
#include "api/video_codecs/h264_profile_level_id.h"
#include "api/video_codecs/sdp_video_format.h"
#include "api/video_codecs/video_codec.h"
#include "api/video_codecs/video_decoder.h"
#include "api/video_codecs/video_decoder_factory_template.h"
#include "api/video_codecs/video_decoder_factory_template_dav1d_adapter.h"
#include "api/video_codecs/video_decoder_factory_template_libvpx_vp8_adapter.h"
#include "api/video_codecs/video_decoder_factory_template_libvpx_vp9_adapter.h"
#include "api/video_codecs/video_decoder_factory_template_open_h264_adapter.h"
#include "api/video_codecs/video_encoder.h"
#include "api/video_codecs/video_encoder_factory_template.h"
#include "api/video_codecs/video_encoder_factory_template_libaom_av1_adapter.h"
#include "api/video_codecs/video_encoder_factory_template_libvpx_vp8_adapter.h"
#include "api/video_codecs/video_encoder_factory_template_libvpx_vp9_adapter.h"
#include "api/video_codecs/video_encoder_factory_template_open_h264_adapter.h"
#include "libyuv/convert_from.h"
#include "media/base/media_constants.h"
#include "modules/video_coding/codecs/h264/include/h264_globals.h"
#include "modules/video_coding/codecs/interface/common_constants.h"
#include "modules/video_coding/include/video_codec_interface.h"
#include "modules/video_coding/include/video_error_codes.h"
#include "rtc_base/time_utils.h"

namespace {

webrtc::SdpVideoFormat H264Format(webrtc::H264Profile profile, webrtc::H264Level level) {
  const std::optional<std::string> id =
      webrtc::H264ProfileLevelIdToString(webrtc::H264ProfileLevelId(profile, level));
  return webrtc::SdpVideoFormat(
      "H264", {{webrtc::kH264FmtpProfileLevelId, id.value_or("42e01f")},
               {webrtc::kH264FmtpLevelAsymmetryAllowed, "1"},
               {webrtc::kH264FmtpPacketizationMode, "1"}});
}

// ---------------------------------------------------------------------------------------------
// Encoder
// ---------------------------------------------------------------------------------------------
class HarnessEncoder final : public webrtc::VideoEncoder {
 public:
  explicit HarnessEncoder(const HarnessCodecOptions& o) : o_(o), h_(o.harness) {}
  ~HarnessEncoder() override { Release(); }

  int InitEncode(const webrtc::VideoCodec* codec, const Settings& /*settings*/) override {
    Release();
    width_ = codec->width;
    height_ = codec->height;
    fps_ = codec->maxFramerate > 0 ? static_cast<int>(codec->maxFramerate) : o_.fps;
    int start_kbps = codec->startBitrate > 0 ? static_cast<int>(codec->startBitrate) : o_.start_kbps;
    spike_encoder_config cfg{};
    cfg.width = width_;
    cfg.height = height_;
    cfg.fps = fps_;
    cfg.bitrate_kbps = start_kbps;
    cfg.gop_frames = 0;
    cfg.force = o_.force_encoder;
    enc_ = h_->encoder_open(&cfg);
    if (!enc_) {
      fprintf(stderr, "[enc] spike_encoder_open failed (%dx%d @%d, %d kbps)\n", width_, height_, fps_,
              start_kbps);
      return WEBRTC_VIDEO_CODEC_ERROR;
    }
    name_ = h_->encoder_name(enc_);
    if (o_.enc_stats) {
      o_.enc_stats->name = name_;
      o_.enc_stats->target_kbps = start_kbps;
      o_.enc_stats->reinits++;
    }
    scratch_.assign(static_cast<size_t>(width_) * height_ * 3 / 2, 0);
    fprintf(stderr, "[enc] harness encoder %s %dx%d @%d fps, start %d kbps\n", name_.c_str(), width_,
            height_, fps_, start_kbps);
    return WEBRTC_VIDEO_CODEC_OK;
  }

  int32_t RegisterEncodeCompleteCallback(webrtc::EncodedImageCallback* cb) override {
    callback_ = cb;
    return WEBRTC_VIDEO_CODEC_OK;
  }

  int32_t Release() override {
    if (enc_) h_->encoder_close(enc_);
    enc_ = nullptr;
    return WEBRTC_VIDEO_CODEC_OK;
  }

  int32_t Encode(const webrtc::VideoFrame& frame,
                 const std::vector<webrtc::VideoFrameType>* frame_types) override {
    if (!enc_ || !callback_) return WEBRTC_VIDEO_CODEC_UNINITIALIZED;
    if (frame.width() != width_ || frame.height() != height_) {
      // libwebrtc only changes resolution through a new InitEncode when adaptation is disabled;
      // a mismatch here means a scaled frame slipped through. Re-open at the new size.
      webrtc::VideoCodec c{};
      c.width = static_cast<uint16_t>(frame.width());
      c.height = static_cast<uint16_t>(frame.height());
      c.maxFramerate = fps_;
      c.startBitrate = o_.enc_stats ? o_.enc_stats->target_kbps.load() : o_.start_kbps;
      if (InitEncode(&c, Settings(Capabilities(false), 1, 1200)) != WEBRTC_VIDEO_CODEC_OK)
        return WEBRTC_VIDEO_CODEC_ERROR;
    }
    if (o_.enc_stats) o_.enc_stats->frames_in++;

    bool want_key = false;
    if (frame_types) {
      for (auto t : *frame_types)
        if (t == webrtc::VideoFrameType::kVideoFrameKey) want_key = true;
    }
    if (want_key) {
      h_->encoder_request_keyframe(enc_);
      if (o_.enc_stats) o_.enc_stats->keyframe_requests++;
    }

    const uint8_t* nv12 = Nv12Of(frame);
    const uint8_t* out = nullptr;
    size_t out_size = 0;
    int key = 0;
    int rc = h_->encoder_encode(enc_, nv12, frame.rtp_timestamp(), &out, &out_size, &key);
    if (o_.enc_stats) o_.enc_stats->cost_us_total += h_->encoder_last_cost_us(enc_);
    if (rc < 0) {
      if (o_.enc_stats) o_.enc_stats->errors++;
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
    image._frameType = key ? webrtc::VideoFrameType::kVideoFrameKey
                           : webrtc::VideoFrameType::kVideoFrameDelta;
    image.qp_ = -1;  // libwebrtc parses the slice QP itself when allowed; scaling is off anyway

    webrtc::CodecSpecificInfo info;
    info.codecType = webrtc::kVideoCodecH264;
    info.codecSpecific.H264.packetization_mode = webrtc::H264PacketizationMode::NonInterleaved;
    info.codecSpecific.H264.temporal_idx = webrtc::kNoTemporalIdx;
    info.codecSpecific.H264.base_layer_sync = false;
    info.codecSpecific.H264.idr_frame = key != 0;
    info.end_of_picture = true;

    if (o_.enc_stats) {
      o_.enc_stats->frames_out++;
      o_.enc_stats->bytes_out += static_cast<int64_t>(out_size);
      if (key) o_.enc_stats->keyframes++;
    }
    const auto result = callback_->OnEncodedImage(image, &info);
    return result.error == webrtc::EncodedImageCallback::Result::OK ? WEBRTC_VIDEO_CODEC_OK
                                                                     : WEBRTC_VIDEO_CODEC_ERROR;
  }

  void SetRates(const RateControlParameters& p) override {
    const int kbps = static_cast<int>(p.bitrate.get_sum_kbps());
    if (o_.enc_stats) o_.enc_stats->set_rates_calls++;
    if (kbps <= 0 || !enc_) return;
    if (kbps != last_kbps_) {
      h_->encoder_set_bitrate(enc_, kbps);
      last_kbps_ = kbps;
      if (o_.enc_stats) o_.enc_stats->target_kbps = kbps;
    }
  }

  EncoderInfo GetEncoderInfo() const override {
    EncoderInfo info;
    info.implementation_name = name_.empty() ? std::string("harness") : name_;
    info.is_hardware_accelerated = name_ != "libx264";
    info.has_trusted_rate_controller = o_.trusted_rate_controller;
    info.supports_native_handle = false;
    info.scaling_settings = VideoEncoder::ScalingSettings::kOff;
    info.requested_resolution_alignment = 2;
    info.preferred_pixel_formats = {webrtc::VideoFrameBuffer::Type::kNV12};
    info.supports_simulcast = false;
    return info;
  }

 private:
  // Returns a contiguous NV12 image (Y then UV, stride == width). Zero-copy when the buffer already is.
  const uint8_t* Nv12Of(const webrtc::VideoFrame& frame) {
    auto buffer = frame.video_frame_buffer();
    if (buffer->type() == webrtc::VideoFrameBuffer::Type::kNV12) {
      const webrtc::NV12BufferInterface* nv = buffer->GetNV12();
      if (nv->StrideY() == width_ && nv->StrideUV() == width_ &&
          nv->DataUV() == nv->DataY() + static_cast<size_t>(width_) * height_) {
        return nv->DataY();
      }
      // Strided: repack rows.
      uint8_t* y = scratch_.data();
      uint8_t* uv = y + static_cast<size_t>(width_) * height_;
      for (int r = 0; r < height_; ++r) memcpy(y + r * width_, nv->DataY() + r * nv->StrideY(), width_);
      for (int r = 0; r < (height_ + 1) / 2; ++r)
        memcpy(uv + r * width_, nv->DataUV() + r * nv->StrideUV(), width_);
      return scratch_.data();
    }
    auto i420 = buffer->ToI420();
    uint8_t* y = scratch_.data();
    uint8_t* uv = y + static_cast<size_t>(width_) * height_;
    libyuv::I420ToNV12(i420->DataY(), i420->StrideY(), i420->DataU(), i420->StrideU(), i420->DataV(),
                       i420->StrideV(), y, width_, uv, width_, width_, height_);
    conversions_++;
    return scratch_.data();
  }

  HarnessCodecOptions o_;
  const Harness* h_;
  spike_encoder* enc_ = nullptr;
  webrtc::EncodedImageCallback* callback_ = nullptr;
  std::string name_;
  int width_ = 0, height_ = 0, fps_ = 60;
  int last_kbps_ = 0;
  int64_t conversions_ = 0;
  std::vector<uint8_t> scratch_;
};

class HarnessEncoderFactory final : public webrtc::VideoEncoderFactory {
 public:
  explicit HarnessEncoderFactory(const HarnessCodecOptions& o) : o_(o) {}
  std::vector<webrtc::SdpVideoFormat> GetSupportedFormats() const override {
    return HarnessH264Formats();
  }
  std::unique_ptr<webrtc::VideoEncoder> Create(const webrtc::Environment& /*env*/,
                                               const webrtc::SdpVideoFormat& format) override {
    if (format.name != "H264") return nullptr;
    return std::make_unique<HarnessEncoder>(o_);
  }

 private:
  HarnessCodecOptions o_;
};

// ---------------------------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------------------------
class HarnessDecoder final : public webrtc::VideoDecoder {
 public:
  explicit HarnessDecoder(const HarnessCodecOptions& o) : o_(o), h_(o.harness) {}
  ~HarnessDecoder() override { Release(); }

  bool Configure(const Settings& /*settings*/) override {
    Release();
    dec_ = h_->decoder_open(o_.force_decoder);
    if (!dec_) {
      fprintf(stderr, "[dec] spike_decoder_open failed\n");
      return false;
    }
    name_ = h_->decoder_name(dec_);
    if (o_.dec_stats) o_.dec_stats->name = name_;
    black_ = webrtc::I420Buffer::Create(16, 16);
    webrtc::I420Buffer::SetBlack(black_.get());
    fprintf(stderr, "[dec] harness decoder %s\n", name_.c_str());
    return true;
  }

  int32_t Decode(const webrtc::EncodedImage& input, int64_t render_time_ms) override {
    if (!dec_ || !callback_) return WEBRTC_VIDEO_CODEC_UNINITIALIZED;
    const int64_t t_in = webrtc::TimeMillis();
    pending_.push_back({input.RtpTimestamp(), render_time_ms});
    if (pending_.size() > 64) pending_.pop_front();  // the decoder is not that deep; drop stale
    int64_t counter = -1;
    int rc = h_->decoder_decode(dec_, input.data(), input.size(), &counter);
    if (rc < 0) {
      if (o_.dec_stats) o_.dec_stats->errors++;
      return WEBRTC_VIDEO_CODEC_ERROR;
    }
    if (rc == 0) return WEBRTC_VIDEO_CODEC_OK;  // nothing out yet (decoder latency)

    Pending p = pending_.front();
    pending_.pop_front();
    if (o_.dec_stats) {
      o_.dec_stats->decoded++;
      if (counter >= 0) {
        o_.dec_stats->counter_read++;
        o_.dec_stats->last_counter = counter;
        if (o_.clock && o_.clock->t0_us.load() > 0) {
          const int64_t now = SpikeNowUs(o_.clock->harness);
          const int64_t g2g = now - (o_.clock->t0_us.load() + counter * o_.clock->period_us);
          if (g2g >= 0 && g2g < 10'000'000) {
            o_.dec_stats->g2g_us_total += g2g;
            o_.dec_stats->g2g_samples++;
            int64_t m = o_.dec_stats->g2g_us_max.load();
            while (g2g > m && !o_.dec_stats->g2g_us_max.compare_exchange_weak(m, g2g)) {
            }
          }
        }
      }
    }
    // libwebrtc matches the decoded frame to its bookkeeping by rtp timestamp; the pixels are not
    // needed (the receiver's own decoder counted the picture), so hand back a 16x16 black frame.
    webrtc::VideoFrame frame = webrtc::VideoFrame::Builder()
                                   .set_video_frame_buffer(black_)
                                   .set_rtp_timestamp(p.rtp_timestamp)
                                   .set_timestamp_ms(p.render_time_ms)
                                   .build();
    callback_->Decoded(frame, static_cast<int32_t>(webrtc::TimeMillis() - t_in), std::nullopt);
    return WEBRTC_VIDEO_CODEC_OK;
  }

  int32_t RegisterDecodeCompleteCallback(webrtc::DecodedImageCallback* cb) override {
    callback_ = cb;
    return WEBRTC_VIDEO_CODEC_OK;
  }

  int32_t Release() override {
    if (dec_) h_->decoder_close(dec_);
    dec_ = nullptr;
    pending_.clear();
    return WEBRTC_VIDEO_CODEC_OK;
  }

  DecoderInfo GetDecoderInfo() const override {
    DecoderInfo info;
    info.implementation_name = name_.empty() ? std::string("harness") : name_;
    info.is_hardware_accelerated = name_ != "h264";
    return info;
  }
  const char* ImplementationName() const override { return name_.c_str(); }

 private:
  struct Pending {
    uint32_t rtp_timestamp;
    int64_t render_time_ms;
  };
  HarnessCodecOptions o_;
  const Harness* h_;
  spike_decoder* dec_ = nullptr;
  webrtc::DecodedImageCallback* callback_ = nullptr;
  std::string name_;
  std::deque<Pending> pending_;
  webrtc::scoped_refptr<webrtc::I420Buffer> black_;
};

class HarnessDecoderFactory final : public webrtc::VideoDecoderFactory {
 public:
  explicit HarnessDecoderFactory(const HarnessCodecOptions& o) : o_(o) {}
  std::vector<webrtc::SdpVideoFormat> GetSupportedFormats() const override {
    return HarnessH264Formats();
  }
  std::unique_ptr<webrtc::VideoDecoder> Create(const webrtc::Environment& /*env*/,
                                               const webrtc::SdpVideoFormat& format) override {
    if (format.name != "H264") return nullptr;
    return std::make_unique<HarnessDecoder>(o_);
  }

 private:
  HarnessCodecOptions o_;
};

}  // namespace

std::vector<webrtc::SdpVideoFormat> HarnessH264Formats() {
  // Level 5.1 covers 1354x1440 @ 60 fps; the ids are labels for negotiation (libwebrtc does not check
  // the bitstream against them). High first: NVENC's default profile.
  return {H264Format(webrtc::H264Profile::kProfileHigh, webrtc::H264Level::kLevel5_1),
          H264Format(webrtc::H264Profile::kProfileMain, webrtc::H264Level::kLevel5_1),
          H264Format(webrtc::H264Profile::kProfileConstrainedBaseline, webrtc::H264Level::kLevel5_1),
          H264Format(webrtc::H264Profile::kProfileConstrainedBaseline, webrtc::H264Level::kLevel3_1)};
}

std::unique_ptr<webrtc::VideoEncoderFactory> CreateHarnessEncoderFactory(const HarnessCodecOptions& o) {
  return std::make_unique<HarnessEncoderFactory>(o);
}

std::unique_ptr<webrtc::VideoDecoderFactory> CreateHarnessDecoderFactory(const HarnessCodecOptions& o) {
  return std::make_unique<HarnessDecoderFactory>(o);
}

std::unique_ptr<webrtc::VideoEncoderFactory> CreateBuiltinEncoderFactory() {
  return std::make_unique<webrtc::VideoEncoderFactoryTemplate<
      webrtc::OpenH264EncoderTemplateAdapter, webrtc::LibvpxVp8EncoderTemplateAdapter,
      webrtc::LibvpxVp9EncoderTemplateAdapter, webrtc::LibaomAv1EncoderTemplateAdapter>>();
}

std::unique_ptr<webrtc::VideoDecoderFactory> CreateBuiltinDecoderFactory() {
  return std::make_unique<webrtc::VideoDecoderFactoryTemplate<
      webrtc::OpenH264DecoderTemplateAdapter, webrtc::LibvpxVp8DecoderTemplateAdapter,
      webrtc::LibvpxVp9DecoderTemplateAdapter, webrtc::Dav1dDecoderTemplateAdapter>>();
}
