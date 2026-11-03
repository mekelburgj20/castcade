// See panel_pipe.h. One blocking thread: create the pipe, wait for the companion, say hello, read messages until it
// goes, repeat. D7.5 (2026-11-02): the camera's worker writes frames to the same pipe from its own thread, so the pipe
// is OVERLAPPED now: on a synchronous handle the I/O manager serialises every operation on the file object, and a
// WriteFile from another thread would wait behind the reader's blocking ReadFile for as long as the companion sends
// nothing. Each operation here still waits for its own completion (an event per caller), so the code reads as before.
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
#include <memory>
#include <mutex>
#include <string>
#include <thread>

namespace castcade {
namespace {

constexpr uint32_t kMaxSide = 4096;  // the SteamVR helper's limit; the companion's frameHeader() refuses larger first
// A control is ~100 bytes; anything this large is not a message this side understands (or a stream out of step).
constexpr uint32_t kMaxMessageBytes = 64 * 1024;
constexpr DWORD kRetryMs = 2000;
// The pipe's own buffers: 1 MiB in (video frames come in pieces anyway), 4 MiB out (D7.5: a camera frame is two JPEGs
// of a few hundred KB; a write beyond the free space blocks the camera's worker, never the render thread).
constexpr DWORD kInBufferBytes = 1u << 20;
constexpr DWORD kOutBufferBytes = 4u << 20;

struct Inbox {
  std::vector<uint8_t> pixels;  // the newest complete frame not yet taken
  uint32_t width = 0, height = 0;
  bool hasFrame = false;
};

// One connection. The reader thread owns the handle; writers (the reader's hello and status, the camera's worker)
// hold a shared_ptr for the duration of one write, under `write`. `dead` is set by the reader when the companion goes,
// before it cancels the handle's I/O and closes it under `write`, so no writer ever calls into a closed handle.
struct Conn {
  HANDLE pipe = INVALID_HANDLE_VALUE;
  std::mutex write;
  std::atomic<bool> dead{false};
};

struct State {
  std::mutex m;
  Inbox inbox[2];  // by Stream
  Control control;
  std::shared_ptr<Conn> conn;  // the connected companion, or null
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

void put32(uint8_t* p, uint32_t v) {
  for (int i = 0; i < 4; i++) p[i] = static_cast<uint8_t>((v >> (8 * i)) & 0xff);
}

// An event for one thread's overlapped operations, made on first use and kept for the thread's life.
HANDLE threadEvent() {
  thread_local HANDLE ev = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  return ev;
}

// One overlapped operation (ReadFile or WriteFile) waited to completion; `got` is the byte count. False on any error
// (the companion went, the handle was cancelled or closed).
template <typename Op>
bool waitOp(HANDLE pipe, Op op, DWORD& got) {
  HANDLE ev = threadEvent();
  if (!ev) return false;
  OVERLAPPED ov{};
  ov.hEvent = ev;
  ResetEvent(ev);
  got = 0;
  if (op(&ov, &got)) return true;  // completed at once (the data was there / the buffer had room)
  if (GetLastError() != ERROR_IO_PENDING) return false;
  return GetOverlappedResult(pipe, &ov, &got, TRUE) != FALSE;
}

bool readExact(HANDLE pipe, uint8_t* p, size_t n) {
  while (n > 0) {
    DWORD got = 0;
    const DWORD want = static_cast<DWORD>(n > (1u << 20) ? (1u << 20) : n);
    const bool ok = waitOp(pipe, [&](OVERLAPPED* ov, DWORD* out) { return ReadFile(pipe, p, want, out, ov) != FALSE; }, got);
    if (!ok || got == 0) return false;  // the companion went (or the pipe broke)
    p += got;
    n -= got;
  }
  return true;
}

bool writeAll(HANDLE pipe, const uint8_t* p, size_t n) {
  while (n > 0) {
    DWORD wrote = 0;
    const DWORD want = static_cast<DWORD>(n > (1u << 20) ? (1u << 20) : n);
    const bool ok = waitOp(pipe, [&](OVERLAPPED* ov, DWORD* out) { return WriteFile(pipe, p, want, out, ov) != FALSE; }, wrote);
    if (!ok || wrote == 0) return false;
    p += wrote;
    n -= wrote;
  }
  return true;
}

// A magic for a log line: printable ASCII as is, anything else as '?'.
std::string printable(const uint8_t* m) {
  std::string s;
  for (int i = 0; i < 4; i++) s += (m[i] >= 0x20 && m[i] < 0x7f) ? static_cast<char>(m[i]) : '?';
  return s;
}

size_t skipSpace(const std::string& body, size_t i) {
  while (i < body.size() && (body[i] == ' ' || body[i] == '\t' || body[i] == '\r' || body[i] == '\n')) i++;
  return i;
}

// The index of the first character of "key"'s value in a flat JSON object, or npos (no key).
size_t valueAt(const std::string& body, const char* key) {
  const std::string k = std::string("\"") + key + "\"";
  size_t i = body.find(k);
  if (i == std::string::npos) return std::string::npos;
  i = skipSpace(body, i + k.size());
  if (i >= body.size() || body[i] != ':') return std::string::npos;
  return skipSpace(body, i + 1);
}

// The string value of "key" in a flat JSON object, or "" (no key, not a string). Enough for the control's three enum
// fields; anything it cannot read leaves that field as it was. No escapes are expected in these values.
std::string jsonString(const std::string& body, const char* key) {
  const size_t i = valueAt(body, key);
  if (i == std::string::npos || i >= body.size() || body[i] != '"') return "";
  const size_t end = body.find('"', i + 1);
  return end == std::string::npos ? "" : body.substr(i + 1, end - i - 1);
}

// The number value of "key" in a flat JSON object: true with `out` set, or false (no key, not a plain decimal).
// Parsed by hand, not with strtod: strtod follows the process's locale, and in a locale with a decimal comma VPX's
// process would read "1.5" as 1.
bool jsonNumber(const std::string& body, const char* key, double& out) {
  size_t i = valueAt(body, key);
  if (i == std::string::npos) return false;
  bool negative = false;
  if (i < body.size() && body[i] == '-') negative = true, i++;
  double v = 0.0;
  bool digits = false;
  for (; i < body.size() && body[i] >= '0' && body[i] <= '9'; i++) v = v * 10.0 + (body[i] - '0'), digits = true;
  if (i < body.size() && body[i] == '.') {
    double place = 0.1;
    for (i++; i < body.size() && body[i] >= '0' && body[i] <= '9'; i++) v += (body[i] - '0') * place, place *= 0.1, digits = true;
  }
  if (!digits) return false;
  if (i < body.size() && (body[i] == 'e' || body[i] == 'E')) return false;  // no exponent in a scale: the field stays as it was
  out = negative ? -v : v;
  return true;
}

// D7.5: "camera" in the control. Absent → unchanged (false). null → off. An object → its width / height / fps, each a
// plain number inside the braces; a malformed object → off (never a camera the companion did not shape).
bool jsonCamera(const std::string& body, CameraRequest& out) {
  const size_t i = valueAt(body, "camera");
  if (i == std::string::npos || i >= body.size()) return false;
  out = CameraRequest{};
  if (body[i] != '{') return true;  // null (or anything else): off
  const size_t end = body.find('}', i);
  if (end == std::string::npos) return true;
  const std::string obj = body.substr(i, end - i + 1);
  double w = 0.0, h = 0.0, fps = 0.0;
  if (!jsonNumber(obj, "width", w) || !jsonNumber(obj, "height", h) || !jsonNumber(obj, "fps", fps)) return true;
  if (!(w >= 2.0 && w <= kCameraMaxSide && h >= 2.0 && h <= kCameraMaxSide && fps >= 1.0 && fps <= kCameraMaxFps)) return true;
  out.on = true;
  out.width = static_cast<uint32_t>(w);
  out.height = static_cast<uint32_t>(h);
  out.fps = static_cast<uint32_t>(fps);
  return true;
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
  double scale = 0.0;
  if (jsonNumber(body, "theaterScale", scale)) {
    c.theaterScale = static_cast<float>(scale < kTheaterScaleMin ? kTheaterScaleMin : scale > kTheaterScaleMax ? kTheaterScaleMax : scale);
  }
  CameraRequest cam;
  if (jsonCamera(body, cam)) c.camera = cam;
  bool changed = false, cameraChanged = false;
  {
    std::lock_guard<std::mutex> lk(st.m);
    changed = st.control.mode != c.mode || st.control.sbs != c.sbs || st.control.panelCentre != c.panelCentre ||
              st.control.theaterScale != c.theaterScale;
    cameraChanged = st.control.camera != c.camera;
    st.control = c;
  }
  if (changed) {
    const char* m = c.mode == ViewMode::Hidden ? "hidden" : c.mode == ViewMode::Panel ? "panel" : "theater";
    logLine(std::string("pipe: mode ") + m + (c.sbs ? ", stereo sbs" : ", stereo mono") + (c.panelCentre ? ", panel centre" : ", panel low") +
            (c.theaterScale != 1.0f ? ", theater scale " + std::to_string(c.theaterScale) : std::string()));
  }
  if (cameraChanged) {
    logLine(c.camera.on ? "pipe: camera asked: each eye in a " + std::to_string(c.camera.width) + "x" + std::to_string(c.camera.height) + " box at " +
                              std::to_string(c.camera.fps) + " fps"
                        : std::string("pipe: camera off"));
  }
}

// Back to the defaults (a new companion starts from them; a protocol-1 one never sends a control).
void resetControl() {
  State& st = state();
  std::lock_guard<std::mutex> lk(st.m);
  st.control = Control{};
}

// "CVH1" + our protocol version. A protocol-1 companion never reads it: 8 bytes sit in its socket's buffer, harmless.
void sendHello() {
  uint8_t hello[8] = {'C', 'V', 'H', '1', 0, 0, 0, 0};
  put32(hello + 4, kPipeProtocol);
  if (!panelPipeSend(hello, sizeof hello))
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

// ConnectNamedPipe on an overlapped handle, waited to completion. False: the wait failed (not a client's doing).
bool waitForClient(HANDLE pipe) {
  HANDLE ev = threadEvent();
  if (!ev) return false;
  OVERLAPPED ov{};
  ov.hEvent = ev;
  ResetEvent(ev);
  if (ConnectNamedPipe(pipe, &ov)) return true;  // not expected on an overlapped pipe, but a connection all the same
  const DWORD err = GetLastError();
  if (err == ERROR_PIPE_CONNECTED) return true;
  if (err != ERROR_IO_PENDING) return false;
  DWORD ignored = 0;
  return GetOverlappedResult(pipe, &ov, &ignored, TRUE) != FALSE;
}

void serve() {
  for (;;) {
    try {
      const HANDLE pipe = CreateNamedPipeW(kPanelPipeName, PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED,
                                           PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, kOutBufferBytes,
                                           kInBufferBytes, 0, nullptr);
      if (pipe == INVALID_HANDLE_VALUE) {
        // ERROR_ACCESS_DENIED here: another process (a second VPX) already serves the name. Keep trying: it may close.
        logOnce("pipe_create", "pipe: CreateNamedPipe failed (error " + std::to_string(GetLastError()) +
                                   "); another process may own \\\\.\\pipe\\castcade-panel; retrying every 2 s");
        Sleep(kRetryMs);
        continue;
      }
      const bool connected = waitForClient(pipe);
      if (connected) {
        logLine("pipe: the companion connected (protocol " + std::to_string(kPipeProtocol) + ")");
        resetControl();
        auto conn = std::make_shared<Conn>();
        conn->pipe = pipe;
        {
          std::lock_guard<std::mutex> lk(state().m);
          state().conn = conn;
        }
        sendHello();
        const std::string why = readMessages(pipe);
        logLine("pipe: the companion disconnected (" + why + ")");
        // Whatever it asked for ends with it: the panel (its last frames fade out within 5 s), never a dark theater, no
        // camera (the camera's worker sees the request go and stops).
        resetControl();
        g_lastFrameAt[1].store(0);
        {
          std::lock_guard<std::mutex> lk(state().m);
          if (state().conn == conn) state().conn.reset();
        }
        conn->dead.store(true);
        // A writer waiting on a full pipe wakes with an error; one that started its write after the cancel is cancelled
        // by the next round. With the write mutex held, no writer is inside the handle, and it can close.
        while (!conn->write.try_lock()) {
          CancelIoEx(pipe, nullptr);
          Sleep(10);
        }
        DisconnectNamedPipe(pipe);
        CloseHandle(pipe);
        conn->pipe = INVALID_HANDLE_VALUE;
        conn->write.unlock();
        continue;
      }
      DisconnectNamedPipe(pipe);
      CloseHandle(pipe);
      Sleep(200);
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

bool panelPipeSend(const uint8_t* data, size_t length) {
  std::shared_ptr<Conn> conn;
  {
    std::lock_guard<std::mutex> lk(state().m);
    conn = state().conn;
  }
  if (!conn || conn->dead.load()) return false;
  std::lock_guard<std::mutex> lk(conn->write);
  if (conn->dead.load() || conn->pipe == INVALID_HANDLE_VALUE) return false;
  if (writeAll(conn->pipe, data, length)) return true;
  // The write failed (the companion went, or the pipe broke): the reader's ReadFile fails too and closes the handle.
  conn->dead.store(true);
  return false;
}

bool panelPipeSendStatus(const char* camera, const std::string& why, const std::string& extra) {
  std::string json = std::string("{\"camera\":\"") + camera + "\",\"why\":\"";
  for (char ch : why) {
    if (ch == '"' || ch == '\\') json += '\\';
    json += (ch >= 0x20 && ch != 0x7f) ? ch : ' ';
  }
  json += "\"" + extra + "}";
  std::vector<uint8_t> msg(8 + json.size());
  std::memcpy(msg.data(), "CVS1", 4);
  put32(msg.data() + 4, static_cast<uint32_t>(json.size()));
  std::memcpy(msg.data() + 8, json.data(), json.size());
  return panelPipeSend(msg.data(), msg.size());
}

}  // namespace castcade
