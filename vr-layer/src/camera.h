// D7.5 (2026-11-02): the layer as the camera for a VR sender (vr-layer/README.md "The camera"; docs/design/alpha-match.md
// §5a). Instead of a screen capture of VPX's preview window (which needs a lit desktop, a window in front, smaller than
// the display and wholly on it, and still stalled on Krobs' rig: D2.5, D7.4.4, D7.4.10), the layer copies the two eye
// views VPX submits in its XrCompositionLayerProjection, each centre-cropped to the companion's box aspect and scaled
// into it, encodes them as JPEG and writes them to the pipe as CVF1 frames, with each eye's fov and crop so the
// receiver's stereo window can use the sender's eyes rather than its own.
//
// Rules:
//   - the render thread (inside xrEndFrame) only ISSUES GPU work: OpenGL, a glBlitFramebuffer of the crop into a small
//     texture of ours and a glReadPixels of that into a pixel-pack buffer, fenced; D3D11, a CopySubresourceRegion of the
//     crop into a staging texture. One or two frames later, when the fence / Map says the copy is done, it maps the
//     buffer and hands the pointer to the worker. It never waits on the GPU and never waits on the worker;
//   - the worker copies the mapped rows out (flipping OpenGL's bottom-up rows, downsizing a D3D11 full-size crop),
//     lets the slot go, encodes both eyes at once (the right eye on a helper thread), and writes the frame; frames are
//     dropped when the ring is full or the worker is behind, never queued;
//   - what it cannot read (a multisampled or non-8-bit swapchain, a session with no projection layer, OpenGL without
//     framebuffer objects or fences) it refuses with one log line and a CVS1 status, so the companion falls back to
//     the screen capture;
//   - every frame's issue / map / copy / encode / write microseconds are measured; the first 10 frames and then every
//     300th go to the log, with a `camera:` line when it starts and when it stops.
#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <vector>

#include <windows.h>

#include "panel_pipe.h"

struct ID3D11Device;
struct ID3D11Texture2D;

namespace castcade {

// One of the app's swapchains, as the hooks in layer.cpp saw it. The camera reads it at xrEndFrame (under the layer's
// mutex; the app's render thread fills it in between).
struct AppSwapchain {
  int64_t format = 0;  // GL internal format or DXGI_FORMAT
  uint32_t width = 0, height = 0, arraySize = 1, sampleCount = 1;
  std::vector<uint32_t> glImages;           // OpenGL sessions: texture names by image index
  std::vector<ID3D11Texture2D*> d3dImages;  // D3D11 sessions: the app's textures (not AddRef'd; alive while the swapchain is)
  std::vector<uint32_t> acquired;           // indices acquired and not yet released, oldest first
  int32_t lastReleased = -1;                // the image the app submits in its next xrEndFrame; -1 before the first release
};

// One eye of the app's projection layer, as submitted this frame.
struct CameraView {
  float fovLeft = 0.0f, fovRight = 0.0f, fovUp = 0.0f, fovDown = 0.0f;  // radians, OpenXR's signs
  int32_t rectX = 0, rectY = 0, rectW = 0, rectH = 0;                  // XrSwapchainSubImage::imageRect
  uint32_t arrayIndex = 0;
  AppSwapchain swapchain;  // a copy of the record (empty images = not a swapchain the hooks saw)
  bool known = false;
};

enum class CameraApi { OpenGL, D3D11 };

class Camera {
 public:
  Camera();
  ~Camera();
  Camera(const Camera&) = delete;
  Camera& operator=(const Camera&) = delete;

  // Every xrEndFrame of the session, on the render thread, with the app's OpenGL context current (OpenGL) or the app's
  // device (D3D11). Starts, runs or stops the camera as `req` says. `views` are the projection layer's two eyes (or
  // fewer: nothing to capture this frame).
  void tick(const CameraRequest& req, CameraApi api, ID3D11Device* device, const CameraView* views, size_t viewCount);

  // The session goes (or the layer turns off for it): stop the worker and free the GPU objects. OpenGL: `dc` / `rc` is
  // the app's context, made current here if it is not (the objects leak, harmlessly, when that fails). Bounded: waits
  // at most a few hundred ms for the worker to let go of mapped memory.
  void shutdown(HDC dc, HGLRC rc);

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace castcade
