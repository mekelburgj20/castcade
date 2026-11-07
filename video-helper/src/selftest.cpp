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
#include "controller.h"
#include "frame_ring.h"
#include "ladder.h"
#include "peer.h"
#include "sink.h"
#include "source.h"
#include "util.h"

// ---------------------------------------------------------------- the controller (D10.5), scripted

namespace {

struct Script {
  // Every 200 ms from `from_ms` to `to_ms` (inclusive of from, exclusive of to): the inputs at t.
  template <typename F>
  static std::vector<std::pair<int64_t, ControllerDecision>> Run(RungController& c, int64_t from_ms, int64_t to_ms, F inputs) {
    std::vector<std::pair<int64_t, ControllerDecision>> out;
    for (int64_t t = from_ms; t < to_ms; t += 200) {
      ControllerInputs in = inputs(t);
      in.now_ms = t;
      ControllerDecision d = c.Step(in);
      if (d.changed) out.emplace_back(t, d);
    }
    return out;
  }
};

ControllerInputs Clean(double bwe) {
  ControllerInputs in;
  in.sending = true;
  in.source_fps = 60;
  in.sent_fps = 60;
  in.loss_pct = 0;
  in.rtt_ms = 30;
  in.bwe_kbps = bwe;
  in.decode_fps = 60;
  in.freeze_ms = 0;
  in.max_kbps = 20000;
  return in;
}

struct Case {
  std::string name;
  bool ok;
  std::string detail;
};

std::string Changes(const std::vector<std::pair<int64_t, ControllerDecision>>& v) {
  std::string s;
  for (const auto& p : v) s += (s.empty() ? "" : " ") + std::to_string(p.first) + ":" + std::to_string(p.second.rung) + "/" + p.second.reason;
  return s.empty() ? "(none)" : s;
}

}  // namespace

int RunControllerSelftest() {
  std::vector<Case> cases;
  auto add = [&](const std::string& name, bool ok, const std::string& detail) { cases.push_back({name, ok, detail}); };

  // 1. The ladder's geometry from a 1354x1440 and a 1920x1080 source; the ceiling and the budget.
  {
    const int want[6][4] = {{1354, 1440, 60, 20000}, {1354, 1440, 30, 10000}, {1016, 1080, 60, 8000}, {1016, 1080, 30, 5000}, {678, 720, 60, 4000}, {678, 720, 30, 2000}};
    bool ok = true;
    std::string detail;
    for (int r = 1; r <= 6; r++) {
      const RungGeometry g = RungFor(r, 1354, 1440);
      detail += (r > 1 ? " · " : "") + std::to_string(r) + ": " + std::to_string(g.width) + "x" + std::to_string(g.height) + "@" + std::to_string(g.fps) + " " + std::to_string(g.kbps);
      if (g.width != want[r - 1][0] || g.height != want[r - 1][1] || g.fps != want[r - 1][2] || g.kbps != want[r - 1][3]) ok = false;
    }
    const RungGeometry d3 = RungFor(3, 1920, 1080), d5 = RungFor(5, 1920, 1080);
    ok = ok && d3.width == 1440 && d3.height == 810 && d5.width == 960 && d5.height == 540;
    ok = ok && CeilingRung(20000) == 1 && CeilingRung(9000) == 3 && CeilingRung(5000) == 4 && CeilingRung(1000) == 6;
    ok = ok && RungForBudget(20000, 1) == 1 && RungForBudget(7500, 1) == 4 && RungForBudget(30000, 3) == 3;
    add("ladder geometry (1440 and 1080 sources, ceiling, budget)", ok, detail + " · 1080p rung 3 " + std::to_string(d3.width) + "x" + std::to_string(d3.height) + ", rung 5 " + std::to_string(d5.width) + "x" + std::to_string(d5.height));
  }

  // 2. The decimator: 60 → 30 keeps every other frame and never drops two in a row; 60 → 60 keeps all.
  {
    FrameDecimator d;
    int kept = 0, run_drops = 0, max_run_drops = 0;
    for (int n = 0; n < 120; n++) {
      const bool k = d.Keep(1000000 + (int64_t)n * 16667, 30);
      if (k) { kept++; run_drops = 0; } else { run_drops++; max_run_drops = std::max(max_run_drops, run_drops); }
    }
    FrameDecimator d2;
    int kept60 = 0;
    for (int n = 0; n < 120; n++) if (d2.Keep(5000000 + (int64_t)n * 16667, 60)) kept60++;
    // A 45 fps source to a 30 fps rung: about 2 of 3 kept, still never two drops in a row.
    FrameDecimator d3;
    int kept45 = 0, run45 = 0, max45 = 0;
    for (int n = 0; n < 135; n++) {
      if (d3.Keep(9000000 + (int64_t)n * 22222, 30)) { kept45++; run45 = 0; } else { run45++; max45 = std::max(max45, run45); }
    }
    const bool ok = kept >= 59 && kept <= 61 && max_run_drops <= 1 && kept60 == 120 && kept45 >= 88 && kept45 <= 92 && max45 <= 1;
    add("decimator (60→30 alternate, no double drop; 60→60 all; 45→30)", ok,
        "60→30 kept " + std::to_string(kept) + "/120, longest drop run " + std::to_string(max_run_drops) + "; 60→60 kept " + std::to_string(kept60) + "/120; 45→30 kept " + std::to_string(kept45) + "/135, longest drop run " + std::to_string(max45));
  }

  // 3. The start-up probe: rung 3 for 5 s, then the jump to what the estimate affords (30 Mbps → rung 1).
  {
    RungController c;
    ControllerInputs idle;
    idle.sending = false;
    idle.max_kbps = 20000;
    const ControllerDecision start = c.Step([&] { ControllerInputs i = idle; i.now_ms = -200; return i; }());
    auto v = Script::Run(c, 0, 8000, [](int64_t) { return Clean(30000); });
    const bool ok = start.changed && start.rung == 3 && start.reason == "start" && v.size() == 2 && v[0].first == 0 && v[0].second.rung == 3 && v[0].second.reason == "probe" && v[1].first == 5000 && v[1].second.rung == 1 && v[1].second.reason == "probe";
    add("probe: rung 3 for 5 s, then straight to rung 1 at BWE 30 Mbps", ok, "start " + std::to_string(start.rung) + "/" + start.reason + "; " + Changes(v));
  }

  // 4. A loss burst at t = 10 s steps down within 3 s (and again while it lasts).
  {
    RungController c;
    auto v = Script::Run(c, 0, 20000, [](int64_t t) {
      ControllerInputs in = Clean(30000);
      if (t >= 10000) in.loss_pct = 5;
      return in;
    });
    // probe 3 @0, probe 1 @5000, down:loss @13000 (rung 2), down:loss @16000 (rung 3), down:loss @19000 (rung 4)
    bool ok = v.size() >= 3 && v[1].second.rung == 1;
    if (ok) {
      const auto& d = v[2];
      ok = d.first >= 12800 && d.first <= 13200 && d.second.rung == 2 && d.second.reason == "down:loss";
    }
    add("loss burst at t = 10 s: down one rung within 3 s", ok, Changes(v));
  }

  // 5. 35 s clean with BWE high: exactly one step up (at 30 s after the last change), from a probe that landed at rung 4.
  {
    RungController c;
    auto v = Script::Run(c, 0, 40000, [](int64_t t) { return Clean(t < 6000 ? 9000 : 30000); });
    // probe 3 @0, probe 4 @5000 (9000 / 1.2 = 7500 → rung 4), up 3 @35000
    const bool ok = v.size() == 3 && v[1].second.rung == 4 && v[2].first == 35000 && v[2].second.rung == 3 && v[2].second.reason == "up";
    add("35 s clean with BWE high: one step up after 30 s", ok, Changes(v));
  }

  // 6. A pin holds through trouble; clearing it resumes the controller where the pin was, with no second probe.
  {
    RungController c;
    auto v1 = Script::Run(c, 0, 10000, [](int64_t) {
      ControllerInputs in = Clean(30000);
      in.pin = 5;
      in.loss_pct = 10;
      in.sent_fps = 10;
      return in;
    });
    auto v2 = Script::Run(c, 10000, 45000, [](int64_t) { return Clean(30000); });
    // pin 5 @0; then up 4 @40000 (clean since 10000 → 30 s)
    const bool ok = v1.size() == 1 && v1[0].second.rung == 5 && v1[0].second.reason == "pin" && c.rung() == 4 && v2.size() == 1 && v2[0].first == 40000 && v2[0].second.rung == 4 && v2[0].second.reason == "up";
    add("pin 5 holds through loss; pin null resumes at 5 without a probe, then up after 30 s clean", ok, Changes(v1) + " | " + Changes(v2));
  }

  // 7. The ceiling: max_kbps 5000 keeps the rung at 4 or below whatever the estimate says.
  {
    RungController c;
    int min_rung = 99;
    auto v = Script::Run(c, 0, 12000, [&](int64_t) {
      ControllerInputs in = Clean(30000);
      in.max_kbps = 5000;
      min_rung = std::min(min_rung, c.rung() ? c.rung() : 99);
      return in;
    });
    const bool ok = !v.empty() && v[0].second.rung == 4 && c.rung() == 4 && min_rung >= 4;
    add("ceiling 5000 kbps: rung 4 at most", ok, Changes(v) + " (lowest rung seen " + std::to_string(min_rung) + ")");
  }

  // 8. The receiver's inputs: unknown never counts; a low decode fps does, after 3 s.
  {
    RungController c;
    auto v = Script::Run(c, 0, 30000, [](int64_t t) {
      ControllerInputs in = Clean(30000);
      in.decode_fps.reset();
      in.freeze_ms.reset();
      if (t >= 20000) in.decode_fps = 20;
      return in;
    });
    // probe 3 @0, probe 1 @5000, nothing while the receiver is unknown, down:receiver @23000 (and on while it stays low)
    const bool ok = v.size() >= 3 && v[1].first == 5000 && v[2].first == 23000 && v[2].second.rung == 2 && v[2].second.reason == "down:receiver";
    add("receiver unknown never counts; decode fps 20 steps down after 3 s", ok, Changes(v));
  }

  // 9. RTT 100 ms above its 10 s minimum; sent fps under 90 % of the rung's; a freeze over 500 ms.
  {
    RungController c;
    auto v = Script::Run(c, 0, 16000, [](int64_t t) {
      ControllerInputs in = Clean(30000);
      in.rtt_ms = t >= 10000 ? 180 : 30;
      return in;
    });
    RungController c2;
    auto v2 = Script::Run(c2, 0, 16000, [](int64_t t) {
      ControllerInputs in = Clean(30000);
      if (t >= 10000) in.sent_fps = 45;
      return in;
    });
    RungController c3;
    auto v3 = Script::Run(c3, 0, 16000, [](int64_t t) {
      ControllerInputs in = Clean(30000);
      if (t >= 10000) in.freeze_ms = 800;
      return in;
    });
    const bool ok = v.size() == 3 && v[2].first == 13000 && v[2].second.reason == "down:rtt" && v2.size() == 3 && v2[2].first == 13000 && v2[2].second.reason == "down:fps" &&
                    v3.size() == 3 && v3[2].first == 13000 && v3[2].second.reason == "down:receiver";
    add("rtt +150 ms, sent fps 45 of 60, a 800 ms freeze: each steps down after 3 s", ok, Changes(v) + " | " + Changes(v2) + " | " + Changes(v3));
  }

  // 10. A later stint (the next ball) starts where the last ended, and its first 2 s ignore fps and the receiver.
  {
    RungController c;
    auto v1 = Script::Run(c, 0, 8000, [](int64_t) { return Clean(30000); });
    ControllerInputs idle;
    idle.sending = false;
    idle.max_kbps = 20000;
    Script::Run(c, 8000, 20000, [&](int64_t) { return idle; });
    auto v2 = Script::Run(c, 20000, 30000, [](int64_t t) {
      ControllerInputs in = Clean(30000);
      if (t < 21400) { in.sent_fps = 0; in.decode_fps = 0; }  // the pipeline filling
      return in;
    });
    const bool ok = v1.size() == 2 && v1[1].second.rung == 1 && v2.empty() && c.rung() == 1;
    add("a later stint starts at the last rung; the first 2 s ignore fps and the receiver", ok, Changes(v1) + " | " + Changes(v2));
  }

  int failed = 0;
  for (const Case& c : cases) {
    printf("%s: %s — %s\n", c.ok ? "pass" : "FAIL", c.name.c_str(), c.detail.c_str());
    if (!c.ok) failed++;
  }
  printf("controller-selftest: %zu cases, %d failed\n", cases.size(), failed);
  fflush(stdout);
  return failed ? 1 : 0;
}

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
  // D10.5: the rung is pinned by hand here (the controller has its own selftest): rung 3 from the start (what a match
  // begins with), the full size at 40 % of the run, the smallest rung at 70 %: two size changes through the encoder's
  // re-open on an IDR and the receiver's decoder; the decoded size at the end must be rung 5's.
  auto pin = [&](int rung) {
    const RungGeometry g = RungFor(rung, W, H);
    a->target()->Set(g.rung, g.fps, g.kbps);
    a->applied = g;
  };
  pin(3);
  const int t_full = std::max(1, seconds * 2 / 5), t_small = std::max(t_full + 1, seconds * 7 / 10);
  int64_t frames_at_small = 0;
  printf("t,rung,recv_fps,recv_kbps,send_fps,send_kbps,target_kbps,enc_us,dec_us,freeze_ms,size,encoder,decoder\n");
  int64_t total_frames = 0, total_kbps = 0;
  StatsSnapshot pa, pb;
  std::string encoder, decoder;
  for (int sec = 1; sec <= seconds; sec++) {
    if (sec - 1 == t_full) pin(1);
    if (sec - 1 == t_small) {
      pin(5);
      frames_at_small = sink.frames_total();
    }
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
    printf("%d,%d,%.0f,%lld,%lld,%lld,%lld,%lld,%lld,%lld,%dx%d,%s,%s\n", sec, a->applied.rung, r.fps, (long long)recv_kbps, (long long)send_fps, (long long)send_kbps,
           (long long)(sa.target_bitrate_bps / 1000), (long long)enc_us, (long long)r.dec_us, (long long)freeze_ms, r.width, r.height, encoder.c_str(), decoder.c_str());
    fflush(stdout);
    total_frames += (int64_t)(r.fps + 0.5);
    total_kbps += recv_kbps;
    pa = sa;
    pb = sb;
  }
  const Sink::Readout fin = sink.Snapshot();
  const RungGeometry g5 = RungFor(5, W, H);
  const int64_t decoded_small = fin.frames_total - frames_at_small;
  const bool size_ok = fin.width == g5.width && fin.height == g5.height && decoded_small > 0;
  printf("loopback-selftest: decoded=%lld fps_avg=%.1f kbps_avg=%lld size=%dx%d (rung 5 wants %dx%d: %s, %lld frames after the pin) encoder=%s decoder=%s (%d s, %dx%d @%d bench source, rungs 3 → 1 → 5)\n",
         (long long)fin.frames_total, (double)total_frames / seconds, (long long)(total_kbps / seconds), fin.width, fin.height, g5.width, g5.height,
         size_ok ? "ok" : "MISMATCH", (long long)decoded_small, encoder.c_str(), decoder.c_str(), seconds, W, H, FPS);
  fflush(stdout);
  source.Stop();
  std::this_thread::sleep_for(std::chrono::milliseconds(100));  // let the last frames leave the encoder queue
  a->Close();
  b->Close();
  a.reset();
  b.reset();
  pf.Shutdown();
  return fin.frames_total > 0 && size_ok ? 0 : 1;
}
