// D10.0.1 libwebrtc candidate: the SDP rewrite between the two in-process peers (the shaper routing
// rule): keep ONE host UDP candidate per m-section, replace its port with the shaper port facing the
// side that will consume this SDP (0 = direct loopback, port kept), drop every other candidate.
// Trickle candidates are never exchanged: the SDP is read after gathering completes.
#pragma once

#include <map>
#include <string>

struct SdpRewrite {
  int shaper_port = 0;       // 0 = keep the real port
  std::string codec_name;    // when set with fmtp_extra: codec whose a=fmtp line gets the extras
  std::map<std::string, std::string> fmtp_extra;  // e.g. x-google-start-bitrate
};

struct SdpRewriteResult {
  std::string sdp;
  std::string kept_candidate;  // the a=candidate line that survived (after rewrite), for the log
  int dropped = 0;
};

SdpRewriteResult RewriteSdp(const std::string& sdp, const SdpRewrite& r);
