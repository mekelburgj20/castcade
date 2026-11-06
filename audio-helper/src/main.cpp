// castcade-audio: table sound for a Castcade match (D2.8, 2026-11-01; audio-helper/README.md). Architecture B runs one
// VPX per player, so each rig hears its own table even while another player is up. This process does the two things
// Electron cannot: it mutes this rig's VPX (and the table's side processes) in the Windows audio engine while another
// player is up, and it captures the VPX process tree's own sound (process loopback) while this rig is up, so the
// companion can send it to the others as a second WebRTC audio track. Nothing runs inside VPX (ADR 0001). D2.10
// (2026-11-05, 0.2.0): it also sets the session volume of the tree (`level`) while this rig is up, so the player's own
// table sits under the other players' voices, and puts it back (`unlevel`).
//
//   castcade-audio.exe [--state <file>] [--version] [-help]
//
// stdin: one text command per line: `mute <pid>`, `unmute <pid>`, `tap <pid>`, `untap`, `level <pid> <percent>`,
// `unlevel <pid>`, `quit`.
// stdout: text event lines (`ready`, `muted`, `unmuted`, `tap-on`, `tap-off`, `tap-unavailable`, `tap-error`,
// `leveled`, `unleveled`, `error`) and binary audio frames: "CAU1" + u32 LE byteLength + byteLength bytes of float32
// interleaved stereo at 48 kHz (10 ms = 3840 bytes). stderr: log lines. On stdin EOF, `quit`, a broken stdout or a
// fatal error every session this process muted is unmuted and every one it levelled is put back before it exits;
// `--state` records them on disk so a later run restores what a crash left.
// Exit codes: 0 normal, 2 COM / CoreAudio could not start, 64 bad arguments.
#include <windows.h>

#include <objbase.h>
#include <objidl.h>
#include <propidl.h>

#include <audioclient.h>
#include <audiopolicy.h>
#include <mmdeviceapi.h>
#include <tlhelp32.h>

#if defined(__has_include)
#if __has_include(<audioclientactivationparams.h>)
#include <audioclientactivationparams.h>
#define CASTCADE_HAVE_ACTIVATION_PARAMS 1
#endif
#endif

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cerrno>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <fstream>
#include <iostream>
#include <map>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <vector>

#ifndef CASTCADE_AUDIO_VERSION
#define CASTCADE_AUDIO_VERSION "0.0.0-dev"
#endif

#ifndef CASTCADE_HAVE_ACTIVATION_PARAMS
// audioclientactivationparams.h (Windows SDK 10.0.20348+); spelled out for older SDKs and MinGW, layout identical.
typedef enum AUDIOCLIENT_ACTIVATION_TYPE {
  AUDIOCLIENT_ACTIVATION_TYPE_DEFAULT = 0,
  AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1
} AUDIOCLIENT_ACTIVATION_TYPE;
typedef enum PROCESS_LOOPBACK_MODE {
  PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE = 0,
  PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE = 1
} PROCESS_LOOPBACK_MODE;
typedef struct AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
  DWORD TargetProcessId;
  PROCESS_LOOPBACK_MODE ProcessLoopbackMode;
} AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS;
typedef struct AUDIOCLIENT_ACTIVATION_PARAMS {
  AUDIOCLIENT_ACTIVATION_TYPE ActivationType;
  union {
    AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS ProcessLoopbackParams;
  };
} AUDIOCLIENT_ACTIVATION_PARAMS;
#endif

namespace {

constexpr int kExitOk = 0;
constexpr int kExitAudio = 2;
constexpr int kExitBadArgs = 64;

// VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK (audioclientactivationparams.h).
constexpr wchar_t kProcessLoopbackDevice[] = L"VAD\\Process_Loopback";
// Process loopback arrived in Windows 10 2004 (build 19041).
constexpr DWORD kMinLoopbackBuild = 19041;
// Sessions appear lazily (VPX opens its DirectSound session at its first sound): a muted tree is looked at this often.
constexpr auto kRescan = std::chrono::seconds(2);
constexpr DWORD kRate = 48000;
constexpr WORD kChannels = 2;
// One frame on stdout: 10 ms.
constexpr size_t kFrameSamples = kRate / 100 * kChannels;
// The table's side processes: COM-launched by the table script, so not in VPX's process tree.
const wchar_t* const kSideProcesses[] = {L"PinUpPlayer.exe", L"B2SBackglassServerEXE.exe"};

// ---- small COM pointer ----
template <class T>
class Com {
 public:
  Com() = default;
  ~Com() { reset(); }
  Com(const Com&) = delete;
  Com& operator=(const Com&) = delete;
  Com(Com&& o) noexcept : p_(o.p_) { o.p_ = nullptr; }
  Com& operator=(Com&& o) noexcept {
    if (this != &o) {
      reset();
      p_ = o.p_;
      o.p_ = nullptr;
    }
    return *this;
  }
  void reset() {
    if (p_) p_->Release();
    p_ = nullptr;
  }
  T** put() {
    reset();
    return &p_;
  }
  void** putVoid() { return reinterpret_cast<void**>(put()); }
  T* get() const { return p_; }
  T* operator->() const { return p_; }
  explicit operator bool() const { return p_ != nullptr; }

 private:
  T* p_ = nullptr;
};

template <class U, class T>
Com<U> qi(T* from) {
  Com<U> out;
  if (from) from->QueryInterface(__uuidof(U), out.putVoid());
  return out;
}

std::string hex(HRESULT hr) {
  char buf[16];
  std::snprintf(buf, sizeof buf, "0x%08lx", static_cast<unsigned long>(hr));
  return buf;
}

std::string narrow(const std::wstring& w) {
  if (w.empty()) return {};
  const int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), nullptr, 0, nullptr, nullptr);
  std::string s(static_cast<size_t>(n > 0 ? n : 0), '\0');
  if (n > 0) WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), s.data(), n, nullptr, nullptr);
  return s;
}

std::wstring widen(const std::string& s) {
  if (s.empty()) return {};
  const int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
  std::wstring w(static_cast<size_t>(n > 0 ? n : 0), L'\0');
  if (n > 0) MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), w.data(), n);
  return w;
}

// ---- stdout (text events and frames) and stderr (log) ----
std::mutex g_outMu;
std::atomic<bool> g_outBroken{false};

void logLine(const std::string& s) {
  std::fprintf(stderr, "%s\n", s.c_str());
  std::fflush(stderr);
}

bool writeAll(const void* data, size_t len) {
  if (g_outBroken.load()) return false;
  HANDLE h = GetStdHandle(STD_OUTPUT_HANDLE);
  const char* p = static_cast<const char*>(data);
  while (len > 0) {
    DWORD wrote = 0;
    const DWORD chunk = static_cast<DWORD>(std::min<size_t>(len, 1u << 20));
    if (!WriteFile(h, p, chunk, &wrote, nullptr) || wrote == 0) {
      g_outBroken = true;
      return false;
    }
    p += wrote;
    len -= wrote;
  }
  return true;
}

void say(const std::string& line) {
  std::lock_guard<std::mutex> lk(g_outMu);
  const std::string s = line + "\n";
  writeAll(s.data(), s.size());
}

void sendFrame(const float* samples, size_t count) {
  const uint32_t bytes = static_cast<uint32_t>(count * sizeof(float));
  std::vector<unsigned char> buf(8 + bytes);
  std::memcpy(buf.data(), "CAU1", 4);
  for (int i = 0; i < 4; i++) buf[4 + static_cast<size_t>(i)] = static_cast<unsigned char>((bytes >> (8 * i)) & 0xff);
  std::memcpy(buf.data() + 8, samples, bytes);
  std::lock_guard<std::mutex> lk(g_outMu);
  writeAll(buf.data(), buf.size());
}

// ---- the command queue (stdin reader and console handler → worker) ----
std::mutex g_qMu;
std::condition_variable g_qCv;
std::deque<std::string> g_queue;
HANDLE g_cleanedUp = nullptr;

void enqueue(const std::string& cmd) {
  {
    std::lock_guard<std::mutex> lk(g_qMu);
    g_queue.push_back(cmd);
  }
  g_qCv.notify_one();
}

BOOL WINAPI onConsoleEvent(DWORD) {
  // Window close, logoff, shutdown: unmute before Windows ends the process (it waits a few seconds for us).
  enqueue("quit");
  if (g_cleanedUp) WaitForSingleObject(g_cleanedUp, 3000);
  return TRUE;
}

DWORD windowsBuild() {
  using RtlGetVersionFn = LONG(WINAPI*)(PRTL_OSVERSIONINFOW);
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  if (!ntdll) return 0;
  auto fn = reinterpret_cast<RtlGetVersionFn>(reinterpret_cast<void*>(GetProcAddress(ntdll, "RtlGetVersion")));
  if (!fn) return 0;
  RTL_OSVERSIONINFOW v{};
  v.dwOSVersionInfoSize = sizeof v;
  if (fn(&v) != 0) return 0;
  return v.dwBuildNumber;
}

// ---- processes ----
bool sameName(const wchar_t* a, const wchar_t* b) { return CompareStringOrdinal(a, -1, b, -1, TRUE) == CSTR_EQUAL; }

// The pid, its descendants, and the side processes (by name).
std::set<DWORD> processTree(DWORD root) {
  std::set<DWORD> out{root};
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap == INVALID_HANDLE_VALUE) return out;
  std::multimap<DWORD, DWORD> children;
  PROCESSENTRY32W e{};
  e.dwSize = sizeof e;
  for (BOOL ok = Process32FirstW(snap, &e); ok; ok = Process32NextW(snap, &e)) {
    if (e.th32ProcessID != e.th32ParentProcessID) children.emplace(e.th32ParentProcessID, e.th32ProcessID);
    for (const wchar_t* side : kSideProcesses)
      if (sameName(e.szExeFile, side)) out.insert(e.th32ProcessID);
  }
  CloseHandle(snap);
  std::vector<DWORD> todo{root};
  while (!todo.empty()) {
    const DWORD p = todo.back();
    todo.pop_back();
    auto range = children.equal_range(p);
    for (auto it = range.first; it != range.second; ++it)
      if (out.insert(it->second).second) todo.push_back(it->second);
  }
  return out;
}

// ---- sessions ----
struct SessionRef {
  std::wstring id;  // IAudioSessionControl2::GetSessionInstanceIdentifier: unique per endpoint and session
  DWORD pid = 0;
  Com<ISimpleAudioVolume> volume;
};

// Every session on every active render endpoint (a headset and speakers may both be present).
std::vector<SessionRef> allSessions(IMMDeviceEnumerator* devices) {
  std::vector<SessionRef> out;
  Com<IMMDeviceCollection> list;
  if (FAILED(devices->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, list.put()))) return out;
  UINT n = 0;
  list->GetCount(&n);
  for (UINT i = 0; i < n; i++) {
    Com<IMMDevice> dev;
    if (FAILED(list->Item(i, dev.put()))) continue;
    Com<IAudioSessionManager2> mgr;
    if (FAILED(dev->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, mgr.putVoid()))) continue;
    Com<IAudioSessionEnumerator> sessions;
    if (FAILED(mgr->GetSessionEnumerator(sessions.put()))) continue;
    int count = 0;
    sessions->GetCount(&count);
    for (int j = 0; j < count; j++) {
      Com<IAudioSessionControl> ctl;
      if (FAILED(sessions->GetSession(j, ctl.put()))) continue;
      Com<IAudioSessionControl2> ctl2 = qi<IAudioSessionControl2>(ctl.get());
      if (!ctl2) continue;
      DWORD pid = 0;
      // S_OK only: AUDCLNT_S_NO_SINGLE_PROCESS is a cross-process (system) session.
      if (ctl2->GetProcessId(&pid) != S_OK) continue;
      LPWSTR raw = nullptr;
      if (FAILED(ctl2->GetSessionInstanceIdentifier(&raw)) || !raw) continue;
      SessionRef s;
      s.id = raw;
      CoTaskMemFree(raw);
      s.pid = pid;
      s.volume = qi<ISimpleAudioVolume>(ctl.get());
      if (s.volume) out.push_back(std::move(s));
    }
  }
  return out;
}

// ---- process loopback ----
using ActivateAudioInterfaceAsyncFn = HRESULT(WINAPI*)(LPCWSTR, REFIID, PROPVARIANT*, IActivateAudioInterfaceCompletionHandler*,
                                                       IActivateAudioInterfaceAsyncOperation**);

class ActivateHandler final : public IActivateAudioInterfaceCompletionHandler, public IAgileObject {
 public:
  ActivateHandler() : done_(CreateEventW(nullptr, TRUE, FALSE, nullptr)) {}
  ActivateHandler(const ActivateHandler&) = delete;
  ActivateHandler& operator=(const ActivateHandler&) = delete;
  HANDLE done() const { return done_; }

  STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    if (riid == __uuidof(IUnknown) || riid == __uuidof(IActivateAudioInterfaceCompletionHandler)) {
      *ppv = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
    } else if (riid == __uuidof(IAgileObject)) {
      *ppv = static_cast<IAgileObject*>(this);
    } else {
      *ppv = nullptr;
      return E_NOINTERFACE;
    }
    AddRef();
    return S_OK;
  }
  STDMETHODIMP_(ULONG) AddRef() override { return static_cast<ULONG>(InterlockedIncrement(&ref_)); }
  STDMETHODIMP_(ULONG) Release() override {
    const LONG r = InterlockedDecrement(&ref_);
    if (r == 0) delete this;
    return static_cast<ULONG>(r);
  }
  STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation*) override {
    SetEvent(done_);
    return S_OK;
  }

 private:
  ~ActivateHandler() {
    if (done_) CloseHandle(done_);
  }
  LONG ref_ = 1;
  HANDLE done_;
};

class Tap {
 public:
  explicit Tap(ActivateAudioInterfaceAsyncFn activate) : activate_(activate) {}
  ~Tap() { stop(); }
  Tap(const Tap&) = delete;
  Tap& operator=(const Tap&) = delete;

  bool running() const { return thread_.joinable(); }
  DWORD pid() const { return pid_; }

  // Starts capturing the tree of `pid`; on failure returns false with `why` set (and nothing running).
  bool start(DWORD pid, std::string& why) {
    stop();
    Com<IAudioClient> client;
    if (!activateFor(pid, client, why)) return false;
    // float32 stereo 48 kHz first; a client that refuses it gets 16-bit PCM, converted here.
    WAVEFORMATEX fmt{};
    fmt.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
    fmt.nChannels = kChannels;
    fmt.nSamplesPerSec = kRate;
    fmt.wBitsPerSample = 32;
    fmt.nBlockAlign = static_cast<WORD>(fmt.nChannels * fmt.wBitsPerSample / 8);
    fmt.nAvgBytesPerSec = fmt.nSamplesPerSec * fmt.nBlockAlign;
    const DWORD flags = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
                        AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
    const REFERENCE_TIME buffer = 200000;  // 20 ms
    HRESULT hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, flags, buffer, 0, &fmt, nullptr);
    pcm16_ = false;
    if (FAILED(hr)) {
      logLine("audio: float capture refused (" + hex(hr) + "); trying 16-bit PCM");
      client.reset();
      if (!activateFor(pid, client, why)) return false;
      fmt.wFormatTag = WAVE_FORMAT_PCM;
      fmt.wBitsPerSample = 16;
      fmt.nBlockAlign = static_cast<WORD>(fmt.nChannels * fmt.wBitsPerSample / 8);
      fmt.nAvgBytesPerSec = fmt.nSamplesPerSec * fmt.nBlockAlign;
      hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, flags, buffer, 0, &fmt, nullptr);
      if (FAILED(hr)) {
        why = "initialize_failed:" + hex(hr);
        return false;
      }
      pcm16_ = true;
    }
    HANDLE ev = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (!ev) {
      why = "no_event";
      return false;
    }
    hr = client->SetEventHandle(ev);
    Com<IAudioCaptureClient> capture;
    if (SUCCEEDED(hr)) hr = client->GetService(__uuidof(IAudioCaptureClient), capture.putVoid());
    if (SUCCEEDED(hr)) hr = client->Start();
    if (FAILED(hr)) {
      CloseHandle(ev);
      why = "start_failed:" + hex(hr);
      return false;
    }
    client_ = std::move(client);
    capture_ = std::move(capture);
    event_ = ev;
    pid_ = pid;
    stop_ = false;
    thread_ = std::thread([this] { loop(); });
    return true;
  }

  void stop() {
    if (thread_.joinable()) {
      stop_ = true;
      if (event_) SetEvent(event_);
      thread_.join();
    }
    if (client_) client_->Stop();
    capture_.reset();
    client_.reset();
    if (event_) CloseHandle(event_);
    event_ = nullptr;
    pid_ = 0;
  }

  // The capture thread ended on its own (an error); `failure` says why.
  bool failed(std::string& failure) {
    std::lock_guard<std::mutex> lk(failMu_);
    if (failure_.empty()) return false;
    failure = failure_;
    failure_.clear();
    return true;
  }

 private:
  bool activateFor(DWORD pid, Com<IAudioClient>& client, std::string& why) {
    AUDIOCLIENT_ACTIVATION_PARAMS params{};
    params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    params.ProcessLoopbackParams.TargetProcessId = pid;
    params.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
    PROPVARIANT pv{};
    pv.vt = VT_BLOB;
    pv.blob.cbSize = sizeof params;
    pv.blob.pBlobData = reinterpret_cast<BYTE*>(&params);
    auto* handler = new ActivateHandler();
    Com<IActivateAudioInterfaceAsyncOperation> op;
    HRESULT hr = activate_(kProcessLoopbackDevice, __uuidof(IAudioClient), &pv, handler, op.put());
    if (FAILED(hr)) {
      handler->Release();
      why = "activate_failed:" + hex(hr);
      return false;
    }
    const DWORD waited = WaitForSingleObject(handler->done(), 5000);
    handler->Release();
    if (waited != WAIT_OBJECT_0) {
      why = "activate_timeout";
      return false;
    }
    HRESULT result = E_FAIL;
    Com<IUnknown> unk;
    hr = op->GetActivateResult(&result, unk.put());
    if (FAILED(hr) || FAILED(result) || !unk) {
      why = "activate_failed:" + hex(FAILED(hr) ? hr : result);
      return false;
    }
    client = qi<IAudioClient>(unk.get());
    if (!client) {
      why = "no_audio_client";
      return false;
    }
    return true;
  }

  void loop() {
    const HRESULT co = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    std::vector<float> pending;
    pending.reserve(kFrameSamples * 4);
    std::string failure;
    while (!stop_.load()) {
      WaitForSingleObject(event_, 50);
      if (stop_.load()) break;
      for (;;) {
        UINT32 packet = 0;
        HRESULT hr = capture_->GetNextPacketSize(&packet);
        if (FAILED(hr)) {
          failure = "capture_failed:" + hex(hr);
          break;
        }
        if (packet == 0) break;
        BYTE* data = nullptr;
        UINT32 frames = 0;
        DWORD flags = 0;
        hr = capture_->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
        if (FAILED(hr)) {
          failure = "capture_failed:" + hex(hr);
          break;
        }
        const size_t samples = static_cast<size_t>(frames) * kChannels;
        if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) || !data) {
          pending.insert(pending.end(), samples, 0.0f);
        } else if (pcm16_) {
          const int16_t* s = reinterpret_cast<const int16_t*>(data);
          for (size_t i = 0; i < samples; i++) pending.push_back(static_cast<float>(s[i]) / 32768.0f);
        } else {
          const float* f = reinterpret_cast<const float*>(data);
          pending.insert(pending.end(), f, f + samples);
        }
        capture_->ReleaseBuffer(frames);
      }
      if (!failure.empty()) break;
      size_t at = 0;
      while (pending.size() - at >= kFrameSamples) {
        sendFrame(pending.data() + at, kFrameSamples);
        at += kFrameSamples;
      }
      pending.erase(pending.begin(), pending.begin() + static_cast<std::ptrdiff_t>(at));
      if (g_outBroken.load()) break;
    }
    if (!failure.empty()) {
      std::lock_guard<std::mutex> lk(failMu_);
      failure_ = failure;
    }
    if (SUCCEEDED(co)) CoUninitialize();
  }

  ActivateAudioInterfaceAsyncFn activate_;
  Com<IAudioClient> client_;
  Com<IAudioCaptureClient> capture_;
  HANDLE event_ = nullptr;
  DWORD pid_ = 0;
  bool pcm16_ = false;
  std::atomic<bool> stop_{false};
  std::thread thread_;
  std::mutex failMu_;
  std::string failure_;
};

// ---- the worker: mutes, rescans, taps ----
class Engine {
 public:
  Engine(IMMDeviceEnumerator* devices, std::string stateFile, ActivateAudioInterfaceAsyncFn activate, std::string tapUnavailable)
      : devices_(devices), stateFile_(std::move(stateFile)), tap_(activate), tapUnavailable_(std::move(tapUnavailable)) {}

  // A crash of an earlier run left sessions muted or levelled: the state file names them (saveState's format).
  void recover() {
    if (stateFile_.empty()) return;
    std::set<std::wstring> ids;
    std::map<std::wstring, float> levels;
    {
      std::ifstream in(stateFile_, std::ios::binary);
      std::string line;
      while (std::getline(in, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        if (line.empty()) continue;
        if (line.rfind("level ", 0) == 0) {
          // `level <previous volume> <session id>` (the id may hold spaces, so it comes last).
          const size_t sp = line.find(' ', 6);
          if (sp == std::string::npos) continue;
          const float previous = static_cast<float>(std::atof(line.substr(6, sp - 6).c_str()));
          const std::string id = line.substr(sp + 1);
          if (!id.empty() && previous >= 0.0f && previous <= 1.0f) levels.emplace(widen(id), previous);
          continue;
        }
        ids.insert(widen(line));
      }
    }
    if (ids.empty() && levels.empty()) return;
    int restored = 0;
    int releveled = 0;
    for (SessionRef& s : allSessions(devices_)) {
      if (ids.count(s.id)) {
        BOOL m = FALSE;
        if (SUCCEEDED(s.volume->GetMute(&m)) && m && SUCCEEDED(s.volume->SetMute(FALSE, nullptr))) restored++;
      }
      const auto lv = levels.find(s.id);
      if (lv != levels.end() && SUCCEEDED(s.volume->SetMasterVolume(lv->second, nullptr))) releveled++;
    }
    logLine("audio: unmuted " + std::to_string(restored) + " session(s) an earlier run left muted (" + std::to_string(ids.size()) +
            " recorded); put back the volume of " + std::to_string(releveled) + " (" + std::to_string(levels.size()) + " recorded)");
    saveState();
  }

  // `<pid>` as the commands carry it: decimal, non-zero, fits a DWORD.
  static bool parsePid(const std::string& arg, DWORD& pid) {
    char* end = nullptr;
    errno = 0;
    const unsigned long long v = std::strtoull(arg.c_str(), &end, 10);
    if (arg.empty() || arg[0] < '0' || arg[0] > '9' || !end || *end != '\0' || errno == ERANGE || v == 0 || v > 0xffffffffULL) return false;
    pid = static_cast<DWORD>(v);
    return true;
  }

  // One command line; false on quit.
  bool handle(const std::string& line) {
    std::string cmd = line;
    std::string arg;
    const size_t sp = line.find(' ');
    if (sp != std::string::npos) {
      cmd = line.substr(0, sp);
      arg = line.substr(sp + 1);
    }
    if (cmd == "quit") return false;
    if (cmd == "untap") {
      untap();
      return true;
    }
    if (cmd == "mute" || cmd == "unmute" || cmd == "tap" || cmd == "unlevel") {
      DWORD pid = 0;
      if (!parsePid(arg, pid)) {
        say("error bad_pid " + cmd);
        return true;
      }
      if (cmd == "mute") mute(pid);
      else if (cmd == "unmute") unmute(pid);
      else if (cmd == "unlevel") unlevel(pid);
      else tap(pid);
      return true;
    }
    if (cmd == "level") {
      // `level <pid> <percent>`, the percent 10–100.
      std::string pidText = arg;
      std::string pctText;
      const size_t sp2 = arg.find(' ');
      if (sp2 != std::string::npos) {
        pidText = arg.substr(0, sp2);
        pctText = arg.substr(sp2 + 1);
      }
      DWORD pid = 0;
      if (!parsePid(pidText, pid)) {
        say("error bad_pid " + cmd);
        return true;
      }
      char* end = nullptr;
      errno = 0;
      const long pct = std::strtol(pctText.c_str(), &end, 10);
      if (pctText.empty() || pctText[0] < '0' || pctText[0] > '9' || !end || *end != '\0' || errno == ERANGE || pct < 10 || pct > 100) {
        say("error bad_percent " + cmd);
        return true;
      }
      level(pid, static_cast<float>(pct) / 100.0f);
      return true;
    }
    if (!cmd.empty()) say("error unknown_command " + cmd);
    return true;
  }

  void rescan() {
    for (DWORD pid : std::vector<DWORD>(targets_.begin(), targets_.end())) scanTarget(pid, false);
    for (DWORD pid : levelPids()) scanLevel(pid, false);
    std::string failure;
    if (tap_.failed(failure)) {
      const DWORD pid = tap_.pid();
      tap_.stop();
      logLine("audio: tap of pid " + std::to_string(pid) + " stopped: " + failure);
      say("tap-error " + failure);
    }
  }

  void shutdown() {
    untap();
    for (DWORD pid : std::vector<DWORD>(targets_.begin(), targets_.end())) unmute(pid);
    for (DWORD pid : levelPids()) unlevel(pid);
    // Sessions recorded under no target any more (none, normally).
    for (auto& kv : muted_) kv.second.volume->SetMute(FALSE, nullptr);
    muted_.clear();
    for (auto& kv : leveled_) restoreLevel(kv.second);
    leveled_.clear();
    saveState();
  }

 private:
  struct Muted {
    DWORD target = 0;
    DWORD pid = 0;
    Com<ISimpleAudioVolume> volume;
  };
  // D2.10: a session whose volume this helper set; `previous` is what it had, `set` what we gave it last.
  struct Leveled {
    DWORD target = 0;
    DWORD pid = 0;
    float previous = 1.0f;
    float set = 1.0f;
    Com<ISimpleAudioVolume> volume;
  };

  size_t countFor(DWORD target) const {
    return static_cast<size_t>(std::count_if(muted_.begin(), muted_.end(), [target](const auto& kv) { return kv.second.target == target; }));
  }

  size_t countLeveled(DWORD target) const {
    return static_cast<size_t>(std::count_if(leveled_.begin(), leveled_.end(), [target](const auto& kv) { return kv.second.target == target; }));
  }

  std::vector<DWORD> levelPids() const {
    std::vector<DWORD> out;
    for (const auto& kv : levelTargets_) out.push_back(kv.first);
    return out;
  }

  static bool sameLevel(float a, float b) { return std::fabs(a - b) < 0.005f; }

  // Back to the volume it had, unless the player moved it meanwhile (then it is theirs, as with a mute).
  static void restoreLevel(Leveled& l) {
    float now = 0.0f;
    if (SUCCEEDED(l.volume->GetMasterVolume(&now)) && sameLevel(now, l.set)) l.volume->SetMasterVolume(l.previous, nullptr);
  }

  void level(DWORD pid, float gain) {
    const bool fresh = levelTargets_.insert_or_assign(pid, gain).second;
    scanLevel(pid, true);
    if (fresh) {
      logLine("audio: setting pid " + std::to_string(pid) + " and its children to " + std::to_string(static_cast<int>(gain * 100.0f + 0.5f)) +
              " % of their volume; rescanning every 2 s");
    }
  }

  // Sets every not-yet-recorded session of the tree to the target's gain (remembering what it had), and follows a
  // changed gain on the sessions already recorded. `always`: report even when nothing changed.
  void scanLevel(DWORD target, bool always) {
    const auto it = levelTargets_.find(target);
    if (it == levelTargets_.end()) return;
    const float gain = it->second;
    const std::set<DWORD> tree = processTree(target);
    size_t changed = 0;
    for (auto& kv : leveled_) {
      Leveled& l = kv.second;
      if (l.target != target || sameLevel(l.set, gain)) continue;
      if (SUCCEEDED(l.volume->SetMasterVolume(gain, nullptr))) {
        l.set = gain;
        changed++;
      }
    }
    for (SessionRef& s : allSessions(devices_)) {
      if (!tree.count(s.pid) || leveled_.count(s.id)) continue;
      float previous = 1.0f;
      if (FAILED(s.volume->GetMasterVolume(&previous))) continue;
      if (FAILED(s.volume->SetMasterVolume(gain, nullptr))) continue;
      Leveled l;
      l.target = target;
      l.pid = s.pid;
      l.previous = previous;
      l.set = gain;
      l.volume = std::move(s.volume);
      leveled_.emplace(s.id, std::move(l));
      changed++;
    }
    if (changed > 0) saveState();
    if (changed > 0 || always) say("leveled " + std::to_string(target) + " " + std::to_string(countLeveled(target)));
  }

  void unlevel(DWORD target) {
    levelTargets_.erase(target);
    size_t n = 0;
    for (auto it = leveled_.begin(); it != leveled_.end();) {
      if (it->second.target != target) {
        ++it;
        continue;
      }
      restoreLevel(it->second);
      it = leveled_.erase(it);
      n++;
    }
    saveState();
    say("unleveled " + std::to_string(target) + " " + std::to_string(n));
  }

  void mute(DWORD pid) {
    const bool fresh = targets_.insert(pid).second;
    scanTarget(pid, true);
    if (fresh) logLine("audio: muting pid " + std::to_string(pid) + " and its children, PinUP and B2S; rescanning every 2 s");
  }

  // Mutes every not-yet-recorded, not-already-muted session of the tree. `always`: report even when nothing changed.
  void scanTarget(DWORD target, bool always) {
    const std::set<DWORD> tree = processTree(target);
    size_t added = 0;
    for (SessionRef& s : allSessions(devices_)) {
      if (!tree.count(s.pid) || muted_.count(s.id)) continue;
      BOOL already = FALSE;
      if (FAILED(s.volume->GetMute(&already))) continue;
      if (already) continue;  // the player muted it themselves: never ours to unmute
      if (FAILED(s.volume->SetMute(TRUE, nullptr))) continue;
      Muted m;
      m.target = target;
      m.pid = s.pid;
      m.volume = std::move(s.volume);
      muted_.emplace(s.id, std::move(m));
      added++;
    }
    if (added > 0) saveState();
    if (added > 0 || always) say("muted " + std::to_string(target) + " " + std::to_string(countFor(target)));
  }

  void unmute(DWORD target) {
    targets_.erase(target);
    size_t n = 0;
    for (auto it = muted_.begin(); it != muted_.end();) {
      if (it->second.target != target) {
        ++it;
        continue;
      }
      BOOL m = FALSE;
      // Still muted (by us): unmute. Unmuted meanwhile (the player): leave it.
      if (SUCCEEDED(it->second.volume->GetMute(&m)) && m) it->second.volume->SetMute(FALSE, nullptr);
      it = muted_.erase(it);
      n++;
    }
    saveState();
    say("unmuted " + std::to_string(target) + " " + std::to_string(n));
  }

  void tap(DWORD pid) {
    if (!tapUnavailable_.empty()) {
      say("tap-unavailable " + tapUnavailable_);
      return;
    }
    if (tap_.running() && tap_.pid() == pid) {
      say("tap-on " + std::to_string(pid));
      return;
    }
    std::string why;
    if (tap_.start(pid, why)) {
      logLine("audio: tapping pid " + std::to_string(pid) + " (process loopback, its tree)");
      say("tap-on " + std::to_string(pid));
    } else {
      logLine("audio: could not tap pid " + std::to_string(pid) + ": " + why);
      say("tap-error " + why);
    }
  }

  void untap() {
    if (!tap_.running()) return;
    tap_.stop();
    say("tap-off");
  }

  // One line per session held: a muted one is its id alone; a levelled one is `level <previous volume> <id>`.
  void saveState() {
    if (stateFile_.empty()) return;
    if (muted_.empty() && leveled_.empty()) {
      DeleteFileW(widen(stateFile_).c_str());
      return;
    }
    std::ofstream out(stateFile_, std::ios::binary | std::ios::trunc);
    for (const auto& kv : muted_) out << narrow(kv.first) << "\n";
    for (const auto& kv : leveled_) {
      char buf[32];
      std::snprintf(buf, sizeof buf, "%.4f", static_cast<double>(kv.second.previous));
      out << "level " << buf << " " << narrow(kv.first) << "\n";
    }
  }

  IMMDeviceEnumerator* devices_;
  std::string stateFile_;
  Tap tap_;
  std::string tapUnavailable_;
  std::set<DWORD> targets_;
  std::map<std::wstring, Muted> muted_;
  // D2.10: the pids whose tree is levelled (pid -> gain 0.1–1.0) and the sessions set so far.
  std::map<DWORD, float> levelTargets_;
  std::map<std::wstring, Leveled> leveled_;
};

void usage() {
  std::printf(
      "castcade-audio %s: table sound for a Castcade match (mute this rig's VPX, capture its sound, set its volume).\n"
      "usage: castcade-audio.exe [--state <file>] [--version] [-help]\n"
      "stdin, one per line: mute <pid> | unmute <pid> | tap <pid> | untap | level <pid> <percent> | unlevel <pid> | quit\n"
      "stdout: event lines and \"CAU1\" + u32 LE byteLength + float32 stereo 48 kHz frames; stderr: log.\n",
      CASTCADE_AUDIO_VERSION);
}

int run(int argc, char** argv) {
  std::string stateFile;
  for (int i = 1; i < argc; i++) {
    const std::string a = argv[i];
    if (a == "--version") {
      std::printf("castcade-audio %s\n", CASTCADE_AUDIO_VERSION);
      return kExitOk;
    }
    if (a == "-help" || a == "--help" || a == "-h" || a == "/?") {
      usage();
      return kExitOk;
    }
    if (a == "--state" && i + 1 < argc) {
      stateFile = argv[++i];
      continue;
    }
    std::fprintf(stderr, "castcade-audio: unknown argument %s (try -help)\n", a.c_str());
    return kExitBadArgs;
  }

  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(hr)) {
    logLine("audio: COM did not start (" + hex(hr) + ")");
    return kExitAudio;
  }
  Com<IMMDeviceEnumerator> devices;
  hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator), devices.putVoid());
  if (FAILED(hr)) {
    logLine("audio: no CoreAudio device enumerator (" + hex(hr) + ")");
    CoUninitialize();
    return kExitAudio;
  }

  std::string tapUnavailable;
  ActivateAudioInterfaceAsyncFn activate = nullptr;
  const DWORD build = windowsBuild();
  if (build != 0 && build < kMinLoopbackBuild) {
    tapUnavailable = "windows_too_old:" + std::to_string(build);
  } else {
    HMODULE mmdevapi = LoadLibraryW(L"Mmdevapi.dll");
    if (mmdevapi)
      activate = reinterpret_cast<ActivateAudioInterfaceAsyncFn>(reinterpret_cast<void*>(GetProcAddress(mmdevapi, "ActivateAudioInterfaceAsync")));
    if (!activate) tapUnavailable = "no_activate_audio_interface";
  }

  g_cleanedUp = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  SetConsoleCtrlHandler(onConsoleEvent, TRUE);

  int code = kExitOk;
  {
    Engine engine(devices.get(), stateFile, activate, tapUnavailable);
    try {
      engine.recover();
      say(std::string("ready ") + CASTCADE_AUDIO_VERSION);
      if (!tapUnavailable.empty()) say("tap-unavailable " + tapUnavailable);
      logLine(std::string("audio: castcade-audio ") + CASTCADE_AUDIO_VERSION + " ready (Windows build " + std::to_string(build) + ", tap " +
              (tapUnavailable.empty() ? "available" : tapUnavailable) + ")");

      // stdin: a blocking reader on its own thread; EOF (the companion closed it or died) is a quit.
      std::thread reader([] {
        std::string line;
        while (std::getline(std::cin, line)) {
          if (!line.empty() && line.back() == '\r') line.pop_back();
          enqueue(line);
        }
        enqueue("quit");
      });
      reader.detach();

      auto lastScan = std::chrono::steady_clock::now();
      bool running = true;
      while (running) {
        std::deque<std::string> cmds;
        {
          std::unique_lock<std::mutex> lk(g_qMu);
          g_qCv.wait_for(lk, kRescan, [] { return !g_queue.empty(); });
          cmds.swap(g_queue);
        }
        for (const std::string& c : cmds) {
          if (!engine.handle(c)) {
            running = false;
            break;
          }
        }
        if (g_outBroken.load()) running = false;
        const auto now = std::chrono::steady_clock::now();
        if (running && now - lastScan >= kRescan) {
          lastScan = now;
          engine.rescan();
        }
      }
    } catch (const std::exception& e) {
      logLine(std::string("audio: fatal: ") + e.what() + "; unmuting and exiting");
    } catch (...) {
      logLine("audio: fatal error; unmuting and exiting");
    }
    try {
      engine.shutdown();
    } catch (...) {
      logLine("audio: unmute on exit failed");
    }
  }
  logLine("audio: exiting");
  devices.reset();
  if (g_cleanedUp) SetEvent(g_cleanedUp);
  CoUninitialize();
  return code;
}

}  // namespace

int main(int argc, char** argv) { return run(argc, argv); }
