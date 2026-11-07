#include "sink_window.h"

#include <windows.h>
#include <d3d11.h>
#include <d3dcompiler.h>
#include <dxgi1_2.h>
#include <wrl/client.h>

#include <algorithm>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <memory>

#include "util.h"

#pragma warning(push, 4)

using Microsoft::WRL::ComPtr;

namespace {

constexpr wchar_t kClassName[] = L"CastcadeVideoWindow";
constexpr UINT kMsgFrame = WM_APP + 1;      // a new frame is pending
constexpr UINT_PTR kTimerId = 1;            // 250 ms: the "waiting" text, shown when no frame came for 3 s
constexpr int64_t kWaitingAfterUs = 3000000;
constexpr double kDefaultAspect = 1354.0 / 1440.0;  // the eye, until the first frame says otherwise

// A full-screen triangle from SV_VertexID (no vertex buffer); the letterbox is the viewport.
const char kShaders[] =
    "struct VSOut { float4 pos : SV_Position; float2 uv : TEXCOORD0; };\n"
    "VSOut vs(uint id : SV_VertexID) {\n"
    "  float2 uv = float2((id << 1) & 2, id & 2);\n"
    "  VSOut o; o.pos = float4(uv * float2(2, -2) + float2(-1, 1), 0, 1); o.uv = uv; return o;\n"
    "}\n"
    "Texture2D tex : register(t0); SamplerState smp : register(s0);\n"
    "float4 ps(VSOut i) : SV_Target { return float4(tex.Sample(smp, i.uv).rgb, 1); }\n";

typedef BOOL(WINAPI* SetProcessDpiAwarenessContext_t)(HANDLE);
typedef UINT(WINAPI* GetDpiForWindow_t)(HWND);

UINT DpiOf(HWND hwnd) {
  static GetDpiForWindow_t fn = (GetDpiForWindow_t)GetProcAddress(GetModuleHandleW(L"user32.dll"), "GetDpiForWindow");
  const UINT dpi = fn ? fn(hwnd) : 0;
  return dpi ? dpi : 96;
}

void BecomeDpiAware() {
  // Per-monitor v2 so the window is not bitmap-scaled on a high-DPI display. Process-wide: the helper has no other UI.
  // Resolved at run time: the declaration needs a Windows 10 1703 SDK target and the call fails harmlessly if the
  // awareness is already set.
  static bool done = false;
  if (done) return;
  done = true;
  auto fn = (SetProcessDpiAwarenessContext_t)GetProcAddress(GetModuleHandleW(L"user32.dll"), "SetProcessDpiAwarenessContext");
  if (fn) fn((HANDLE)(INT_PTR)-4);  // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
}

struct Monitors {
  std::vector<HMONITOR> all;  // enumeration order
  HMONITOR primary = nullptr;
  static BOOL CALLBACK Enum(HMONITOR m, HDC, LPRECT, LPARAM p) {
    reinterpret_cast<Monitors*>(p)->all.push_back(m);
    return TRUE;
  }
  Monitors() {
    EnumDisplayMonitors(nullptr, nullptr, Enum, reinterpret_cast<LPARAM>(this));
    const POINT origin{0, 0};
    primary = MonitorFromPoint(origin, MONITOR_DEFAULTTOPRIMARY);
  }
  // 0 = primary, n = the n-th display; out of range = primary.
  HMONITOR Pick(int n) const {
    if (n >= 1 && (size_t)n <= all.size()) return all[(size_t)n - 1];
    return primary;
  }
};

const char* HrText(HRESULT hr, char* buf, size_t n) {
  snprintf(buf, n, "0x%08lx", (unsigned long)hr);
  return buf;
}

}  // namespace

struct WindowSink::Handshake {
  std::mutex mu;
  std::condition_variable cv;
  bool done = false, ok = false;
  std::string error;
  void Set(bool okay, const std::string& e) {
    std::lock_guard<std::mutex> l(mu);
    if (done) return;
    done = true;
    ok = okay;
    error = e;
    cv.notify_all();
  }
};

// ---------------------------------------------------------------- the D3D11 side (window thread only)

struct WindowSink::Gfx {
  HWND hwnd = nullptr;
  ComPtr<ID3D11Device> dev;
  ComPtr<ID3D11DeviceContext> ctx;
  ComPtr<IDXGISwapChain1> swap;
  ComPtr<ID3D11RenderTargetView> rtv;
  ComPtr<ID3D11VertexShader> vs;
  ComPtr<ID3D11PixelShader> ps;
  ComPtr<ID3D11SamplerState> sampler;
  ComPtr<ID3D11RasterizerState> raster;
  ComPtr<ID3D11Texture2D> picture;
  ComPtr<ID3D11ShaderResourceView> picture_srv;
  UINT picture_w = 0, picture_h = 0;
  ComPtr<ID3D11ShaderResourceView> text_srv;
  UINT text_w = 0, text_h = 0;
  bool warp = false;
  bool have_frame = false;
  int64_t last_frame_us = 0;
  bool showing_waiting = false;
  // Window state
  bool fullscreen = false, user_touched = false, auto_size = true, topmost = false, minimized = false;
  RECT saved_rect{};
  LONG_PTR saved_style = 0;

  bool CreateDevice(bool force_warp, std::string* error) {
    const D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_10_1, D3D_FEATURE_LEVEL_10_0};
    const UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
    char buf[32];
    HRESULT hr = E_FAIL;
    if (!force_warp) {
      hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, flags, levels, 4, D3D11_SDK_VERSION, &dev, nullptr, &ctx);
      if (SUCCEEDED(hr)) {
        warp = false;
        return true;
      }
      LogLine("window: no hardware D3D11 device (%s): trying WARP", HrText(hr, buf, sizeof buf));
    }
    hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_WARP, nullptr, flags, levels, 4, D3D11_SDK_VERSION, &dev, nullptr, &ctx);
    if (FAILED(hr)) {
      *error = std::string("D3D11CreateDevice failed (hardware and WARP), ") + HrText(hr, buf, sizeof buf);
      return false;
    }
    warp = true;
    return true;
  }

  bool CreateSwapchain(std::string* error) {
    ComPtr<IDXGIDevice> dxgi_dev;
    ComPtr<IDXGIAdapter> adapter;
    ComPtr<IDXGIFactory2> factory;
    if (FAILED(dev.As(&dxgi_dev)) || FAILED(dxgi_dev->GetAdapter(&adapter)) || FAILED(adapter->GetParent(IID_PPV_ARGS(&factory)))) {
      *error = "no IDXGIFactory2 behind the device";
      return false;
    }
    DXGI_SWAP_CHAIN_DESC1 d{};
    d.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    d.SampleDesc.Count = 1;
    d.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    d.BufferCount = 2;
    d.Scaling = DXGI_SCALING_STRETCH;
    d.SwapEffect = DXGI_SWAP_EFFECT_FLIP_DISCARD;
    d.AlphaMode = DXGI_ALPHA_MODE_IGNORE;
    HRESULT hr = factory->CreateSwapChainForHwnd(dev.Get(), hwnd, &d, nullptr, nullptr, &swap);
    if (FAILED(hr)) {
      // A runtime without the flip model (should not exist on Windows 10+): the bitblt model.
      d.SwapEffect = DXGI_SWAP_EFFECT_DISCARD;
      d.BufferCount = 1;
      hr = factory->CreateSwapChainForHwnd(dev.Get(), hwnd, &d, nullptr, nullptr, &swap);
      if (FAILED(hr)) {
        char buf[32];
        *error = std::string("CreateSwapChainForHwnd failed, ") + HrText(hr, buf, sizeof buf);
        return false;
      }
      LogLine("window: flip-model swapchain refused: using the bitblt model");
    }
    factory->MakeWindowAssociation(hwnd, DXGI_MWA_NO_ALT_ENTER);  // full screen is ours (borderless), never DXGI's
    return MakeRtv(error);
  }

  bool MakeRtv(std::string* error) {
    rtv.Reset();
    ComPtr<ID3D11Texture2D> back;
    if (FAILED(swap->GetBuffer(0, IID_PPV_ARGS(&back))) || FAILED(dev->CreateRenderTargetView(back.Get(), nullptr, &rtv))) {
      *error = "no render target view on the back buffer";
      return false;
    }
    return true;
  }

  bool CreatePipeline(std::string* error) {
    ComPtr<ID3DBlob> vcode, pcode, errors;
    if (FAILED(D3DCompile(kShaders, sizeof kShaders - 1, "window.hlsl", nullptr, nullptr, "vs", "vs_4_0", 0, 0, &vcode, &errors)) ||
        FAILED(D3DCompile(kShaders, sizeof kShaders - 1, "window.hlsl", nullptr, nullptr, "ps", "ps_4_0", 0, 0, &pcode, &errors))) {
      *error = std::string("D3DCompile failed: ") + (errors ? (const char*)errors->GetBufferPointer() : "");
      return false;
    }
    if (FAILED(dev->CreateVertexShader(vcode->GetBufferPointer(), vcode->GetBufferSize(), nullptr, &vs)) ||
        FAILED(dev->CreatePixelShader(pcode->GetBufferPointer(), pcode->GetBufferSize(), nullptr, &ps))) {
      *error = "shader creation failed";
      return false;
    }
    D3D11_SAMPLER_DESC sd{};
    sd.Filter = D3D11_FILTER_MIN_MAG_MIP_LINEAR;
    sd.AddressU = sd.AddressV = sd.AddressW = D3D11_TEXTURE_ADDRESS_CLAMP;
    sd.MaxLOD = D3D11_FLOAT32_MAX;
    D3D11_RASTERIZER_DESC rd{};
    rd.FillMode = D3D11_FILL_SOLID;
    rd.CullMode = D3D11_CULL_NONE;
    rd.DepthClipEnable = TRUE;
    if (FAILED(dev->CreateSamplerState(&sd, &sampler)) || FAILED(dev->CreateRasterizerState(&rd, &raster))) {
      *error = "sampler / rasterizer creation failed";
      return false;
    }
    return true;
  }

  // The picture texture, re-made when the size changes (dynamic: Map WRITE_DISCARD + row copy each frame).
  bool EnsurePicture(UINT w, UINT h) {
    if (picture && picture_w == w && picture_h == h) return true;
    picture.Reset();
    picture_srv.Reset();
    D3D11_TEXTURE2D_DESC td{};
    td.Width = w;
    td.Height = h;
    td.MipLevels = 1;
    td.ArraySize = 1;
    td.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    td.SampleDesc.Count = 1;
    td.Usage = D3D11_USAGE_DYNAMIC;
    td.BindFlags = D3D11_BIND_SHADER_RESOURCE;
    td.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;
    if (FAILED(dev->CreateTexture2D(&td, nullptr, &picture)) || FAILED(dev->CreateShaderResourceView(picture.Get(), nullptr, &picture_srv))) {
      picture.Reset();
      return false;
    }
    picture_w = w;
    picture_h = h;
    return true;
  }

  // "waiting for the player up", drawn once with GDI into a DIB and uploaded as an immutable texture.
  void MakeWaitingText() {
    const wchar_t* text = L"waiting for the player up";
    const UINT dpi = DpiOf(hwnd);
    HDC dc = CreateCompatibleDC(nullptr);
    if (!dc) return;
    HFONT font = CreateFontW(-MulDiv(13, (int)dpi, 72), 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                             CLIP_DEFAULT_PRECIS, ANTIALIASED_QUALITY, DEFAULT_PITCH | FF_DONTCARE, L"Segoe UI");
    HGDIOBJ old_font = SelectObject(dc, font);
    RECT r{0, 0, 0, 0};
    DrawTextW(dc, text, -1, &r, DT_CALCRECT | DT_SINGLELINE);
    const int w = std::max<int>(1, r.right + 8), h = std::max<int>(1, r.bottom + 4);
    BITMAPINFO bi{};
    bi.bmiHeader.biSize = sizeof bi.bmiHeader;
    bi.bmiHeader.biWidth = w;
    bi.bmiHeader.biHeight = -h;  // top-down
    bi.bmiHeader.biPlanes = 1;
    bi.bmiHeader.biBitCount = 32;
    bi.bmiHeader.biCompression = BI_RGB;
    void* bits = nullptr;
    HBITMAP bmp = CreateDIBSection(dc, &bi, DIB_RGB_COLORS, &bits, nullptr, 0);
    if (bmp && bits) {
      HGDIOBJ old_bmp = SelectObject(dc, bmp);
      RECT full{0, 0, w, h};
      FillRect(dc, &full, (HBRUSH)GetStockObject(BLACK_BRUSH));
      SetBkMode(dc, TRANSPARENT);
      SetTextColor(dc, RGB(190, 190, 190));
      DrawTextW(dc, text, -1, &full, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
      GdiFlush();
      D3D11_TEXTURE2D_DESC td{};
      td.Width = (UINT)w;
      td.Height = (UINT)h;
      td.MipLevels = 1;
      td.ArraySize = 1;
      td.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
      td.SampleDesc.Count = 1;
      td.Usage = D3D11_USAGE_IMMUTABLE;
      td.BindFlags = D3D11_BIND_SHADER_RESOURCE;
      D3D11_SUBRESOURCE_DATA init{bits, (UINT)w * 4, 0};
      ComPtr<ID3D11Texture2D> tex;
      if (SUCCEEDED(dev->CreateTexture2D(&td, &init, &tex)) && SUCCEEDED(dev->CreateShaderResourceView(tex.Get(), nullptr, &text_srv))) {
        text_w = (UINT)w;
        text_h = (UINT)h;
      }
      SelectObject(dc, old_bmp);
      DeleteObject(bmp);
    }
    SelectObject(dc, old_font);
    DeleteObject(font);
    DeleteDC(dc);
  }

  void Resize() {
    if (!swap) return;
    RECT rc;
    GetClientRect(hwnd, &rc);
    if (rc.right <= 0 || rc.bottom <= 0) return;
    ctx->OMSetRenderTargets(0, nullptr, nullptr);
    rtv.Reset();
    if (FAILED(swap->ResizeBuffers(0, 0, 0, DXGI_FORMAT_UNKNOWN, 0))) return;
    std::string err;
    MakeRtv(&err);
  }

  void DrawQuad(ID3D11ShaderResourceView* srv, float x, float y, float w, float h) {
    D3D11_VIEWPORT vp{x, y, w, h, 0.f, 1.f};
    ctx->RSSetViewports(1, &vp);
    ID3D11ShaderResourceView* srvs[1] = {srv};
    ctx->PSSetShaderResources(0, 1, srvs);
    ctx->Draw(3, 0);
    ID3D11ShaderResourceView* none[1] = {nullptr};
    ctx->PSSetShaderResources(0, 1, none);
  }
};

// ---------------------------------------------------------------- the window procedure

struct WndProcDispatch {
  static LRESULT CALLBACK Proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    if (msg == WM_NCCREATE) {
      auto* cs = reinterpret_cast<CREATESTRUCTW*>(lp);
      SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(cs->lpCreateParams));
    }
    auto* self = reinterpret_cast<WindowSink*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
    if (!self) return DefWindowProcW(hwnd, msg, wp, lp);
    return (LRESULT)self->WndProc(hwnd, msg, (uintptr_t)wp, (intptr_t)lp);
  }
};

intptr_t WindowSink::WndProc(void* h, unsigned msg, uintptr_t wp, intptr_t lp) {
  HWND hwnd = (HWND)h;
  switch (msg) {
    case WM_ERASEBKGND:
      return 1;
    case WM_PAINT: {
      ValidateRect(hwnd, nullptr);
      Render();
      return 0;
    }
    case WM_SIZE:
      if (gfx_) {
        gfx_->minimized = wp == SIZE_MINIMIZED;
        if (!gfx_->minimized) {
          gfx_->Resize();
          TrackPlacement();
          Render();
        }
      }
      return 0;
    case WM_MOVE:
      TrackPlacement();
      return 0;
    case WM_ENTERSIZEMOVE:
      if (gfx_) gfx_->user_touched = true;
      return 0;
    case WM_GETMINMAXINFO: {
      auto* mmi = reinterpret_cast<MINMAXINFO*>(lp);
      mmi->ptMinTrackSize.x = 200;
      mmi->ptMinTrackSize.y = 200;
      return 0;
    }
    case WM_DPICHANGED: {
      const RECT* r = reinterpret_cast<const RECT*>(lp);
      if (gfx_ && !gfx_->fullscreen)
        SetWindowPos(hwnd, nullptr, r->left, r->top, r->right - r->left, r->bottom - r->top, SWP_NOZORDER | SWP_NOACTIVATE);
      return 0;
    }
    case WM_KEYDOWN:
      if (wp == VK_F11) ToggleFullscreen();
      else if (wp == VK_ESCAPE && gfx_ && gfx_->fullscreen) ToggleFullscreen();
      return 0;
    case WM_LBUTTONDBLCLK:
      ToggleFullscreen();
      return 0;
    case WM_TIMER:
      if (wp == kTimerId && gfx_) {
        const bool waiting = !gfx_->have_frame || NowUs() - gfx_->last_frame_us > kWaitingAfterUs;
        if (waiting != gfx_->showing_waiting) Render();
      }
      return 0;
    case WM_CLOSE:
      DestroyWindow(hwnd);
      return 0;
    case WM_DESTROY:
      KillTimer(hwnd, kTimerId);
      hwnd_ = nullptr;
      PostQuitMessage(0);
      return 0;
    default:
      if (msg == kMsgFrame) {
        frame_posted_ = false;
        Render();
        return 0;
      }
      return (intptr_t)DefWindowProcW(hwnd, msg, (WPARAM)wp, (LPARAM)lp);
  }
}

// ---------------------------------------------------------------- the window thread

void WindowSink::ThreadMain(WindowOptions o, Handshake* hs) {
  Gfx gfx;
  gfx_ = &gfx;
  std::string err;
  if (!SetUp(o, &err)) {
    if (gfx.hwnd) DestroyWindow(gfx.hwnd);
    hwnd_ = nullptr;
    gfx_ = nullptr;
    hs->Set(false, err);
    return;
  }
  alive_ = true;
  hs->Set(true, "");
  MSG m;
  while (GetMessageW(&m, nullptr, 0, 0) > 0) {
    TranslateMessage(&m);
    DispatchMessageW(&m);
  }
  const bool by_user = !closing_;
  alive_ = false;
  gfx_ = nullptr;  // the D3D objects go with `gfx`; from here on Begin() refuses
  if (by_user && on_closed_) on_closed_(placement());
}

bool WindowSink::SetUp(const WindowOptions& o, std::string* error) {
  BecomeDpiAware();
  const HINSTANCE inst = GetModuleHandleW(nullptr);
  static bool registered = false;
  if (!registered) {
    WNDCLASSEXW wc{};
    wc.cbSize = sizeof wc;
    wc.style = CS_HREDRAW | CS_VREDRAW | CS_DBLCLKS;
    wc.lpfnWndProc = WndProcDispatch::Proc;
    wc.hInstance = inst;
    wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    wc.hbrBackground = (HBRUSH)GetStockObject(BLACK_BRUSH);
    wc.lpszClassName = kClassName;
    wc.hIcon = LoadIconW(nullptr, IDI_APPLICATION);
    if (!RegisterClassExW(&wc)) {
      *error = "RegisterClassEx failed";
      return false;
    }
    registered = true;
  }
  // Placement: a remembered rect as given; a size alone centred on the chosen display; else 50 % of the display's
  // height at the eye's aspect, centred in its work area.
  const Monitors mons;
  HMONITOR mon = mons.Pick(o.monitor);
  MONITORINFO mi{};
  mi.cbSize = sizeof mi;
  GetMonitorInfoW(mon, &mi);
  const DWORD style = WS_OVERLAPPEDWINDOW;
  const DWORD ex_style = o.topmost ? WS_EX_TOPMOST : 0;
  int x, y, w, h;
  if (o.placement) {
    x = o.placement->x;
    y = o.placement->y;
    w = std::max(200, o.placement->width);
    h = std::max(200, o.placement->height);
    gfx_->auto_size = false;
  } else {
    RECT rc{0, 0, 0, 0};
    if (o.width && o.height) {
      rc.right = std::max(200, *o.width);
      rc.bottom = std::max(200, *o.height);
      gfx_->auto_size = false;
    } else {
      rc.bottom = (mi.rcMonitor.bottom - mi.rcMonitor.top) / 2;
      rc.right = (LONG)(rc.bottom * kDefaultAspect + 0.5);
    }
    AdjustWindowRectEx(&rc, style, FALSE, ex_style);
    w = rc.right - rc.left;
    h = rc.bottom - rc.top;
    x = mi.rcWork.left + ((mi.rcWork.right - mi.rcWork.left) - w) / 2;
    y = mi.rcWork.top + ((mi.rcWork.bottom - mi.rcWork.top) - h) / 2;
  }
  gfx_->topmost = o.topmost;
  const std::wstring title = WideFromUtf8(o.title.empty() ? "Castcade \xE2\x80\x94 spectating" : o.title);
  HWND hwnd = CreateWindowExW(ex_style, kClassName, title.c_str(), style, x, y, w, h, nullptr, nullptr, inst, this);
  if (!hwnd) {
    *error = "CreateWindowEx failed";
    return false;
  }
  gfx_->hwnd = hwnd;
  if (!gfx_->CreateDevice(o.force_warp, error) || !gfx_->CreateSwapchain(error) || !gfx_->CreatePipeline(error)) return false;
  gfx_->MakeWaitingText();
  {
    std::lock_guard<std::mutex> l(mu_);
    driver_ = gfx_->warp ? "warp" : "hardware";
  }
  hwnd_ = hwnd;
  ShowWindow(hwnd, SW_SHOWNORMAL);
  TrackPlacement();
  SetTimer(hwnd, kTimerId, 250, nullptr);
  gfx_->last_frame_us = NowUs();  // the waiting text comes 3 s after opening, not at once
  LogLine("window: open (%s, %dx%d at %d,%d%s)", gfx_->warp ? "WARP" : "hardware", w, h, x, y, o.topmost ? ", topmost" : "");
  Render();
  return true;
}

void WindowSink::TrackPlacement() {
  if (!gfx_ || gfx_->fullscreen || gfx_->minimized || !gfx_->hwnd) return;
  RECT r;
  if (!GetWindowRect(gfx_->hwnd, &r)) return;
  std::lock_guard<std::mutex> l(mu_);
  placement_ = {r.left, r.top, r.right - r.left, r.bottom - r.top};
}

// The first frame (or a frame of a new aspect) resizes a window the user has not touched: height kept, width from
// the picture's aspect, centred where it was.
void WindowSink::OnFirstFrameSize(uint32_t pw, uint32_t ph) {
  if (!gfx_ || !gfx_->auto_size || gfx_->user_touched || gfx_->fullscreen || !pw || !ph) return;
  RECT client, win;
  GetClientRect(gfx_->hwnd, &client);
  GetWindowRect(gfx_->hwnd, &win);
  const int ch = client.bottom, cw = client.right;
  const int want_w = (int)((double)ch * pw / ph + 0.5);
  if (want_w == cw || want_w < 100) return;
  const int dx = want_w - cw;
  SetWindowPos(gfx_->hwnd, nullptr, win.left - dx / 2, win.top, (win.right - win.left) + dx, win.bottom - win.top,
               SWP_NOZORDER | SWP_NOACTIVATE);
}

void WindowSink::ToggleFullscreen() {
  if (!gfx_ || !gfx_->hwnd) return;
  HWND hwnd = gfx_->hwnd;
  if (!gfx_->fullscreen) {
    GetWindowRect(hwnd, &gfx_->saved_rect);
    gfx_->saved_style = GetWindowLongPtrW(hwnd, GWL_STYLE);
    MONITORINFO mi{};
    mi.cbSize = sizeof mi;
    GetMonitorInfoW(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), &mi);
    gfx_->fullscreen = true;
    SetWindowLongPtrW(hwnd, GWL_STYLE, WS_POPUP | WS_VISIBLE);
    SetWindowPos(hwnd, gfx_->topmost ? HWND_TOPMOST : HWND_TOP, mi.rcMonitor.left, mi.rcMonitor.top,
                 mi.rcMonitor.right - mi.rcMonitor.left, mi.rcMonitor.bottom - mi.rcMonitor.top, SWP_FRAMECHANGED | SWP_NOOWNERZORDER);
  } else {
    gfx_->fullscreen = false;
    SetWindowLongPtrW(hwnd, GWL_STYLE, gfx_->saved_style);
    const RECT& r = gfx_->saved_rect;
    SetWindowPos(hwnd, nullptr, r.left, r.top, r.right - r.left, r.bottom - r.top, SWP_FRAMECHANGED | SWP_NOZORDER | SWP_NOOWNERZORDER);
  }
  gfx_->user_touched = true;
}

void WindowSink::Render() {
  Gfx* g = gfx_;
  if (!g || !g->swap || !g->rtv || g->minimized) return;
  const int64_t t0 = NowUs();
  int64_t upload_us = 0;
  uint32_t resize_w = 0, resize_h = 0;  // a new picture size: the window follows it after the lock is released
  // 1. The newest pending frame → the picture texture (one row copy under the pending lock).
  {
    std::lock_guard<std::mutex> l(mu_);
    if (pending_new_ && pending_w_ && pending_h_) {
      pending_new_ = false;
      const bool new_size = g->picture_w != pending_w_ || g->picture_h != pending_h_;
      if (g->EnsurePicture(pending_w_, pending_h_)) {
        D3D11_MAPPED_SUBRESOURCE map{};
        if (SUCCEEDED(g->ctx->Map(g->picture.Get(), 0, D3D11_MAP_WRITE_DISCARD, 0, &map))) {
          const size_t row = (size_t)pending_w_ * 4;
          const uint8_t* src = pending_.data();
          uint8_t* dst = static_cast<uint8_t*>(map.pData);
          if (map.RowPitch == row) memcpy(dst, src, row * pending_h_);
          else
            for (uint32_t yy = 0; yy < pending_h_; yy++) memcpy(dst + (size_t)yy * map.RowPitch, src + (size_t)yy * row, row);
          g->ctx->Unmap(g->picture.Get(), 0);
          g->have_frame = true;
          g->last_frame_us = t0;
          upload_us = NowUs() - t0;
        }
        if (new_size) {
          resize_w = pending_w_;
          resize_h = pending_h_;
        }
      }
    }
  }
  // SetWindowPos sends WM_SIZE synchronously (which renders): never under mu_.
  if (resize_w) OnFirstFrameSize(resize_w, resize_h);
  // 2. Black, then the picture letterboxed (or the waiting text) through the viewport.
  RECT rc;
  GetClientRect(g->hwnd, &rc);
  const float cw = (float)rc.right, ch = (float)rc.bottom;
  if (cw <= 0 || ch <= 0) return;
  const float black[4] = {0.f, 0.f, 0.f, 1.f};
  ID3D11RenderTargetView* rtvs[1] = {g->rtv.Get()};
  g->ctx->OMSetRenderTargets(1, rtvs, nullptr);
  g->ctx->ClearRenderTargetView(g->rtv.Get(), black);
  g->ctx->IASetInputLayout(nullptr);
  g->ctx->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
  g->ctx->VSSetShader(g->vs.Get(), nullptr, 0);
  g->ctx->PSSetShader(g->ps.Get(), nullptr, 0);
  ID3D11SamplerState* samplers[1] = {g->sampler.Get()};
  g->ctx->PSSetSamplers(0, 1, samplers);
  g->ctx->RSSetState(g->raster.Get());
  const bool waiting = !g->have_frame || t0 - g->last_frame_us > kWaitingAfterUs;
  g->showing_waiting = waiting;
  if (!waiting && g->picture_srv) {
    const float scale = std::min(cw / (float)g->picture_w, ch / (float)g->picture_h);
    const float vw = g->picture_w * scale, vh = g->picture_h * scale;
    g->DrawQuad(g->picture_srv.Get(), (cw - vw) / 2, (ch - vh) / 2, vw, vh);
  } else if (g->text_srv) {
    const float tw = std::min(cw, (float)g->text_w), th = std::min(ch, (float)g->text_h);
    g->DrawQuad(g->text_srv.Get(), (cw - tw) / 2, (ch - th) / 2, tw, th);
  }
  // 3. Present at vsync.
  const HRESULT hr = g->swap->Present(1, 0);
  if (SUCCEEDED(hr)) {
    presented_++;
    upload_us_ += upload_us;
    present_us_ += NowUs() - t0;
  } else if (hr == DXGI_ERROR_DEVICE_REMOVED || hr == DXGI_ERROR_DEVICE_RESET) {
    LogLine("window: device lost (0x%08lx): closing the window", (unsigned long)hr);
    PostMessageW(g->hwnd, WM_CLOSE, 0, 0);
  }
}

// ---------------------------------------------------------------- the public side (any thread)

WindowSink::~WindowSink() { Close(); }

bool WindowSink::Open(const WindowOptions& o, ClosedFn on_closed, std::string* error) {
  Close();
  on_closed_ = std::move(on_closed);
  closing_ = false;
  alive_ = false;
  frame_posted_ = false;
  presented_ = upload_us_ = present_us_ = 0;
  {
    std::lock_guard<std::mutex> l(mu_);
    pending_new_ = false;
    pending_w_ = pending_h_ = 0;
    driver_.clear();
  }
  auto hs = std::make_shared<Handshake>();  // shared: the thread outlives this call when the window stays open
  thread_ = std::thread([this, o, hs] {
    ThreadMain(o, hs.get());
    hs->Set(false, "the window thread ended before the window was up");
  });
  std::unique_lock<std::mutex> l(hs->mu);
  hs->cv.wait(l, [&] { return hs->done; });
  if (!hs->ok) {
    *error = hs->error;
    l.unlock();
    if (thread_.joinable()) thread_.join();
    return false;
  }
  return true;
}

void WindowSink::Close() {
  closing_ = true;
  HWND hwnd = (HWND)hwnd_.load();
  if (hwnd) PostMessageW(hwnd, WM_CLOSE, 0, 0);
  if (thread_.joinable()) thread_.join();
  alive_ = false;
}

std::string WindowSink::driver() const {
  std::lock_guard<std::mutex> l(mu_);
  return driver_;
}

WindowPlacement WindowSink::placement() const {
  std::lock_guard<std::mutex> l(mu_);
  return placement_;
}

bool WindowSink::Begin(uint32_t width, uint32_t height, uint8_t** pixels, uint32_t* stride) {
  if (!alive_ || !width || !height) return false;
  mu_.lock();  // held until Commit (the converter writes straight into the pending buffer)
  const size_t bytes = (size_t)width * height * 4;
  if (pending_.size() < bytes) pending_.resize(bytes);
  pending_w_ = width;
  pending_h_ = height;
  *pixels = pending_.data();
  *stride = width * 4;
  return true;
}

void WindowSink::Commit() {
  pending_new_ = true;
  mu_.unlock();
  HWND hwnd = (HWND)hwnd_.load();
  if (hwnd && !frame_posted_.exchange(true)) PostMessageW(hwnd, kMsgFrame, 0, 0);
}

WindowSink::Readout WindowSink::Snapshot() {
  Readout r;
  r.presented = presented_.exchange(0);
  const int64_t up = upload_us_.exchange(0), pr = present_us_.exchange(0);
  r.upload_us = r.presented ? (double)up / r.presented : 0;
  r.present_us = r.presented ? (double)pr / r.presented : 0;
  return r;
}

#pragma warning(pop)
