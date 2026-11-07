#include "harness.h"

#include <cstdio>

namespace {
template <typename F>
bool Bind(HMODULE mod, const char* name, F* out, std::string* error) {
  FARPROC p = GetProcAddress(mod, name);
  if (!p) {
    *error = std::string("missing export ") + name;
    return false;
  }
  *out = reinterpret_cast<F>(p);
  return true;
}
}  // namespace

bool Harness::Load(const std::string& dll_path, std::string* error) {
  Unload();
  char full[MAX_PATH];
  DWORD n = GetFullPathNameA(dll_path.c_str(), MAX_PATH, full, nullptr);
  path = (n > 0 && n < MAX_PATH) ? std::string(full) : dll_path;
  mod = LoadLibraryExA(path.c_str(), nullptr, LOAD_WITH_ALTERED_SEARCH_PATH);
  if (!mod) {
    char buf[64];
    snprintf(buf, sizeof buf, "LoadLibrary failed, error %lu", GetLastError());
    *error = buf;
    return false;
  }
  bool ok = Bind(mod, "spike_source_open", &source_open, error) &&
            Bind(mod, "spike_source_frame", &source_frame, error) &&
            Bind(mod, "spike_source_close", &source_close, error) &&
            Bind(mod, "spike_encoder_open", &encoder_open, error) &&
            Bind(mod, "spike_encoder_name", &encoder_name, error) &&
            Bind(mod, "spike_encoder_encode", &encoder_encode, error) &&
            Bind(mod, "spike_encoder_set_bitrate", &encoder_set_bitrate, error) &&
            Bind(mod, "spike_encoder_request_keyframe", &encoder_request_keyframe, error) &&
            Bind(mod, "spike_encoder_last_cost_us", &encoder_last_cost_us, error) &&
            Bind(mod, "spike_encoder_close", &encoder_close, error) &&
            Bind(mod, "spike_decoder_open", &decoder_open, error) &&
            Bind(mod, "spike_decoder_name", &decoder_name, error) &&
            Bind(mod, "spike_decoder_decode", &decoder_decode, error) &&
            Bind(mod, "spike_decoder_close", &decoder_close, error) &&
            Bind(mod, "spike_now_us", &now_us, error);
  if (!ok) Unload();
  return ok;
}

void Harness::Unload() {
  if (mod) FreeLibrary(mod);
  mod = nullptr;
  source_open = nullptr;
  source_frame = nullptr;
  source_close = nullptr;
  encoder_open = nullptr;
  encoder_name = nullptr;
  encoder_encode = nullptr;
  encoder_set_bitrate = nullptr;
  encoder_request_keyframe = nullptr;
  encoder_last_cost_us = nullptr;
  encoder_close = nullptr;
  decoder_open = nullptr;
  decoder_name = nullptr;
  decoder_decode = nullptr;
  decoder_close = nullptr;
  now_us = nullptr;
}

int64_t SpikeNowUs(const Harness* h) {
  if (h && h->now_us) return h->now_us();
  static LARGE_INTEGER freq = [] {
    LARGE_INTEGER f;
    QueryPerformanceFrequency(&f);
    return f;
  }();
  LARGE_INTEGER c;
  QueryPerformanceCounter(&c);
  return static_cast<int64_t>(c.QuadPart * 1000000.0 / static_cast<double>(freq.QuadPart));
}
