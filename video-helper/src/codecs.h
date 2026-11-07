// castcade-video: the libavcodec encoder and decoder (the D10.0.1 harness's, lifted) and the start-up probe.
// Encoder order h264_nvenc → h264_amf → h264_qsv → libx264; decoder order h264_cuvid → d3d11va → h264 (software).
// Low-latency settings: CBR, 50 ms VBV, no B-frames, in-band SPS/PPS on every IDR, IDR on request only. Output is
// Annex B; libwebrtc's packetizer splits the NAL units (packetization mode 1).
#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>

// D10.1.1: how a new target bitrate reaches the encoder. libavcodec's h264_nvenc costs an IDR on every applied
// change (measured by `--bench`), so the default limits how often one is applied.
enum class RatePolicy {
  kLimited,  // apply when the target differs >= 10 % from the applied rate, at most once a second; a drop >= 30 % at once
  kNaive,    // apply every change as it comes (what the spike did; the bench's comparison baseline)
};
const char* RatePolicyName(RatePolicy p);
bool ParseRatePolicy(const std::string& s, RatePolicy* out);

struct EncoderConfig {
  int width = 1354, height = 1440, fps = 60;
  int kbps = 8000;              // the initial target
  std::string force;            // "" = probe the order; else one libavcodec encoder name
  RatePolicy policy = RatePolicy::kLimited;
};

class Encoder {
 public:
  static std::unique_ptr<Encoder> Open(const EncoderConfig& cfg, std::string* error);
  ~Encoder();

  const std::string& name() const { return name_; }
  int width() const { return cfg_.width; }
  int height() const { return cfg_.height; }

  // Encodes one NV12 frame given as its two planes. On success returns 0 and points *out at an Annex B access
  // unit owned by the encoder until the next call; 1 = buffered (zero-latency settings: should not happen); < 0 error.
  int Encode(const uint8_t* y, int stride_y, const uint8_t* uv, int stride_uv, uint64_t pts_90k,
             const uint8_t** out, size_t* out_size, bool* keyframe);
  void RequestKeyframe() { want_idr_ = true; }

  // The wanted target from the stack. Returns true when the policy applied it to the encoder in this call.
  bool SetTargetKbps(int kbps, int64_t now_us);
  int applied_kbps() const { return applied_kbps_; }
  int wanted_kbps() const { return wanted_kbps_; }

  int64_t last_cost_us() const { return last_cost_us_; }
  int64_t idr_count() const { return idr_count_; }
  int64_t rate_changes_applied() const { return rate_changes_; }

 private:
  Encoder() = default;
  bool OpenContext(const std::string& name, int kbps);
  bool ApplyRate(int kbps, int64_t now_us);

  EncoderConfig cfg_;
  std::string name_;
  struct AVCodecContext* ctx_ = nullptr;
  struct AVFrame* frame_ = nullptr;
  struct AVPacket* pkt_ = nullptr;
  std::string out_;  // used only when SPS/PPS had to be prepended
  bool want_idr_ = true;
  int64_t last_cost_us_ = 0;
  int applied_kbps_ = 0, wanted_kbps_ = 0, pending_reopen_kbps_ = 0;
  int64_t last_apply_us_ = 0;
  int64_t idr_count_ = 0, rate_changes_ = 0;
};

// One decoded picture as libavcodec hands it over (after the hardware → system copy for cuvid / d3d11va).
struct DecodedPicture {
  int width = 0, height = 0;
  bool nv12 = true;                     // else I420 (the software decoder)
  const uint8_t* y = nullptr;
  const uint8_t* uv = nullptr;          // NV12: interleaved UV; I420: U
  const uint8_t* v = nullptr;           // I420 only
  int stride_y = 0, stride_uv = 0, stride_v = 0;
  int64_t pts_90k = 0;
};

class Decoder {
 public:
  static std::unique_ptr<Decoder> Open(const std::string& force, std::string* error);
  ~Decoder();
  const std::string& name() const { return name_; }

  // Feeds one Annex B access unit (nullptr, 0 = flush) and calls on_picture for every picture that comes out.
  // Returns the number of pictures, < 0 on error.
  int Decode(const uint8_t* annexb, size_t size, int64_t pts_90k,
             const std::function<void(const DecodedPicture&)>& on_picture);
  int64_t last_cost_us() const { return last_cost_us_; }

 private:
  Decoder() = default;
  bool OpenContext(const std::string& which);

  std::string name_;
  struct AVCodecContext* ctx_ = nullptr;
  struct AVBufferRef* hw_ = nullptr;
  struct AVFrame* frame_ = nullptr;
  struct AVFrame* sw_ = nullptr;
  struct AVPacket* pkt_ = nullptr;
  int64_t last_cost_us_ = 0;
};

// Opens each candidate in order at the given size (a real session: NVENC / AMF / QSV fail where the GPU is
// absent) and closes it again; the first that opened on each side is the choice. Logs one line per candidate.
struct ProbeResult {
  std::string encoder;  // "" when nothing opened
  std::string decoder;
};
ProbeResult ProbeCodecs(int width, int height, int fps);

// libavcodec's logging to our stderr (warnings and errors only).
void InstallAvLog();
// True when the libavcodec the calls reach is the build the exe was compiled against (and knows libx264).
bool CheckAvLinked(std::string* detail);
