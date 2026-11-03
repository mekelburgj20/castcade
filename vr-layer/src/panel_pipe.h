// The input of the layer (D7.3, 2026-10-31; protocol 2 since D7.4, 2026-10-31; protocol 3 since D7.5, 2026-11-02): a
// named pipe server, \\.\pipe\castcade-panel, that the companion connects to (companion/src/media/vr-layer.ts).
// vr-layer/README.md "The pipe" is the format; in short, little-endian throughout:
//   layer → companion, once per connection: "CVH1", u32 protocol version (kPipeProtocol);
//   layer → companion (protocol 3): "CVF1", u32 byteLength, a camera frame (camera.h: u16 jsonLength, the JSON header,
//     then the eyes' JPEG payloads back to back); "CVS1", u32 byteLength, UTF-8 JSON {"camera", "why", ...}: the
//     camera's state, or (D7.6.2) {"kind": "session", ...}: the session report (layer.cpp sessionFacts), sent at the
//     session's first frame, on every new connection and on request. Every layer → companion message after the hello
//     is magic + u32 byteLength + payload;
//   companion → layer, any order:
//     "CVO1", u32 width, u32 height, u32 byteLength = width * height * 4, then BGRA top-down: a panel frame (the panel
//       page's paint; the SteamVR helper's stdin format, so a protocol-1 companion still works);
//     "CVO2", same header, then RGBA top-down: a video frame (the opponent's feed, theater mode);
//     "CVC1", u32 byteLength (≤ kMaxMessageBytes), then UTF-8 JSON {"mode","stereo","panelPos"}, optionally the
//       number "theaterScale" (D7.4.5) and, protocol 3, "camera": {"width","height","fps"} | null (D7.5) and
//       "report": true (D7.6.2: send the session report now; a request, never a state): the control;
//     any other magic: u32 byteLength + payload, skipped (every message after protocol 2 is shaped so).
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace castcade {

// The pipe name; companion/src/media/vr-layer.ts connects to the same one.
constexpr const wchar_t* kPanelPipeName = L"\\\\.\\pipe\\castcade-panel";

// The version this layer announces in its hello (companion: VR_LAYER_PROTOCOL). A protocol-1 layer (0.2.26) sends no
// hello and drops the client on any magic but CVO1, so the companion sends CVC1 / CVO2 only after a hello of 2 or more;
// a protocol-3 layer (D7.5) also sends CVF1 / CVS1, which a protocol-2 companion never reads (they sit in its socket).
constexpr uint32_t kPipeProtocol = 3;

// No frame of a stream for this long → that stream is not live (the companion re-sends its last frame every 2 s while
// the picture is still, so a gap this long means it stopped feeding; the SteamVR helper hides on the same rule). With
// neither stream live the layer passes VPX's frame through untouched, whatever the mode: a crashed companion never
// leaves a player blind (D7.4).
constexpr int kPanelHideAfterMs = 5000;

enum class Stream { Panel = 0, Video = 1 };

// What the companion asks for (CVC1). The defaults hold until the first control and again after a disconnect, so a
// protocol-1 companion gets the panel as before (placed low since D7.4).
enum class ViewMode { Hidden, Panel, Theater };
constexpr float kTheaterScale = 1.0f;  // D7.4.5: life size (layer.cpp, "the stereo window")

// D7.5: the camera the companion asks for: each eye of VPX's frame, centre-cropped to the box's aspect and scaled into
// it (never up), at most `fps` frames a second, as JPEG over the pipe (camera.h). `on` false = no camera (the default,
// and "camera": null).
struct CameraRequest {
  bool on = false;
  uint32_t width = 0, height = 0;  // the box, per eye
  uint32_t fps = 0;
  bool operator==(const CameraRequest& o) const { return on == o.on && width == o.width && height == o.height && fps == o.fps; }
  bool operator!=(const CameraRequest& o) const { return !(*this == o); }
};
constexpr uint32_t kCameraMaxSide = 4096;
constexpr uint32_t kCameraMaxFps = 60;

struct Control {
  ViewMode mode = ViewMode::Panel;
  bool sbs = false;          // the video frame is left eye | right eye side by side
  bool panelCentre = false;  // panelPos "center": the D7.3 placement; else "low"
  // D7.4.5: the side-by-side theater picture's size against life size (1 = every pixel in the direction the sender's
  // eye rendered it). Optional in CVC1, clamped to [kTheaterScaleMin, kTheaterScaleMax].
  float theaterScale = kTheaterScale;
  CameraRequest camera;  // D7.5
};
constexpr float kTheaterScaleMin = 0.25f;
constexpr float kTheaterScaleMax = 4.0f;

// Starts the server thread once per process (later calls do nothing) and pins this dll in memory, so the thread can
// never outlive the code it runs when the loader unloads the layer at xrDestroyInstance.
void panelPipeStart();

// The newest frame of `stream` not yet taken: swapped into `pixels` (top-down, BGRA for Panel, RGBA for Video) with
// its size; false when none arrived since the last call. Older unread frames are dropped (newest wins).
bool panelPipeTake(Stream stream, std::vector<uint8_t>& pixels, uint32_t& width, uint32_t& height);

// A frame of `stream` arrived within kPanelHideAfterMs.
bool panelPipeLive(Stream stream);

// The control now.
Control panelPipeControl();

// D7.5: one whole message (magic, length and payload already laid out by the caller) to the connected companion, from
// any thread; blocks while the companion is slow to read; false when no companion is connected or the write failed
// (the connection is then dropped). Writes never interleave: one message at a time.
bool panelPipeSend(const uint8_t* data, size_t length);

// D7.6.2: goes up by one on every new connection (after the hello) and every control with "report": true; the render
// thread sends the session report whenever it differs from the value at its last report.
uint32_t panelPipeReportSerial();

// D7.6.2: a companion is connected now (a write may succeed).
bool panelPipeConnected();

// D7.6.2: one message, `magic` (4 characters) + u32 byteLength + `payload`, to the companion. Blocks like panelPipeSend.
bool panelPipeSendMessage(const char* magic, const std::string& payload);

// D7.5: a JSON status message ("CVS1") to the companion: the camera's state, `{"camera": "<state>", "why": "<why>", ...}`.
// `extra` is appended inside the object as is (already JSON, e.g. `,"source":[3072,3264]`), or empty.
bool panelPipeSendStatus(const char* camera, const std::string& why, const std::string& extra);

}  // namespace castcade
