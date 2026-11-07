/* D10.0.1 spike harness: the ONE frame source and the ONE encoder every candidate uses, so the
 * comparison measures the WebRTC stack and nothing else. C ABI, built as castcade_spike_harness.dll
 * against the pinned FFmpeg shared build (BtbN ffmpeg-n8.1-latest-win64-gpl-shared-8.1.zip).
 * Scratch code: not shipped (WORK D10.0.1, docs/design/spectator-video-native.md §3a). */
#ifndef CASTCADE_SPIKE_HARNESS_H
#define CASTCADE_SPIKE_HARNESS_H
#include <stdint.h>
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif
#ifdef SPIKE_HARNESS_EXPORTS
#define SPIKE_API __declspec(dllexport)
#else
#define SPIKE_API __declspec(dllimport)
#endif

/* ---- Frame source: deterministic synthetic playfield, NV12, 1354x1440 by default ----
 * Frame n is a function of n alone (every candidate sees the same pixels): a scrolling grid, a bouncing
 * bright "ball" (fast motion), a noise block that costs real bits, and a frame counter burned in as a
 * 16-bit binary strip in the top-left (the receiver's decoder can read it back to measure glass to glass). */
typedef struct spike_source spike_source;
SPIKE_API spike_source* spike_source_open(int width, int height);
/* Fills dst with frame n. Returns the NV12 byte count written (width*height*3/2). dst_stride_y == width. */
SPIKE_API size_t spike_source_frame(spike_source*, uint64_t n, uint8_t* dst, size_t dst_size);
SPIKE_API void spike_source_close(spike_source*);

/* ---- Encoder: libavcodec, probed in order h264_nvenc → h264_amf → h264_qsv → libx264 ----
 * Low-latency settings (zerolatency / ll tune, CBR, no B-frames, repeated SPS/PPS, IDR on demand).
 * Output is Annex B (start codes); candidates packetize it themselves or hand it to their stack. */
typedef struct spike_encoder spike_encoder;
typedef struct {
  int width, height, fps;
  int bitrate_kbps;          /* initial target; spike_encoder_set_bitrate changes it live */
  int gop_frames;            /* 0 = infinite (IDR only on request); the spike uses 0 */
  const char* force;         /* NULL = probe; else an encoder name to force, e.g. "libx264" */
} spike_encoder_config;
SPIKE_API spike_encoder* spike_encoder_open(const spike_encoder_config*);
/* The libavcodec encoder name actually opened ("h264_nvenc", ...). Valid while the encoder is open. */
SPIKE_API const char* spike_encoder_name(spike_encoder*);
/* Encodes one NV12 frame. pts_90k is the RTP-style 90 kHz timestamp. On success *out points at an
 * Annex B access unit owned by the encoder until the next call; *out_size its length; *keyframe 1 for IDR.
 * Returns 0 on success, <0 on error, 1 if the encoder buffered the frame (should not happen: zero latency). */
SPIKE_API int spike_encoder_encode(spike_encoder*, const uint8_t* nv12, uint64_t pts_90k,
                                   const uint8_t** out, size_t* out_size, int* keyframe);
SPIKE_API int spike_encoder_set_bitrate(spike_encoder*, int kbps);
SPIKE_API int spike_encoder_request_keyframe(spike_encoder*);
/* Microseconds the last spike_encoder_encode spent inside avcodec (encode cost, not transport). */
SPIKE_API int64_t spike_encoder_last_cost_us(spike_encoder*);
SPIKE_API void spike_encoder_close(spike_encoder*);

/* ---- Decoder (receiver side): h264_cuvid → d3d11va → h264 software; NV12 out ----
 * Used to count delivered frames and read the burned-in counter; a candidate may instead count complete
 * access units from its depacketizer and skip decoding, saying so in its results. */
typedef struct spike_decoder spike_decoder;
SPIKE_API spike_decoder* spike_decoder_open(const char* force /* NULL = probe */);
SPIKE_API const char* spike_decoder_name(spike_decoder*);
/* Feeds one Annex B access unit; on a decoded picture returns 1 and fills *frame_counter from the strip
 * (or -1 if unreadable); 0 if nothing came out yet; <0 on error. */
SPIKE_API int spike_decoder_decode(spike_decoder*, const uint8_t* annexb, size_t size, int64_t* frame_counter);
SPIKE_API void spike_decoder_close(spike_decoder*);

/* ---- Clock ---- monotonic microseconds, the same clock every candidate stamps with. */
SPIKE_API int64_t spike_now_us(void);

#ifdef __cplusplus
}
#endif
#endif
