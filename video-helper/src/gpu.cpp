#include "gpu.h"

#include <windows.h>
#include <d3d11.h>
#include <d3dcompiler.h>
#include <dxgi1_2.h>
#include <wrl/client.h>

#include <chrono>
#include <cstdio>

#include "util.h"

using Microsoft::WRL::ComPtr;

std::string GpuAdapterName() {
  ComPtr<IDXGIFactory1> factory;
  if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory)))) return "";
  for (UINT i = 0;; i++) {
    ComPtr<IDXGIAdapter1> adapter;
    if (factory->EnumAdapters1(i, &adapter) != S_OK) break;
    DXGI_ADAPTER_DESC1 desc{};
    if (FAILED(adapter->GetDesc1(&desc))) continue;
    if (desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) continue;
    return Utf8FromWide(desc.Description);
  }
  return "";
}

// ---------------------------------------------------------------- NVML (run-time bound; no header needed)

namespace {
typedef int (*nvmlInit_t)();
typedef int (*nvmlShutdown_t)();
typedef int (*nvmlDeviceGetHandleByIndex_t)(unsigned, void**);
typedef int (*nvmlDeviceGetPerformanceState_t)(void*, unsigned*);
}  // namespace

bool Nvml::Load() {
  // The driver installs nvml.dll into System32 (and under NVSMI on old drivers). Absent on non-NVIDIA machines.
  HMODULE m = LoadLibraryW(L"nvml.dll");
  if (!m) m = LoadLibraryW(L"C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvml.dll");
  if (!m) return false;
  auto init = (nvmlInit_t)GetProcAddress(m, "nvmlInit_v2");
  auto by_index = (nvmlDeviceGetHandleByIndex_t)GetProcAddress(m, "nvmlDeviceGetHandleByIndex_v2");
  auto pstate = (nvmlDeviceGetPerformanceState_t)GetProcAddress(m, "nvmlDeviceGetPerformanceState");
  if (!init || !by_index || !pstate || init() != 0) {
    FreeLibrary(m);
    return false;
  }
  inited_ = true;
  void* dev = nullptr;
  if (by_index(0, &dev) != 0) {
    auto shutdown = (nvmlShutdown_t)GetProcAddress(m, "nvmlShutdown");
    if (shutdown) shutdown();
    inited_ = false;
    FreeLibrary(m);
    return false;
  }
  module_ = m;
  device_ = dev;
  get_pstate_ = (void*)pstate;
  return true;
}

std::string Nvml::PState() {
  if (!module_) return "-";
  unsigned p = 0;
  if (((nvmlDeviceGetPerformanceState_t)get_pstate_)(device_, &p) != 0) return "-";
  return "P" + std::to_string(p);
}

Nvml::~Nvml() {
  if (module_) {
    if (inited_) {
      auto shutdown = (nvmlShutdown_t)GetProcAddress((HMODULE)module_, "nvmlShutdown");
      if (shutdown) shutdown();
    }
    FreeLibrary((HMODULE)module_);
  }
}

// ---------------------------------------------------------------- the load loop

namespace {
const char kShader[] =
    "RWStructuredBuffer<float> buf : register(u0);\n"
    "[numthreads(256, 1, 1)] void main(uint3 id : SV_DispatchThreadID) {\n"
    "  float v = buf[id.x];\n"
    "  [loop] for (int i = 0; i < 1024; i++) v = sin(v) * 1.0001f + 0.37f;\n"
    "  buf[id.x] = v;\n"
    "}\n";
constexpr UINT kElements = 256 * 8192;  // two million threads a dispatch: a few ms of work on a big GPU
}  // namespace

bool GpuLoad::Start(std::string* error) {
  Stop();
  ComPtr<ID3D11Device> dev;
  ComPtr<ID3D11DeviceContext> ctx;
  D3D_FEATURE_LEVEL fl;
  HRESULT hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, 0, nullptr, 0, D3D11_SDK_VERSION,
                                 &dev, &fl, &ctx);
  if (FAILED(hr)) {
    *error = "D3D11CreateDevice failed";
    return false;
  }
  ComPtr<ID3DBlob> code, errors;
  hr = D3DCompile(kShader, sizeof kShader - 1, "load.hlsl", nullptr, nullptr, "main", "cs_5_0", 0, 0, &code, &errors);
  if (FAILED(hr)) {
    *error = std::string("D3DCompile failed: ") + (errors ? (const char*)errors->GetBufferPointer() : "");
    return false;
  }
  ComPtr<ID3D11ComputeShader> cs;
  if (FAILED(dev->CreateComputeShader(code->GetBufferPointer(), code->GetBufferSize(), nullptr, &cs))) {
    *error = "CreateComputeShader failed";
    return false;
  }
  D3D11_BUFFER_DESC bd{};
  bd.ByteWidth = kElements * sizeof(float);
  bd.Usage = D3D11_USAGE_DEFAULT;
  bd.BindFlags = D3D11_BIND_UNORDERED_ACCESS;
  bd.MiscFlags = D3D11_RESOURCE_MISC_BUFFER_STRUCTURED;
  bd.StructureByteStride = sizeof(float);
  ComPtr<ID3D11Buffer> buf;
  if (FAILED(dev->CreateBuffer(&bd, nullptr, &buf))) {
    *error = "CreateBuffer failed";
    return false;
  }
  D3D11_UNORDERED_ACCESS_VIEW_DESC ud{};
  ud.Format = DXGI_FORMAT_UNKNOWN;
  ud.ViewDimension = D3D11_UAV_DIMENSION_BUFFER;
  ud.Buffer.NumElements = kElements;
  ComPtr<ID3D11UnorderedAccessView> uav;
  if (FAILED(dev->CreateUnorderedAccessView(buf.Get(), &ud, &uav))) {
    *error = "CreateUnorderedAccessView failed";
    return false;
  }
  D3D11_QUERY_DESC qd{D3D11_QUERY_EVENT, 0};
  ComPtr<ID3D11Query> query;
  dev->CreateQuery(&qd, &query);

  stop_ = false;
  thread_ = std::thread([this, dev, ctx, cs, uav, query]() mutable {
    ID3D11UnorderedAccessView* uavs[1] = {uav.Get()};
    ctx->CSSetShader(cs.Get(), nullptr, 0);
    ctx->CSSetUnorderedAccessViews(0, 1, uavs, nullptr);
    while (!stop_) {
      // A few milliseconds of work, waited for, then a short pause: the GPU is busy most of the time without being
      // saturated, which is what a running game looks like to the clock governor (an idle-ish load is not enough:
      // the first version at ~10 % busy still let the clocks fall to P8).
      ctx->Dispatch(kElements / 256, 1, 1);
      ctx->End(query.Get());
      ctx->Flush();
      BOOL done = FALSE;
      while (!stop_ && ctx->GetData(query.Get(), &done, sizeof done, 0) != S_OK) std::this_thread::yield();
      dispatches_++;
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
  });
  return true;
}

void GpuLoad::Stop() {
  stop_ = true;
  if (thread_.joinable()) thread_.join();
}
