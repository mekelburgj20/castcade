// castcade-video `--bench`: synthetic BGRA frames → libyuv NV12 → the probed encoder at the source's fps, one line a
// second (t, encoder, fps, kbps, convert_us, enc_us_avg, enc_us_max, pstate, applied_kbps, idr) and a summary. The
// target bitrate steps down at 1/3 of the run and back up at 2/3 (with a small GCC-like jitter in between) so the
// IDRs each rate policy costs can be counted (D10.1.1); `--gpu-load` keeps the GPU clocked (D10.1.2).
#pragma once

#include <string>

#include "codecs.h"

struct BenchOptions {
  int seconds = 10;
  int width = 1354, height = 1440, fps = 60;
  int kbps = 20000;
  bool gpu_load = false;
  RatePolicy policy = RatePolicy::kLimited;
  int jitter_pct = 5;       // the wanted target wobbles by up to this much every 200 ms, as a bandwidth estimate would
  std::string encoder;      // force one; "" = the probe order
};

int RunBench(const BenchOptions& o);
