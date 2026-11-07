// castcade-video: the few helpers every file needs (clock, the stderr log line, the exe's folder).
#pragma once

#include <cstdint>
#include <string>

#ifndef CASTCADE_VIDEO_VERSION
#define CASTCADE_VIDEO_VERSION "0.0.0"
#endif

// Monotonic microseconds (QueryPerformanceCounter); the ring's ptsUs and every timing here use it.
int64_t NowUs();

// One line to stderr, prefixed "video: " (the companion copies stderr into its log). State changes only: never per frame.
void LogLine(const char* fmt, ...);

// The folder castcade-video.exe runs from (the FFmpeg DLLs sit beside it).
std::string ExeDir();

std::string Utf8FromWide(const wchar_t* w);
std::wstring WideFromUtf8(const std::string& s);
