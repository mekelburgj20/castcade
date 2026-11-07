// ring_feed: either side of a Castcade frame ring from the console, for testing the video helper and the layer without
// VPX (D10.2; vr-layer/README.md "The rings"; the contract is video-helper/include/castcade_frame_ring.h).
//
//   ring_feed --send <token> [--width 1354] [--height 1440] [--fps 60] [--seconds 30] [--send-role send|recv]
//       produces a moving test pattern into the ring at that rate, as the layer's camera does (role "send" by default;
//       --send-role recv plays the helper feeding the layer's theater);
//   ring_feed --recv <token> [--seconds 30] [--recv-role recv|send]
//       consumes a ring as the layer's theater does (role "recv" by default; --recv-role send plays the helper reading
//       the camera) and prints, once a second: frames taken, skipped, the size, the mean age (now - ptsUs);
//   both at once with both flags; a loopback is `ring_feed --send t1 --recv t1 --recv-role send`.
// A consumer started before the producer waits for the ring (tries every 250 ms until --seconds run out).
#include <windows.h>

#include <mmsystem.h>

#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#include "frame_ring.h"

using castcade::RingConsumer;
using castcade::RingProducer;
using castcade::ringNowUs;

namespace {

struct Options {
  std::string sendToken, recvToken, sendRole = "send", recvRole = "recv";
  uint32_t width = 1354, height = 1440, fps = 60, seconds = 30;
};

bool parse(int argc, char** argv, Options& o) {
  for (int i = 1; i < argc; i++) {
    const std::string a = argv[i];
    const auto next = [&](std::string& out) {
      if (i + 1 >= argc) return false;
      out = argv[++i];
      return true;
    };
    std::string v;
    if (a == "--send" && next(v)) o.sendToken = v;
    else if (a == "--recv" && next(v)) o.recvToken = v;
    else if (a == "--send-role" && next(v)) o.sendRole = v;
    else if (a == "--recv-role" && next(v)) o.recvRole = v;
    else if (a == "--width" && next(v)) o.width = static_cast<uint32_t>(std::atoi(v.c_str()));
    else if (a == "--height" && next(v)) o.height = static_cast<uint32_t>(std::atoi(v.c_str()));
    else if (a == "--fps" && next(v)) o.fps = static_cast<uint32_t>(std::atoi(v.c_str()));
    else if (a == "--seconds" && next(v)) o.seconds = static_cast<uint32_t>(std::atoi(v.c_str()));
    else return false;
  }
  if (o.sendToken.empty() && o.recvToken.empty()) return false;
  if ((o.sendRole != "send" && o.sendRole != "recv") || (o.recvRole != "send" && o.recvRole != "recv")) return false;
  return o.width >= 1 && o.height >= 1 && o.fps >= 1 && o.fps <= 240;
}

void usage() {
  std::fprintf(stderr,
               "ring_feed --send <token> [--width W] [--height H] [--fps F] [--seconds S] [--send-role send|recv]\n"
               "ring_feed --recv <token> [--seconds S] [--recv-role recv|send]\n"
               "both flags at once run both; `--send t1 --recv t1 --recv-role send` is a loopback.\n");
}

// The pattern: colour bars sliding one pixel a frame, a diagonal, and a white column at the frame number so a stall or
// a repeat is visible; BGRA.
void drawPattern(uint8_t* dst, uint32_t w, uint32_t h, uint64_t frame) {
  static const uint8_t bars[8][3] = {{255, 255, 255}, {0, 255, 255}, {255, 255, 0}, {0, 255, 0}, {255, 0, 255}, {0, 0, 255}, {255, 0, 0}, {0, 0, 0}};  // BGR
  const uint32_t barW = w / 8 ? w / 8 : 1;
  const uint32_t shift = static_cast<uint32_t>(frame % w);
  const uint32_t marker = static_cast<uint32_t>(frame % w);
  for (uint32_t y = 0; y < h; y++) {
    uint8_t* row = dst + static_cast<size_t>(y) * w * 4;
    const uint32_t diag = static_cast<uint32_t>((static_cast<uint64_t>(y) * w / (h ? h : 1) + frame) % w);
    for (uint32_t x = 0; x < w; x++) {
      const uint8_t* c = bars[((x + shift) / barW) % 8];
      uint8_t* p = row + static_cast<size_t>(x) * 4;
      if (x == marker || x == diag) p[0] = p[1] = p[2] = 255;
      else p[0] = c[0], p[1] = c[1], p[2] = c[2];
      p[3] = 255;
    }
  }
}

void sendMain(const Options& o, std::atomic<bool>& stop) {
  std::string why;
  auto ring = RingProducer::create(o.sendRole.c_str(), o.sendToken, o.width, o.height, why);
  if (!ring) {
    std::printf("send: cannot make the %s ring '%s': %s\n", o.sendRole.c_str(), o.sendToken.c_str(), why.c_str());
    stop.store(true);
    return;
  }
  std::printf("send: %s ring '%s' %s: %ux%u BGRA at %u fps for %u s\n", o.sendRole.c_str(), o.sendToken.c_str(), ring->reused() ? "adopted" : "created", o.width,
              o.height, o.fps, o.seconds);
  std::fflush(stdout);
  std::vector<uint8_t> frame(static_cast<size_t>(o.width) * o.height * 4);
  const int64_t intervalUs = 1000000 / o.fps;
  const int64_t startUs = ringNowUs();
  int64_t dueUs = startUs, nextReportUs = startUs + 1000000;
  uint64_t n = 0, inSecond = 0, publishUsSum = 0, drawUsSum = 0;
  while (!stop.load()) {
    const int64_t now = ringNowUs();
    if (now >= startUs + static_cast<int64_t>(o.seconds) * 1000000) break;
    if (now < dueUs) {
      const int64_t waitUs = dueUs - now;
      if (waitUs > 2000) Sleep(static_cast<DWORD>((waitUs - 1000) / 1000));
      else std::this_thread::yield();
      continue;
    }
    dueUs += intervalUs;
    if (dueUs < now) dueUs = now + intervalUs;  // behind by more than a frame: no burst
    const int64_t t0 = ringNowUs();
    drawPattern(frame.data(), o.width, o.height, n);
    const int64_t t1 = ringNowUs();
    uint8_t* dst = ring->beginFrame(o.width, o.height);
    if (!dst) break;
    std::memcpy(dst, frame.data(), frame.size());
    ring->endFrame(t0);  // the capture moment: when the frame was "taken"
    const int64_t t2 = ringNowUs();
    drawUsSum += static_cast<uint64_t>(t1 - t0);
    publishUsSum += static_cast<uint64_t>(t2 - t1);
    n++, inSecond++;
    if (t2 >= nextReportUs) {
      std::printf("send: %llu frames this second (seq %lld), draw %llu us, publish %llu us a frame\n", static_cast<unsigned long long>(inSecond),
                  static_cast<long long>(ring->published()), static_cast<unsigned long long>(inSecond ? drawUsSum / inSecond : 0),
                  static_cast<unsigned long long>(inSecond ? publishUsSum / inSecond : 0));
      std::fflush(stdout);
      inSecond = publishUsSum = drawUsSum = 0;
      nextReportUs += 1000000;
    }
    ring->heartbeat();
  }
  std::printf("send: done, %llu frames published\n", static_cast<unsigned long long>(n));
  std::fflush(stdout);
}

void recvMain(const Options& o, std::atomic<bool>& stop) {
  const int64_t startUs = ringNowUs(), endUs = startUs + static_cast<int64_t>(o.seconds) * 1000000;
  std::unique_ptr<RingConsumer> ring;
  bool waitingSaid = false;
  while (!ring && !stop.load() && ringNowUs() < endUs) {
    std::string why;
    bool missing = false;
    ring = RingConsumer::open(o.recvRole.c_str(), o.recvToken, why, missing);
    if (ring) break;
    if (!missing) {
      std::printf("recv: the %s ring '%s' cannot be used: %s\n", o.recvRole.c_str(), o.recvToken.c_str(), why.c_str());
      return;
    }
    if (!waitingSaid) std::printf("recv: waiting for the %s ring '%s' (%s)\n", o.recvRole.c_str(), o.recvToken.c_str(), why.c_str()), waitingSaid = true;
    std::fflush(stdout);
    Sleep(250);
  }
  if (!ring) {
    std::printf("recv: the ring never appeared\n");
    return;
  }
  std::printf("recv: %s ring '%s' open: up to %ux%u, producer pid %u%s; connected after %lld ms\n", o.recvRole.c_str(), o.recvToken.c_str(), ring->maxWidth(),
              ring->maxHeight(), ring->producerPid(), ring->writable() ? "" : " (header read-only)", static_cast<long long>((ringNowUs() - startUs) / 1000));
  std::fflush(stdout);
  std::vector<uint8_t> pixels;
  int64_t nextReportUs = ringNowUs() + 1000000;
  int64_t takenBefore = 0, skippedBefore = 0, lappedBefore = 0, ageSumUs = 0, ageN = 0;
  uint32_t w = 0, h = 0;
  bool deadSaid = false;
  while (!stop.load() && ringNowUs() < endUs) {
    ring->wait(100);
    int64_t pts = 0;
    while (ring->take(pixels, w, h, pts)) {
      ageSumUs += ringNowUs() - pts;
      ageN++;
    }
    const bool alive = ring->producerAlive();
    if (!alive && !deadSaid) std::printf("recv: the producer has not touched the ring for 3 s (dead)\n"), deadSaid = true;
    if (alive) deadSaid = false;
    const int64_t now = ringNowUs();
    if (now >= nextReportUs) {
      const int64_t taken = ring->taken() - takenBefore, skipped = ring->skipped() - skippedBefore, lapped = ring->lapped() - lappedBefore;
      std::printf("recv: %lld taken, %lld skipped, %lld lapped, %ux%u, mean age %lld us, producer %s (last seq %lld)\n", static_cast<long long>(taken),
                  static_cast<long long>(skipped), static_cast<long long>(lapped), w, h, static_cast<long long>(ageN ? ageSumUs / ageN : 0), alive ? "alive" : "dead",
                  static_cast<long long>(ring->lastSeq()));
      std::fflush(stdout);
      takenBefore = ring->taken(), skippedBefore = ring->skipped(), lappedBefore = ring->lapped();
      ageSumUs = ageN = 0;
      nextReportUs += 1000000;
    }
  }
  std::printf("recv: done, %lld frames taken, %lld skipped, %lld lapped\n", static_cast<long long>(ring->taken()), static_cast<long long>(ring->skipped()),
              static_cast<long long>(ring->lapped()));
  std::fflush(stdout);
}

}  // namespace

int main(int argc, char** argv) {
  Options o;
  if (!parse(argc, argv, o)) {
    usage();
    return 2;
  }
  timeBeginPeriod(1);  // the producer's pacing sleeps at 1 ms
  std::atomic<bool> stop{false};
  std::thread sender, receiver;
  if (!o.recvToken.empty()) receiver = std::thread(recvMain, std::cref(o), std::ref(stop));
  if (!o.sendToken.empty()) {
    if (receiver.joinable()) Sleep(300);  // the consumer first, so "a consumer started before the producer connects" is what runs
    sender = std::thread(sendMain, std::cref(o), std::ref(stop));
  }
  if (sender.joinable()) sender.join();
  if (receiver.joinable()) {
    if (!o.sendToken.empty()) stop.store(true);  // the loopback ends with the producer
    receiver.join();
  }
  timeEndPeriod(1);
  return 0;
}
