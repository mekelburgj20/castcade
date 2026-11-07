# castcade-video: the native spectator-video helper (WORK D10.1, ADR 0010; README.md). libwebrtc (LiveKit's prebuilt
# M150, static) + the pinned BtbN FFmpeg shared build (libavcodec NVENC / AMF / QSV / x264, cuvid / D3D11VA) + libyuv
# from the libwebrtc archive. Windows x64, MSVC.
#
#   pwsh video-helper/fetch-webrtc.ps1                    # 114 MB zip → video-helper/deps/webrtc/ (sha256-checked)
#   node video-helper/fetch-ffmpeg.mjs                    # BtbN n8.1 shared → video-helper/deps/ffmpeg/ (sha256-pinned)
#   cmake -S video-helper -B video-helper/build -A x64
#   cmake --build video-helper/build --config Release
#   → video-helper/build/Release/castcade-video.exe + the FFmpeg DLLs it needs + THIRD-PARTY.md
#
cmake_minimum_required(VERSION 3.21)
project(castcade_video VERSION 0.1.0 LANGUAGES CXX)

if(NOT WIN32 OR NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
  message(FATAL_ERROR "castcade-video builds for Windows x64 only")
endif()

# The libwebrtc headers need C++20; the code here is plain C++17 (the audio helper's altitude).
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
# webrtc.lib was built static, non-component, release: every object asks for libcmt.lib (/MT). No VC++ redistributable.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded")

# ---- dependencies ----
set(WEBRTC_DIR "${CMAKE_CURRENT_SOURCE_DIR}/deps/webrtc/webrtc-win-x64-release/win-x64-release"
    CACHE PATH "Root of the extracted LiveKit libwebrtc prebuilt (holds include/, lib/webrtc.lib, webrtc.ninja)")
if(NOT EXISTS "${WEBRTC_DIR}/lib/webrtc.lib")
  message(FATAL_ERROR "libwebrtc prebuilt not found at ${WEBRTC_DIR}: run pwsh video-helper/fetch-webrtc.ps1")
endif()
set(FFMPEG_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/deps/ffmpeg" CACHE PATH "BtbN ffmpeg shared build (bin/ include/ lib/)")
if(NOT EXISTS "${FFMPEG_ROOT}/include/libavcodec/avcodec.h")
  message(FATAL_ERROR "FFmpeg not found at ${FFMPEG_ROOT}: run node video-helper/fetch-ffmpeg.mjs")
endif()

# The preprocessor defines the library was compiled with are the first line of webrtc.ninja ("defines = -DWEBRTC_WIN
# -DNOMINMAX ..."). Compile against the same set so the headers describe the same ABI (what LiveKit's webrtc-sys
# build.rs does).
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

# ---- the exe ----
add_executable(castcade-video
  src/main.cpp
  src/session.cpp
  src/ipc.cpp
  src/json.cpp
  src/util.cpp
  src/codecs.cpp
  src/gpu.cpp
  src/frame_ring.cpp
  src/source.cpp
  src/source_wgc.cpp
  src/sink.cpp
  src/sink_window.cpp
  src/factories.cpp
  src/sdp.cpp
  src/peer.cpp
  src/bench.cpp
  src/selftest.cpp)

target_include_directories(castcade-video PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}/src"
  "${CMAKE_CURRENT_SOURCE_DIR}/include"
  "${FFMPEG_ROOT}/include"
  "${WEBRTC_DIR}/include"
  "${WEBRTC_DIR}/include/third_party/abseil-cpp"
  "${WEBRTC_DIR}/include/third_party/libyuv/include")

target_compile_definitions(castcade-video PRIVATE ${WEBRTC_DEFINES}
  "CASTCADE_VIDEO_VERSION=\"${PROJECT_VERSION}\"")

# CMake's default /EHsc would only draw a D9025 "overriding" warning next to /EHs-c-.
string(REPLACE "/EHsc" "" CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS}")
# Chromium's Windows toolchain shape: no C++ exceptions (_HAS_EXCEPTIONS=0 is in the defines), no RTTI, big objects
# (the peer connection headers are large), UTF-8 sources. Silenced: C4244/C4267/C4996 (ours), C4530 (the MSVC STL has
# `try` in <chrono>/<xstring> even with _HAS_EXCEPTIONS=0), C4068 (`#pragma clang` in a few headers), C4146 (upstream's
# divide_round.h).
target_compile_options(castcade-video PRIVATE
  /EHs-c- /GR- /bigobj /utf-8 /W3 /Zc:__cplusplus /permissive-
  /wd4244 /wd4267 /wd4996 /wd4530 /wd4068 /wd4146
  "$<$<CONFIG:Release>:/O2>")
target_link_options(castcade-video PRIVATE "$<$<CONFIG:Release>:/OPT:REF;/OPT:ICF>")

# The FFmpeg import libraries go BEFORE webrtc.lib: libwebrtc carries Chromium's own (decoder-only, LGPL) ffmpeg objects
# with the same symbol names, and the linker takes the first library that defines a symbol. With this order our
# av* calls bind to the DLLs beside the exe (codecs.cpp checks the loaded version at start); libwebrtc's internal
# H.264 decoder is never referenced, so its ffmpeg objects stay out of the link.
target_link_libraries(castcade-video PRIVATE
  "${FFMPEG_ROOT}/lib/avcodec.lib" "${FFMPEG_ROOT}/lib/avutil.lib" "${FFMPEG_ROOT}/lib/swscale.lib"
  "${WEBRTC_DIR}/lib/webrtc.lib"
  ws2_32 winmm secur32 iphlpapi crypt32 ole32 oleaut32 uuid
  dmoguids wmcodecdspuuid msdmo strmiids
  d3d11 dxgi d3dcompiler dwmapi shcore gdi32 user32 advapi32 shell32 avrt dbghelp
  # D10.6: Windows Graphics Capture through the WinRT ABI (RoGetActivationFactory, HSTRING; the SDK's umbrella lib).
  windowsapp)

set_target_properties(castcade-video PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}/Release"
  RUNTIME_OUTPUT_DIRECTORY_DEBUG "${CMAKE_BINARY_DIR}/Debug")

# The FFmpeg DLLs the exe imports (avcodec-62 pulls swresample-6 itself), copied beside it after every build:
# avcodec-62.dll avutil-60.dll swscale-9.dll swresample-6.dll (the exact names come from deps/ffmpeg/bin).
file(GLOB FFMPEG_DLLS "${FFMPEG_ROOT}/bin/avcodec-*.dll" "${FFMPEG_ROOT}/bin/avutil-*.dll"
  "${FFMPEG_ROOT}/bin/swscale-*.dll" "${FFMPEG_ROOT}/bin/swresample-*.dll")
list(LENGTH FFMPEG_DLLS n_dlls)
if(NOT n_dlls EQUAL 4)
  message(FATAL_ERROR "expected 4 FFmpeg DLLs in ${FFMPEG_ROOT}/bin, found: ${FFMPEG_DLLS}")
endif()
add_custom_command(TARGET castcade-video POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_if_different ${FFMPEG_DLLS} $<TARGET_FILE_DIR:castcade-video>
  COMMAND ${CMAKE_COMMAND} -E copy_if_different "${CMAKE_BINARY_DIR}/THIRD-PARTY.md" $<TARGET_FILE_DIR:castcade-video>
  COMMENT "copying the FFmpeg DLLs and THIRD-PARTY.md next to castcade-video.exe")

# ---- THIRD-PARTY.md: what ships beside the exe and under which licence ----
# libwebrtc (BSD) and its third parties as the LiveKit zip's LICENSE.md lists them (libyuv among them); FFmpeg (GPL,
# the BtbN build identified by its own version string in libavutil/ffversion.h).
file(STRINGS "${FFMPEG_ROOT}/include/libavutil/ffversion.h" FFVERSION_LINE REGEX "FFMPEG_VERSION")
string(REGEX REPLACE ".*\"([^\"]+)\".*" "\\1" FFMPEG_VERSION_STRING "${FFVERSION_LINE}")
file(STRINGS "${WEBRTC_DIR}/LICENSE.md" WEBRTC_LICENSE_HEADINGS REGEX "^# ")
set(WEBRTC_COMPONENTS "")
foreach(h IN LISTS WEBRTC_LICENSE_HEADINGS)
  string(SUBSTRING "${h}" 2 -1 name)
  string(APPEND WEBRTC_COMPONENTS "- ${name}\n")
endforeach()
file(READ "${WEBRTC_DIR}/LICENSE.md" WEBRTC_LICENSE_TEXT)
file(READ "${FFMPEG_ROOT}/LICENSE.txt" FFMPEG_LICENSE_TEXT)
set(THIRD_PARTY_MD "# castcade-video ${PROJECT_VERSION}: third-party notices

`castcade-video.exe` is part of Castcade (GPLv3, https://github.com/mekelburgj20/castcade). It links and ships the
following. Nothing from VPX, VPinMAME, RetroArch, any ROM or any table is in it.

## libwebrtc (statically linked)

Google's WebRTC library, M150, as prebuilt by LiveKit: `webrtc-win-x64-release.zip` from the `livekit/rust-sdks`
release `webrtc-a545de4` (sha256 862403fcb248c7d8803487e4c22b8821c6130e89100cb9c69be95ef45ff46146;
`video-helper/fetch-webrtc.ps1`). BSD 3-Clause. Its `LICENSE.md` lists the components below; the complete text of
that file follows at the end of this document. libyuv (BSD) from the same archive provides the BGRA / NV12 conversions.

${WEBRTC_COMPONENTS}
## FFmpeg (shared DLLs beside the exe: avcodec-62, avutil-60, swscale-9, swresample-6)

BtbN's build `ffmpeg-n8.1-latest-win64-gpl-shared-8.1.zip` (https://github.com/BtbN/FFmpeg-Builds), version
string `${FFMPEG_VERSION_STRING}`, sha256 pinned in `video-helper/ffmpeg.sha256`. Licensed under the GNU General
Public License version 3 (a GPL build: it includes libx264). Castcade is GPLv3 and offers the Corresponding Source
of this build as of its releases (E5, `docs/ffmpeg-source.md`). The hardware encoders and decoders (h264_nvenc,
h264_amf, h264_qsv, h264_cuvid, D3D11VA) load the GPU vendor's driver libraries at run time; no vendor SDK is bundled.

The FFmpeg build's LICENSE.txt:

```
${FFMPEG_LICENSE_TEXT}
```

## The libwebrtc archive's LICENSE.md, in full

${WEBRTC_LICENSE_TEXT}
")
file(WRITE "${CMAKE_BINARY_DIR}/THIRD-PARTY.md" "${THIRD_PARTY_MD}")
message(STATUS "castcade-video ${PROJECT_VERSION}: FFmpeg ${FFMPEG_VERSION_STRING}, THIRD-PARTY.md written")
