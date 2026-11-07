// castcade-video: what the helper knows about the GPU without a vendor SDK: the adapter's name (DXGI), the
// NVIDIA performance state (nvml.dll loaded at run time, absent on other vendors), and a small D3D11 compute loop
// that keeps the GPU out of its idle P-state while `--bench` encodes (D10.1.2: encode-only load lets the clocks drop
// after ~8 s and the encode time triples; a running VPX keeps them up, the bench stands in for it).
#pragma once

#include <atomic>
#include <memory>
#include <string>
#include <thread>

// The first hardware adapter's description ("NVIDIA GeForce RTX 3090"), "" when DXGI has none.
std::string GpuAdapterName();

class Nvml {
 public:
  ~Nvml();
  // true when nvml.dll loaded and device 0 answered.
  bool Load();
  // "P0".."P15", or "-" when NVML is not there.
  std::string PState();

 private:
  void* module_ = nullptr;
  void* device_ = nullptr;
  void* get_pstate_ = nullptr;
  bool inited_ = false;
};

class GpuLoad {
 public:
  ~GpuLoad() { Stop(); }
  // Starts the compute loop on its own thread. false (with the reason) when D3D11 or the shader compiler is missing.
  bool Start(std::string* error);
  void Stop();
  bool running() const { return thread_.joinable(); }
  int64_t dispatches() const { return dispatches_.load(); }

 private:
  std::thread thread_;
  std::atomic<bool> stop_{false};
  std::atomic<int64_t> dispatches_{0};
};
