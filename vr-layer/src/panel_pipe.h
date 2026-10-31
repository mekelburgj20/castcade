// The input of the layer (D7.3, 2026-10-31; protocol 2 since D7.4, 2026-10-31): a named pipe server,
// \\.\pipe\castcade-panel, that the companion connects to (companion/src/media/vr-layer.ts). vr-layer/README.md "The
// pipe" is the format; in short, little-endian throughout:
//   layer → companion, once per connection: "CVH1", u32 protocol version (kPipeProtocol);
//   companion → layer, any order:
//     "CVO1", u32 width, u32 height, u32 byteLength = width * height * 4, then BGRA top-down: a panel frame (the panel
//       page's paint; the SteamVR helper's stdin format, so a protocol-1 companion still works);
//     "CVO2", same header, then RGBA top-down: a video frame (the opponent's feed, theater mode);
//     "CVC1", u32 byteLength (≤ kMaxMessageBytes), then UTF-8 JSON {"mode","stereo","panelPos"}: the control;
//     any other magic: u32 byteLength + payload, skipped (every message after protocol 2 is shaped so).
#pragma once

#include <cstdint>
#include <vector>

namespace castcade {

// The pipe name; companion/src/media/vr-layer.ts connects to the same one.
constexpr const wchar_t* kPanelPipeName = L"\\\\.\\pipe\\castcade-panel";

// The version this layer announces in its hello (companion: VR_LAYER_PROTOCOL). A protocol-1 layer (0.2.26) sends no
// hello and drops the client on any magic but CVO1, so the companion sends CVC1 / CVO2 only after a hello of 2 or more.
constexpr uint32_t kPipeProtocol = 2;

// No frame of a stream for this long → that stream is not live (the companion re-sends its last frame every 2 s while
// the picture is still, so a gap this long means it stopped feeding; the SteamVR helper hides on the same rule). With
// neither stream live the layer passes VPX's frame through untouched, whatever the mode: a crashed companion never
// leaves a player blind (D7.4).
constexpr int kPanelHideAfterMs = 5000;

enum class Stream { Panel = 0, Video = 1 };

// What the companion asks for (CVC1). The defaults hold until the first control and again after a disconnect, so a
// protocol-1 companion gets the panel as before (placed low since D7.4).
enum class ViewMode { Hidden, Panel, Theater };
struct Control {
  ViewMode mode = ViewMode::Panel;
  bool sbs = false;          // the video frame is left eye | right eye side by side
  bool panelCentre = false;  // panelPos "center": the D7.3 placement; else "low"
};

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

}  // namespace castcade
