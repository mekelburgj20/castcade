#include "bench.h"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <thread>
#include <vector>

#include "api/video/nv12_buffer.h"

#include "gpu.h"
#include "source.h"
#include "util.h"

int RunBench(const BenchOptions& o) {
  if (o.width < 480 || o.height < 300 || (o.width & 1) || (o.height & 1) || o.fps <= 0 || o.seconds <= 0 || o.kbps <= 0) {
    fprintf(stderr, "castcade-video: bad bench size / fps / seconds / kbps\n");
    return 64;
  }
  Nvml nvml;
  const bool have_nvml = nvml.Load();
  GpuLoad load;
  if (o.gpu_load) {
    std::string err;
    if (!load.Start(&err)) LogLine("bench: --gpu-load not running: %s", err.c_str());
  }
  EncoderConfig cfg;
  cfg.width = o.width;
  cfg.height = o.height;
  cfg.fps = o.fps;
  cfg.kbps = o.kbps;
  cfg.force = o.encoder;
  cfg.policy = o.policy;
  std::string err;
  auto enc = Encoder::Open(cfg, &err);
  if (!enc) {
    fprintf(stderr, "castcade-video: %s\n", err.c_str());
    return 2;
  }
  LogLine("bench: %s %dx%d @%d fps, %d kbps, %d s, policy %s, jitter %d %%, gpu-load %s, nvml %s", enc->name().c_str(),
          o.width, o.height, o.fps, o.kbps, o.seconds, RatePolicyName(o.policy), o.jitter_pct,
          load.running() ? "on" : "off", have_nvml ? "yes" : "no");

  const int stride = o.width * 4;
  std::vector<uint8_t> bgra((size_t)stride * o.height);
  auto nv12 = webrtc::NV12Buffer::Create(o.width, o.height);
  const int64_t period_us = 1000000 / o.fps;
  const int64_t total_frames = (int64_t)o.seconds * o.fps;
  const int64_t step1 = total_frames / 3, step2 = total_frames * 2 / 3;

  printf("t,encoder,fps,kbps,convert_us,enc_us_avg,enc_us_max,pstate,applied_kbps,idr\n");
  fflush(stdout);

  // Per-second window
  int64_t w_frames = 0, w_bytes = 0, w_conv_us = 0, w_enc_us = 0, w_enc_max = 0, w_idr = 0;
  // Whole run
  int64_t frames = 0, bytes = 0, conv_us = 0, enc_us = 0, enc_max = 0, idr_first = 0, idr_steps = 0, idr_other = 0;
  int64_t first_sec_enc_us = 0, last_sec_enc_us = 0;
  std::string pstate_first = "-", pstate_last = "-";
  int64_t idr_step1 = 0, idr_step2 = 0;
  uint32_t rng = 0x2545F491u;
  int64_t last_step_frame = -1000000;
  int64_t next_jitter_frame = 0;
  int wanted = o.kbps;

  const int64_t t0 = NowUs();
  int sec = 1;
  for (int64_t n = 0; n < total_frames; n++) {
    const int64_t due = t0 + n * period_us;
    for (;;) {
      const int64_t wait = due - NowUs();
      if (wait <= 0) break;
      std::this_thread::sleep_for(std::chrono::microseconds(std::min<int64_t>(wait, 1500)));
    }
    // The target schedule: full → a quarter at 1/3 → full at 2/3, wobbling by ±jitter every 200 ms like an estimate.
    const int base = (n >= step1 && n < step2) ? o.kbps / 4 : o.kbps;
    if (n == step1 || n == step2) {
      last_step_frame = n;
      wanted = base;
      enc->SetTargetKbps(wanted, NowUs());
    } else if (n >= next_jitter_frame) {
      next_jitter_frame = n + std::max<int64_t>(1, o.fps / 5);
      rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5;
      const double j = o.jitter_pct ? ((int)(rng % 2001) - 1000) / 1000.0 * o.jitter_pct / 100.0 : 0.0;
      wanted = (int)(base * (1.0 + j));
      enc->SetTargetKbps(wanted, NowUs());
    }

    BenchPattern((uint64_t)n, o.width, o.height, bgra.data(), stride);
    const int64_t c = ConvertBgraToNv12(bgra.data(), stride, o.width, o.height, nv12.get());
    const uint8_t* out;
    size_t out_size;
    bool key = false;
    const int r = enc->Encode(nv12->DataY(), nv12->StrideY(), nv12->DataUV(), nv12->StrideUV(), (uint64_t)n * 90000 / o.fps, &out, &out_size, &key);
    if (r < 0) {
      fprintf(stderr, "castcade-video: encode error %d at frame %lld\n", r, (long long)n);
      return 1;
    }
    const int64_t e = enc->last_cost_us();
    w_frames++; frames++;
    w_conv_us += c; conv_us += c;
    w_enc_us += e; enc_us += e;
    w_enc_max = std::max(w_enc_max, e); enc_max = std::max(enc_max, e);
    if (r == 0) { w_bytes += out_size; bytes += out_size; }
    if (key) {
      w_idr++;
      if (n == 0) idr_first++;
      else if (n - last_step_frame < (int64_t)o.fps * 3 / 2) { idr_steps++; if (last_step_frame == step1) idr_step1++; else idr_step2++; }
      else idr_other++;
    }

    if (NowUs() - t0 >= (int64_t)sec * 1000000 || n + 1 == total_frames) {
      const std::string ps = have_nvml ? nvml.PState() : "-";
      if (sec == 1) { pstate_first = ps; first_sec_enc_us = w_frames ? w_enc_us / w_frames : 0; }
      pstate_last = ps;
      last_sec_enc_us = w_frames ? w_enc_us / w_frames : 0;
      printf("%d,%s,%lld,%lld,%lld,%lld,%lld,%s,%d,%lld\n", sec, enc->name().c_str(), (long long)w_frames,
             (long long)(w_bytes * 8 / 1000), (long long)(w_frames ? w_conv_us / w_frames : 0),
             (long long)(w_frames ? w_enc_us / w_frames : 0), (long long)w_enc_max, ps.c_str(), enc->applied_kbps(), (long long)w_idr);
      fflush(stdout);
      w_frames = w_bytes = w_conv_us = w_enc_us = w_enc_max = w_idr = 0;
      sec++;
    }
  }
  const double secs = (NowUs() - t0) / 1e6;
  printf("summary: encoder=%s frames=%lld fps=%.1f kbps_avg=%lld convert_us_avg=%lld enc_us_avg=%lld enc_us_max=%lld "
         "enc_us_first_s=%lld enc_us_last_s=%lld pstate_first=%s pstate_last=%s gpu_load=%s policy=%s jitter_pct=%d "
         "rate_changes_applied=%lld idr_total=%lld idr_first=%lld idr_at_step_down=%lld idr_at_step_up=%lld idr_other=%lld\n",
         enc->name().c_str(), (long long)frames, frames / secs, (long long)(bytes * 8 / 1000 / (int64_t)std::max(1.0, secs)),
         (long long)(frames ? conv_us / frames : 0), (long long)(frames ? enc_us / frames : 0), (long long)enc_max,
         (long long)first_sec_enc_us, (long long)last_sec_enc_us, pstate_first.c_str(), pstate_last.c_str(),
         load.running() ? "on" : "off", RatePolicyName(o.policy), o.jitter_pct,
         (long long)enc->rate_changes_applied(), (long long)enc->idr_count(), (long long)idr_first, (long long)idr_step1,
         (long long)idr_step2, (long long)idr_other);
  fflush(stdout);
  load.Stop();
  return 0;
}
