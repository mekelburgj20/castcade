// The frame input of the layer (D7.3, 2026-10-31): a named pipe server, \\.\pipe\castcade-panel, that the companion
// connects to and writes the SAME frames it writes to the SteamVR helper's stdin (vr-overlay/README.md "stdin: frames":
// 16-byte little-endian header "CVO1", u32 width, u32 height, u32 byteLength = width * height * 4, then BGRA top-down).
#pragma once

#include <cstdint>
#include <vector>

namespace castcade {

// The pipe name; companion/src/media/vr-layer.ts connects to the same one.
constexpr const wchar_t* kPanelPipeName = L"\\\\.\\pipe\\castcade-panel";

// No frame for this long → the quad is left out of xrEndFrame (the companion re-sends its last frame every 2 s while
// the panel is still, so a gap this long means it stopped feeding; the SteamVR helper hides on the same rule).
constexpr int kPanelHideAfterMs = 5000;

// Starts the server thread once per process (later calls do nothing) and pins this dll in memory, so the thread can
// never outlive the code it runs when the loader unloads the layer at xrDestroyInstance.
void panelPipeStart();

// The newest frame not yet taken: swapped into `bgra` (top-down BGRA) with its size; false when none arrived since the
// last call. Older unread frames are dropped (newest wins).
bool panelPipeTake(std::vector<uint8_t>& bgra, uint32_t& width, uint32_t& height);

// A frame arrived within kPanelHideAfterMs.
bool panelPipeLive();

}  // namespace castcade
