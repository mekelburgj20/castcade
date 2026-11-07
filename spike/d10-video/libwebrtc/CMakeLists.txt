# D10.0.1 spike, the libwebrtc candidate (rung 1, C++): sender + receiver loopback on LiveKit's
# prebuilt libwebrtc with the harness encoder plugged in as a VideoEncoderFactory. Scratch code: nothing
# here ships (docs/design/spectator-video-native.md §3a). See NOTES.md for the asset, flags and findings.
#
#   cmake -S spike/d10-video/libwebrtc -B spike/d10-video/libwebrtc/build -A x64
#   cmake --build spike/d10-video/libwebrtc/build --config Release
#
cmake_minimum_required(VERSION 3.21)
project(castcade_spike_libwebrtc LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
# webrtc.lib was built static, non-component, release: every object asks for libcmt.lib (/MT).
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded")

# The LiveKit prebuilt (webrtc-win-x64-release.zip from livekit/rust-sdks release webrtc-a545de4),
# extracted into deps/webrtc/webrtc-win-x64-release/ by the fetch step in NOTES.md.
set(WEBRTC_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../deps/webrtc/webrtc-win-x64-release/win-x64-release"
    CACHE PATH "Root of the extracted LiveKit libwebrtc prebuilt (holds include/, lib/webrtc.lib, webrtc.ninja)")
if(NOT EXISTS "${WEBRTC_DIR}/lib/webrtc.lib")
  message(FATAL_ERROR "libwebrtc prebuilt not found at ${WEBRTC_DIR} (see NOTES.md, 'Fetch').")
endif()

# The preprocessor defines the library was compiled with are the first line of webrtc.ninja
# ("defines = -DWEBRTC_WIN -DNOMINMAX ..."). Compile against the same set so the headers describe the
# same ABI (this is exactly what LiveKit's webrtc-sys build.rs does).
file(STRINGS "${WEBRTC_DIR}/webrtc.ninja" WEBRTC_DEFINES_LINE REGEX "^defines = " LIMIT_COUNT 1)
string(REGEX MATCHALL "-D[A-Za-z_][A-Za-z0-9_]*(=[^ \"]+)?" WEBRTC_DEFINE_FLAGS "${WEBRTC_DEFINES_LINE}")
set(WEBRTC_DEFINES "")
foreach(flag IN LISTS WEBRTC_DEFINE_FLAGS)
  string(SUBSTRING "${flag}" 2 -1 def)
  if(def MATCHES "^CR_CLANG_REVISION")
    continue()
  endif()
  list(APPEND WEBRTC_DEFINES "${def}")
endforeach()
list(LENGTH WEBRTC_DEFINES n_defines)
message(STATUS "libwebrtc: ${n_defines} defines read from webrtc.ninja")

add_executable(spike-libwebrtc
  src/main.cpp
  src/harness.cpp
  src/codecs.cpp
  src/peer.cpp
  src/sdp.cpp)

target_include_directories(spike-libwebrtc PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}/src"
  "${CMAKE_CURRENT_SOURCE_DIR}/../harness/include"
  "${WEBRTC_DIR}/include"
  "${WEBRTC_DIR}/include/third_party/abseil-cpp"
  "${WEBRTC_DIR}/include/third_party/libyuv/include")

target_compile_definitions(spike-libwebrtc PRIVATE ${WEBRTC_DEFINES})

# Mirror Chromium's Windows toolchain shape: no C++ exceptions (_HAS_EXCEPTIONS=0 is in the defines),
# no RTTI, big objects (the peer connection headers are large), UTF-8 sources.
target_compile_options(spike-libwebrtc PRIVATE
  /EHs-c- /GR- /bigobj /utf-8 /W3 /Zc:__cplusplus /permissive-
  /wd4244 /wd4267 /wd4996 /wd4530 /wd4068)

target_link_libraries(spike-libwebrtc PRIVATE
  "${WEBRTC_DIR}/lib/webrtc.lib"
  ws2_32 winmm secur32 iphlpapi crypt32 ole32 oleaut32 uuid
  dmoguids wmcodecdspuuid msdmo strmiids
  d3d11 dxgi dwmapi shcore gdi32 user32 advapi32 shell32 avrt dbghelp)

set_target_properties(spike-libwebrtc PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}/Release"
  RUNTIME_OUTPUT_DIRECTORY_DEBUG "${CMAKE_BINARY_DIR}/Debug")
