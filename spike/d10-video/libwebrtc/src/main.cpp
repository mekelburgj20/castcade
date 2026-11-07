// D10.0.1 spike, the libwebrtc candidate (rung 1): sender + receiver in one process on LiveKit's
// prebuilt libwebrtc, the harness encoder (libavcodec NVENC → AMF → QSV → x264) plugged in as a
// VideoEncoderFactory, the harness decoder as the VideoDecoderFactory, one UDP port per side, ICE
// rewritten through the shaper. Logs the README's CSV lines once a second.
//
//   spike-libwebrtc [--harness <dll>] [--no-harness] [--shaper-s <port> --shaper-c <port>]
//                   [--duration <s>] [--port-s <p>] [--port-c <p>] [--fps 60] [--width 1354]
//                   [--height 1440] [--start-kbps 8000] [--max-kbps 20000] [--min-kbps 1000]
//                   [--codec H264] [--encoder <name>] [--decoder <name>] [--builtin-decoder]
//                   [--untrusted-rc] [--no-zero-playout-delay] [--results <dir>] [--verbose]
//
// Scratch code: nothing here ships (docs/design/spectator-video-native.md §3a).

#include <winsock2.h>
#include <windows.h>
#include <mmsystem.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <fstream>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "api/make_ref_counted.h"
#include "api/video/nv12_buffer.h"
#include "api/video/video_frame.h"
#include "api/video/video_sink_interface.h"
#include "media/base/video_broadcaster.h"
#include "pc/video_track_source.h"
#include "rtc_base/logging.h"
#include "rtc_base/ssl_adapter.h"
#include "rtc_base/time_utils.h"

#include "codecs.h"
#include "harness.h"
#include "peer.h"
#include "sdp.h"

namespace {

struct Args {
  std::string harness_path;  // explicit --harness
  bool no_harness = false;
  int shaper_s = 0, shaper_c = 0;
  int duration_s = 90;
  int port_s = 50100, port_c = 50200;
  int fps = 60, width = 1354, height = 1440;
  int start_kbps = 8000, max_kbps = 20000, min_kbps = 1000;
  std::string codec = "H264";
  std::string force_encoder, force_decoder;
  bool builtin_decoder = false;
  bool trusted_rc = true;
  bool zero_playout_delay = true;
  std::string results_dir;
  bool verbose = false;
};

void Usage() {
  fprintf(stderr,
          "spike-libwebrtc: D10.0.1 libwebrtc loopback candidate\n"
          "  --harness <dll>        castcade_spike_harness.dll (default: ../../../harness/build/Release/ from the exe)\n"
          "  --no-harness           synthetic flat frame + libwebrtc's own encoder/decoder (bring-up mode)\n"
          "  --shaper-s <port>      shaper port facing the sender (the sender sends to it); omit = direct\n"
          "  --shaper-c <port>      shaper port facing the receiver (the receiver sends to it)\n"
          "  --duration <s>         run length after connect (default 90)\n"
          "  --port-s/--port-c <p>  the one UDP port each side binds (default 50100 / 50200)\n"
          "  --fps/--width/--height source (default 60, 1354x1440)\n"
          "  --start-kbps/--max-kbps/--min-kbps  bitrate envelope handed to libwebrtc (8000/20000/1000)\n"
          "  --codec <name>         H264 (default) | VP8 | VP9 | AV1; only H264 with the harness\n"
          "  --encoder <name>       force a harness encoder (h264_nvenc, h264_amf, h264_qsv, libx264)\n"
          "  --decoder <name>       force a harness decoder (h264_cuvid, h264 ...)\n"
          "  --builtin-decoder      decode with libwebrtc's own H264 decoder instead of the harness\n"
          "  --untrusted-rc         tell libwebrtc the encoder's rate control is NOT trusted (frame dropper on)\n"
          "  --no-zero-playout-delay  drop the WebRTC-ForcePlayoutDelay/min_ms:0,max_ms:0 field trial\n"
          "  --results <dir>        CSV folder (default spike/d10-video/results next to the exe tree)\n"
          "  --verbose              libwebrtc LS_INFO logging to stderr\n");
}

long ArgInt(const char* s, const char* name) {
  char* end = nullptr;
  long v = strtol(s, &end, 10);
  if (!end || *end != '\0') {
    fprintf(stderr, "bad integer for %s: %s\n", name, s);
    exit(2);
  }
  return v;
}

bool ParseArgs(int argc, char** argv, Args* a) {
  for (int i = 1; i < argc; ++i) {
    std::string k = argv[i];
    auto need = [&](const char* name) -> const char* {
      if (i + 1 >= argc) {
        fprintf(stderr, "%s needs a value\n", name);
        exit(2);
      }
      return argv[++i];
    };
    if (k == "--harness") a->harness_path = need("--harness");
    else if (k == "--no-harness") a->no_harness = true;
    else if (k == "--shaper-s") a->shaper_s = ArgInt(need(k.c_str()), "--shaper-s");
    else if (k == "--shaper-c") a->shaper_c = ArgInt(need(k.c_str()), "--shaper-c");
    else if (k == "--duration") a->duration_s = ArgInt(need(k.c_str()), "--duration");
    else if (k == "--port-s") a->port_s = ArgInt(need(k.c_str()), "--port-s");
    else if (k == "--port-c") a->port_c = ArgInt(need(k.c_str()), "--port-c");
    else if (k == "--fps") a->fps = ArgInt(need(k.c_str()), "--fps");
    else if (k == "--width") a->width = ArgInt(need(k.c_str()), "--width");
    else if (k == "--height") a->height = ArgInt(need(k.c_str()), "--height");
    else if (k == "--start-kbps") a->start_kbps = ArgInt(need(k.c_str()), "--start-kbps");
    else if (k == "--max-kbps") a->max_kbps = ArgInt(need(k.c_str()), "--max-kbps");
    else if (k == "--min-kbps") a->min_kbps = ArgInt(need(k.c_str()), "--min-kbps");
    else if (k == "--codec") a->codec = need("--codec");
    else if (k == "--encoder") a->force_encoder = need("--encoder");
    else if (k == "--decoder") a->force_decoder = need("--decoder");
    else if (k == "--builtin-decoder") a->builtin_decoder = true;
    else if (k == "--untrusted-rc") a->trusted_rc = false;
    else if (k == "--no-zero-playout-delay") a->zero_playout_delay = false;
    else if (k == "--results") a->results_dir = need("--results");
    else if (k == "--verbose") a->verbose = true;
    else if (k == "--help" || k == "-h") {
      Usage();
      exit(0);
    } else {
      fprintf(stderr, "unknown argument %s\n", argv[i]);
      Usage();
      return false;
    }
  }
  if ((a->shaper_s == 0) != (a->shaper_c == 0)) {
    fprintf(stderr, "--shaper-s and --shaper-c go together\n");
    return false;
  }
  return true;
}

std::string ExeDir() {
  char buf[MAX_PATH];
  DWORD n = GetModuleFileNameA(nullptr, buf, MAX_PATH);
  std::string p(buf, n);
  size_t slash = p.find_last_of("\\/");
  return slash == std::string::npos ? "." : p.substr(0, slash);
}

bool FileExists(const std::string& p) {
  DWORD a = GetFileAttributesA(p.c_str());
  return a != INVALID_FILE_ATTRIBUTES && !(a & FILE_ATTRIBUTE_DIRECTORY);
}

std::string Timestamp() {
  time_t t = time(nullptr);
  tm lt{};
  localtime_s(&lt, &t);
  char buf[32];
  strftime(buf, sizeof buf, "%Y%m%d-%H%M%S", &lt);
  return buf;
}

class StderrLogSink final : public webrtc::LogSink {
 public:
  void OnLogMessage(const std::string& message) override { fputs(message.c_str(), stderr); }
};

// The frames the sender pushes: a VideoTrackSource fed from our producer thread.
class PushSource : public webrtc::VideoTrackSource {
 public:
  PushSource() : webrtc::VideoTrackSource(/*remote=*/false) {}
  void Push(const webrtc::VideoFrame& f) { broadcaster_.OnFrame(f); }

 protected:
  webrtc::VideoSourceInterface<webrtc::VideoFrame>* source() override { return &broadcaster_; }

 private:
  webrtc::VideoBroadcaster broadcaster_;
};

// The receiver's renderer stand-in: counts delivered frames and the longest gap between them.
class DeliverySink final : public webrtc::VideoSinkInterface<webrtc::VideoFrame> {
 public:
  explicit DeliverySink(const Harness* h) : h_(h) {}
  void OnFrame(const webrtc::VideoFrame& /*frame*/) override {
    const int64_t now = SpikeNowUs(h_);
    std::lock_guard<std::mutex> l(mu_);
    if (last_us_ > 0) gap_max_us_ = std::max(gap_max_us_, now - last_us_);
    last_us_ = now;
    total_++;
    window_++;
  }
  // Frames in the window, cumulative total, longest freeze (ms) seen in the window (or ongoing).
  void Snapshot(int64_t* total, int64_t* in_window, double* freeze_ms_max) {
    const int64_t now = SpikeNowUs(h_);
    std::lock_guard<std::mutex> l(mu_);
    int64_t gap = gap_max_us_;
    if (last_us_ > 0) gap = std::max(gap, now - last_us_);  // a freeze still running counts
    *total = total_;
    *in_window = window_;
    *freeze_ms_max = total_ == 0 ? 0.0 : gap / 1000.0;
    window_ = 0;
    gap_max_us_ = 0;
  }

 private:
  const Harness* h_;
  std::mutex mu_;
  int64_t last_us_ = 0, gap_max_us_ = 0, total_ = 0, window_ = 0;
};

// Bring-up frame when the harness is absent: flat gray, a moving white square, a noise block.
void SyntheticFrame(uint64_t n, int w, int h, uint8_t* y, uint8_t* uv) {
  memset(y, 110, static_cast<size_t>(w) * h);
  memset(uv, 128, static_cast<size_t>(w) * ((h + 1) / 2));
  const int sq = 128;
  const int sx = static_cast<int>((n * 7) % static_cast<uint64_t>(w - sq));
  const int sy = static_cast<int>((n * 5) % static_cast<uint64_t>(h - sq));
  for (int r = 0; r < sq; ++r) memset(y + static_cast<size_t>(sy + r) * w + sx, 235, sq);
  uint32_t seed = static_cast<uint32_t>(n * 2654435761u + 12345u);
  for (int r = 0; r < 256 && r < h; ++r) {
    uint8_t* row = y + static_cast<size_t>(r) * w + (w - 256);
    for (int c = 0; c < 256; ++c) {
      seed = seed * 1664525u + 1013904223u;
      row[c] = static_cast<uint8_t>(64 + (seed >> 24) / 2);
    }
  }
}

}  // namespace

int main(int argc, char** argv) {
  Args a;
  if (!ParseArgs(argc, argv, &a)) return 2;

  WSADATA wsa;
  WSAStartup(MAKEWORD(2, 2), &wsa);
  timeBeginPeriod(1);
  // libwebrtc's own stderr output ignores the LogToDebug threshold in this build; route it through
  // our sink instead (warnings and errors, everything with --verbose).
  webrtc::LogMessage::LogToDebug(webrtc::LS_NONE);
  webrtc::LogMessage::SetLogToStderr(false);
  webrtc::LogMessage::LogTimestamps(true);
  webrtc::LogMessage::LogThreads(true);
  StderrLogSink log_sink;
  webrtc::LogMessage::AddLogToStream(&log_sink, a.verbose ? webrtc::LS_INFO : webrtc::LS_WARNING);
  webrtc::InitializeSSL();

  const std::string exe_dir = ExeDir();

  // ---- harness ----
  Harness harness;
  if (!a.no_harness) {
    std::vector<std::string> candidates;
    if (!a.harness_path.empty()) {
      candidates.push_back(a.harness_path);
    } else {
      candidates.push_back(exe_dir + "\\..\\..\\..\\harness\\build\\Release\\castcade_spike_harness.dll");
      candidates.push_back(exe_dir + "\\..\\harness\\build\\Release\\castcade_spike_harness.dll");
      candidates.push_back("spike\\d10-video\\harness\\build\\Release\\castcade_spike_harness.dll");
    }
    std::string err;
    for (const auto& c : candidates) {
      if (!FileExists(c)) {
        err = "not found";
        continue;
      }
      if (harness.Load(c, &err)) break;
      fprintf(stderr, "harness at %s did not load: %s\n", c.c_str(), err.c_str());
    }
    if (!harness.loaded()) {
      if (!a.harness_path.empty()) {
        fprintf(stderr, "--harness %s: %s\n", a.harness_path.c_str(), err.c_str());
        return 1;
      }
      fprintf(stderr, "harness DLL not found (looked next to the exe tree); running --no-harness\n");
      a.no_harness = true;
    }
  }
  const bool use_harness = harness.loaded();
  if (use_harness) a.codec = "H264";
  fprintf(stderr, "mode: %s | codec %s | %dx%d @%d fps | %d..%d kbps start %d | ports %d/%d | shaper %s\n",
          use_harness ? ("harness " + harness.path).c_str() : "no-harness (builtin encoder)",
          a.codec.c_str(), a.width, a.height, a.fps, a.min_kbps, a.max_kbps, a.start_kbps, a.port_s,
          a.port_c, a.shaper_s ? "on" : "off (direct loopback)");

  // ---- results ----
  std::string results = a.results_dir;
  if (results.empty()) results = exe_dir + "\\..\\..\\..\\results";
  CreateDirectoryA(results.c_str(), nullptr);
  const std::string stamp = Timestamp();
  const std::string sender_csv = results + "\\" + stamp + "-libwebrtc-sender.csv";
  const std::string receiver_csv = results + "\\" + stamp + "-libwebrtc-receiver.csv";
  std::ofstream fs(sender_csv), fr(receiver_csv);
  if (!fs || !fr) {
    fprintf(stderr, "cannot write CSVs in %s\n", results.c_str());
    return 1;
  }
  fs << "t,encoder,fps_sent,kbps_sent,target_kbps,enc_cost_us_avg,rtt_ms,loss_pct,bwe_kbps,"
        "frames_encoded,quality_limitation,nack,pli,codec,encoder_impl_stats\n";
  fr << "t,frames_delivered,fps,kbps_received,decode_ok,freeze_ms_max,"
        "g2g_ms_avg,g2g_ms_max,jb_ms,nack,pli,frames_dropped,freeze_count,decoder\n";

  // ---- codecs ----
  FrameClock clock;
  clock.period_us = 1000000 / a.fps;
  clock.harness = use_harness ? &harness : nullptr;
  EncoderStats enc_stats;
  DecoderStats dec_stats;
  HarnessCodecOptions co;
  co.harness = &harness;
  co.force_encoder = a.force_encoder.empty() ? nullptr : a.force_encoder.c_str();
  co.force_decoder = a.force_decoder.empty() ? nullptr : a.force_decoder.c_str();
  co.trusted_rate_controller = a.trusted_rc;
  co.fps = a.fps;
  co.start_kbps = a.start_kbps;
  co.clock = &clock;
  co.enc_stats = &enc_stats;
  co.dec_stats = &dec_stats;

  const std::string trials = a.zero_playout_delay ? "WebRTC-ForcePlayoutDelay/min_ms:0,max_ms:0/" : "";
  const bool harness_decoder = use_harness && !a.builtin_decoder;

  DeliverySink sink(use_harness ? &harness : nullptr);

  PeerConfig sc;
  sc.name = "sender";
  sc.udp_port = a.port_s;
  sc.field_trials = trials;
  sc.encoder_factory = use_harness ? CreateHarnessEncoderFactory(co) : CreateBuiltinEncoderFactory();
  sc.decoder_factory = CreateBuiltinDecoderFactory();
  PeerConfig rc;
  rc.name = "receiver";
  rc.udp_port = a.port_c;
  rc.field_trials = trials;
  rc.encoder_factory = CreateBuiltinEncoderFactory();
  rc.decoder_factory = harness_decoder ? CreateHarnessDecoderFactory(co) : CreateBuiltinDecoderFactory();
  rc.remote_sink = &sink;

  {
    auto b = CreateBuiltinEncoderFactory();
    std::string names;
    for (const auto& f : b->GetSupportedFormats()) names += f.ToString() + " | ";
    fprintf(stderr, "builtin encoder formats: %s\n", names.c_str());
  }

  Peer sender(std::move(sc));
  Peer receiver(std::move(rc));
  std::string err;
  if (!sender.Init(&err) || !receiver.Init(&err)) {
    fprintf(stderr, "peer init failed: %s\n", err.c_str());
    return 1;
  }

  auto source = webrtc::make_ref_counted<PushSource>();
  source->SetState(webrtc::MediaSourceInterface::kLive);
  if (!sender.AddSendVideo(source, a.codec, a.max_kbps, a.min_kbps, a.fps, &err)) {
    fprintf(stderr, "AddSendVideo failed: %s\n", err.c_str());
    return 1;
  }

  // ---- signalling: in-memory, after gathering, rewritten per the shaper routing rule ----
  const int64_t t_neg0 = SpikeNowUs(clock.harness);
  std::string offer, answer;
  if (!sender.CreateLocal(true, &offer, &err)) {
    fprintf(stderr, "offer failed: %s\n", err.c_str());
    return 1;
  }
  SdpRewrite to_receiver;
  to_receiver.shaper_port = a.shaper_c;  // the receiver sends to the shaper port facing it
  SdpRewriteResult offer_rw = RewriteSdp(offer, to_receiver);
  fprintf(stderr, "[offer → receiver] kept: %s (dropped %d)\n", offer_rw.kept_candidate.c_str(),
          offer_rw.dropped);
  if (a.verbose) fprintf(stderr, "---- offer ----\n%s----\n", offer_rw.sdp.c_str());
  if (!receiver.SetRemote(true, offer_rw.sdp, &err)) {
    fprintf(stderr, "receiver SetRemote(offer) failed: %s\n", err.c_str());
    return 1;
  }
  if (!receiver.CreateLocal(false, &answer, &err)) {
    fprintf(stderr, "answer failed: %s\n", err.c_str());
    return 1;
  }
  SdpRewrite to_sender;
  to_sender.shaper_port = a.shaper_s;  // the sender sends to the shaper port facing it
  to_sender.codec_name = a.codec;
  // The sender's send codec comes from the answer, so the bitrate envelope rides in its fmtp.
  to_sender.fmtp_extra = {{"x-google-start-bitrate", std::to_string(a.start_kbps)},
                          {"x-google-max-bitrate", std::to_string(a.max_kbps)},
                          {"x-google-min-bitrate", std::to_string(a.min_kbps)}};
  SdpRewriteResult answer_rw = RewriteSdp(answer, to_sender);
  fprintf(stderr, "[answer → sender] kept: %s (dropped %d)\n", answer_rw.kept_candidate.c_str(),
          answer_rw.dropped);
  if (a.verbose) fprintf(stderr, "---- answer ----\n%s----\n", answer_rw.sdp.c_str());
  if (!sender.SetRemote(false, answer_rw.sdp, &err)) {
    fprintf(stderr, "sender SetRemote(answer) failed: %s\n", err.c_str());
    return 1;
  }
  if (!sender.WaitConnected(15000) || !receiver.WaitConnected(15000)) {
    fprintf(stderr, "not connected after 15 s (sender %s, receiver %s)\n",
            sender.ConnectionStateName().c_str(), receiver.ConnectionStateName().c_str());
    return 1;
  }
  fprintf(stderr, "connected in %.0f ms\n", (SpikeNowUs(clock.harness) - t_neg0) / 1000.0);

  // ---- producer: frame n at t0 + n * period ----
  std::atomic<bool> stop{false};
  std::atomic<int64_t> frames_pushed{0};
  spike_source* src = use_harness ? harness.source_open(a.width, a.height) : nullptr;
  if (use_harness && !src) {
    fprintf(stderr, "spike_source_open failed\n");
    return 1;
  }
  const int64_t t0 = SpikeNowUs(clock.harness);
  clock.t0_us = t0;
  std::thread producer([&] {
    const size_t nv12_size = static_cast<size_t>(a.width) * a.height * 3 / 2;
    using sc_t = std::chrono::steady_clock;
    const auto start = sc_t::now();
    for (uint64_t n = 0; !stop; ++n) {
      const auto target = start + std::chrono::microseconds(n * clock.period_us);
      std::this_thread::sleep_until(target - std::chrono::microseconds(900));
      while (sc_t::now() < target) {
        std::this_thread::yield();
      }
      if (stop) break;
      auto buf = webrtc::NV12Buffer::Create(a.width, a.height);
      if (use_harness) {
        harness.source_frame(src, n, buf->MutableDataY(), nv12_size);
      } else {
        SyntheticFrame(n, a.width, a.height, buf->MutableDataY(), buf->MutableDataUV());
      }
      webrtc::VideoFrame frame = webrtc::VideoFrame::Builder()
                                     .set_video_frame_buffer(buf)
                                     .set_timestamp_us(webrtc::TimeMicros())
                                     .build();
      source->Push(frame);
      frames_pushed = static_cast<int64_t>(n) + 1;
    }
  });

  // ---- the 1 Hz CSV loop ----
  StatsSnapshot ps, pr;  // previous
  int64_t prev_cost = 0, prev_frames_in = 0, prev_dec_err = 0, prev_g2g_total = 0, prev_g2g_n = 0;
  int64_t prev_g2g_max_reset = 0;
  (void)prev_g2g_max_reset;
  for (int sec = 1; sec <= a.duration_s; ++sec) {
    const int64_t due = t0 + static_cast<int64_t>(sec) * 1000000;
    while (SpikeNowUs(clock.harness) < due) std::this_thread::sleep_for(std::chrono::milliseconds(2));
    const double t = (SpikeNowUs(clock.harness) - t0) / 1e6;
    StatsSnapshot s, r;
    if (!sender.GetStats(&s, 700)) s.valid = false;
    if (!receiver.GetStats(&r, 700)) r.valid = false;

    // sender line
    {
      const double fps_sent = s.valid && ps.valid ? static_cast<double>(s.frames_sent - ps.frames_sent) : 0;
      const double kbps_sent = s.valid && ps.valid
          ? ((s.bytes_sent + s.header_bytes_sent) - (ps.bytes_sent + ps.header_bytes_sent)) * 8.0 / 1000.0
          : 0;
      const int target_kbps = use_harness ? enc_stats.target_kbps.load()
                                          : static_cast<int>(s.target_bitrate_bps / 1000.0);
      double cost_us = 0;
      if (use_harness) {
        const int64_t c = enc_stats.cost_us_total.load(), f = enc_stats.frames_in.load();
        if (f > prev_frames_in) cost_us = static_cast<double>(c - prev_cost) / (f - prev_frames_in);
        prev_cost = c;
        prev_frames_in = f;
      } else if (s.valid && ps.valid && s.frames_encoded > ps.frames_encoded) {
        cost_us = (s.total_encode_time_s - ps.total_encode_time_s) * 1e6 / (s.frames_encoded - ps.frames_encoded);
      }
      const double rtt_ms = s.rtt_s ? *s.rtt_s * 1000 : (s.pair_rtt_s ? *s.pair_rtt_s * 1000 : -1);
      const double loss_pct = s.fraction_lost ? *s.fraction_lost * 100 : 0;
      const double bwe_kbps = s.available_outgoing_bitrate_bps ? *s.available_outgoing_bitrate_bps / 1000 : -1;
      const std::string encoder = use_harness ? enc_stats.name : s.encoder_implementation;
      char line[512];
      snprintf(line, sizeof line, "%.1f,%s,%.0f,%.0f,%d,%.0f,%.1f,%.2f,%.0f,%u,%s,%u,%u,%s,%s\n", t,
               encoder.c_str(), fps_sent, kbps_sent, target_kbps, cost_us, rtt_ms, loss_pct, bwe_kbps,
               s.frames_encoded, s.quality_limitation_reason.c_str(), s.out_nack, s.out_pli,
               s.out_codec.c_str(), s.encoder_implementation.c_str());
      fs << line;
      fs.flush();
      printf("S %s", line);
    }
    // receiver line
    {
      int64_t total = 0, in_window = 0;
      double freeze_ms = 0;
      sink.Snapshot(&total, &in_window, &freeze_ms);
      const double kbps_rx = r.valid && pr.valid
          ? ((r.bytes_received + r.header_bytes_received) - (pr.bytes_received + pr.header_bytes_received)) * 8.0 / 1000.0
          : 0;
      const int64_t dec_err = dec_stats.errors.load();
      const int decode_ok = (dec_err == prev_dec_err) ? 1 : 0;
      prev_dec_err = dec_err;
      double g2g_avg = -1, g2g_max = -1;
      if (harness_decoder) {
        const int64_t gt = dec_stats.g2g_us_total.load(), gn = dec_stats.g2g_samples.load();
        if (gn > prev_g2g_n) g2g_avg = static_cast<double>(gt - prev_g2g_total) / (gn - prev_g2g_n) / 1000.0;
        prev_g2g_total = gt;
        prev_g2g_n = gn;
        g2g_max = dec_stats.g2g_us_max.exchange(0) / 1000.0;
      }
      double jb_ms = -1;
      if (r.valid && pr.valid && r.jitter_buffer_emitted_count > pr.jitter_buffer_emitted_count) {
        jb_ms = (r.jitter_buffer_delay_s - pr.jitter_buffer_delay_s) * 1000.0 /
                static_cast<double>(r.jitter_buffer_emitted_count - pr.jitter_buffer_emitted_count);
      }
      const std::string decoder = harness_decoder ? dec_stats.name : r.decoder_implementation;
      char line[512];
      snprintf(line, sizeof line, "%.1f,%lld,%lld,%.0f,%d,%.0f,%.1f,%.1f,%.1f,%u,%u,%u,%u,%s\n", t,
               static_cast<long long>(total), static_cast<long long>(in_window), kbps_rx, decode_ok,
               freeze_ms, g2g_avg, g2g_max, jb_ms, r.in_nack, r.in_pli, r.frames_dropped, r.freeze_count,
               decoder.c_str());
      fr << line;
      fr.flush();
      printf("R %s", line);
    }
    fflush(stdout);
    ps = s;
    pr = r;
  }

  // ---- summary + teardown ----
  stop = true;
  producer.join();
  fs.close();
  fr.close();
  StatsSnapshot fin;
  sender.GetStats(&fin, 700);
  fprintf(stderr,
          "done: pushed %lld frames, encoder %s (stats impl '%s', power-efficient %s), codec %s, "
          "frames_encoded %u key %u, set_rates %d keyframe-requests %d, decoder %s decoded %lld "
          "errors %lld counter-read %lld\n",
          static_cast<long long>(frames_pushed.load()), enc_stats.name.c_str(),
          fin.encoder_implementation.c_str(),
          fin.power_efficient_encoder ? (*fin.power_efficient_encoder ? "yes" : "no") : "n/a",
          fin.out_codec.c_str(), fin.frames_encoded, fin.key_frames_encoded, enc_stats.set_rates_calls.load(),
          enc_stats.keyframe_requests.load(), dec_stats.name.c_str(),
          static_cast<long long>(dec_stats.decoded.load()), static_cast<long long>(dec_stats.errors.load()),
          static_cast<long long>(dec_stats.counter_read.load()));
  fprintf(stderr, "csv: %s\n     %s\n", sender_csv.c_str(), receiver_csv.c_str());

  sender.Close();
  receiver.Close();
  if (src) harness.source_close(src);
  webrtc::LogMessage::RemoveLogToStream(&log_sink);
  webrtc::CleanupSSL();
  timeEndPeriod(1);
  return 0;
}
