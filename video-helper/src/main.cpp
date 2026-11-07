// castcade-video: the native spectator-video helper (WORK D10.1, ADR 0010; docs/design/spectator-video-native.md §3,
// §6). A libwebrtc peer per remote player with our libavcodec H.264 encoder (NVENC → AMF → QSV → x264) and decoder
// (cuvid → D3D11VA → software) plugged in; frames come and go through the shared-memory rings of
// include/castcade_frame_ring.h; the companion drives it over stdin / stdout in JSON lines (README.md, §6.2).
//
//   castcade-video.exe                      the stdio protocol (the companion spawns it this way)
//   castcade-video.exe --version | --probe | --bench [...] | --ring-selftest | --loopback-selftest [--seconds 5]
//                      | --window-selftest [--seconds 5] [--warp]
//
// Exit codes as the audio helper: 0 normal (also after `quit` or stdin EOF), 2 the helper cannot run here (no
// H.264 encoder at all, libwebrtc did not start), 64 bad arguments.

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

#include "bench.h"
#include "codecs.h"
#include "gpu.h"
#include "json.h"
#include "selftest.h"
#include "util.h"

namespace {

constexpr int kExitOk = 0, kExitCannotRun = 2, kExitBadArgs = 64;

void Usage() {
  printf("castcade-video %s: the spectator-video helper of a Castcade match (D10.1).\n"
         "usage: castcade-video.exe [mode] [options]\n"
         "  (no mode)              the stdio protocol: JSON commands on stdin, JSON events on stdout (README.md)\n"
         "  --version              print the version\n"
         "  --probe                open each encoder / decoder candidate in turn, print one JSON line\n"
         "  --bench                encode synthetic frames; options below\n"
         "  --ring-selftest        produce and consume a frame ring in this process for 3 s\n"
         "  --loopback-selftest    two in-process peers over real libwebrtc for --seconds (default 5)\n"
         "  --window-selftest      open the sink window and feed it the bench pattern at 60 fps for --seconds (default 5);\n"
         "                         --warp skips the hardware D3D11 device (what a GPU-less runner falls back to)\n"
         "bench options: --seconds 10 --width 1354 --height 1440 --fps 60 --kbps 20000 --gpu-load\n"
         "               --rate-policy limited|naive --rate-jitter 5 --encoder <name>\n",
         CASTCADE_VIDEO_VERSION);
}

int ArgInt(const char* name, const char* v, bool* ok) {
  char* end = nullptr;
  long n = strtol(v, &end, 10);
  if (!end || *end) { fprintf(stderr, "castcade-video: bad integer for %s: %s\n", name, v); *ok = false; return 0; }
  return (int)n;
}

int RunProbe() {
  InstallAvLog();
  ProbeResult p = ProbeCodecs(1354, 1440, 60);
  Json j = Json::Object();
  j.Set("encoder", p.encoder.empty() ? Json::Null() : Json::String(p.encoder));
  j.Set("decoder", p.decoder.empty() ? Json::Null() : Json::String(p.decoder));
  j.Set("gpu", Json::String(GpuAdapterName()));
  printf("%s\n", j.Dump().c_str());
  fflush(stdout);
  return p.encoder.empty() ? kExitCannotRun : kExitOk;
}

}  // namespace

int RunProtocol(const ProbeResult& probe);

int main(int argc, char** argv) {
  enum class Mode { kProtocol, kProbe, kBench, kRing, kLoopback, kWindow } mode = Mode::kProtocol;
  BenchOptions bench;
  int seconds = -1;
  bool warp = false;
  bool ok = true;
  for (int i = 1; i < argc; i++) {
    const std::string a = argv[i];
    auto need = [&](const char* name) -> const char* {
      if (i + 1 >= argc) { fprintf(stderr, "castcade-video: %s needs a value\n", name); ok = false; return "0"; }
      return argv[++i];
    };
    if (a == "--version") { printf("castcade-video %s\n", CASTCADE_VIDEO_VERSION); return kExitOk; }
    else if (a == "--help" || a == "-help" || a == "-h" || a == "/?") { Usage(); return kExitOk; }
    else if (a == "--probe") mode = Mode::kProbe;
    else if (a == "--bench") mode = Mode::kBench;
    else if (a == "--ring-selftest") mode = Mode::kRing;
    else if (a == "--loopback-selftest") mode = Mode::kLoopback;
    else if (a == "--window-selftest") mode = Mode::kWindow;
    else if (a == "--warp") warp = true;
    else if (a == "--seconds") seconds = ArgInt("--seconds", need("--seconds"), &ok);
    else if (a == "--width") bench.width = ArgInt("--width", need("--width"), &ok);
    else if (a == "--height") bench.height = ArgInt("--height", need("--height"), &ok);
    else if (a == "--fps") bench.fps = ArgInt("--fps", need("--fps"), &ok);
    else if (a == "--kbps") bench.kbps = ArgInt("--kbps", need("--kbps"), &ok);
    else if (a == "--gpu-load") bench.gpu_load = true;
    else if (a == "--rate-jitter") bench.jitter_pct = ArgInt("--rate-jitter", need("--rate-jitter"), &ok);
    else if (a == "--encoder") bench.encoder = need("--encoder");
    else if (a == "--rate-policy") {
      if (!ParseRatePolicy(need("--rate-policy"), &bench.policy)) { fprintf(stderr, "castcade-video: --rate-policy is limited or naive\n"); ok = false; }
    } else {
      fprintf(stderr, "castcade-video: unknown argument %s (try --help)\n", a.c_str());
      return kExitBadArgs;
    }
    if (!ok) return kExitBadArgs;
  }
  switch (mode) {
    case Mode::kProbe: return RunProbe();
    case Mode::kBench:
      if (seconds > 0) bench.seconds = seconds;
      InstallAvLog();
      return RunBench(bench);
    case Mode::kRing: return RunRingSelftest();
    case Mode::kLoopback:
      InstallAvLog();
      return RunLoopbackSelftest(seconds > 0 ? seconds : 5);
    case Mode::kWindow: return RunWindowSelftest(seconds > 0 ? seconds : 5, warp);
    case Mode::kProtocol: break;
  }
  InstallAvLog();
  ProbeResult probe = ProbeCodecs(1354, 1440, 60);
  if (probe.encoder.empty()) {
    LogLine("no H.264 encoder opened (not even libx264): cannot run here");
    return kExitCannotRun;
  }
  return RunProtocol(probe);
}
