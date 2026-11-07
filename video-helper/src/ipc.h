// castcade-video: the stdio side of the protocol (§6.2): one JSON object per line in on stdin (commands), one per line
// out on stdout (events) under one writer lock, log lines on stderr. Nothing binary on these pipes.
#pragma once

#include <mutex>
#include <string>

#include "json.h"

class Ipc {
 public:
  Ipc();
  // Blocks for the next stdin line (CR LF or LF); false at EOF or a broken pipe. Empty lines are skipped.
  bool ReadLine(std::string* line);
  // Writes one event object as a line and flushes.
  void Emit(const Json& event);
  void EmitError(const std::string& code, const std::string& text);
  void EmitLog(const std::string& level, const std::string& text);
  bool stdout_broken() const { return broken_; }

 private:
  std::mutex mu_;
  bool broken_ = false;
};
