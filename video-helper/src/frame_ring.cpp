#include "frame_ring.h"

#include <windows.h>

#include <chrono>
#include <cstring>

#include "util.h"

std::wstring RingSectionName(const std::string& role, const std::string& token) {
  return WideFromUtf8("Local\\castcade-video-" + role + "-" + token);
}
std::wstring RingEventName(const std::string& role, const std::string& token) {
  return WideFromUtf8("Local\\castcade-video-" + role + "-" + token + "-event");
}

namespace {
bool TokenOk(const std::string& role, const std::string& token) {
  if (role != "send" && role != "recv") return false;
  if (token.empty() || token.size() > 64) return false;
  for (char c : token)
    if (!isalnum((unsigned char)c) && c != '-' && c != '_') return false;
  return true;
}
}  // namespace

// ---------------------------------------------------------------- producer

CastcadeRingSlot* RingProducer::Slot(uint32_t i) const {
  return reinterpret_cast<CastcadeRingSlot*>(reinterpret_cast<uint8_t*>(header_) + header_->headerBytes + (size_t)i * header_->slotBytes);
}

bool RingProducer::Create(const std::string& role, const std::string& token, uint32_t maxWidth, uint32_t maxHeight, std::string* error) {
  Close();
  if (!TokenOk(role, token)) { *error = "bad role or token"; return false; }
  if (maxWidth == 0 || maxHeight == 0 || maxWidth > CASTCADE_RING_MAX_SIDE || maxHeight > CASTCADE_RING_MAX_SIDE) {
    *error = "bad ring size";
    return false;
  }
  const uint64_t bytes = castcade_ring_section_bytes(maxWidth, maxHeight);
  const uint32_t slotBytes = castcade_ring_slot_bytes(maxWidth, maxHeight);
  HANDLE m = CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, (DWORD)(bytes >> 32), (DWORD)(bytes & 0xFFFFFFFFu),
                                RingSectionName(role, token).c_str());
  if (!m) { *error = "CreateFileMapping failed, error " + std::to_string(GetLastError()); return false; }
  const bool existed = GetLastError() == ERROR_ALREADY_EXISTS;
  void* view = MapViewOfFile(m, FILE_MAP_ALL_ACCESS, 0, 0, 0);
  if (!view) {
    *error = "MapViewOfFile failed, error " + std::to_string(GetLastError());
    CloseHandle(m);
    return false;
  }
  auto* h = static_cast<CastcadeRingHeader*>(view);
  if (existed) {
    // Adopt a section already under this name only when it is the same ring (magic, version, format, slots,
    // slotBytes, maxima); seq carries on from its latest. A different box needs a new token.
    MEMORY_BASIC_INFORMATION mbi{};
    VirtualQuery(view, &mbi, sizeof mbi);
    const bool same = mbi.RegionSize >= bytes && h->magic == CASTCADE_RING_MAGIC && h->version == CASTCADE_RING_VERSION &&
                      h->format == CASTCADE_RING_FORMAT_BGRA && h->slots == CASTCADE_RING_SLOTS && h->slotBytes == slotBytes &&
                      h->headerBytes == sizeof(CastcadeRingHeader) && h->maxWidth == maxWidth && h->maxHeight == maxHeight;
    if (!same) {
      *error = "a different ring already exists under this token";
      UnmapViewOfFile(view);
      CloseHandle(m);
      return false;
    }
    LogLine("ring %s/%s: adopted an existing section (latest %lld)", role.c_str(), token.c_str(), (long long)h->latest);
  }
  HANDLE ev = CreateEventW(nullptr, FALSE /* auto-reset */, FALSE, RingEventName(role, token).c_str());
  if (!ev) {
    *error = "CreateEvent failed, error " + std::to_string(GetLastError());
    UnmapViewOfFile(view);
    CloseHandle(m);
    return false;
  }
  mapping_ = m;
  event_ = ev;
  header_ = h;
  if (!existed) {
    memset(header_, 0, sizeof *header_);
    header_->format = CASTCADE_RING_FORMAT_BGRA;
    header_->slots = CASTCADE_RING_SLOTS;
    header_->maxWidth = maxWidth;
    header_->maxHeight = maxHeight;
    header_->slotBytes = slotBytes;
    header_->headerBytes = sizeof(CastcadeRingHeader);
    header_->latest = 0;
    header_->reading = 0;
    for (uint32_t i = 0; i < CASTCADE_RING_SLOTS; i++) memset(Slot(i), 0, sizeof(CastcadeRingSlot));
    // Magic and version last: a consumer that opens mid-initialisation sees them unset and waits.
    header_->version = CASTCADE_RING_VERSION;
    MemoryBarrier();
    header_->magic = CASTCADE_RING_MAGIC;
  }
  header_->producerPid = GetCurrentProcessId();
  Touch();
  stop_ = false;
  keepalive_ = std::thread([this] {
    while (!stop_) {
      std::this_thread::sleep_for(std::chrono::milliseconds(200));
      if (!stop_) Touch();
    }
  });
  return true;
}

void RingProducer::Touch() {
  if (header_) InterlockedExchange64(&header_->producerAliveUs, NowUs());
}

bool RingProducer::Begin(uint32_t width, uint32_t height, uint8_t** pixels, uint32_t* stride, int64_t* seq_out) {
  if (!header_ || width == 0 || height == 0 || width > header_->maxWidth || height > header_->maxHeight) return false;
  const int64_t latest = header_->latest;
  const int64_t reading = header_->reading;
  // seq = latest + 1, slot = seq % slots; if that is the slot the consumer is reading, step seq on by one.
  int64_t seq = latest + 1;
  if (reading != 0 && (uint32_t)(seq % CASTCADE_RING_SLOTS) == (uint32_t)(reading % CASTCADE_RING_SLOTS)) seq++;
  begun_seq_ = seq;
  begun_slot_ = (uint32_t)(seq % CASTCADE_RING_SLOTS);
  CastcadeRingSlot* s = Slot(begun_slot_);
  InterlockedExchange64(&s->seq, 0);  // "being written": a consumer that lands here sees no valid frame
  s->width = width;
  s->height = height;
  s->stride = width * 4;
  s->format = CASTCADE_RING_FORMAT_BGRA;
  *pixels = reinterpret_cast<uint8_t*>(s) + sizeof(CastcadeRingSlot);
  *stride = width * 4;
  if (seq_out) *seq_out = seq;
  return true;
}

void RingProducer::Commit(int64_t pts_us) {
  if (!header_ || begun_seq_ == 0) return;
  CastcadeRingSlot* s = Slot(begun_slot_);
  s->ptsUs = pts_us;
  // The slot's seq last (release), then latest (interlocked), then the event.
  InterlockedExchange64(&s->seq, begun_seq_);
  InterlockedExchange64(&header_->latest, begun_seq_);
  InterlockedExchange64(&header_->producerAliveUs, NowUs());
  SetEvent((HANDLE)event_);
  published_++;
  begun_seq_ = 0;
}

bool RingProducer::Publish(const uint8_t* bgra, uint32_t width, uint32_t height, uint32_t stride, int64_t pts_us) {
  uint8_t* dst;
  uint32_t dst_stride;
  if (!Begin(width, height, &dst, &dst_stride)) return false;
  if (stride == dst_stride) memcpy(dst, bgra, (size_t)dst_stride * height);
  else for (uint32_t r = 0; r < height; r++) memcpy(dst + (size_t)r * dst_stride, bgra + (size_t)r * stride, (size_t)width * 4);
  Commit(pts_us);
  return true;
}

void RingProducer::Close() {
  stop_ = true;
  if (keepalive_.joinable()) keepalive_.join();
  if (header_) UnmapViewOfFile(header_);
  if (event_) CloseHandle((HANDLE)event_);
  if (mapping_) CloseHandle((HANDLE)mapping_);
  header_ = nullptr;
  event_ = nullptr;
  mapping_ = nullptr;
  begun_seq_ = 0;
}

// ---------------------------------------------------------------- consumer

CastcadeRingSlot* RingConsumer::Slot(uint32_t i) const {
  return reinterpret_cast<CastcadeRingSlot*>(reinterpret_cast<uint8_t*>(header_) + header_->headerBytes + (size_t)i * header_->slotBytes);
}

bool RingConsumer::Open(const std::string& role, const std::string& token, std::string* error) {
  Close();
  if (!TokenOk(role, token)) { *error = "bad role or token"; return false; }
  // Read/write: `reading` and `consumerAliveUs` are the consumer's fields. An elevated producer's section may only
  // open read-only (ERROR_ACCESS_DENIED): then the post-use seq check alone guards against a lapped slot.
  bool writable = true;
  HANDLE m = OpenFileMappingW(FILE_MAP_READ | FILE_MAP_WRITE, FALSE, RingSectionName(role, token).c_str());
  if (!m && GetLastError() == ERROR_ACCESS_DENIED) {
    writable = false;
    m = OpenFileMappingW(FILE_MAP_READ, FALSE, RingSectionName(role, token).c_str());
  }
  if (!m) { *error = "missing"; return false; }
  void* view = MapViewOfFile(m, writable ? (FILE_MAP_READ | FILE_MAP_WRITE) : FILE_MAP_READ, 0, 0, 0);
  if (!view) {
    *error = "MapViewOfFile failed, error " + std::to_string(GetLastError());
    CloseHandle(m);
    return false;
  }
  MEMORY_BASIC_INFORMATION mbi{};
  VirtualQuery(view, &mbi, sizeof mbi);
  const size_t mapped = mbi.RegionSize;
  auto* h = static_cast<CastcadeRingHeader*>(view);
  if (mapped < sizeof(CastcadeRingHeader) || h->magic != CASTCADE_RING_MAGIC || h->version != CASTCADE_RING_VERSION) {
    *error = mapped >= sizeof(CastcadeRingHeader) && h->magic == 0 ? "missing" : "bad magic or version";
    UnmapViewOfFile(view);
    CloseHandle(m);
    return false;
  }
  if (h->slots != CASTCADE_RING_SLOTS || h->headerBytes != sizeof(CastcadeRingHeader) || h->maxWidth == 0 ||
      h->maxHeight == 0 || h->maxWidth > CASTCADE_RING_MAX_SIDE || h->maxHeight > CASTCADE_RING_MAX_SIDE ||
      h->slotBytes < castcade_ring_slot_bytes(h->maxWidth, h->maxHeight) ||
      mapped < (size_t)h->headerBytes + (size_t)h->slots * h->slotBytes) {
    *error = "bad ring geometry";
    UnmapViewOfFile(view);
    CloseHandle(m);
    return false;
  }
  HANDLE ev = OpenEventW(SYNCHRONIZE, FALSE, RingEventName(role, token).c_str());
  if (!ev) {
    *error = "missing";
    UnmapViewOfFile(view);
    CloseHandle(m);
    return false;
  }
  mapping_ = m;
  event_ = ev;
  header_ = h;
  writable_ = writable;
  mapped_bytes_ = mapped;
  if (writable_) {
    header_->consumerPid = GetCurrentProcessId();
    InterlockedExchange64(&header_->consumerAliveUs, NowUs());
  } else {
    LogLine("ring %s/%s: opened read-only (the producer is elevated?); relying on the post-use check", role.c_str(), token.c_str());
  }
  last_seq_ = 0;
  held_seq_ = 0;
  return true;
}

bool RingConsumer::Acquire(int timeout_ms, Frame* frame) {
  if (!header_) return false;
  if (held_seq_) Release();
  WaitForSingleObject((HANDLE)event_, (DWORD)timeout_ms);
  if (writable_) InterlockedExchange64(&header_->consumerAliveUs, NowUs());
  const int64_t latest = header_->latest;
  if (latest <= last_seq_) return false;  // nothing new, or a repeat (the event was set twice)
  if (writable_) InterlockedExchange64(&header_->reading, latest);
  MemoryBarrier();
  // The slot: latest % slots first, else the one whose seq == latest.
  uint32_t slot = (uint32_t)(latest % CASTCADE_RING_SLOTS);
  CastcadeRingSlot* s = Slot(slot);
  if (s->seq != latest) {
    s = nullptr;
    for (uint32_t i = 0; i < CASTCADE_RING_SLOTS; i++)
      if (Slot(i)->seq == latest) { slot = i; s = Slot(i); break; }
  }
  if (!s || s->format != CASTCADE_RING_FORMAT_BGRA || s->width == 0 || s->height == 0 || s->width > header_->maxWidth ||
      s->height > header_->maxHeight || s->stride < s->width * 4 ||
      (size_t)s->stride * s->height > header_->slotBytes - sizeof(CastcadeRingSlot)) {
    if (writable_) InterlockedExchange64(&header_->reading, 0);
    skipped_++;
    last_seq_ = latest;
    return false;
  }
  held_seq_ = latest;
  held_slot_ = slot;
  frame->bgra = reinterpret_cast<const uint8_t*>(s) + sizeof(CastcadeRingSlot);
  frame->width = s->width;
  frame->height = s->height;
  frame->stride = s->stride;
  frame->pts_us = s->ptsUs;
  frame->seq = latest;
  last_seq_ = latest;
  used_++;
  return true;
}

bool RingConsumer::Release() {
  if (!header_ || !held_seq_) return true;
  MemoryBarrier();
  // The post-use check: a changed seq means the producer wrote the slot under us (lapped) and the frame is void.
  const bool intact = Slot(held_slot_)->seq == held_seq_;
  if (!intact) { torn_++; used_--; skipped_++; }
  if (writable_) InterlockedExchange64(&header_->reading, 0);
  held_seq_ = 0;
  return intact;
}

bool RingConsumer::ProducerAlive() const {
  if (!header_) return false;
  return NowUs() - header_->producerAliveUs < 3000000;
}

void RingConsumer::Close() {
  if (header_) {
    if (held_seq_) Release();
    UnmapViewOfFile(header_);
  }
  if (event_) CloseHandle((HANDLE)event_);
  if (mapping_) CloseHandle((HANDLE)mapping_);
  header_ = nullptr;
  event_ = nullptr;
  mapping_ = nullptr;
}
