// D10.2 (2026-11-07): the layer's side of the frame ring to the video helper (video-helper/include/castcade_frame_ring.h
// is the contract, byte for byte; docs/design/spectator-video-native.md §6.1 / §6.5). A named shared-memory section and
// a named event per direction, three slots, newest wins:
//   send ring  layer → helper   the eye the camera scaled into the box (RingProducer, camera.cpp's worker publishes)
//   recv ring  helper → layer   the decoded picture of the player who is up (RingConsumer, layer.cpp's theater takes)
// Plain Win32, no exceptions escape (every failure is a return value with `why` filled; the caller writes the one log
// line), no dependency on the rest of the layer, so tools/ring_feed.cpp links it alone.
#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace castcade {

// The token the companion hands both sides goes into a kernel object name: letters, digits, '_' and '-', 1..64 of them.
bool ringTokenValid(const std::string& token);

// "Local\\castcade-video-<role>-<token>" (and "...-event"): the names both sides derive from role and token.
std::wstring ringSectionName(const char* role, const std::string& token);
std::wstring ringEventName(const char* role, const std::string& token);

// QueryPerformanceCounter in microseconds: the clock of `ptsUs` and `producerAliveUs` (system-wide, both processes agree).
int64_t ringNowUs();

// The producer: creates the section sized for maxWidth x maxHeight BGRA frames and the event, publishes frames by the
// header's slot rule, refreshes producerAliveUs. One frame at a time: beginFrame() hands out the pixel area of a slot
// neither the newest nor the one being read, the caller fills `height` rows of `width * 4` bytes (BGRA, top-down),
// endFrame() publishes it. Thread rule: one publishing thread; heartbeat() may be called from any other thread.
class RingProducer {
 public:
  ~RingProducer();
  RingProducer(const RingProducer&) = delete;
  RingProducer& operator=(const RingProducer&) = delete;

  // Null with `why` on any failure (a bad token, a section of this name that already exists with another geometry,
  // CreateFileMapping / CreateEvent / MapViewOfFile failing). A section that already exists with the same geometry is
  // reused (the consumer keeps the old one alive while it holds it open, e.g. the camera restarting under one token):
  // publishing continues from its `latest`.
  static std::unique_ptr<RingProducer> create(const char* role, const std::string& token, uint32_t maxWidth, uint32_t maxHeight, std::string& why);

  // The pixel area of the slot the next frame goes into, `width * 4` bytes a row, or null when the frame does not fit
  // (larger than the ring's maximum).
  uint8_t* beginFrame(uint32_t width, uint32_t height);
  // Publishes the frame begun: seq, ptsUs (capture time in ringNowUs() units), size, then `latest` and the event.
  void endFrame(int64_t ptsUs);
  // Refreshes producerAliveUs when the last touch is older than ~250 ms (cheap; call it every frame while idle).
  void heartbeat();

  uint32_t maxWidth() const { return maxW_; }
  uint32_t maxHeight() const { return maxH_; }
  bool reused() const { return reused_; }  // the section existed already and was adopted
  int64_t published() const { return published_; }
  const std::wstring& sectionName() const { return name_; }

 private:
  RingProducer() = default;
  void* section_ = nullptr;  // HANDLE
  void* event_ = nullptr;    // HANDLE
  uint8_t* base_ = nullptr;
  uint32_t maxW_ = 0, maxH_ = 0, slotBytes_ = 0;
  uint32_t slot_ = 0;  // the slot beginFrame picked
  uint32_t frameW_ = 0, frameH_ = 0;
  bool inFrame_ = false, reused_ = false;
  int64_t published_ = 0, lastAliveUs_ = 0;
  std::wstring name_;
};

// The consumer: opens an existing section and its event, takes the newest unseen frame by the header's `reading`
// protocol, reports a producer whose heartbeat is older than kRingDeadAfterUs. Thread rule: one taking thread.
constexpr int64_t kRingDeadAfterUs = 3000000;

class RingConsumer {
 public:
  ~RingConsumer();
  RingConsumer(const RingConsumer&) = delete;
  RingConsumer& operator=(const RingConsumer&) = delete;

  // Null with `why`. `missing` is set when the section simply is not there yet (the producer has not started: retry
  // later, nothing is wrong); any other failure (a bad token, a header that is not a ring of this version, a section
  // smaller than its header says) is a fault.
  static std::unique_ptr<RingConsumer> open(const char* role, const std::string& token, std::string& why, bool& missing);

  // The newest frame not taken before, copied into `pixels` (BGRA top-down, packed rows) with its size and capture time;
  // false when there is none new (or the one there was torn by a lapping producer twice over: it is skipped and counted).
  bool take(std::vector<uint8_t>& pixels, uint32_t& width, uint32_t& height, int64_t& ptsUs);

  // Waits up to `ms` for the producer's event (a hint: a return of true means "look", not "a frame is there").
  bool wait(uint32_t ms);

  // The producer touched the ring within kRingDeadAfterUs.
  bool producerAlive() const;
  // Frames the producer published that this consumer never took (it was slower than the producer), and frames skipped
  // because the producer lapped the consumer mid-read.
  int64_t skipped() const { return skipped_; }
  int64_t lapped() const { return lapped_; }
  int64_t taken() const { return taken_; }
  int64_t lastSeq() const { return lastSeq_; }
  uint32_t maxWidth() const { return maxW_; }
  uint32_t maxHeight() const { return maxH_; }
  uint32_t producerPid() const;
  bool writable() const { return writable_; }  // the header could be opened for writing (the `reading` protocol is in force)

 private:
  RingConsumer() = default;
  void* section_ = nullptr;
  void* event_ = nullptr;
  uint8_t* base_ = nullptr;
  uint32_t maxW_ = 0, maxH_ = 0, slotBytes_ = 0;
  bool writable_ = false;
  int64_t lastSeq_ = 0, taken_ = 0, skipped_ = 0, lapped_ = 0;
};

}  // namespace castcade
