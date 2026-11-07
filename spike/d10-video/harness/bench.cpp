// spike_bench: the harness dll's smoke test. Encodes 600 synthetic frames at 1354x1440 / 60 fps / 20 Mbps,
// then decodes them and checks the burned-in counters read back.
//   spike_bench [--encoder <name>] [--decoder h264_cuvid|d3d11va|h264] [--frames 600] [--kbps 20000] [--pace]
// --pace encodes in real time (one frame every 1/60 s, the GPU otherwise idle, as the candidates do) and prints
// the mean encode cost once a second, to see the encoder's behaviour over time rather than back to back.
#include "spike_harness.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

int main(int argc, char** argv) {
  const char* enc_force = nullptr;
  const char* dec_force = nullptr;
  int frames = 600, kbps = 20000, W = 1354, H = 1440, FPS = 60;
  bool pace = false;
  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--pace")) pace = true;
    else if (!strcmp(argv[i], "--encoder") && i + 1 < argc) enc_force = argv[++i];
    else if (!strcmp(argv[i], "--decoder") && i + 1 < argc) dec_force = argv[++i];
    else if (!strcmp(argv[i], "--frames") && i + 1 < argc) frames = atoi(argv[++i]);
    else if (!strcmp(argv[i], "--kbps") && i + 1 < argc) kbps = atoi(argv[++i]);
    else { fprintf(stderr, "usage: spike_bench [--encoder name] [--decoder name] [--frames n] [--kbps n]\n"); return 2; }
  }
  spike_source* src = spike_source_open(W, H);
  if (!src) { fprintf(stderr, "source open failed\n"); return 1; }
  spike_encoder_config cfg{W, H, FPS, kbps, 0, enc_force};
  spike_encoder* enc = spike_encoder_open(&cfg);
  if (!enc) { fprintf(stderr, "no encoder opened\n"); return 1; }
  printf("encoder: %s\n", spike_encoder_name(enc));

  std::vector<uint8_t> nv12((size_t)W * H * 3 / 2);
  std::vector<std::vector<uint8_t>> aus;
  aus.reserve(frames);
  int64_t total_bytes = 0, cost_sum = 0, cost_max = 0, buffered = 0, idrs = 0;
  const int64_t t_start = spike_now_us();
  int64_t sec_cost = 0; int sec_n = 0;
  for (int n = 0; n < frames; n++) {
    if (pace) {
      const int64_t due = t_start + (int64_t)n * 1000000 / FPS;
      while (spike_now_us() < due) {}
      if (n && n % FPS == 0) { printf("  t=%ds mean encode cost %lld us\n", n / FPS, (long long)(sec_cost / (sec_n ? sec_n : 1))); sec_cost = 0; sec_n = 0; }
    }
    spike_source_frame(src, (uint64_t)n, nv12.data(), nv12.size());
    if (n == frames / 2) spike_encoder_set_bitrate(enc, kbps / 2);  // exercise the live change
    if (n == frames * 3 / 4) spike_encoder_set_bitrate(enc, kbps);
    if (n == 200) spike_encoder_request_keyframe(enc);  // explicit request; any other IDR is the encoder's doing
    const uint8_t* out; size_t size; int key;
    int r = spike_encoder_encode(enc, nv12.data(), (uint64_t)n * 90000 / FPS, &out, &size, &key);
    if (r < 0) { fprintf(stderr, "encode error %d at frame %d\n", r, n); return 1; }
    if (r == 1) { buffered++; continue; }
    const int64_t c = spike_encoder_last_cost_us(enc);
    cost_sum += c; if (c > cost_max) cost_max = c;
    sec_cost += c; sec_n++;
    total_bytes += (int64_t)size; idrs += key;
    if (key) printf("IDR at frame %d (%zu bytes)\n", n, size);
    aus.emplace_back(out, out + size);
  }
  const double secs = (spike_now_us() - t_start) / 1e6;
  const double wall_fps = frames / secs;
  printf("frames: %d encoded in %.2fs (%.1f fps wall, source+encode), %lld buffered, %lld IDR\n", frames, secs, wall_fps, (long long)buffered, (long long)idrs);
  printf("encode cost: mean %.0f us, max %lld us\n", (double)cost_sum / (frames - buffered), (long long)cost_max);
  printf("bitrate: %.0f kbps over %d frames at %d fps (target %d, halved for the third quarter)\n",
         total_bytes * 8.0 / ((double)frames / FPS) / 1000.0, frames, FPS, kbps);
  spike_encoder_close(enc);

  spike_decoder* dec = spike_decoder_open(dec_force);
  if (!dec) { fprintf(stderr, "no decoder opened\n"); return 1; }
  printf("decoder: %s\n", spike_decoder_name(dec));
  int64_t decoded = 0, ok = 0, unreadable = 0, wrong = 0, expect = 0;
  const int64_t d0 = spike_now_us();
  for (size_t i = 0; i <= aus.size(); i++) {
    int64_t counter = -1;
    int r = i < aus.size() ? spike_decoder_decode(dec, aus[i].data(), aus[i].size(), &counter)
                           : spike_decoder_decode(dec, nullptr, 0, &counter);  // flush
    if (r < 0) { fprintf(stderr, "decode error %d at au %zu\n", r, i); break; }
    for (int k = 0; k < r; k++, expect++) {
      decoded++;
      if (counter < 0) unreadable++;
      else if (counter == (expect & 0xFFFF)) ok++;
      else wrong++;
    }
  }
  const double dsecs = (spike_now_us() - d0) / 1e6;
  printf("decoded: %lld frames in %.2fs (%.1f fps); counters: %lld correct, %lld wrong, %lld unreadable\n",
         (long long)decoded, dsecs, decoded / dsecs, (long long)ok, (long long)wrong, (long long)unreadable);
  spike_decoder_close(dec);
  spike_source_close(src);
  return (decoded == (int64_t)aus.size() && wrong == 0 && unreadable == 0) ? 0 : 3;
}
