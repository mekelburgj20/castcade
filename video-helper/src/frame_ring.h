// castcade-video: the helper's two sides of the frame ring of include/castcade_frame_ring.h (§6.1): a producer (the
// `recv` ring: decoded pictures for the layer) and a consumer (the `send` ring: the eye the layer scaled). The layer
// implements the opposite sides from the same header independently; the protocol in the header's comment is followed
// to the letter here (slot choice, seq, reading, aliveness, names).
#pragma once

#include <atomic>
#include <cstdint>
#include <string>
#include <thread>

#include "../include/castcade_frame_ring.h"

// Section and event names for a role ("send" / "recv") and the companion's token.
std::wstring RingSectionName(const std::string& role, const std::string& token);
std::wstring RingEventName(const std::string& role, const std::string& token);

class RingProducer {
 public:
  ~RingProducer() { Close(); }
  // Creates the section (sized for maxWidth x maxHeight BGRA) and the event, or adopts a matching one already under
  // the name (seq carries on). A keepalive thread refreshes producerAliveUs every 200 ms while nothing is published.
  bool Create(const std::string& role, const std::string& token, uint32_t maxWidth, uint32_t maxHeight, std::string* error);
  void Close();
  bool open() const { return header_ != nullptr; }
  uint32_t maxWidth() const { return header_ ? header_->maxWidth : 0; }
  uint32_t maxHeight() const { return header_ ? header_->maxHeight : 0; }

  // Two-step publish so a converter can write straight into the slot: Begin hands out the free slot's pixel area
  // (stride = width * 4), Commit publishes it. false from Begin when the frame does not fit the section.
  bool Begin(uint32_t width, uint32_t height, uint8_t** pixels, uint32_t* stride, int64_t* seq = nullptr);
  void Commit(int64_t pts_us);
  // One-step convenience: copies rows from `bgra` (any stride) and publishes.
  bool Publish(const uint8_t* bgra, uint32_t width, uint32_t height, uint32_t stride, int64_t pts_us);

  int64_t frames_published() const { return published_.load(); }

 private:
  CastcadeRingSlot* Slot(uint32_t i) const;
  void Touch();

  void* mapping_ = nullptr;
  void* event_ = nullptr;
  CastcadeRingHeader* header_ = nullptr;
  int64_t begun_seq_ = 0;
  uint32_t begun_slot_ = 0;
  std::atomic<int64_t> published_{0};
  std::thread keepalive_;
  std::atomic<bool> stop_{false};
};

class RingConsumer {
 public:
  struct Frame {
    const uint8_t* bgra = nullptr;
    uint32_t width = 0, height = 0, stride = 0;
    int64_t pts_us = 0;
    int64_t seq = 0;
  };
  ~RingConsumer() { Close(); }
  // Opens the producer's section and event; false (error = "missing") until the producer created them, or with the
  // reason when the header does not check out.
  bool Open(const std::string& role, const std::string& token, std::string* error);
  void Close();
  bool open() const { return header_ != nullptr; }

  // Waits up to timeout_ms for the event, then takes the newest frame if it is new. The pixels stay valid until
  // Release(). Returns false when there is nothing new (timeout, a repeat, or a slot that does not check out: those
  // count in skipped()).
  bool Acquire(int timeout_ms, Frame* frame);
  // The post-use check of the protocol: false when the producer wrote the slot while it was held (the frame just used
  // is void: a lapped read, counted in torn() and skipped()).
  bool Release();
  // False when producerAliveUs is older than 3 s (the other side is gone).
  bool ProducerAlive() const;

  int64_t frames_used() const { return used_; }
  int64_t frames_skipped() const { return skipped_; }
  int64_t frames_torn() const { return torn_; }
  bool writable() const { return writable_; }

 private:
  CastcadeRingSlot* Slot(uint32_t i) const;

  void* mapping_ = nullptr;
  void* event_ = nullptr;
  CastcadeRingHeader* header_ = nullptr;
  bool writable_ = true;
  size_t mapped_bytes_ = 0;
  int64_t last_seq_ = 0;
  int64_t held_seq_ = 0;
  uint32_t held_slot_ = 0;
  int64_t used_ = 0, skipped_ = 0, torn_ = 0;
};
