#include "sdp.h"

#include <cctype>
#include <set>
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

std::string Lower(std::string s) {
  for (auto& c : s) c = static_cast<char>(tolower(static_cast<unsigned char>(c)));
  return s;
}

}  // namespace

std::string AddFmtpExtras(const std::string& sdp, const std::string& codec_name, const std::map<std::string, std::string>& extras) {
  if (extras.empty()) return sdp;
  std::vector<std::string> lines = SplitLines(sdp);
  const std::string want = Lower(codec_name);
  std::set<std::string> pts;
  for (const auto& line : lines) {  // a=rtpmap:<pt> <name>/<clock>
    if (line.rfind("a=rtpmap:", 0) != 0) continue;
    size_t sp = line.find(' ');
    if (sp == std::string::npos) continue;
    const std::string pt = line.substr(9, sp - 9);
    const std::string name = Lower(line.substr(sp + 1, line.find('/', sp) - sp - 1));
    if (name == want) pts.insert(pt);
  }
  if (pts.empty()) return sdp;
  std::string extra;
  for (const auto& kv : extras) extra += ";" + kv.first + "=" + kv.second;

  std::string out;
  for (size_t i = 0; i < lines.size(); ++i) {
    const std::string& line = lines[i];
    if (line.rfind("a=fmtp:", 0) == 0) {
      size_t sp = line.find(' ');
      const std::string pt = sp == std::string::npos ? line.substr(7) : line.substr(7, sp - 7);
      if (pts.count(pt)) {
        out += line + extra + "\r\n";
        continue;
      }
    }
    out += line + "\r\n";
    if (line.rfind("a=rtpmap:", 0) == 0) {  // a payload with no a=fmtp line of its own gets one after its rtpmap
      size_t sp = line.find(' ');
      const std::string pt = line.substr(9, sp - 9);
      if (pts.count(pt)) {
        bool has_fmtp = false;
        for (size_t j = i + 1; j < lines.size() && lines[j].rfind("m=", 0) != 0; ++j)
          if (lines[j].rfind("a=fmtp:" + pt + " ", 0) == 0) has_fmtp = true;
        if (!has_fmtp) out += "a=fmtp:" + pt + " " + extra.substr(1) + "\r\n";
      }
    }
  }
  return out;
}
