#include "selftest.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <thread>
#include <vector>

#include "frame_ring.h"
#include "source.h"
#include "util.h"

int RunRingSelftest() {
  const int W = 1354, H = 1440, FPS = 60, SECONDS = 3;
  const std::string token = "selftest-" + std::to_string((unsigned)(NowUs() & 0xFFFFFF));
  RingProducer prod;
  std::string err;
  if (!prod.Create("send", token, W, H, &err)) {
    fprintf(stderr, "castcade-video: ring create failed: %s\n", err.c_str());
    return 1;
  }
  RingConsumer cons;
  if (!cons.Open("send", token, &err)) {
    fprintf(stderr, "castcade-video: ring open failed: %s\n", err.c_str());
    return 1;
  }
  std::atomic<bool> stop{false};
  std::atomic<int64_t> consumed{0}, bad_pixels{0}, out_of_order{0}, consume_us_total{0};
  std::thread consumer([&] {
    int64_t last_seq = 0;
    while (!stop) {
      RingConsumer::Frame f;
      if (!cons.Acquire(50, &f)) continue;
      const int64_t t0 = NowUs();
      // The producer stamps every pixel with the frame's seq; sample rows and columns.
      const uint32_t expect = (uint32_t)f.seq;
      bool ok = f.width == (uint32_t)W && f.height == (uint32_t)H;
      for (uint32_t y = 0; ok && y < f.height; y += 97) {
        const uint32_t* row = reinterpret_cast<const uint32_t*>(f.bgra + (size_t)y * f.stride);
        for (uint32_t x = 0; x < f.width; x += 131) if (row[x] != expect) { ok = false; break; }
      }
      if (f.seq <= last_seq) out_of_order++;
      last_seq = f.seq;
      cons.Release();
      consume_us_total += NowUs() - t0;
      if (!ok) bad_pixels++;
      consumed++;
    }
  });
  const int64_t period_us = 1000000 / FPS;
  const int64_t t0 = NowUs();
  int64_t produced = 0, publish_us_total = 0;
  for (int64_t n = 0; n < (int64_t)SECONDS * FPS; n++) {
    const int64_t due = t0 + n * period_us;
    while (NowUs() < due) std::this_thread::sleep_for(std::chrono::microseconds(500));
    uint8_t* px;
    uint32_t stride;
    int64_t seq = 0;
    const int64_t p0 = NowUs();
    if (!prod.Begin(W, H, &px, &stride, &seq)) {
      fprintf(stderr, "castcade-video: ring Begin failed\n");
      break;
    }
    const uint32_t value = (uint32_t)seq;
    for (int y = 0; y < H; y++) {
      uint32_t* row = reinterpret_cast<uint32_t*>(px + (size_t)y * stride);
      for (int x = 0; x < W; x++) row[x] = value;
    }
    prod.Commit(due);
    publish_us_total += NowUs() - p0;
    produced++;
  }
  std::this_thread::sleep_for(std::chrono::milliseconds(100));
  stop = true;
  consumer.join();
  const int64_t skipped = cons.frames_skipped();
  printf("ring-selftest: produced=%lld consumed=%lld skipped=%lld torn=%lld bad_pixels=%lld out_of_order=%lld "
         "publish_us_avg=%lld consume_us_avg=%lld (%dx%d BGRA, %d fps, %d s)\n",
         (long long)produced, (long long)consumed.load(), (long long)skipped, (long long)cons.frames_torn(),
         (long long)bad_pixels.load(), (long long)out_of_order.load(), (long long)(produced ? publish_us_total / produced : 0),
         (long long)(consumed ? consume_us_total / consumed : 0), W, H, FPS, SECONDS);
  const bool ok = produced > 0 && consumed + skipped >= produced - 2 && bad_pixels == 0 && out_of_order == 0;
  return ok ? 0 : 1;
}

int RunLoopbackSelftest(int /*seconds*/) {
  fprintf(stderr, "castcade-video: --loopback-selftest is not built yet\n");
  return 1;
}
