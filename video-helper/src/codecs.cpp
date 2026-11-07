#include "codecs.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/hwcontext.h>
#include <libavutil/imgutils.h>
#include <libavutil/log.h>
#include <libavutil/opt.h>
}

#include <cstdio>
#include <cstdlib>
#include <cstring>

#include "util.h"

namespace {

void set_opt(AVCodecContext* c, const char* k, const char* v) { av_opt_set(c->priv_data, k, v, 0); }

std::string AvErr(int r) {
  char buf[AV_ERROR_MAX_STRING_SIZE] = {0};
  av_strerror(r, buf, sizeof buf);
  return buf;
}

bool has_nal(const uint8_t* p, size_t n, int type) {
  for (size_t i = 0; i + 3 < n; i++)
    if (p[i] == 0 && p[i + 1] == 0 && (p[i + 2] == 1 || (p[i + 2] == 0 && i + 4 < n && p[i + 3] == 1))) {
      size_t h = i + (p[i + 2] == 1 ? 3 : 4);
      if (h < n && (p[h] & 0x1F) == type) return true;
      i = h - 1;
    }
  return false;
}

void AvLogCallback(void* ptr, int level, const char* fmt, va_list vl) {
  if (level > AV_LOG_WARNING || level > av_log_get_level()) return;
  char line[1024];
  int print_prefix = 1;
  av_log_format_line(ptr, level, fmt, vl, line, sizeof line, &print_prefix);
  size_t n = strlen(line);
  while (n && (line[n - 1] == '\n' || line[n - 1] == '\r')) line[--n] = 0;
  if (n) LogLine("avcodec: %s", line);
}

}  // namespace

void InstallAvLog() {
  av_log_set_level(AV_LOG_WARNING);
  av_log_set_callback(AvLogCallback);
}

bool CheckAvLinked(std::string* detail) {
  // Guards the link order of CMakeLists.txt: the calls must reach the BtbN DLLs beside the exe, not the ffmpeg
  // objects inside webrtc.lib (those know no encoder at all).
  const unsigned v = avcodec_version();
  char buf[256];
  snprintf(buf, sizeof buf, "libavcodec %u.%u.%u (%s), built against %d.%d.%d", v >> 16, (v >> 8) & 0xFF, v & 0xFF,
           av_version_info(), LIBAVCODEC_VERSION_MAJOR, LIBAVCODEC_VERSION_MINOR, LIBAVCODEC_VERSION_MICRO);
  *detail = buf;
  return (v >> 16) == LIBAVCODEC_VERSION_MAJOR && avcodec_find_encoder_by_name("libx264") != nullptr;
}

const char* RatePolicyName(RatePolicy p) { return p == RatePolicy::kLimited ? "limited" : "naive"; }

bool ParseRatePolicy(const std::string& s, RatePolicy* out) {
  if (s == "limited") { *out = RatePolicy::kLimited; return true; }
  if (s == "naive") { *out = RatePolicy::kNaive; return true; }
  return false;
}

// ---------------------------------------------------------------- encoder

bool Encoder::OpenContext(const std::string& name, int kbps) {
  const AVCodec* codec = avcodec_find_encoder_by_name(name.c_str());
  if (!codec) {
    LogLine("encoder %s: not in this libavcodec", name.c_str());
    return false;
  }
  AVCodecContext* c = avcodec_alloc_context3(codec);
  c->width = cfg_.width;
  c->height = cfg_.height;
  c->time_base = {1, 90000};
  c->framerate = {cfg_.fps, 1};
  c->pix_fmt = AV_PIX_FMT_NV12;
  c->bit_rate = (int64_t)kbps * 1000;
  c->rc_max_rate = c->bit_rate;
  c->rc_buffer_size = (int)(c->bit_rate / 20);  // 50 ms of VBV: low latency, CBR-ish
  c->gop_size = 1 << 30;                         // IDR only on request (libwebrtc asks when it needs one)
  c->max_b_frames = 0;
  c->thread_count = 0;
  // No AV_CODEC_FLAG_GLOBAL_HEADER: every wrapper here then repeats SPS/PPS in band on each IDR.
  if (name == "h264_nvenc") {
    set_opt(c, "preset", "p4"); set_opt(c, "tune", "ll"); set_opt(c, "rc", "cbr");
    set_opt(c, "zerolatency", "1"); set_opt(c, "delay", "0"); set_opt(c, "forced-idr", "1");
    set_opt(c, "no-scenecut", "1"); set_opt(c, "b_ref_mode", "disabled");
  } else if (name == "h264_amf") {
    set_opt(c, "usage", "lowlatency"); set_opt(c, "rc", "cbr"); set_opt(c, "header_insertion_mode", "idr");
    set_opt(c, "enforce_hrd", "1"); set_opt(c, "quality", "speed");
  } else if (name == "h264_qsv") {
    set_opt(c, "preset", "veryfast"); set_opt(c, "look_ahead", "0"); set_opt(c, "async_depth", "1");
    set_opt(c, "forced_idr", "1"); set_opt(c, "repeat_pps", "1");
  } else if (name == "libx264") {
    set_opt(c, "preset", "veryfast"); set_opt(c, "tune", "zerolatency"); set_opt(c, "forced-idr", "1");
    set_opt(c, "x264-params", "repeat-headers=1:annexb=1:scenecut=0");
  }
  const int r = avcodec_open2(c, codec, nullptr);
  if (r < 0) {
    LogLine("encoder %s: avcodec_open2: %s", name.c_str(), AvErr(r).c_str());
    avcodec_free_context(&c);
    return false;
  }
  if (ctx_) avcodec_free_context(&ctx_);
  ctx_ = c;
  name_ = name;
  return true;
}

std::unique_ptr<Encoder> Encoder::Open(const EncoderConfig& cfg, std::string* error) {
  static const char* order[] = {"h264_nvenc", "h264_amf", "h264_qsv", "libx264"};
  std::unique_ptr<Encoder> e(new Encoder());
  e->cfg_ = cfg;
  if (cfg.width <= 0 || cfg.height <= 0 || (cfg.width & 1) || (cfg.height & 1) || cfg.fps <= 0 || cfg.kbps <= 0) {
    if (error) *error = "bad encoder config";
    return nullptr;
  }
  bool ok = false;
  if (!cfg.force.empty()) ok = e->OpenContext(cfg.force, cfg.kbps);
  else for (const char* n : order) if ((ok = e->OpenContext(n, cfg.kbps))) break;
  if (!ok) {
    if (error) *error = cfg.force.empty() ? "no H.264 encoder opened" : "encoder " + cfg.force + " did not open";
    return nullptr;
  }
  e->frame_ = av_frame_alloc();
  e->pkt_ = av_packet_alloc();
  e->applied_kbps_ = e->wanted_kbps_ = cfg.kbps;
  e->last_apply_us_ = NowUs();
  return e;
}

Encoder::~Encoder() {
  av_packet_free(&pkt_);
  av_frame_free(&frame_);
  avcodec_free_context(&ctx_);
}

bool Encoder::ApplyRate(int kbps, int64_t now_us) {
  // nvenc and libx264 pick up bit_rate / rc_max_rate / rc_buffer_size on the next frame (nvenc: reconfig_encoder →
  // NvEncReconfigureEncoder, which the wrapper issues with forceIDR: one IDR per applied change, measured by --bench,
  // the same with the VBV size held; x264: x264_encoder_reconfig, no IDR). amf / qsv are not verified to reconfigure
  // live: reopen on the next encode, which costs an IDR anyway.
  if (name_ == "h264_nvenc" || name_ == "libx264") {
    ctx_->bit_rate = (int64_t)kbps * 1000;
    ctx_->rc_max_rate = ctx_->bit_rate;
    ctx_->rc_buffer_size = (int)(ctx_->bit_rate / 20);
  } else {
    pending_reopen_kbps_ = kbps;
  }
  applied_kbps_ = kbps;
  last_apply_us_ = now_us;
  rate_changes_++;
  return true;
}

bool Encoder::SetTargetKbps(int kbps, int64_t now_us) {
  if (kbps <= 0 || !ctx_) return false;
  wanted_kbps_ = kbps;
  if (kbps == applied_kbps_) return false;
  if (cfg_.policy == RatePolicy::kNaive || applied_kbps_ <= 0) return ApplyRate(kbps, now_us);
  const double change = (double)(kbps - applied_kbps_) / (double)applied_kbps_;
  if (change <= -0.30) return ApplyRate(kbps, now_us);                                   // a real drop: at once
  if (change >= 0.10 || change <= -0.10) {
    if (now_us - last_apply_us_ >= 1000000) return ApplyRate(kbps, now_us);              // at most once a second
  }
  return false;  // held; re-checked on the next SetTargetKbps or Encode
}

int Encoder::Encode(const uint8_t* y, int stride_y, const uint8_t* uv, int stride_uv, uint64_t pts_90k,
                    const uint8_t** out, size_t* out_size, bool* keyframe) {
  if (wanted_kbps_ != applied_kbps_) SetTargetKbps(wanted_kbps_, NowUs());  // a held change whose second has passed
  av_packet_unref(pkt_);
  if (pending_reopen_kbps_) {
    const int k = pending_reopen_kbps_;
    pending_reopen_kbps_ = 0;
    if (OpenContext(name_, k)) want_idr_ = true;
  }
  AVFrame* f = frame_;
  av_frame_unref(f);
  f->format = AV_PIX_FMT_NV12;
  f->width = cfg_.width;
  f->height = cfg_.height;
  f->data[0] = const_cast<uint8_t*>(y);
  f->data[1] = const_cast<uint8_t*>(uv);
  f->linesize[0] = stride_y;
  f->linesize[1] = stride_uv;
  f->pts = (int64_t)pts_90k;
  if (want_idr_) {
    f->pict_type = AV_PICTURE_TYPE_I;
    f->flags |= AV_FRAME_FLAG_KEY;
    want_idr_ = false;
  } else {
    f->pict_type = AV_PICTURE_TYPE_NONE;
  }
  const int64_t t0 = NowUs();
  int r = avcodec_send_frame(ctx_, f);
  if (r < 0) return r;
  r = avcodec_receive_packet(ctx_, pkt_);
  last_cost_us_ = NowUs() - t0;
  if (r == AVERROR(EAGAIN)) return 1;
  if (r < 0) return r;
  *keyframe = (pkt_->flags & AV_PKT_FLAG_KEY) != 0;
  if (*keyframe) idr_count_++;
  *out = pkt_->data;
  *out_size = (size_t)pkt_->size;
  // Belt and braces: an IDR without an in-band SPS gets the codec's Annex B extradata in front.
  if (*keyframe && !has_nal(pkt_->data, pkt_->size, 7) && ctx_->extradata_size > 3 && ctx_->extradata[0] == 0) {
    out_.assign((const char*)ctx_->extradata, ctx_->extradata_size);
    out_.append((const char*)pkt_->data, pkt_->size);
    *out = (const uint8_t*)out_.data();
    *out_size = out_.size();
  }
  return 0;
}

// ---------------------------------------------------------------- decoder

namespace {
AVPixelFormat pick_d3d11(AVCodecContext*, const AVPixelFormat* fmts) {
  for (const AVPixelFormat* p = fmts; *p != AV_PIX_FMT_NONE; p++)
    if (*p == AV_PIX_FMT_D3D11) return *p;
  return fmts[0];  // hwaccel unavailable: libavcodec falls back to the software path
}
}  // namespace

bool Decoder::OpenContext(const std::string& which) {
  const AVCodec* codec = avcodec_find_decoder_by_name(which == "d3d11va" ? "h264" : which.c_str());
  if (!codec) {
    LogLine("decoder %s: not in this libavcodec", which.c_str());
    return false;
  }
  AVCodecContext* c = avcodec_alloc_context3(codec);
  c->flags |= AV_CODEC_FLAG_LOW_DELAY;
  c->thread_count = 1;
  c->pkt_timebase = {1, 90000};
  if (which == "d3d11va") {
    const int hr = av_hwdevice_ctx_create(&hw_, AV_HWDEVICE_TYPE_D3D11VA, nullptr, nullptr, 0);
    if (hr < 0) {
      LogLine("decoder d3d11va: av_hwdevice_ctx_create: %s", AvErr(hr).c_str());
      avcodec_free_context(&c);
      return false;
    }
    c->hw_device_ctx = av_buffer_ref(hw_);
    c->get_format = pick_d3d11;
  }
  const int r = avcodec_open2(c, codec, nullptr);
  if (r < 0) {
    LogLine("decoder %s: avcodec_open2: %s", which.c_str(), AvErr(r).c_str());
    avcodec_free_context(&c);
    av_buffer_unref(&hw_);
    return false;
  }
  ctx_ = c;
  name_ = which == "d3d11va" ? "h264+d3d11va" : which;
  return true;
}

std::unique_ptr<Decoder> Decoder::Open(const std::string& force, std::string* error) {
  static const char* order[] = {"h264_cuvid", "d3d11va", "h264"};
  std::unique_ptr<Decoder> d(new Decoder());
  bool ok = false;
  if (!force.empty()) ok = d->OpenContext(force == "h264+d3d11va" ? "d3d11va" : force);
  else for (const char* n : order) if ((ok = d->OpenContext(n))) break;
  if (!ok) {
    if (error) *error = force.empty() ? "no H.264 decoder opened" : "decoder " + force + " did not open";
    return nullptr;
  }
  d->frame_ = av_frame_alloc();
  d->sw_ = av_frame_alloc();
  d->pkt_ = av_packet_alloc();
  return d;
}

Decoder::~Decoder() {
  av_packet_free(&pkt_);
  av_frame_free(&sw_);
  av_frame_free(&frame_);
  avcodec_free_context(&ctx_);
  av_buffer_unref(&hw_);
}

int Decoder::Decode(const uint8_t* annexb, size_t size, int64_t pts_90k,
                    const std::function<void(const DecodedPicture&)>& on_picture) {
  const int64_t t0 = NowUs();
  av_packet_unref(pkt_);
  if (annexb && size) {
    if (av_new_packet(pkt_, (int)size) < 0) return -1;
    memcpy(pkt_->data, annexb, size);
    pkt_->pts = pts_90k;
  }
  int r = avcodec_send_packet(ctx_, (annexb && size) ? pkt_ : nullptr);
  if (r < 0 && r != AVERROR_EOF) return r;
  int got = 0;
  for (;;) {
    r = avcodec_receive_frame(ctx_, frame_);
    if (r == AVERROR(EAGAIN) || r == AVERROR_EOF) break;
    if (r < 0) return r;
    AVFrame* f = frame_;
    if (f->format == AV_PIX_FMT_D3D11 || f->format == AV_PIX_FMT_CUDA) {
      av_frame_unref(sw_);
      if (av_hwframe_transfer_data(sw_, f, 0) < 0) {
        av_frame_unref(frame_);
        continue;
      }
      f = sw_;
    }
    if (f->format == AV_PIX_FMT_NV12 || f->format == AV_PIX_FMT_YUV420P || f->format == AV_PIX_FMT_YUVJ420P) {
      DecodedPicture p;
      p.width = f->width;
      p.height = f->height;
      p.nv12 = f->format == AV_PIX_FMT_NV12;
      p.y = f->data[0];
      p.uv = f->data[1];
      p.v = p.nv12 ? nullptr : f->data[2];
      p.stride_y = f->linesize[0];
      p.stride_uv = f->linesize[1];
      p.stride_v = p.nv12 ? 0 : f->linesize[2];
      p.pts_90k = frame_->pts;
      last_cost_us_ = NowUs() - t0;
      got++;
      on_picture(p);
    }
    av_frame_unref(frame_);
  }
  if (!got) last_cost_us_ = NowUs() - t0;
  return got;
}

// ---------------------------------------------------------------- probe

ProbeResult ProbeCodecs(int width, int height, int fps) {
  ProbeResult r;
  const int saved_level = av_log_get_level();
  av_log_set_level(AV_LOG_QUIET);  // candidates that are not there (AMF, QSV, cuvid on other vendors) complain loudly
  std::string av;
  if (!CheckAvLinked(&av)) LogLine("probe: WARNING: %s: not the expected FFmpeg build", av.c_str());
  else LogLine("probe: %s", av.c_str());
  static const char* enc_order[] = {"h264_nvenc", "h264_amf", "h264_qsv", "libx264"};
  for (const char* n : enc_order) {
    EncoderConfig cfg;
    cfg.width = width;
    cfg.height = height;
    cfg.fps = fps;
    cfg.kbps = 8000;
    cfg.force = n;
    std::string err;
    const int64_t t0 = NowUs();
    auto e = Encoder::Open(cfg, &err);
    LogLine("probe: encoder %s: %s (%lld ms)", n, e ? "opened" : "no", (long long)((NowUs() - t0) / 1000));
    if (e && r.encoder.empty()) r.encoder = n;
    e.reset();
  }
  static const char* dec_order[] = {"h264_cuvid", "d3d11va", "h264"};
  for (const char* n : dec_order) {
    std::string err;
    const int64_t t0 = NowUs();
    auto d = Decoder::Open(n, &err);
    LogLine("probe: decoder %s: %s (%lld ms)", n, d ? "opened" : "no", (long long)((NowUs() - t0) / 1000));
    if (d && r.decoder.empty()) r.decoder = d->name();
    d.reset();
  }
  av_log_set_level(saved_level);
  return r;
}
