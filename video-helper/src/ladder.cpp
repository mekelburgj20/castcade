#include "ladder.h"

#include <algorithm>
#include <cmath>

const RungSpec kLadder[kRungCount] = {
    {1.0, 60, 20000}, {1.0, 30, 10000}, {0.75, 60, 8000}, {0.75, 30, 5000}, {0.5, 60, 4000}, {0.5, 30, 2000},
};

int ClampRung(int rung) { return std::min(kRungCount, std::max(1, rung)); }

namespace {
int Even(double v) {
  const int n = static_cast<int>(std::lround(v));
  const int e = (n & 1) ? n + 1 : n;  // the odd case rounds up (677 → 678): never below the fraction asked
  return std::max(2, e);
}
}  // namespace

RungGeometry RungFor(int rung, int src_width, int src_height) {
  RungGeometry g;
  g.rung = ClampRung(rung);
  const RungSpec& s = kLadder[g.rung - 1];
  g.width = src_width > 0 ? Even(src_width * s.scale) : 0;
  g.height = src_height > 0 ? Even(src_height * s.scale) : 0;
  g.fps = s.fps;
  g.kbps = s.kbps;
  return g;
}

int RungKbps(int rung) { return kLadder[ClampRung(rung) - 1].kbps; }
int RungFps(int rung) { return kLadder[ClampRung(rung) - 1].fps; }

int CeilingRung(int max_kbps) {
  for (int r = 1; r <= kRungCount; r++)
    if (kLadder[r - 1].kbps <= max_kbps) return r;
  return kRungCount;
}

int RungForBudget(int budget_kbps, int ceiling) {
  int r = CeilingRung(budget_kbps);
  return std::max(r, ClampRung(ceiling));
}

bool FrameDecimator::Keep(int64_t ts_us, int target_fps) {
  if (target_fps <= 0) {
    Reset();
    return true;
  }
  const int64_t period = 1000000 / target_fps;
  const bool restart = next_due_us_ == 0 || ts_us < last_ts_us_ || ts_us - last_ts_us_ > 1000000 || target_fps != last_fps_;
  last_ts_us_ = ts_us;
  last_fps_ = target_fps;
  if (restart) {
    next_due_us_ = ts_us + period;
    return true;
  }
  if (ts_us < next_due_us_ - period / 4) return false;
  next_due_us_ += period;
  if (next_due_us_ < ts_us) next_due_us_ = ts_us + period;  // a late frame: catch up instead of a burst
  return true;
}
