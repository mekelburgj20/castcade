#include "selftest.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <thread>
#include <vector>

#include <condition_variable>
#include <mutex>

#include "codecs.h"
#include "frame_ring.h"
#include "peer.h"
#include "sink.h"
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

int RunLoopbackSelftest(int seconds) {
  const int W = 1354, H = 1440, FPS = 60;
  ProbeResult probe = ProbeCodecs(W, H, FPS);
  if (probe.encoder.empty() || probe.decoder.empty()) {
    fprintf(stderr, "castcade-video: no encoder / decoder\n");
    return 2;
  }
  Sink sink;  // kind none: counts the receiver's decoded pictures
  CodecOptions codecs;
  codecs.encoder = probe.encoder;
  codecs.decoder = probe.decoder;
  codecs.sink = &sink;
  PeerFactory pf;
  std::string err;
  if (!pf.Init(codecs, /*allow_loopback=*/true, &err)) {
    fprintf(stderr, "castcade-video: libwebrtc did not start: %s\n", err.c_str());
    return 2;
  }
  // Two peers wired straight to each other: what the companion would relay over MEDIA_SIGNAL.
  std::shared_ptr<Peer> a, b;
  std::mutex mu;
  std::condition_variable cv;
  std::string a_ice = "new", b_ice = "new";
  int errors = 0;
  auto events = [&](std::shared_ptr<Peer>* other, std::string* ice) {
    PeerEvents ev;
    ev.on_sdp = [other](const std::string&, const std::string& kind, const std::string& sdp) { (*other)->OnRemoteSdp(kind, sdp); };
    ev.on_candidate = [other](const std::string&, const std::string& c, const std::string& mid, int mline) { (*other)->OnRemoteCandidate(c, mid, mline); };
    ev.on_ice = [&, ice](const std::string& id, const std::string& state, const Json& pair) {
      std::lock_guard<std::mutex> l(mu);
      *ice = state;
      if (pair.is_object()) printf("peer %s: %s via %s\n", id.c_str(), state.c_str(), pair.Dump().c_str());
      cv.notify_all();
    };
    ev.on_error = [&](const std::string& id, const std::string& code, const std::string& text) {
      fprintf(stderr, "castcade-video: peer %s: %s: %s\n", id.c_str(), code.c_str(), text.c_str());
      std::lock_guard<std::mutex> l(mu);
      errors++;
      cv.notify_all();
    };
    return ev;
  };
  PeerLimits limits;
  a = std::make_shared<Peer>(pf, "a", true, std::vector<IceServerSpec>{}, limits, events(&b, &a_ice));
  b = std::make_shared<Peer>(pf, "b", false, std::vector<IceServerSpec>{}, limits, events(&a, &b_ice));
  const int64_t t0 = NowUs();
  if (!b->Start(&err) || !a->Start(&err)) {
    fprintf(stderr, "castcade-video: peer start failed: %s\n", err.c_str());
    return 1;
  }
  {
    std::unique_lock<std::mutex> l(mu);
    if (!cv.wait_for(l, std::chrono::seconds(15), [&] {
          return errors > 0 || ((a_ice == "connected" || a_ice == "completed") && (b_ice == "connected" || b_ice == "completed"));
        }) || errors > 0) {
      fprintf(stderr, "castcade-video: not connected after 15 s (a %s, b %s, %d errors)\n", a_ice.c_str(), b_ice.c_str(), errors);
      return 1;
    }
  }
  printf("connected in %lld ms\n", (long long)((NowUs() - t0) / 1000));
  Source source([&](const webrtc::scoped_refptr<webrtc::NV12Buffer>& buf, int64_t) { pf.PushFrame(buf); }, nullptr);
  SourceConfig sc;
  sc.kind = SourceConfig::Kind::kBench;
  sc.width = W; sc.height = H; sc.fps = FPS;
  source.Configure(sc);
  source.SetEnabled(true);
  a->SetSendActive(true);
  sink.Snapshot();
  printf("t,recv_fps,recv_kbps,send_fps,send_kbps,target_kbps,enc_us,dec_us,freeze_ms,encoder,decoder\n");
  int64_t total_frames = 0, total_kbps = 0;
  StatsSnapshot pa, pb;
  std::string encoder, decoder;
  for (int sec = 1; sec <= seconds; sec++) {
    std::this_thread::sleep_for(std::chrono::seconds(1));
    StatsSnapshot sa, sb;
    {
      std::mutex m;
      std::condition_variable c;
      int got = 0;
      a->GetStats([&](const StatsSnapshot& s) { std::lock_guard<std::mutex> l(m); sa = s; got++; c.notify_all(); });
      b->GetStats([&](const StatsSnapshot& s) { std::lock_guard<std::mutex> l(m); sb = s; got++; c.notify_all(); });
      std::unique_lock<std::mutex> l(m);
      c.wait_for(l, std::chrono::milliseconds(700), [&] { return got == 2; });
    }
    const Sink::Readout r = sink.Snapshot();
    const int64_t recv_kbps = pb.valid ? (int64_t)(((sb.bytes_received + sb.header_bytes_received) - (pb.bytes_received + pb.header_bytes_received)) * 8 / 1000) : 0;
    const int64_t send_kbps = pa.valid ? (int64_t)(((sa.bytes_sent + sa.header_bytes_sent) - (pa.bytes_sent + pa.header_bytes_sent)) * 8 / 1000) : 0;
    const int64_t send_fps = pa.valid ? (int64_t)sa.frames_sent - pa.frames_sent : 0;
    const int64_t enc_us = pa.valid && sa.frames_encoded > pa.frames_encoded ? (int64_t)((sa.total_encode_time_s - pa.total_encode_time_s) * 1e6 / (sa.frames_encoded - pa.frames_encoded)) : 0;
    const int64_t freeze_ms = pb.valid ? (int64_t)((sb.total_freezes_duration_s - pb.total_freezes_duration_s) * 1000) : 0;
    encoder = sa.encoder_implementation;
    decoder = sb.decoder_implementation;
    printf("%d,%.0f,%lld,%lld,%lld,%lld,%lld,%lld,%lld,%s,%s\n", sec, r.fps, (long long)recv_kbps, (long long)send_fps, (long long)send_kbps,
           (long long)(sa.target_bitrate_bps / 1000), (long long)enc_us, (long long)r.dec_us, (long long)freeze_ms, encoder.c_str(), decoder.c_str());
    fflush(stdout);
    total_frames += (int64_t)(r.fps + 0.5);
    total_kbps += recv_kbps;
    pa = sa;
    pb = sb;
  }
  const Sink::Readout fin = sink.Snapshot();
  printf("loopback-selftest: decoded=%lld fps_avg=%.1f kbps_avg=%lld size=%dx%d encoder=%s decoder=%s (%d s, %dx%d @%d bench source)\n",
         (long long)fin.frames_total, (double)total_frames / seconds, (long long)(total_kbps / seconds), fin.width, fin.height,
         encoder.c_str(), decoder.c_str(), seconds, W, H, FPS);
  fflush(stdout);
  source.Stop();
  a->Close();
  b->Close();
  a.reset();
  b.reset();
  pf.Shutdown();
  return fin.frames_total > 0 ? 0 : 1;
}
