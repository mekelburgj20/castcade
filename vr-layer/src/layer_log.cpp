// See layer_log.h. One live file plus one `.1` backup, rotated at 1 MB, like the companion's own log (main/log.ts).
#include "layer_log.h"

#include <windows.h>

#include <cstdio>
#include <mutex>
#include <set>
#include <string>

namespace castcade {
namespace {

constexpr DWORD kMaxBytes = 1u << 20;

std::mutex& logMutex() {
  static std::mutex m;
  return m;
}

// %LOCALAPPDATA%\Castcade\logs (created on first use); empty when LOCALAPPDATA is unset.
std::wstring logDir() {
  wchar_t buf[MAX_PATH];
  const DWORD n = GetEnvironmentVariableW(L"LOCALAPPDATA", buf, MAX_PATH);
  if (n == 0 || n >= MAX_PATH) return {};
  std::wstring dir(buf, n);
  dir += L"\\Castcade";
  CreateDirectoryW(dir.c_str(), nullptr);  // ERROR_ALREADY_EXISTS is fine
  dir += L"\\logs";
  CreateDirectoryW(dir.c_str(), nullptr);
  return dir;
}

void writeLocked(const std::string& text) {
  static const std::wstring dir = logDir();
  if (dir.empty()) return;
  const std::wstring file = dir + L"\\vr-layer.log";
  WIN32_FILE_ATTRIBUTE_DATA fa{};
  if (GetFileAttributesExW(file.c_str(), GetFileExInfoStandard, &fa) && (fa.nFileSizeHigh != 0 || fa.nFileSizeLow >= kMaxBytes)) {
    MoveFileExW(file.c_str(), (file + L".1").c_str(), MOVEFILE_REPLACE_EXISTING);
  }
  // Opened per line: VPX may run for hours, and a held handle would keep the companion from rotating or reading it.
  const HANDLE h = CreateFileW(file.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
                               OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (h == INVALID_HANDLE_VALUE) return;
  DWORD wrote = 0;
  WriteFile(h, text.data(), static_cast<DWORD>(text.size()), &wrote, nullptr);
  CloseHandle(h);
}

}  // namespace

void logLine(const std::string& line) {
  try {
    SYSTEMTIME t{};
    GetLocalTime(&t);
    char prefix[64];
    std::snprintf(prefix, sizeof prefix, "%04u-%02u-%02u %02u:%02u:%02u.%03u [%lu] ", t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute,
                  t.wSecond, t.wMilliseconds, GetCurrentProcessId());
    std::lock_guard<std::mutex> lk(logMutex());
    writeLocked(prefix + line + "\r\n");
  } catch (...) {
    // A log line is never worth a fault inside VPX.
  }
}

void logOnce(const std::string& key, const std::string& line) {
  try {
    static std::mutex m;
    static std::set<std::string> seen;
    {
      std::lock_guard<std::mutex> lk(m);
      if (!seen.insert(key).second) return;
    }
    logLine(line);
  } catch (...) {
  }
}

}  // namespace castcade
