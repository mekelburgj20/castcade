#include "sdp.h"

#include <cctype>
#include <set>
#include <sstream>
#include <vector>

namespace {

std::vector<std::string> SplitLines(const std::string& s) {
  std::vector<std::string> out;
  size_t start = 0;
  while (start < s.size()) {
    size_t nl = s.find('\n', start);
    std::string line = s.substr(start, nl == std::string::npos ? std::string::npos : nl - start);
    if (!line.empty() && line.back() == '\r') line.pop_back();
    out.push_back(line);
    if (nl == std::string::npos) break;
    start = nl + 1;
  }
  return out;
}

std::vector<std::string> Tokens(const std::string& line) {
  std::vector<std::string> t;
  std::istringstream is(line);
  std::string w;
  while (is >> w) t.push_back(w);
  return t;
}

std::string Lower(std::string s) {
  for (auto& c : s) c = static_cast<char>(tolower(static_cast<unsigned char>(c)));
  return s;
}

}  // namespace

SdpRewriteResult RewriteSdp(const std::string& sdp, const SdpRewrite& r) {
  SdpRewriteResult res;
  std::vector<std::string> lines = SplitLines(sdp);
  std::set<std::string> codec_pts;
  const std::string want_codec = Lower(r.codec_name);
  // Pass 1: payload types of the codec the fmtp extras apply to.
  if (!want_codec.empty() && !r.fmtp_extra.empty()) {
    for (const auto& line : lines) {
      if (line.rfind("a=rtpmap:", 0) != 0) continue;
      // a=rtpmap:<pt> <name>/<clock>
      size_t sp = line.find(' ');
      if (sp == std::string::npos) continue;
      std::string pt = line.substr(9, sp - 9);
      std::string name = Lower(line.substr(sp + 1, line.find('/', sp) - sp - 1));
      if (name == want_codec) codec_pts.insert(pt);
    }
  }
  std::set<std::string> pts_with_fmtp;
  std::string extras;
  for (const auto& kv : r.fmtp_extra) extras += ";" + kv.first + "=" + kv.second;

  std::string out;
  bool kept_in_section = false;
  for (size_t i = 0; i < lines.size(); ++i) {
    const std::string& line = lines[i];
    if (line.rfind("m=", 0) == 0) kept_in_section = false;
    if (line.rfind("a=candidate:", 0) == 0) {
      // a=candidate:<foundation> <component> <proto> <priority> <ip> <port> typ <type> ...
      std::vector<std::string> t = Tokens(line);
      bool host_udp = t.size() >= 8 && t[1] == "1" && Lower(t[2]) == "udp" && t[6] == "typ" &&
                      t[7] == "host";
      if (!host_udp || kept_in_section) {
        res.dropped++;
        continue;
      }
      kept_in_section = true;
      if (r.shaper_port > 0) t[5] = std::to_string(r.shaper_port);
      std::string rebuilt;
      for (size_t k = 0; k < t.size(); ++k) rebuilt += (k ? " " : "") + t[k];
      res.kept_candidate = rebuilt;
      out += rebuilt + "\r\n";
      continue;
    }
    if (!codec_pts.empty() && line.rfind("a=fmtp:", 0) == 0) {
      size_t sp = line.find(' ');
      std::string pt = sp == std::string::npos ? line.substr(7) : line.substr(7, sp - 7);
      if (codec_pts.count(pt)) {
        pts_with_fmtp.insert(pt);
        out += line + extras + "\r\n";
        continue;
      }
    }
    out += line + "\r\n";
    // A codec with no a=fmtp line of its own gets one right after its rtpmap.
    if (!codec_pts.empty() && line.rfind("a=rtpmap:", 0) == 0) {
      size_t sp = line.find(' ');
      std::string pt = line.substr(9, sp - 9);
      if (codec_pts.count(pt)) {
        bool has_fmtp = false;
        for (size_t j = i + 1; j < lines.size() && lines[j].rfind("m=", 0) != 0; ++j) {
          if (lines[j].rfind("a=fmtp:" + pt + " ", 0) == 0) has_fmtp = true;
        }
        if (!has_fmtp) out += "a=fmtp:" + pt + " " + extras.substr(1) + "\r\n";
      }
    }
  }
  res.sdp = out;
  return res;
}
