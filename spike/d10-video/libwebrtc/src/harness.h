// D10.0.1 libwebrtc candidate: the shared harness (castcade_spike_harness.dll) loaded at run time.
// The import library is never linked: another worker builds the DLL in parallel, so the exe must come
// up without it (--no-harness) and bind by name when it exists.
#pragma once

#include <cstdint>
#include <string>

#include <windows.h>

#include "spike_harness.h"  // signatures only (decltype); the SPIKE_API symbols are never referenced

struct Harness {
  HMODULE mod = nullptr;
  std::string path;

  decltype(&spike_source_open) source_open = nullptr;
  decltype(&spike_source_frame) source_frame = nullptr;
  decltype(&spike_source_close) source_close = nullptr;
  decltype(&spike_encoder_open) encoder_open = nullptr;
  decltype(&spike_encoder_name) encoder_name = nullptr;
  decltype(&spike_encoder_encode) encoder_encode = nullptr;
  decltype(&spike_encoder_set_bitrate) encoder_set_bitrate = nullptr;
  decltype(&spike_encoder_request_keyframe) encoder_request_keyframe = nullptr;
  decltype(&spike_encoder_last_cost_us) encoder_last_cost_us = nullptr;
  decltype(&spike_encoder_close) encoder_close = nullptr;
  decltype(&spike_decoder_open) decoder_open = nullptr;
  decltype(&spike_decoder_name) decoder_name = nullptr;
  decltype(&spike_decoder_decode) decoder_decode = nullptr;
  decltype(&spike_decoder_close) decoder_close = nullptr;
  decltype(&spike_now_us) now_us = nullptr;

  bool loaded() const { return mod != nullptr; }
  // LoadLibraryEx with the altered search path so the FFmpeg DLLs beside the harness resolve.
  bool Load(const std::string& dll_path, std::string* error);
  void Unload();
};

// Monotonic microseconds: the harness clock when loaded, QueryPerformanceCounter otherwise.
int64_t SpikeNowUs(const Harness* h);
