#include "util.h"

#include <windows.h>

#include <cstdarg>
#include <cstdio>
#include <mutex>

int64_t NowUs() {
  static const LARGE_INTEGER freq = [] {
    LARGE_INTEGER f;
    QueryPerformanceFrequency(&f);
    return f;
  }();
  LARGE_INTEGER c;
  QueryPerformanceCounter(&c);
  // Split to keep the microsecond exact for days of uptime.
  return (c.QuadPart / freq.QuadPart) * 1000000 + (c.QuadPart % freq.QuadPart) * 1000000 / freq.QuadPart;
}

void LogLine(const char* fmt, ...) {
  static std::mutex mu;
  char buf[2048];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(buf, sizeof buf, fmt, ap);
  va_end(ap);
  std::lock_guard<std::mutex> l(mu);
  fprintf(stderr, "video: %s\n", buf);
  fflush(stderr);
}

std::string ExeDir() {
  wchar_t buf[MAX_PATH];
  DWORD n = GetModuleFileNameW(nullptr, buf, MAX_PATH);
  std::string p = Utf8FromWide(std::wstring(buf, n).c_str());
  size_t slash = p.find_last_of("\\/");
  return slash == std::string::npos ? "." : p.substr(0, slash);
}

std::string Utf8FromWide(const wchar_t* w) {
  if (!w || !*w) return "";
  int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
  std::string s(n > 0 ? n - 1 : 0, '\0');
  if (n > 1) WideCharToMultiByte(CP_UTF8, 0, w, -1, &s[0], n, nullptr, nullptr);
  return s;
}

std::wstring WideFromUtf8(const std::string& s) {
  if (s.empty()) return L"";
  int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, nullptr, 0);
  std::wstring w(n > 0 ? n - 1 : 0, L'\0');
  if (n > 1) MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, &w[0], n);
  return w;
}
