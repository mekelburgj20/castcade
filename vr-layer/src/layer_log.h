// The layer's log: %LOCALAPPDATA%\Castcade\logs\vr-layer.log (D7.3, 2026-10-31). The only way to see from outside
// that the layer loaded inside VPX and what it did; VPX's own log never mentions API layers.
#pragma once

#include <string>

namespace castcade {

// One line, prefixed with the local time and the process id. Never throws; a log that cannot be written is skipped.
void logLine(const std::string& line);

// `logLine` the first time a given key is seen in this process, nothing after: for faults that repeat every frame.
void logOnce(const std::string& key, const std::string& line);

}  // namespace castcade
