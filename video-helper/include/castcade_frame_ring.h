/* The frame ring between the OpenXR layer (vr-layer/) and the video helper (video-helper/): D10.2 / D10.4, the
 * contract of docs/design/spectator-video-native.md §6.1. A named shared memory section plus a named event, one ring
 * per direction, three slots, newest-wins (a slow consumer skips frames, nothing ever queues).
 *
 *   send ring  layer → helper   the eye the layer scaled into the box (the picture this rig sends)
 *   recv ring  helper → layer   the decoded picture of the player who is up (what theater shows)
 *
 * Names: "Local\\castcade-video-<role>-<token>" for the section and "...-<token>-event" for the event, where <role> is
 * "send" or "recv" and <token> is the string the companion hands both sides (it owns the names; a fresh token per
 * companion start so a stale layer in a running VPX never meets a new helper's ring). The creator (the producer)
 * sizes the section; the consumer opens it read-only and checks magic, version and size before touching a slot.
 *
 * Pixel format v1: BGRA 8-bit, top-down, stride = width * 4 (the layer already produces this for its JPEG path; the
 * helper converts to NV12 with libyuv). NV12 is reserved as format 2 (D10.2.1) and is not produced by anyone yet.
 *
 * Protocol (all fields little-endian, written with release / read with acquire semantics on x64 = plain aligned stores
 * and loads, Interlocked* for the sequence):
 *   - the producer picks a slot that is neither `latest % slots` nor `reading % slots` (with 3 slots one always
 *     exists), writes the pixels, fills the slot's `seq` (= latest + 1), `ptsUs` (QueryPerformanceCounter in µs,
 *     the moment the pixels were captured), `width`/`height` (the frame's own size: it may differ from the header's
 *     when a size change is in flight; a consumer that cannot take the new size drops the frame), then publishes
 *     `latest = seq` and sets the event;
 *   - the consumer reads `latest`, stores `reading = latest`, checks the slot's `seq == latest` (else the producer
 *     lapped it: retry once, then skip), uses the pixels, and when done stores `reading = 0` (0 = not reading);
 *   - a frame whose `seq` is not greater than the last one the consumer used is a repeat (the event was set twice):
 *     skip it;
 *   - `producerAliveUs` is refreshed by the producer every frame and at least every 500 ms while idle; a consumer that
 *     sees it older than 3 s treats the ring as dead (the other side is gone) and tells its owner. */
#ifndef CASTCADE_FRAME_RING_H
#define CASTCADE_FRAME_RING_H
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define CASTCADE_RING_MAGIC 0x31525643u /* "CVR1" as a little-endian u32 */
#define CASTCADE_RING_VERSION 1u
#define CASTCADE_RING_SLOTS 3u
#define CASTCADE_RING_FORMAT_BGRA 1u
#define CASTCADE_RING_FORMAT_NV12 2u /* reserved, D10.2.1 */
#define CASTCADE_RING_MAX_SIDE 4096u
#define CASTCADE_RING_NAME_MAX 128

/* The section starts with this header (one 4 KiB page), then CASTCADE_RING_SLOTS slots of `slotBytes` each, each
 * 4 KiB aligned. `slotBytes` = CastcadeRingSlot (one page) + maxWidth * maxHeight * 4 rounded up to 4 KiB. */
typedef struct CastcadeRingHeader {
  uint32_t magic;        /* CASTCADE_RING_MAGIC */
  uint32_t version;      /* CASTCADE_RING_VERSION */
  uint32_t format;       /* CASTCADE_RING_FORMAT_BGRA */
  uint32_t slots;        /* CASTCADE_RING_SLOTS */
  uint32_t maxWidth;     /* the largest frame a slot holds (the box the companion asked for) */
  uint32_t maxHeight;
  uint32_t slotBytes;    /* bytes from one slot's start to the next */
  uint32_t headerBytes;  /* 4096: where slot 0 starts */
  volatile int64_t latest;          /* seq of the newest published frame; 0 = none yet */
  volatile int64_t reading;         /* seq the consumer is using now; 0 = none */
  volatile int64_t producerAliveUs; /* QPC µs of the producer's last touch */
  volatile int64_t consumerAliveUs; /* QPC µs of the consumer's last touch (informational) */
  uint32_t producerPid;             /* informational, for logs */
  uint32_t consumerPid;
  uint8_t reserved[4096 - 8 * 4 - 8 * 4 - 2 * 4];
} CastcadeRingHeader;

/* One slot: this page, then the pixels (BGRA top-down, stride = width * 4). */
typedef struct CastcadeRingSlot {
  volatile int64_t seq;  /* = header.latest when this slot is the newest; written last before publishing */
  int64_t ptsUs;         /* capture time, QPC µs */
  uint32_t width, height;
  uint32_t stride;       /* bytes per row; width * 4 for BGRA */
  uint32_t format;       /* CASTCADE_RING_FORMAT_* */
  uint8_t reserved[4096 - 8 * 2 - 4 * 4];
} CastcadeRingSlot;

static inline uint32_t castcade_ring_align(uint32_t bytes) { return (bytes + 4095u) & ~4095u; }
static inline uint32_t castcade_ring_slot_bytes(uint32_t maxWidth, uint32_t maxHeight) {
  return castcade_ring_align((uint32_t)sizeof(CastcadeRingSlot) + maxWidth * maxHeight * 4u);
}
static inline uint64_t castcade_ring_section_bytes(uint32_t maxWidth, uint32_t maxHeight) {
  return (uint64_t)sizeof(CastcadeRingHeader) + (uint64_t)CASTCADE_RING_SLOTS * castcade_ring_slot_bytes(maxWidth, maxHeight);
}

#ifdef __cplusplus
}
#endif
#endif
