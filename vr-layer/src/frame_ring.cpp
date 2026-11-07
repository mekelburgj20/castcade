// See frame_ring.h. The protocol is the one in castcade_frame_ring.h's comment; what it leaves open is settled here:
//   - the event is auto-reset (SetEvent wakes one waiter; a consumer treats a wake-up as "look", never as "a frame is
//     there", and polls `latest` on its own clock as well, as the layer's render thread does);
//   - the consumer opens the section for writing when it can (the `reading` protocol needs it: the producer must see
//     which slot it holds), read-only when it cannot (an elevated producer), and then simply risks being lapped, which
//     the seq re-check after the copy catches;
//   - the producer stores seq = 0 into a slot before writing its pixels (the header says seq is written last; nothing
//     forbids clearing it first), so a consumer that stored `reading` a moment too late sees a seq that is not the one
//     it wants and retries instead of copying a frame being overwritten;
//   - a section that already exists under the name (the consumer keeps it alive while it holds it) is adopted when its
//     header describes the same geometry; with another geometry the producer fails and says so, since the consumer
//     holding the old object would read the new frames with the old slot layout. The companion gives a new token when
//     it changes the box.
// All ordering is x64 TSO plus MSVC's volatile semantics (/volatile:ms: acquire loads, release stores); the two stores
// the other side keys on (`reading`, `latest`) are Interlocked exchanges (full fences) so a store is never passed by a
// load after it.
#include "frame_ring.h"

#include <windows.h>

#include <algorithm>
#include <cstring>

#include "castcade_frame_ring.h"

namespace castcade {
namespace {

constexpr int64_t kHeartbeatEveryUs = 250000;

static_assert(sizeof(CastcadeRingHeader) == 4096, "the ring header is one page");
static_assert(sizeof(CastcadeRingSlot) == 4096, "the ring slot header is one page");

int64_t qpcFreq() {
  static const int64_t f = [] {
    LARGE_INTEGER li{};
    QueryPerformanceFrequency(&li);
    return li.QuadPart > 0 ? li.QuadPart : 1;
  }();
  return f;
}

std::wstring widen(const std::string& ascii) {
  std::wstring w;
  w.reserve(ascii.size());
  for (char c : ascii) w += static_cast<wchar_t>(static_cast<unsigned char>(c));
  return w;
}

std::string errText(const char* what, DWORD err) { return std::string(what) + " failed (error " + std::to_string(err) + ")"; }

// The mapped region's size (the section's, rounded to pages): what the consumer trusts before it trusts the header.
size_t mappedBytes(const void* base) {
  MEMORY_BASIC_INFORMATION mbi{};
  if (VirtualQuery(base, &mbi, sizeof mbi) != sizeof mbi) return 0;
  return mbi.RegionSize;
}

// The header's own account of itself, checked against this version of the contract and the mapping's size.
bool headerSane(const CastcadeRingHeader* h, size_t mapped, std::string& why) {
  if (h->magic != CASTCADE_RING_MAGIC) return why = "the section is not a frame ring (bad magic)", false;
  if (h->version != CASTCADE_RING_VERSION) return why = "ring version " + std::to_string(h->version) + " is not " + std::to_string(CASTCADE_RING_VERSION), false;
  if (h->format != CASTCADE_RING_FORMAT_BGRA) return why = "ring pixel format " + std::to_string(h->format) + " is not BGRA", false;
  if (h->slots != CASTCADE_RING_SLOTS) return why = "ring has " + std::to_string(h->slots) + " slots, not " + std::to_string(CASTCADE_RING_SLOTS), false;
  if (h->headerBytes != sizeof(CastcadeRingHeader)) return why = "ring header size " + std::to_string(h->headerBytes) + " is not 4096", false;
  if (h->maxWidth < 1 || h->maxHeight < 1 || h->maxWidth > CASTCADE_RING_MAX_SIDE || h->maxHeight > CASTCADE_RING_MAX_SIDE)
    return why = "ring size " + std::to_string(h->maxWidth) + "x" + std::to_string(h->maxHeight) + " is out of range", false;
  if (h->slotBytes != castcade_ring_slot_bytes(h->maxWidth, h->maxHeight)) return why = "ring slot size " + std::to_string(h->slotBytes) + " does not match its frame size", false;
  if (mapped < castcade_ring_section_bytes(h->maxWidth, h->maxHeight))
    return why = "the section (" + std::to_string(mapped) + " bytes) is smaller than its header says", false;
  return true;
}

CastcadeRingSlot* slotAt(uint8_t* base, uint32_t slotBytes, uint32_t i) {
  return reinterpret_cast<CastcadeRingSlot*>(base + sizeof(CastcadeRingHeader) + static_cast<size_t>(slotBytes) * i);
}

uint8_t* pixelsOf(CastcadeRingSlot* s) { return reinterpret_cast<uint8_t*>(s) + sizeof(CastcadeRingSlot); }

}  // namespace

bool ringTokenValid(const std::string& token) {
  if (token.empty() || token.size() > 64) return false;
  for (char c : token) {
    const bool ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '-';
    if (!ok) return false;
  }
  return true;
}

std::wstring ringSectionName(const char* role, const std::string& token) { return L"Local\\castcade-video-" + widen(role) + L"-" + widen(token); }

std::wstring ringEventName(const char* role, const std::string& token) { return ringSectionName(role, token) + L"-event"; }

int64_t ringNowUs() {
  LARGE_INTEGER li{};
  QueryPerformanceCounter(&li);
  const int64_t f = qpcFreq();
  return (li.QuadPart / f) * 1000000 + (li.QuadPart % f) * 1000000 / f;
}

// ---- producer ---------------------------------------------------------------------------------------------------------

std::unique_ptr<RingProducer> RingProducer::create(const char* role, const std::string& token, uint32_t maxWidth, uint32_t maxHeight, std::string& why) {
  why.clear();
  if (!ringTokenValid(token)) return why = "the ring token is not 1..64 of [A-Za-z0-9_-]", nullptr;
  if (maxWidth < 1 || maxHeight < 1 || maxWidth > CASTCADE_RING_MAX_SIDE || maxHeight > CASTCADE_RING_MAX_SIDE)
    return why = "a " + std::to_string(maxWidth) + "x" + std::to_string(maxHeight) + " ring is out of range (1.." + std::to_string(CASTCADE_RING_MAX_SIDE) + " a side)", nullptr;
  std::unique_ptr<RingProducer> p(new RingProducer());
  p->name_ = ringSectionName(role, token);
  p->maxW_ = maxWidth, p->maxH_ = maxHeight;
  p->slotBytes_ = castcade_ring_slot_bytes(maxWidth, maxHeight);
  const uint64_t bytes = castcade_ring_section_bytes(maxWidth, maxHeight);
  // The event first: a consumer that finds the section finds the event too.
  p->event_ = CreateEventW(nullptr, FALSE, FALSE, ringEventName(role, token).c_str());
  if (!p->event_) return why = errText("CreateEvent", GetLastError()), nullptr;
  p->section_ = CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, static_cast<DWORD>(bytes >> 32), static_cast<DWORD>(bytes & 0xffffffffu),
                                   p->name_.c_str());
  if (!p->section_) return why = errText("CreateFileMapping", GetLastError()), nullptr;
  const bool existed = GetLastError() == ERROR_ALREADY_EXISTS;
  p->base_ = static_cast<uint8_t*>(MapViewOfFile(p->section_, FILE_MAP_ALL_ACCESS, 0, 0, 0));
  if (!p->base_) return why = errText("MapViewOfFile", GetLastError()), nullptr;
  auto* h = reinterpret_cast<CastcadeRingHeader*>(p->base_);
  if (existed) {
    std::string hw;
    if (!headerSane(h, mappedBytes(p->base_), hw) || h->maxWidth != maxWidth || h->maxHeight != maxHeight) {
      why = "a ring of this name exists already with another geometry (" + (hw.empty() ? std::to_string(h->maxWidth) + "x" + std::to_string(h->maxHeight) : hw) +
            "); its consumer still holds it: a new token is needed";
      return nullptr;
    }
    p->reused_ = true;
    p->published_ = h->latest;
  } else {
    // A fresh section is zero-filled; the header in one go, then the fields the other side keys on.
    h->magic = CASTCADE_RING_MAGIC;
    h->version = CASTCADE_RING_VERSION;
    h->format = CASTCADE_RING_FORMAT_BGRA;
    h->slots = CASTCADE_RING_SLOTS;
    h->maxWidth = maxWidth;
    h->maxHeight = maxHeight;
    h->slotBytes = p->slotBytes_;
    h->headerBytes = sizeof(CastcadeRingHeader);
    h->latest = 0;
    h->reading = 0;
  }
  h->producerPid = GetCurrentProcessId();
  p->lastAliveUs_ = ringNowUs();
  InterlockedExchange64(&h->producerAliveUs, p->lastAliveUs_);
  return p;
}

RingProducer::~RingProducer() {
  if (base_) UnmapViewOfFile(base_);
  if (section_) CloseHandle(static_cast<HANDLE>(section_));
  if (event_) CloseHandle(static_cast<HANDLE>(event_));
}

uint8_t* RingProducer::beginFrame(uint32_t width, uint32_t height) {
  if (!base_ || width < 1 || height < 1 || width > maxW_ || height > maxH_) return nullptr;
  auto* h = reinterpret_cast<CastcadeRingHeader*>(base_);
  const int64_t latest = h->latest, reading = h->reading;
  // Neither the newest (a consumer may take it next) nor the one being read; with three slots one always remains. The
  // slot of latest + 1 first, so seq is latest + 1 whenever it can be (a consumer that looks in `latest % slots` and one
  // that scans for seq == latest both find it); only a slot being read pushes the frame on by one.
  uint32_t pick = 0;
  for (uint32_t k = 1; k <= CASTCADE_RING_SLOTS; k++) {
    const uint32_t i = static_cast<uint32_t>((latest + k) % CASTCADE_RING_SLOTS);
    const bool isLatest = latest != 0 && static_cast<uint32_t>(latest % CASTCADE_RING_SLOTS) == i;
    const bool isReading = reading != 0 && static_cast<uint32_t>(reading % CASTCADE_RING_SLOTS) == i;
    if (!isLatest && !isReading) {
      pick = i;
      break;
    }
  }
  CastcadeRingSlot* s = slotAt(base_, slotBytes_, pick);
  InterlockedExchange64(&s->seq, 0);  // not a frame while its pixels are being written
  slot_ = pick, frameW_ = width, frameH_ = height, inFrame_ = true;
  return pixelsOf(s);
}

void RingProducer::endFrame(int64_t ptsUs) {
  if (!base_ || !inFrame_) return;
  inFrame_ = false;
  auto* h = reinterpret_cast<CastcadeRingHeader*>(base_);
  CastcadeRingSlot* s = slotAt(base_, slotBytes_, slot_);
  // seq must equal latest when published: slot = seq % slots must be the slot picked, so seq climbs to the next value
  // that lands on it (the pick above excludes latest's slot, so at least one step is taken).
  int64_t seq = h->latest + 1;
  while (static_cast<uint32_t>(seq % CASTCADE_RING_SLOTS) != slot_) seq++;
  s->ptsUs = ptsUs;
  s->width = frameW_;
  s->height = frameH_;
  s->stride = frameW_ * 4;
  s->format = CASTCADE_RING_FORMAT_BGRA;
  InterlockedExchange64(&s->seq, seq);
  InterlockedExchange64(&h->latest, seq);
  published_ = seq;
  lastAliveUs_ = ringNowUs();
  InterlockedExchange64(&h->producerAliveUs, lastAliveUs_);
  SetEvent(static_cast<HANDLE>(event_));
}

void RingProducer::heartbeat() {
  if (!base_) return;
  const int64_t now = ringNowUs();
  if (now - lastAliveUs_ < kHeartbeatEveryUs) return;
  lastAliveUs_ = now;
  InterlockedExchange64(&reinterpret_cast<CastcadeRingHeader*>(base_)->producerAliveUs, now);
}

// ---- consumer ---------------------------------------------------------------------------------------------------------

std::unique_ptr<RingConsumer> RingConsumer::open(const char* role, const std::string& token, std::string& why, bool& missing) {
  why.clear();
  missing = false;
  if (!ringTokenValid(token)) return why = "the ring token is not 1..64 of [A-Za-z0-9_-]", nullptr;
  std::unique_ptr<RingConsumer> c(new RingConsumer());
  const std::wstring name = ringSectionName(role, token);
  DWORD access = FILE_MAP_READ | FILE_MAP_WRITE;
  c->section_ = OpenFileMappingW(access, FALSE, name.c_str());
  if (!c->section_ && GetLastError() == ERROR_ACCESS_DENIED) {
    access = FILE_MAP_READ;
    c->section_ = OpenFileMappingW(access, FALSE, name.c_str());
  }
  if (!c->section_) {
    const DWORD err = GetLastError();
    missing = err == ERROR_FILE_NOT_FOUND || err == ERROR_PATH_NOT_FOUND;
    return why = errText("OpenFileMapping", err), nullptr;
  }
  c->writable_ = (access & FILE_MAP_WRITE) != 0;
  c->base_ = static_cast<uint8_t*>(MapViewOfFile(c->section_, access, 0, 0, 0));
  if (!c->base_) return why = errText("MapViewOfFile", GetLastError()), nullptr;
  const size_t mapped = mappedBytes(c->base_);
  if (mapped < sizeof(CastcadeRingHeader)) return why = "the section is smaller than a ring header", nullptr;
  const auto* h = reinterpret_cast<const CastcadeRingHeader*>(c->base_);
  if (!headerSane(h, mapped, why)) return nullptr;
  c->maxW_ = h->maxWidth, c->maxH_ = h->maxHeight, c->slotBytes_ = h->slotBytes;
  c->event_ = OpenEventW(SYNCHRONIZE, FALSE, ringEventName(role, token).c_str());
  if (!c->event_) {
    // The producer makes the event before the section; a section without one is half made or not ours: come back later.
    missing = true;
    return why = errText("OpenEvent", GetLastError()), nullptr;
  }
  if (c->writable_) {
    auto* hw = reinterpret_cast<CastcadeRingHeader*>(c->base_);
    hw->consumerPid = GetCurrentProcessId();
    InterlockedExchange64(&hw->consumerAliveUs, ringNowUs());
  }
  return c;
}

RingConsumer::~RingConsumer() {
  if (base_ && writable_) InterlockedExchange64(&reinterpret_cast<CastcadeRingHeader*>(base_)->reading, 0);
  if (base_) UnmapViewOfFile(base_);
  if (section_) CloseHandle(static_cast<HANDLE>(section_));
  if (event_) CloseHandle(static_cast<HANDLE>(event_));
}

bool RingConsumer::take(std::vector<uint8_t>& pixels, uint32_t& width, uint32_t& height, int64_t& ptsUs) {
  if (!base_) return false;
  auto* h = reinterpret_cast<CastcadeRingHeader*>(base_);
  int64_t latest = h->latest;
  if (latest == 0 || latest <= lastSeq_) return false;
  const auto release = [&] {
    if (writable_) InterlockedExchange64(&h->reading, 0);
  };
  for (int attempt = 0; attempt < 2; attempt++) {
    if (writable_) InterlockedExchange64(&h->reading, latest);
    else MemoryBarrier();
    // The frame is in slot latest % slots (this producer's rule), or wherever seq == latest (a producer that keeps seq =
    // latest + 1 even when that slot is being read): the first, then a scan.
    CastcadeRingSlot* s = slotAt(base_, slotBytes_, static_cast<uint32_t>(latest % CASTCADE_RING_SLOTS));
    for (uint32_t i = 0; i < CASTCADE_RING_SLOTS && s->seq != latest; i++) s = slotAt(base_, slotBytes_, i);
    if (s->seq != latest) {
      // The producer moved on (or is still writing this one): once more with the newest, then give up this round.
      const int64_t newest = h->latest;
      if (newest != latest && attempt == 0) {
        latest = newest;
        continue;
      }
      lapped_++;
      release();
      return false;
    }
    const uint32_t w = s->width, hgt = s->height, stride = s->stride, format = s->format;
    const bool fits = w >= 1 && hgt >= 1 && w <= maxW_ && hgt <= maxH_ && format == CASTCADE_RING_FORMAT_BGRA && stride >= w * 4 &&
                      static_cast<uint64_t>(stride) * hgt <= static_cast<uint64_t>(slotBytes_) - sizeof(CastcadeRingSlot);
    if (!fits) {
      // Not a frame this consumer can take (the contract: drop it), and never the same one twice.
      release();
      skipped_ += latest - lastSeq_;
      lastSeq_ = latest;
      return false;
    }
    const size_t row = static_cast<size_t>(w) * 4;
    pixels.resize(row * hgt);
    const uint8_t* src = pixelsOf(s);
    if (stride == row) std::memcpy(pixels.data(), src, row * hgt);
    else
      for (uint32_t y = 0; y < hgt; y++) std::memcpy(pixels.data() + row * y, src + static_cast<size_t>(stride) * y, row);
    const int64_t pts = s->ptsUs;
    // The copy done, the slot must still be this frame (a producer that never saw our `reading` may have taken it).
    if (s->seq != latest) {
      const int64_t newest = h->latest;
      if (newest != latest && attempt == 0) {
        latest = newest;
        continue;
      }
      lapped_++;
      release();
      return false;
    }
    release();
    if (lastSeq_ != 0 && latest > lastSeq_ + 1) skipped_ += latest - lastSeq_ - 1;
    lastSeq_ = latest;
    taken_++;
    width = w, height = hgt, ptsUs = pts;
    if (writable_) InterlockedExchange64(&h->consumerAliveUs, ringNowUs());
    return true;
  }
  release();
  return false;
}

bool RingConsumer::wait(uint32_t ms) { return event_ && WaitForSingleObject(static_cast<HANDLE>(event_), ms) == WAIT_OBJECT_0; }

bool RingConsumer::producerAlive() const {
  if (!base_) return false;
  const int64_t at = reinterpret_cast<const CastcadeRingHeader*>(base_)->producerAliveUs;
  return at != 0 && ringNowUs() - at < kRingDeadAfterUs;
}

uint32_t RingConsumer::producerPid() const { return base_ ? reinterpret_cast<const CastcadeRingHeader*>(base_)->producerPid : 0; }

}  // namespace castcade
