#include "source_wgc.h"

#include <windows.h>
#include <d3d11.h>
#include <dwmapi.h>
#include <dxgi1_2.h>
#include <inspectable.h>
#include <roapi.h>
#include <winstring.h>
#include <wrl.h>
#include <windows.foundation.h>
#include <windows.foundation.metadata.h>
#include <windows.graphics.capture.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.h>
#include <windows.graphics.directx.direct3d11.interop.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cwctype>
#include <mutex>
#include <thread>
#include <vector>

#include "libyuv/scale_argb.h"

#include "json.h"
#include "source.h"
#include "util.h"

using Microsoft::WRL::ComPtr;
using Microsoft::WRL::Wrappers::HStringReference;
namespace WGC = ABI::Windows::Graphics::Capture;
namespace WFM = ABI::Windows::Foundation::Metadata;
namespace D3D = ABI::Windows::Graphics::DirectX::Direct3D11;
using ABI::Windows::Foundation::ITypedEventHandler;
using ABI::Windows::Graphics::SizeInt32;

namespace {

// ---------------------------------------------------------------- WinRT plumbing without exceptions

// RoInitialize for the calling thread (the finder, the capture thread, the selftest); the pool's callbacks come on
// system threadpool threads, which are MTA already. A thread that is an STA already stays one.
class RoInit {
 public:
  RoInit() { hr_ = RoInitialize(RO_INIT_MULTITHREADED); }
  ~RoInit() { if (hr_ == S_OK || hr_ == S_FALSE) RoUninitialize(); }
 private:
  HRESULT hr_;
};

template <class T>
HRESULT Factory(const WCHAR* runtime_class, ComPtr<T>& out) {
  return RoGetActivationFactory(HStringReference(reinterpret_cast<const wchar_t*>(runtime_class), static_cast<UINT32>(wcslen(reinterpret_cast<const wchar_t*>(runtime_class)))).Get(), __uuidof(T),
                                reinterpret_cast<void**>(out.ReleaseAndGetAddressOf()));
}

std::string Hex(HRESULT hr) {
  char b[16];
  snprintf(b, sizeof b, "0x%08lx", static_cast<unsigned long>(hr));
  return b;
}

// User32 geometry is DPI-virtualised for an unaware thread; the capture is in physical pixels, so every thread that
// measures a window is made per-monitor aware first (what window-geometry.ts does in its probe).
void DpiAware() { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2); }

// ApiInformation::IsPropertyPresent("Windows.Graphics.Capture.GraphicsCaptureSession", "IsBorderRequired"): Windows 11
// (and 10 21H1+). Absent: the yellow capture border stays, nothing else changes.
bool BorderApiPresent() {
  ComPtr<WFM::IApiInformationStatics> api;
  if (FAILED(Factory(RuntimeClass_Windows_Foundation_Metadata_ApiInformation, api))) return false;
  boolean present = 0;
  const HRESULT hr = api->IsPropertyPresent(HStringReference(L"Windows.Graphics.Capture.GraphicsCaptureSession").Get(),
                                            HStringReference(L"IsBorderRequired").Get(), &present);
  return SUCCEEDED(hr) && present;
}

// ---------------------------------------------------------------- finding the window

std::wstring Lower(std::wstring s) {
  for (auto& c : s) c = static_cast<wchar_t>(towlower(c));
  return s;
}

bool Cloaked(HWND h) {
  DWORD c = 0;
  return SUCCEEDED(DwmGetWindowAttribute(h, DWMWA_CLOAKED, &c, sizeof c)) && c != 0;
}

struct FindCtx {
  int pid;
  std::wstring needle;
  WgcWindow best;
  bool found = false;
};

BOOL CALLBACK EnumProc(HWND h, LPARAM l) {
  FindCtx* ctx = reinterpret_cast<FindCtx*>(l);
  if (!IsWindowVisible(h) || IsIconic(h) || Cloaked(h)) return TRUE;
  DWORD pid = 0;
  GetWindowThreadProcessId(h, &pid);
  if (ctx->pid && static_cast<int>(pid) != ctx->pid) return TRUE;
  wchar_t buf[512];
  const int n = GetWindowTextW(h, buf, 512);
  std::wstring title(buf, n > 0 ? n : 0);
  if (!ctx->needle.empty() && Lower(title).find(ctx->needle) == std::wstring::npos) return TRUE;
  RECT r{};
  if (!GetClientRect(h, &r)) return TRUE;
  const int w = r.right - r.left, hh = r.bottom - r.top;
  if (w < 1 || hh < 1) return TRUE;
  if (ctx->found && static_cast<int64_t>(w) * hh <= static_cast<int64_t>(ctx->best.width) * ctx->best.height) return TRUE;
  ctx->best = WgcWindow{reinterpret_cast<uintptr_t>(h), static_cast<int>(pid), Utf8FromWide(title.c_str()), w, hh};
  ctx->found = true;
  return TRUE;
}

// The window's client area inside the captured content (the DWM frame bounds): a windowed VPX's title bar and frame
// are not the playfield. The whole content when it cannot be told or the client area does not lie inside it.
RECT ClientRectIn(HWND hwnd, int cw, int ch) {
  const RECT full{0, 0, cw, ch};
  RECT ext{};
  if (FAILED(DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &ext, sizeof ext))) return full;
  RECT cr{};
  POINT p{0, 0};
  if (!GetClientRect(hwnd, &cr) || !ClientToScreen(hwnd, &p)) return full;
  const int l = p.x - ext.left, t = p.y - ext.top;
  const int r = l + (cr.right - cr.left), b = t + (cr.bottom - cr.top);
  if (l < 0 || t < 0 || r > cw || b > ch || r - l < 1 || b - t < 1) return full;
  return RECT{l, t, r, b};
}

}  // namespace

bool FindWgcWindow(int pid, const std::string& title, WgcWindow* out) {
  DpiAware();
  FindCtx ctx{pid, Lower(WideFromUtf8(title))};
  EnumWindows(EnumProc, reinterpret_cast<LPARAM>(&ctx));
  if (ctx.found) *out = ctx.best;
  return ctx.found;
}

bool WgcSupported(std::string* why) {
  RoInit ro;
  ComPtr<WGC::IGraphicsCaptureSessionStatics> statics;
  const HRESULT hr = Factory(RuntimeClass_Windows_Graphics_Capture_GraphicsCaptureSession, statics);
  if (FAILED(hr)) {
    *why = "Windows.Graphics.Capture is not available (" + Hex(hr) + ")";
    return false;
  }
  boolean ok = 0;
  if (FAILED(statics->IsSupported(&ok)) || !ok) {
    *why = "GraphicsCaptureSession::IsSupported() is false";
    return false;
  }
  return true;
}

// ---------------------------------------------------------------- the capture

struct WgcCapture::Impl {
  std::mutex mu;
  bool stopped = false;
  HWND hwnd = nullptr;
  FrameFn on_frame;
  ComPtr<ID3D11Device> dev;
  ComPtr<ID3D11DeviceContext> ctx;
  ComPtr<D3D::IDirect3DDevice> rt_dev;
  ComPtr<WGC::IGraphicsCaptureItem> item;
  ComPtr<WGC::IDirect3D11CaptureFramePool> pool;
  ComPtr<WGC::IGraphicsCaptureSession> session;
  EventRegistrationToken frame_token{}, closed_token{};
  SizeInt32 pool_size{};
  ComPtr<ID3D11Texture2D> staging;
  int staging_w = 0, staging_h = 0;
  std::atomic<bool> closed{false};
  std::atomic<int64_t> frames{0};
  std::atomic<int64_t> copy_us{0};

  void OnFrame() {
    std::lock_guard<std::mutex> l(mu);
    if (stopped) return;
    DpiAware();
    ComPtr<WGC::IDirect3D11CaptureFrame> frame;
    if (FAILED(pool->TryGetNextFrame(&frame)) || !frame) return;
    const int64_t t0 = NowUs();
    SizeInt32 content{};
    frame->get_ContentSize(&content);
    ComPtr<D3D::IDirect3DSurface> surface;
    if (FAILED(frame->get_Surface(&surface)) || !surface) return;
    ComPtr<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess> access;
    ComPtr<ID3D11Texture2D> tex;
    if (FAILED(surface.As(&access)) || FAILED(access->GetInterface(IID_PPV_ARGS(&tex)))) return;
    D3D11_TEXTURE2D_DESC td{};
    tex->GetDesc(&td);
    // The pool's buffers keep their size until recreated: a window that changed size fills part of this one.
    const int cw = std::min<int>(content.Width, static_cast<int>(td.Width));
    const int ch = std::min<int>(content.Height, static_cast<int>(td.Height));
    if (cw >= 1 && ch >= 1) {
      const RECT crop = ClientRectIn(hwnd, cw, ch);
      const int w = crop.right - crop.left, h = crop.bottom - crop.top;
      if (!staging || staging_w != w || staging_h != h) {
        D3D11_TEXTURE2D_DESC sd{};
        sd.Width = w;
        sd.Height = h;
        sd.MipLevels = 1;
        sd.ArraySize = 1;
        sd.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
        sd.SampleDesc.Count = 1;
        sd.Usage = D3D11_USAGE_STAGING;
        sd.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
        staging.Reset();
        if (SUCCEEDED(dev->CreateTexture2D(&sd, nullptr, &staging))) {
          staging_w = w;
          staging_h = h;
        }
      }
      if (staging) {
        const D3D11_BOX box{static_cast<UINT>(crop.left), static_cast<UINT>(crop.top), 0, static_cast<UINT>(crop.right), static_cast<UINT>(crop.bottom), 1};
        ctx->CopySubresourceRegion(staging.Get(), 0, 0, 0, 0, tex.Get(), 0, &box);
        D3D11_MAPPED_SUBRESOURCE m{};
        if (SUCCEEDED(ctx->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &m))) {
          copy_us += NowUs() - t0;
          frames++;
          if (on_frame) on_frame(static_cast<const uint8_t*>(m.pData), static_cast<int>(m.RowPitch), w, h);
          ctx->Unmap(staging.Get(), 0);
        }
      }
    }
    // The window changed size: the next frames come in buffers of the new size.
    if (content.Width > 0 && content.Height > 0 && (content.Width != pool_size.Width || content.Height != pool_size.Height)) {
      pool_size = content;
      pool->Recreate(rt_dev.Get(), ABI::Windows::Graphics::DirectX::DirectXPixelFormat_B8G8R8A8UIntNormalized, 2, content);
    }
  }
};

WgcCapture::WgcCapture() = default;
WgcCapture::~WgcCapture() { Stop(); }

bool WgcCapture::Start(uintptr_t hwnd, FrameFn on_frame, std::string* err) {
  Stop();
  auto im = std::make_shared<Impl>();
  im->hwnd = reinterpret_cast<HWND>(hwnd);
  im->on_frame = std::move(on_frame);
  HRESULT hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION, &im->dev, nullptr, &im->ctx);
  if (FAILED(hr)) {
    *err = "D3D11CreateDevice failed (" + Hex(hr) + ")";
    return false;
  }
  ComPtr<ID3D10Multithread> mt;
  if (SUCCEEDED(im->dev.As(&mt))) mt->SetMultithreadProtected(TRUE);
  ComPtr<IDXGIDevice> dxgi;
  ComPtr<IInspectable> insp;
  if (FAILED(im->dev.As(&dxgi)) || FAILED(hr = CreateDirect3D11DeviceFromDXGIDevice(dxgi.Get(), &insp)) || FAILED(insp.As(&im->rt_dev))) {
    *err = "CreateDirect3D11DeviceFromDXGIDevice failed (" + Hex(hr) + ")";
    return false;
  }
  ComPtr<IGraphicsCaptureItemInterop> interop;
  if (FAILED(hr = Factory(RuntimeClass_Windows_Graphics_Capture_GraphicsCaptureItem, interop))) {
    *err = "no GraphicsCaptureItem factory (" + Hex(hr) + ")";
    return false;
  }
  if (FAILED(hr = interop->CreateForWindow(im->hwnd, IID_PPV_ARGS(&im->item)))) {
    *err = "GraphicsCaptureItem::CreateForWindow failed (" + Hex(hr) + ")";
    return false;
  }
  SizeInt32 size{};
  im->item->get_Size(&size);
  if (size.Width < 1 || size.Height < 1) {
    *err = "the window has no size";
    return false;
  }
  ComPtr<WGC::IDirect3D11CaptureFramePoolStatics2> pools;
  if (FAILED(hr = Factory(RuntimeClass_Windows_Graphics_Capture_Direct3D11CaptureFramePool, pools)) ||
      FAILED(hr = pools->CreateFreeThreaded(im->rt_dev.Get(), ABI::Windows::Graphics::DirectX::DirectXPixelFormat_B8G8R8A8UIntNormalized, 2, size, &im->pool))) {
    *err = "Direct3D11CaptureFramePool::CreateFreeThreaded failed (" + Hex(hr) + ")";
    return false;
  }
  im->pool_size = size;
  // The callbacks hold the Impl weakly: one in flight after Stop finds nothing to do.
  std::weak_ptr<Impl> weak = im;
  // A free-threaded pool raises its events on threadpool threads and refuses a delegate that is not agile
  // (RO_E_MUST_BE_AGILE): FtmBase makes these two so.
  using FrameHandler = Microsoft::WRL::Implements<Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>, ITypedEventHandler<WGC::Direct3D11CaptureFramePool*, IInspectable*>, Microsoft::WRL::FtmBase>;
  using ClosedHandler = Microsoft::WRL::Implements<Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>, ITypedEventHandler<WGC::GraphicsCaptureItem*, IInspectable*>, Microsoft::WRL::FtmBase>;
  auto on_arrived = Microsoft::WRL::Callback<FrameHandler>(
      [weak](WGC::IDirect3D11CaptureFramePool*, IInspectable*) -> HRESULT {
        if (auto p = weak.lock()) p->OnFrame();
        return S_OK;
      });
  auto on_closed = Microsoft::WRL::Callback<ClosedHandler>(
      [weak](WGC::IGraphicsCaptureItem*, IInspectable*) -> HRESULT {
        if (auto p = weak.lock()) p->closed = true;
        return S_OK;
      });
  if (!on_arrived || !on_closed || FAILED(hr = im->pool->add_FrameArrived(on_arrived.Get(), &im->frame_token))) {
    *err = "FrameArrived handler failed (" + Hex(hr) + ")";
    return false;
  }
  im->item->add_Closed(on_closed.Get(), &im->closed_token);
  if (FAILED(hr = im->pool->CreateCaptureSession(im->item.Get(), &im->session))) {
    *err = "CreateCaptureSession failed (" + Hex(hr) + ")";
    return false;
  }
  ComPtr<WGC::IGraphicsCaptureSession2> s2;
  if (SUCCEEDED(im->session.As(&s2))) s2->put_IsCursorCaptureEnabled(FALSE);
  if (BorderApiPresent()) {
    ComPtr<WGC::IGraphicsCaptureSession3> s3;
    if (SUCCEEDED(im->session.As(&s3))) s3->put_IsBorderRequired(FALSE);
  }
  if (FAILED(hr = im->session->StartCapture())) {
    *err = "StartCapture failed (" + Hex(hr) + ")";
    return false;
  }
  impl_ = std::move(im);
  return true;
}

void WgcCapture::Stop() {
  std::shared_ptr<Impl> im = std::move(impl_);
  if (!im) return;
  {
    std::lock_guard<std::mutex> l(im->mu);  // a callback mid-frame finishes first
    im->stopped = true;
  }
  if (im->pool) im->pool->remove_FrameArrived(im->frame_token);
  if (im->item) im->item->remove_Closed(im->closed_token);
  ComPtr<ABI::Windows::Foundation::IClosable> c;
  if (im->session && SUCCEEDED(im->session.As(&c))) c->Close();
  if (im->pool && SUCCEEDED(im->pool.As(&c))) c->Close();
}

bool WgcCapture::closed() const { return impl_ && impl_->closed.load(); }
int64_t WgcCapture::frames() const { return impl_ ? impl_->frames.load() : 0; }
double WgcCapture::copy_map_us() const {
  if (!impl_) return 0;
  const int64_t n = impl_->frames.load();
  return n ? static_cast<double>(impl_->copy_us.load()) / n : 0;
}

// ---------------------------------------------------------------- the source's wgc run (Source's member, source.h)

namespace {
// Fits w x h inside the box, never upscaled, both sizes even (4:2:0).
void FitBox(int w, int h, int bw, int bh, int* dw, int* dh) {
  const double k = std::min(1.0, std::min(static_cast<double>(bw) / w, static_cast<double>(bh) / h));
  *dw = std::max(2, static_cast<int>(std::lround(w * k)) & ~1);
  *dh = std::max(2, static_cast<int>(std::lround(h * k)) & ~1);
}

std::string WindowWords(const WgcWindow& w) {
  return "\"" + w.title + "\" " + std::to_string(w.width) + "x" + std::to_string(w.height) + " (pid " + std::to_string(w.pid) + ")";
}
}  // namespace

void Source::RunWgc(SourceConfig cfg, uint64_t gen) {
  auto live = [&] { return generation_.load() == gen; };
  auto wait = [&](int ms) {
    for (int t = 0; t < ms && live(); t += 50) std::this_thread::sleep_for(std::chrono::milliseconds(50));
  };
  RoInit ro;
  std::string why;
  if (!WgcSupported(&why)) {
    LogLine("source: wgc: %s", why.c_str());
    SetState("missing");
    while (live()) wait(1000);
    return;
  }
  const int64_t period_us = 1000000 / std::max(1, std::min(120, cfg.fps));
  std::string last_err;
  while (live()) {
    WgcWindow win;
    if (!FindWgcWindow(cfg.pid, cfg.title, &win)) {
      SetState("missing");
      wait(1000);
      continue;
    }
    int64_t due_us = 0;
    std::vector<uint8_t> scaled;
    WgcCapture cap;
    std::string err;
    const bool started = cap.Start(win.hwnd, [&](const uint8_t* bgra, int stride, int w, int h) {
      // The push clock: the window renders at its own rate; one frame per period goes on (the nearest after it is
      // due), whether or not sending; a window that paused restarts the clock from its next frame.
      const int64_t now = NowUs();
      if (due_us == 0) due_us = now;
      if (now < due_us - period_us / 4) return;
      due_us = std::max(due_us + period_us, now + period_us / 2);
      if (!enabled_) {
        Count(0);
        return;
      }
      int dw, dh;
      FitBox(w, h, cfg.width, cfg.height, &dw, &dh);
      const int64_t t0 = NowUs();
      auto buf = webrtc::NV12Buffer::Create(dw, dh);
      if (dw == w && dh == h) {
        ConvertBgraToNv12(bgra, stride, w, h, buf.get());
      } else {
        scaled.resize(static_cast<size_t>(dw) * 4 * dh);
        libyuv::ARGBScale(bgra, stride, w, h, scaled.data(), dw * 4, dw, dh, libyuv::kFilterBilinear);
        ConvertBgraToNv12(scaled.data(), dw * 4, dw, dh, buf.get());
      }
      Count(NowUs() - t0);
      on_frame_(buf, now);
    }, &err);
    if (!started) {
      if (err != last_err) {
        LogLine("source: wgc: %s: %s", WindowWords(win).c_str(), err.c_str());
        last_err = err;
      }
      SetState("missing");
      wait(1000);
      continue;
    }
    last_err.clear();
    LogLine("source: wgc: capturing %s into a %dx%d box at %d fps", WindowWords(win).c_str(), cfg.width, cfg.height, cfg.fps);
    SetWindow(WindowWords(win));
    SetState("ok");
    const char* gone = nullptr;
    while (live() && !gone) {
      std::this_thread::sleep_for(std::chrono::milliseconds(100));
      const HWND h = reinterpret_cast<HWND>(win.hwnd);
      RECT r{};
      if (cap.closed() || !IsWindow(h)) gone = "closed";
      else if (IsIconic(h)) gone = "minimised";
      else if (GetClientRect(h, &r) && (r.right - r.left < 1 || r.bottom - r.top < 1)) gone = "no size";
    }
    cap.Stop();
    SetWindow("");
    if (gone && live()) {
      LogLine("source: wgc: the window is %s; looking again", gone);
      SetState("missing");
    }
  }
}

// ---------------------------------------------------------------- the command

bool ParseWgcSource(const Json& c, SourceConfig* cfg, std::string* err) {
  cfg->kind = SourceConfig::Kind::kWgc;
  cfg->pid = c.GetInt("pid", 0);
  cfg->title = c.GetString("title");
  cfg->width = c.GetInt("width", 1280);
  cfg->height = c.GetInt("height", 720);
  cfg->fps = c.GetInt("fps", 30);
  if (cfg->pid <= 0 && cfg->title.empty()) { *err = "source wgc: pid or title required"; return false; }
  if (cfg->width < 64 || cfg->height < 64 || cfg->fps < 1 || cfg->fps > 120) { *err = "source wgc: bad width / height / fps"; return false; }
  return true;
}

// ---------------------------------------------------------------- the selftest

int RunWgcSelftest(int pid, const std::string& title, int seconds) {
  RoInit ro;
  std::string why;
  if (!WgcSupported(&why)) {
    printf("wgc-selftest: skipped: no capture session (%s)\n", why.c_str());
    return 0;
  }
  WgcWindow win;
  bool found;
  const bool named = pid > 0 || !title.empty();
  if (named) found = FindWgcWindow(pid, title, &win);
  else {
    found = FindWgcWindow(0, "Visual Pinball Player", &win);
    if (!found) {
      const HWND c = GetConsoleWindow();
      RECT r{};
      if (c && GetClientRect(c, &r) && r.right > r.left && r.bottom > r.top) {
        wchar_t buf[512];
        const int n = GetWindowTextW(c, buf, 512);
        win = WgcWindow{reinterpret_cast<uintptr_t>(c), static_cast<int>(GetCurrentProcessId()), Utf8FromWide(std::wstring(buf, n > 0 ? n : 0).c_str()), r.right - r.left, r.bottom - r.top};
        found = true;
      }
    }
  }
  if (!found) {
    if (named) {
      fprintf(stderr, "castcade-video: no visible window matches%s%s\n", pid > 0 ? (" pid " + std::to_string(pid)).c_str() : "", title.empty() ? "" : (" title \"" + title + "\"").c_str());
      return 1;
    }
    printf("wgc-selftest: skipped: no capture session (no window to capture)\n");
    return 0;
  }
  std::mutex mu;
  int last_w = 0, last_h = 0;
  WgcCapture cap;
  std::string err;
  const bool ok = cap.Start(win.hwnd, [&](const uint8_t*, int, int w, int h) {
    std::lock_guard<std::mutex> l(mu);
    last_w = w;
    last_h = h;
  }, &err);
  if (!ok) {
    printf("wgc-selftest: skipped: no capture session (%s: %s)\n", WindowWords(win).c_str(), err.c_str());
    return 0;
  }
  printf("capturing %s for %d s\n", WindowWords(win).c_str(), seconds);
  int64_t prev = 0;
  for (int s = 1; s <= seconds; s++) {
    std::this_thread::sleep_for(std::chrono::seconds(1));
    const int64_t n = cap.frames();
    int w, h;
    {
      std::lock_guard<std::mutex> l(mu);
      w = last_w;
      h = last_h;
    }
    printf("%d: %lld frames (%lld this second), %dx%d%s\n", s, static_cast<long long>(n), static_cast<long long>(n - prev), w, h, cap.closed() ? ", window closed" : "");
    fflush(stdout);
    prev = n;
    if (cap.closed()) break;
  }
  const int64_t frames = cap.frames();
  const double copy = cap.copy_map_us();
  cap.Stop();
  printf("wgc-selftest: frames=%lld size=%dx%d copy_map_us_avg=%.0f fps_avg=%.1f window=%s (%d s)\n", static_cast<long long>(frames), last_w, last_h, copy,
         static_cast<double>(frames) / seconds, WindowWords(win).c_str(), seconds);
  fflush(stdout);
  return frames > 0 ? 0 : 1;
}
