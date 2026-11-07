# D10.0.1 spike harness: castcade_spike_harness.dll (+ import lib) and spike_bench.exe, against the pinned
# BtbN FFmpeg shared build in ../deps/ffmpeg (node harness/fetch-ffmpeg.mjs puts it there).
#
#   node spike/d10-video/harness/fetch-ffmpeg.mjs
#   cmake -S spike/d10-video/harness -B spike/d10-video/harness/build -A x64
#   cmake --build spike/d10-video/harness/build --config Release
#   spike\d10-video\harness\build\Release\spike_bench.exe
#
# Windows x64, MSVC. The needed FFmpeg dlls are copied next to the harness dll after each build.
cmake_minimum_required(VERSION 3.20)
project(castcade_spike_harness LANGUAGES CXX)

if(NOT WIN32 OR NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
  message(FATAL_ERROR "the spike harness builds for Windows x64 only")
endif()

set(FFMPEG_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../deps/ffmpeg" CACHE PATH "BtbN ffmpeg shared build (bin/ include/ lib/)")
if(NOT EXISTS "${FFMPEG_ROOT}/include/libavcodec/avcodec.h")
  message(FATAL_ERROR "FFmpeg not found at ${FFMPEG_ROOT}: run node spike/d10-video/harness/fetch-ffmpeg.mjs")
endif()

add_library(castcade_spike_harness SHARED src/harness.cpp)
target_include_directories(castcade_spike_harness PUBLIC include PRIVATE "${FFMPEG_ROOT}/include")
target_compile_features(castcade_spike_harness PRIVATE cxx_std_17)
target_compile_options(castcade_spike_harness PRIVATE /W3 /O2)
target_link_libraries(castcade_spike_harness PRIVATE
  "${FFMPEG_ROOT}/lib/avcodec.lib" "${FFMPEG_ROOT}/lib/avutil.lib" "${FFMPEG_ROOT}/lib/swscale.lib")

# avcodec-62 imports swresample-6 too; the five dlls together are what the harness needs at run time.
file(GLOB FFMPEG_DLLS "${FFMPEG_ROOT}/bin/avcodec-*.dll" "${FFMPEG_ROOT}/bin/avutil-*.dll"
  "${FFMPEG_ROOT}/bin/swscale-*.dll" "${FFMPEG_ROOT}/bin/swresample-*.dll")
add_custom_command(TARGET castcade_spike_harness POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_if_different ${FFMPEG_DLLS} $<TARGET_FILE_DIR:castcade_spike_harness>
  COMMENT "copying FFmpeg dlls next to the harness")

add_executable(spike_bench bench.cpp)
target_compile_features(spike_bench PRIVATE cxx_std_17)
target_link_libraries(spike_bench PRIVATE castcade_spike_harness)
