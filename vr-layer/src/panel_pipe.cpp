// See panel_pipe.h. One blocking thread: create the pipe, wait for the companion, say hello, read messages until it
// goes, repeat.
//
// Byte mode, not message mode (D7.3 decision, 2026-10-31): the format delimits itself, and Node's net.Socket on a pipe
// is a byte stream whose writes may be split or coalesced, so message boundaries would carry no meaning. One instance
// at a time (one companion), local clients only, the default security descriptor (only this user, SYSTEM and
// administrators may write to it).
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
// A control is ~60 bytes; anything this large is not a message this side understands (or a stream out of step).
constexpr uint32_t kMaxMessageBytes = 64 * 1024;
constexpr DWORD kRetryMs = 2000;

struct Inbox {
  std::vector<uint8_t> pixels;  // the newest complete frame not yet taken
  uint32_t width = 0, height = 0;
  bool hasFrame = false;
};

struct State {
  std::mutex m;
  Inbox inbox[2];  // by Stream
  Control control;
};

State& state() {
  static State* st = new State();  // never freed: the reader thread runs until the process ends
  return *st;
}

// GetTickCount64 at the last complete frame of each stream; 0 = none (static storage: zero before the thread starts).
std::atomic<uint64_t> g_lastFrameAt[2];

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

// A magic for a log line: printable ASCII as is, anything else as '?'.
std::string printable(const uint8_t* m) {
  std::string s;
  for (int i = 0; i < 4; i++) s += (m[i] >= 0x20 && m[i] < 0x7f) ? static_cast<char>(m[i]) : '?';
  return s;
}

// The string value of "key" in a flat JSON object, or "" (no key, not a string). Enough for the control's three enum
// fields; anything it cannot read leaves that field as it was. No escapes are expected in these values.
std::string jsonString(const std::string& body, const char* key) {
  const std::string k = std::string("\"") + key + "\"";
  size_t i = body.find(k);
  if (i == std::string::npos) return "";
  i += k.size();
  while (i < body.size() && (body[i] == ' ' || body[i] == '\t' || body[i] == '\r' || body[i] == '\n')) i++;
  if (i >= body.size() || body[i] != ':') return "";
  i++;
  while (i < body.size() && (body[i] == ' ' || body[i] == '\t' || body[i] == '\r' || body[i] == '\n')) i++;
  if (i >= body.size() || body[i] != '"') return "";
  const size_t end = body.find('"', i + 1);
  return end == std::string::npos ? "" : body.substr(i + 1, end - i - 1);
}

void applyControl(const std::string& body) {
  State& st = state();
  Control c;
  {
    std::lock_guard<std::mutex> lk(st.m);
    c = st.control;
  }
  const std::string mode = jsonString(body, "mode"), stereo = jsonString(body, "stereo"), pos = jsonString(body, "panelPos");
  if (mode == "hidden") c.mode = ViewMode::Hidden;
  else if (mode == "panel") c.mode = ViewMode::Panel;
  else if (mode == "theater") c.mode = ViewMode::Theater;
  if (stereo == "sbs") c.sbs = true;
  else if (stereo == "mono") c.sbs = false;
  if (pos == "center") c.panelCentre = true;
  else if (pos == "low") c.panelCentre = false;
  bool changed = false;
  {
    std::lock_guard<std::mutex> lk(st.m);
    changed = st.control.mode != c.mode || st.control.sbs != c.sbs || st.control.panelCentre != c.panelCentre;
    st.control = c;
  }
  if (changed) {
    const char* m = c.mode == ViewMode::Hidden ? "hidden" : c.mode == ViewMode::Panel ? "panel" : "theater";
    logLine(std::string("pipe: mode ") + m + (c.sbs ? ", stereo sbs" : ", stereo mono") + (c.panelCentre ? ", panel centre" : ", panel low"));
  }
}

// Back to the defaults (a new companion starts from them; a protocol-1 one never sends a control).
void resetControl() {
  State& st = state();
  std::lock_guard<std::mutex> lk(st.m);
  st.control = Control{};
}

// "CVH1" + our protocol version. A protocol-1 companion never reads it: 8 bytes sit in its socket's buffer, harmless.
void sendHello(HANDLE pipe) {
  uint8_t hello[8] = {'C', 'V', 'H', '1', 0, 0, 0, 0};
  for (int i = 0; i < 4; i++) hello[4 + i] = static_cast<uint8_t>((kPipeProtocol >> (8 * i)) & 0xff);
  DWORD wrote = 0;
  if (!WriteFile(pipe, hello, sizeof hello, &wrote, nullptr) || wrote != sizeof hello)
    logLine("pipe: could not send the hello (error " + std::to_string(GetLastError()) + "); the companion stays on protocol 1 (the panel only)");
}

// Reads messages from a connected client until it disconnects or sends something unreadable. Returns why it stopped.
std::string readMessages(HANDLE pipe) {
  std::vector<uint8_t> buf;
  bool first[2] = {true, true};
  for (;;) {
    uint8_t magic[4];
    if (!readExact(pipe, magic, sizeof magic)) return "closed";
    const bool panel = std::memcmp(magic, "CVO1", 4) == 0, video = std::memcmp(magic, "CVO2", 4) == 0;
    if (panel || video) {
      uint8_t hdr[12];
      if (!readExact(pipe, hdr, sizeof hdr)) return "closed";
      const uint32_t w = le32(hdr), h = le32(hdr + 4), n = le32(hdr + 8);
      if (w == 0 || h == 0 || w > kMaxSide || h > kMaxSide) return "bad_size:" + std::to_string(w) + "x" + std::to_string(h);
      if (static_cast<uint64_t>(n) != static_cast<uint64_t>(w) * h * 4) return "bad_length:" + std::to_string(n);
      buf.resize(n);
      if (!readExact(pipe, buf.data(), n)) return "closed mid-frame";  // the partial frame is dropped
      const int k = video ? 1 : 0;
      if (first[k]) {
        logLine(std::string("pipe: first ") + (video ? "video" : "panel") + " frame " + std::to_string(w) + "x" + std::to_string(h));
        first[k] = false;
      }
      State& st = state();
      {
        std::lock_guard<std::mutex> lk(st.m);
        Inbox& box = st.inbox[k];
        box.pixels.swap(buf);
        box.width = w;
        box.height = h;
        box.hasFrame = true;
      }
      g_lastFrameAt[k].store(GetTickCount64());
      continue;
    }
    uint8_t len[4];
    if (!readExact(pipe, len, sizeof len)) return "closed";
    const uint32_t n = le32(len);
    if (n > kMaxMessageBytes) return "bad_message:" + printable(magic) + ":" + std::to_string(n);
    std::string body(n, '\0');
    if (n > 0 && !readExact(pipe, reinterpret_cast<uint8_t*>(&body[0]), n)) return "closed mid-message";
    if (std::memcmp(magic, "CVC1", 4) == 0) applyControl(body);
    else logOnce("pipe_unknown_" + printable(magic), "pipe: skipped a message '" + printable(magic) + "' this layer does not know (newer companion)");
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
        logLine("pipe: the companion connected (protocol " + std::to_string(kPipeProtocol) + ")");
        resetControl();
        sendHello(pipe);
        const std::string why = readMessages(pipe);
        logLine("pipe: the companion disconnected (" + why + ")");
        // Whatever it asked for ends with it: the panel (its last frames fade out within 5 s), never a dark theater.
        resetControl();
        g_lastFrameAt[1].store(0);
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

bool panelPipeTake(Stream stream, std::vector<uint8_t>& pixels, uint32_t& width, uint32_t& height) {
  State& st = state();
  std::lock_guard<std::mutex> lk(st.m);
  Inbox& box = st.inbox[stream == Stream::Video ? 1 : 0];
  if (!box.hasFrame) return false;
  pixels.swap(box.pixels);
  width = box.width;
  height = box.height;
  box.hasFrame = false;
  return true;
}

bool panelPipeLive(Stream stream) {
  const uint64_t at = g_lastFrameAt[stream == Stream::Video ? 1 : 0].load();
  return at != 0 && GetTickCount64() - at < static_cast<uint64_t>(kPanelHideAfterMs);
}

Control panelPipeControl() {
  State& st = state();
  std::lock_guard<std::mutex> lk(st.m);
  return st.control;
}

}  // namespace castcade
