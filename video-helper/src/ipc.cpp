#include "ipc.h"

#include <fcntl.h>
#include <io.h>

#include <cstdio>

Ipc::Ipc() {
  // Binary stdout: no CR LF translation (the companion splits on LF), and a line never splits across writes.
  _setmode(_fileno(stdout), _O_BINARY);
  _setmode(_fileno(stdin), _O_BINARY);
  setvbuf(stdout, nullptr, _IOFBF, 1 << 16);
}

bool Ipc::ReadLine(std::string* line) {
  for (;;) {
    line->clear();
    int c;
    bool any = false;
    while ((c = fgetc(stdin)) != EOF) {
      any = true;
      if (c == '\n') break;
      line->push_back(static_cast<char>(c));
      if (line->size() > 1 << 20) break;  // not our stream: drop it
    }
    if (!any && c == EOF) return false;
    while (!line->empty() && (line->back() == '\r' || line->back() == ' ' || line->back() == '\t')) line->pop_back();
    if (!line->empty()) return true;
    if (c == EOF) return false;
  }
}

void Ipc::Emit(const Json& event) {
  const std::string s = event.Dump() + "\n";
  std::lock_guard<std::mutex> l(mu_);
  if (broken_) return;
  if (fwrite(s.data(), 1, s.size(), stdout) != s.size() || fflush(stdout) != 0) broken_ = true;
}

void Ipc::EmitError(const std::string& code, const std::string& text) {
  Json j = Json::Object();
  j.Set("event", Json::String("error")).Set("code", Json::String(code)).Set("text", Json::String(text));
  Emit(j);
}

void Ipc::EmitLog(const std::string& level, const std::string& text) {
  Json j = Json::Object();
  j.Set("event", Json::String("log")).Set("level", Json::String(level)).Set("text", Json::String(text));
  Emit(j);
}
