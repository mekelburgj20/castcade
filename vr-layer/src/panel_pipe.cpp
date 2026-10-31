// See panel_pipe.h. One blocking thread: create the pipe, wait for the companion, read frames until it goes, repeat.
//
// Byte mode, not message mode (D7.3 decision, 2026-10-31): the frame format delimits itself, and Node's net.Socket on
// a pipe is a byte stream whose writes may be split or coalesced, so message boundaries would carry no meaning. One
// instance at a time (one companion), local clients only, the default security descriptor (only this user, SYSTEM
// and administrators may write to it).
#include "panel_pipe.h"

#include "layer_log.h"

#include <windows.h>

#include <atomic>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>

namespace castcade {
namespace {

constexpr uint32_t kMaxSide = 4096;  // the SteamVR helper's limit; the companion's frameHeader() refuses larger first
constexpr DWORD kRetryMs = 2000;

struct Inbox {
  std::mutex m;
  std::vector<uint8_t> pixels;  // the newest complete frame not yet taken
  uint32_t width = 0, height = 0;
  bool hasFrame = false;
};

Inbox& inbox() {
  static Inbox* box = new Inbox();  // never freed: the reader thread runs until the process ends
  return *box;
}

std::atomic<uint64_t> g_lastFrameAt{0};  // GetTickCount64 at the last complete frame; 0 = none yet

uint32_t le32(const uint8_t* p) {
  return static_cast<uint32_t>(p[0]) | static_cast<uint32_t>(p[1]) << 8 | static_cast<uint32_t>(p[2]) << 16 |
         static_cast<uint32_t>(p[3]) << 24;
}

bool readExact(HANDLE pipe, uint8_t* p, size_t n) {
  while (n > 0) {
    DWORD got = 0;
    const DWORD want = static_cast<DWORD>(n > (1u << 20) ? (1u << 20) : n);
    if (!ReadFile(pipe, p, want, &got, nullptr) || got == 0) return false;  // the companion went (or the pipe broke)
    p += got;
    n -= got;
  }
  return true;
}

// Reads frames from a connected client until it disconnects or sends a bad header. Returns why it stopped.
std::string readFrames(HANDLE pipe) {
  std::vector<uint8_t> buf;
  bool first = true;
  for (;;) {
    uint8_t hdr[16];
    if (!readExact(pipe, hdr, sizeof hdr)) return "closed";
    const uint32_t w = le32(hdr + 4), h = le32(hdr + 8), n = le32(hdr + 12);
    if (std::memcmp(hdr, "CVO1", 4) != 0) return "bad_magic";
    if (w == 0 || h == 0 || w > kMaxSide || h > kMaxSide) return "bad_size:" + std::to_string(w) + "x" + std::to_string(h);
    if (static_cast<uint64_t>(n) != static_cast<uint64_t>(w) * h * 4) return "bad_length:" + std::to_string(n);
    buf.resize(n);
    if (!readExact(pipe, buf.data(), n)) return "closed mid-frame";  // the partial frame is dropped
    if (first) {
      logLine("pipe: first frame " + std::to_string(w) + "x" + std::to_string(h));
      first = false;
    }
    Inbox& box = inbox();
    {
      std::lock_guard<std::mutex> lk(box.m);
      box.pixels.swap(buf);
      box.width = w;
      box.height = h;
      box.hasFrame = true;
    }
    g_lastFrameAt.store(GetTickCount64());
  }
}

void serve() {
  for (;;) {
    try {
      const HANDLE pipe =
          CreateNamedPipeW(kPanelPipeName, PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
                           PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 4096, 1u << 20, 0, nullptr);
      if (pipe == INVALID_HANDLE_VALUE) {
        // ERROR_ACCESS_DENIED here: another process (a second VPX) already serves the name. Keep trying: it may close.
        logOnce("pipe_create", "pipe: CreateNamedPipe failed (error " + std::to_string(GetLastError()) +
                                   "); another process may own \\\\.\\pipe\\castcade-panel; retrying every 2 s");
        Sleep(kRetryMs);
        continue;
      }
      const bool connected = ConnectNamedPipe(pipe, nullptr) ? true : GetLastError() == ERROR_PIPE_CONNECTED;
      if (connected) {
        logLine("pipe: the companion connected");
        const std::string why = readFrames(pipe);
        logLine("pipe: the companion disconnected (" + why + ")");
      }
      DisconnectNamedPipe(pipe);
      CloseHandle(pipe);
      if (!connected) Sleep(200);
    } catch (...) {
      logOnce("pipe_fault", "pipe: an internal fault in the reader; retrying every 2 s");
      Sleep(kRetryMs);
    }
  }
}

}  // namespace

void panelPipeStart() {
  static std::once_flag once;
  std::call_once(once, [] {
    HMODULE self = nullptr;
    // Pin: the loader unloads the layer dll when the instance goes; this thread blocks in ConnectNamedPipe/ReadFile and
    // cannot be stopped cleanly, so the dll stays mapped for the life of the process instead.
    if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN,
                            reinterpret_cast<LPCWSTR>(&panelPipeStart), &self)) {
      logLine("pipe: could not pin the layer dll (error " + std::to_string(GetLastError()) + "); no pipe server, so no panel");
      return;
    }
    std::thread(serve).detach();
    logLine("pipe: serving \\\\.\\pipe\\castcade-panel");
  });
}

bool panelPipeTake(std::vector<uint8_t>& bgra, uint32_t& width, uint32_t& height) {
  Inbox& box = inbox();
  std::lock_guard<std::mutex> lk(box.m);
  if (!box.hasFrame) return false;
  bgra.swap(box.pixels);
  width = box.width;
  height = box.height;
  box.hasFrame = false;
  return true;
}

bool panelPipeLive() {
  const uint64_t at = g_lastFrameAt.load();
  return at != 0 && GetTickCount64() - at < static_cast<uint64_t>(kPanelHideAfterMs);
}

}  // namespace castcade
