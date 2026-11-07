// D10.0.1 spike harness: frame source, libavcodec encoder, decoder, clock behind the C ABI in
// include/spike_harness.h. Scratch code: not shipped. See CMakeLists.txt for the build.
#define SPIKE_HARNESS_EXPORTS
#include "spike_harness.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/hwcontext.h>
#include <libavutil/imgutils.h>
#include <libavutil/opt.h>
}
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include <algorithm>
#include <chrono>
#include <climits>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

// ---------------------------------------------------------------- clock
SPIKE_API int64_t spike_now_us(void) {
  static LARGE_INTEGER freq = [] { LARGE_INTEGER f; QueryPerformanceFrequency(&f); return f; }();
  LARGE_INTEGER c;
  QueryPerformanceCounter(&c);
  return (int64_t)((double)c.QuadPart * 1e6 / (double)freq.QuadPart);
}

// ---------------------------------------------------------------- frame source
// Counter strip geometry, shared by the source and the decoder's reader: 16 blocks of STRIP_BLOCK px,
// MSB first, starting at (STRIP_MARGIN, STRIP_MARGIN), inside a flat quiet zone so no texture abuts it.
static const int STRIP_MARGIN = 16, STRIP_BLOCK = 24, STRIP_BITS = 16;
static const int QUIET_W = STRIP_MARGIN * 2 + STRIP_BLOCK * STRIP_BITS, QUIET_H = STRIP_MARGIN * 2 + STRIP_BLOCK;
static const int NOISE = 128;  // noise block side; fresh pseudo-random Y every frame, so it costs real bits

struct spike_source { int w, h; };

SPIKE_API spike_source* spike_source_open(int width, int height) {
  if (width < QUIET_W + NOISE + 64 || height < QUIET_H + NOISE + 64 || (width & 1) || (height & 1)) return nullptr;
  return new spike_source{width, height};
}
SPIKE_API void spike_source_close(spike_source* s) { delete s; }

SPIKE_API size_t spike_source_frame(spike_source* s, uint64_t n, uint8_t* dst, size_t dst_size) {
  const int w = s->w, h = s->h;
  const size_t need = (size_t)w * h * 3 / 2;
  if (dst_size < need) return 0;
  uint8_t* Y = dst;
  uint8_t* UV = dst + (size_t)w * h;
  const int scroll = (int)(n * 3 % 64);
  const double cx = w / 2.0 + (w / 2.0 - 60) * std::sin(n * 0.071), cy = h / 2.0 + (h / 2.0 - 60) * std::sin(n * 0.113);
  const int r = 28;
  // Luma: scrolling checker + grid lines + vertical gradient.
  for (int y = 0; y < h; y++) {
    uint8_t* row = Y + (size_t)y * w;
    const int cy64 = (y / 64) & 1;
    const int gradient = y * 40 / h;
    for (int x = 0; x < w; x++) {
      const int xs = x + scroll;
      int v = 48 + gradient + ((((xs / 64) & 1) ^ cy64) ? 36 : 0);
      if ((xs & 63) == 0 || (y & 63) == 0) v = 200;
      row[x] = (uint8_t)v;
    }
  }
  // Chroma: mild checker tint (NV12 interleaved, 2x2 subsampled).
  for (int y = 0; y < h / 2; y++) {
    uint8_t* row = UV + (size_t)y * w;
    for (int x = 0; x < w / 2; x++) {
      const bool c = ((((2 * x + scroll) / 64) & 1) ^ (((2 * y) / 64) & 1)) != 0;
      row[2 * x] = c ? 118 : 138;
      row[2 * x + 1] = c ? 136 : 120;
    }
  }
  // Ball: bright, red-ish, fast.
  for (int y = std::max(0, (int)cy - r); y <= std::min(h - 1, (int)cy + r); y++)
    for (int x = std::max(0, (int)cx - r); x <= std::min(w - 1, (int)cx + r); x++) {
      const double d = std::hypot(x - cx, y - cy);
      if (d > r) continue;
      Y[(size_t)y * w + x] = d > r - 3 ? 16 : 235;
      UV[(size_t)(y / 2) * w + (x / 2) * 2] = 90;
      UV[(size_t)(y / 2) * w + (x / 2) * 2 + 1] = 240;
    }
  // Noise block, bottom right.
  uint32_t rng = (uint32_t)(n * 2654435761u + 0x9e3779b9u) | 1u;
  for (int y = h - 16 - NOISE; y < h - 16; y++)
    for (int x = w - 16 - NOISE; x < w - 16; x++) {
      rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5;
      Y[(size_t)y * w + x] = (uint8_t)(16 + ((rng >> 8) & 0xFF) * 200 / 255);
    }
  // Quiet zone + counter strip, top left.
  for (int y = 0; y < QUIET_H; y++) memset(Y + (size_t)y * w, 128, QUIET_W);
  for (int y = 0; y < QUIET_H / 2; y++) memset(UV + (size_t)y * w, 128, QUIET_W);
  for (int i = 0; i < STRIP_BITS; i++) {
    const int bit = (int)((n >> (STRIP_BITS - 1 - i)) & 1);
    for (int y = STRIP_MARGIN; y < STRIP_MARGIN + STRIP_BLOCK; y++)
      memset(Y + (size_t)y * w + STRIP_MARGIN + i * STRIP_BLOCK, bit ? 235 : 16, STRIP_BLOCK);
  }
  return need;
}

// Reads the strip back from a decoded luma plane. Returns -1 when any block is ambiguous.
static int64_t read_counter(const uint8_t* Y, int linesize, int w, int h) {
  if (w < QUIET_W || h < QUIET_H) return -1;
  int64_t v = 0;
  for (int i = 0; i < STRIP_BITS; i++) {
    int sum = 0;
    for (int y = STRIP_MARGIN + 6; y < STRIP_MARGIN + STRIP_BLOCK - 6; y++)
      for (int x = STRIP_MARGIN + i * STRIP_BLOCK + 6; x < STRIP_MARGIN + (i + 1) * STRIP_BLOCK - 6; x++) sum += Y[(size_t)y * linesize + x];
    const int mean = sum / 144;
    if (mean > 96 && mean < 160) return -1;
    v = (v << 1) | (mean >= 160 ? 1 : 0);
  }
  return v;
}

// ---------------------------------------------------------------- encoder
struct spike_encoder {
  spike_encoder_config cfg;
  std::string name;
  AVCodecContext* ctx = nullptr;
  AVFrame* frame = nullptr;
  AVPacket* pkt = nullptr;
  std::vector<uint8_t> out;  // used only when SPS/PPS had to be prepended
  bool want_idr = true;      // first frame is an IDR anyway; set by request_keyframe
  int64_t last_cost_us = 0;
  int pending_kbps = 0;      // a reopen-style bitrate change waiting for the next frame (amf/qsv)
};

static void set_opt(AVCodecContext* c, const char* k, const char* v) { av_opt_set(c->priv_data, k, v, 0); }

static AVCodecContext* open_encoder(const char* name, const spike_encoder_config* cfg, int kbps) {
  const AVCodec* codec = avcodec_find_encoder_by_name(name);
  if (!codec) return nullptr;
  AVCodecContext* c = avcodec_alloc_context3(codec);
  c->width = cfg->width;
  c->height = cfg->height;
  c->time_base = {1, 90000};
  c->framerate = {cfg->fps, 1};
  c->pix_fmt = AV_PIX_FMT_NV12;
  c->bit_rate = (int64_t)kbps * 1000;
  c->rc_max_rate = c->bit_rate;
  c->rc_buffer_size = (int)(c->bit_rate / 20);  // 50 ms of VBV: low latency, CBR-ish
  c->gop_size = cfg->gop_frames > 0 ? cfg->gop_frames : (1 << 30);
  c->max_b_frames = 0;
  c->thread_count = 0;
  // No AV_CODEC_FLAG_GLOBAL_HEADER: every wrapper here then repeats SPS/PPS in band on each IDR.
  std::string n = name;
  if (n == "h264_nvenc") {
    set_opt(c, "preset", "p4"); set_opt(c, "tune", "ll"); set_opt(c, "rc", "cbr");
    set_opt(c, "zerolatency", "1"); set_opt(c, "delay", "0"); set_opt(c, "forced-idr", "1");
    set_opt(c, "no-scenecut", "1"); set_opt(c, "b_ref_mode", "disabled");
  } else if (n == "h264_amf") {
    set_opt(c, "usage", "lowlatency"); set_opt(c, "rc", "cbr"); set_opt(c, "header_insertion_mode", "idr");
    set_opt(c, "enforce_hrd", "1"); set_opt(c, "quality", "speed");
  } else if (n == "h264_qsv") {
    set_opt(c, "preset", "veryfast"); set_opt(c, "look_ahead", "0"); set_opt(c, "async_depth", "1");
    set_opt(c, "forced_idr", "1"); set_opt(c, "repeat_pps", "1");
  } else if (n == "libx264") {
    set_opt(c, "preset", "veryfast"); set_opt(c, "tune", "zerolatency"); set_opt(c, "forced-idr", "1");
    set_opt(c, "x264-params", "repeat-headers=1:annexb=1:scenecut=0");
  }
  if (avcodec_open2(c, codec, nullptr) < 0) { avcodec_free_context(&c); return nullptr; }
  return c;
}

SPIKE_API spike_encoder* spike_encoder_open(const spike_encoder_config* cfg) {
  static const char* order[] = {"h264_nvenc", "h264_amf", "h264_qsv", "libx264"};
  spike_encoder* e = new spike_encoder();
  e->cfg = *cfg;
  if (cfg->force) {
    e->ctx = open_encoder(cfg->force, cfg, cfg->bitrate_kbps);
    if (e->ctx) e->name = cfg->force;
  } else {
    for (const char* n : order) {
      e->ctx = open_encoder(n, cfg, cfg->bitrate_kbps);
      if (e->ctx) { e->name = n; break; }
    }
  }
  if (!e->ctx) { delete e; return nullptr; }
  e->frame = av_frame_alloc();
  e->pkt = av_packet_alloc();
  return e;
}

SPIKE_API const char* spike_encoder_name(spike_encoder* e) { return e->name.c_str(); }

static bool has_nal(const uint8_t* p, size_t n, int type) {
  for (size_t i = 0; i + 3 < n; i++)
    if (p[i] == 0 && p[i + 1] == 0 && (p[i + 2] == 1 || (p[i + 2] == 0 && i + 4 < n && p[i + 3] == 1))) {
      size_t h = i + (p[i + 2] == 1 ? 3 : 4);
      if (h < n && (p[h] & 0x1F) == type) return true;
      i = h - 1;
    }
  return false;
}

SPIKE_API int spike_encoder_encode(spike_encoder* e, const uint8_t* nv12, uint64_t pts_90k,
                                   const uint8_t** out, size_t* out_size, int* keyframe) {
  av_packet_unref(e->pkt);
  if (e->pending_kbps) {  // amf/qsv: reopen with the new rate, then the next frame is an IDR
    AVCodecContext* c = open_encoder(e->name.c_str(), &e->cfg, e->pending_kbps);
    if (c) { avcodec_free_context(&e->ctx); e->ctx = c; e->want_idr = true; }
    e->pending_kbps = 0;
  }
  AVFrame* f = e->frame;
  av_frame_unref(f);
  f->format = AV_PIX_FMT_NV12;
  f->width = e->cfg.width;
  f->height = e->cfg.height;
  f->data[0] = const_cast<uint8_t*>(nv12);
  f->data[1] = const_cast<uint8_t*>(nv12) + (size_t)e->cfg.width * e->cfg.height;
  f->linesize[0] = f->linesize[1] = e->cfg.width;
  f->pts = (int64_t)pts_90k;
  if (e->want_idr) { f->pict_type = AV_PICTURE_TYPE_I; f->flags |= AV_FRAME_FLAG_KEY; e->want_idr = false; }
  else f->pict_type = AV_PICTURE_TYPE_NONE;
  const int64_t t0 = spike_now_us();
  int r = avcodec_send_frame(e->ctx, f);
  if (r < 0) return r;
  r = avcodec_receive_packet(e->ctx, e->pkt);
  e->last_cost_us = spike_now_us() - t0;
  if (r == AVERROR(EAGAIN)) return 1;
  if (r < 0) return r;
  *keyframe = (e->pkt->flags & AV_PKT_FLAG_KEY) ? 1 : 0;
  *out = e->pkt->data;
  *out_size = (size_t)e->pkt->size;
  // Belt and braces: an IDR without an in-band SPS gets the codec's Annex B extradata in front.
  if (*keyframe && !has_nal(e->pkt->data, e->pkt->size, 7) && e->ctx->extradata_size > 3 && e->ctx->extradata[0] == 0) {
    e->out.assign(e->ctx->extradata, e->ctx->extradata + e->ctx->extradata_size);
    e->out.insert(e->out.end(), e->pkt->data, e->pkt->data + e->pkt->size);
    *out = e->out.data();
    *out_size = e->out.size();
  }
  return 0;
}

SPIKE_API int spike_encoder_set_bitrate(spike_encoder* e, int kbps) {
  if (kbps <= 0) return -1;
  // nvenc and libx264 both pick up bit_rate / rc_max_rate / rc_buffer_size changes on the next frame
  // (nvenc: reconfig_encoder → NvEncReconfigureEncoder; x264: x264_encoder_reconfig). No reopen, no IDR.
  if (e->name == "h264_nvenc" || e->name == "libx264") {
    e->ctx->bit_rate = (int64_t)kbps * 1000;
    e->ctx->rc_max_rate = e->ctx->bit_rate;
    e->ctx->rc_buffer_size = (int)(e->ctx->bit_rate / 20);
    return 0;
  }
  // amf / qsv: not verified to reconfigure live here; reopen on the next encode and force an IDR.
  e->pending_kbps = kbps;
  return 0;
}

SPIKE_API int spike_encoder_request_keyframe(spike_encoder* e) { e->want_idr = true; return 0; }
SPIKE_API int64_t spike_encoder_last_cost_us(spike_encoder* e) { return e->last_cost_us; }

SPIKE_API void spike_encoder_close(spike_encoder* e) {
  if (!e) return;
  av_packet_free(&e->pkt);
  av_frame_free(&e->frame);
  avcodec_free_context(&e->ctx);
  delete e;
}

// ---------------------------------------------------------------- decoder
struct spike_decoder {
  std::string name;
  AVCodecContext* ctx = nullptr;
  AVBufferRef* hw = nullptr;
  AVFrame* frame = nullptr;
  AVFrame* sw = nullptr;
  AVPacket* pkt = nullptr;
};

static AVPixelFormat pick_d3d11(AVCodecContext*, const AVPixelFormat* fmts) {
  for (const AVPixelFormat* p = fmts; *p != AV_PIX_FMT_NONE; p++)
    if (*p == AV_PIX_FMT_D3D11) return *p;
  return fmts[0];  // hwaccel unavailable: libavcodec falls back to the software path
}

static bool open_decoder(spike_decoder* d, const char* which) {
  std::string w = which;
  const AVCodec* codec = avcodec_find_decoder_by_name(w == "d3d11va" ? "h264" : which);
  if (!codec) return false;
  AVCodecContext* c = avcodec_alloc_context3(codec);
  c->flags |= AV_CODEC_FLAG_LOW_DELAY;
  c->thread_count = 1;
  c->pkt_timebase = {1, 90000};
  if (w == "d3d11va") {
    if (av_hwdevice_ctx_create(&d->hw, AV_HWDEVICE_TYPE_D3D11VA, nullptr, nullptr, 0) < 0) { avcodec_free_context(&c); return false; }
    c->hw_device_ctx = av_buffer_ref(d->hw);
    c->get_format = pick_d3d11;
  }
  if (avcodec_open2(c, codec, nullptr) < 0) { avcodec_free_context(&c); av_buffer_unref(&d->hw); return false; }
  d->ctx = c;
  d->name = w == "d3d11va" ? "h264+d3d11va" : which;
  return true;
}

SPIKE_API spike_decoder* spike_decoder_open(const char* force) {
  static const char* order[] = {"h264_cuvid", "d3d11va", "h264"};
  spike_decoder* d = new spike_decoder();
  bool ok = false;
  if (force) ok = open_decoder(d, force);
  else for (const char* n : order) if ((ok = open_decoder(d, n))) break;
  if (!ok) { delete d; return nullptr; }
  d->frame = av_frame_alloc();
  d->sw = av_frame_alloc();
  d->pkt = av_packet_alloc();
  return d;
}

SPIKE_API const char* spike_decoder_name(spike_decoder* d) { return d->name.c_str(); }

// Returns the number of pictures that came out (normally 1; 0 if the decoder is still holding
// the first frame), *frame_counter is read from the last of them.
SPIKE_API int spike_decoder_decode(spike_decoder* d, const uint8_t* annexb, size_t size, int64_t* frame_counter) {
  av_packet_unref(d->pkt);
  if (annexb && size) {
    if (av_new_packet(d->pkt, (int)size) < 0) return -1;
    memcpy(d->pkt->data, annexb, size);
  }
  int r = avcodec_send_packet(d->ctx, (annexb && size) ? d->pkt : nullptr);
  if (r < 0 && r != AVERROR_EOF) return r;
  int got = 0;
  for (;;) {
    r = avcodec_receive_frame(d->ctx, d->frame);
    if (r == AVERROR(EAGAIN) || r == AVERROR_EOF) break;
    if (r < 0) return r;
    AVFrame* f = d->frame;
    if (f->format == AV_PIX_FMT_D3D11 || f->format == AV_PIX_FMT_CUDA) {
      av_frame_unref(d->sw);
      if (av_hwframe_transfer_data(d->sw, f, 0) < 0) { *frame_counter = -1; got++; av_frame_unref(f); continue; }
      f = d->sw;
    }
    *frame_counter = (f->format == AV_PIX_FMT_NV12 || f->format == AV_PIX_FMT_YUV420P)
                         ? read_counter(f->data[0], f->linesize[0], f->width, f->height) : -1;
    got++;
    av_frame_unref(d->frame);
  }
  return got;
}

SPIKE_API void spike_decoder_close(spike_decoder* d) {
  if (!d) return;
  av_packet_free(&d->pkt);
  av_frame_free(&d->sw);
  av_frame_free(&d->frame);
  avcodec_free_context(&d->ctx);
  av_buffer_unref(&d->hw);
  delete d;
}
