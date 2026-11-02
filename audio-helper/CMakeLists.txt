# castcade-audio: table sound for a Castcade match (D2.8): mutes this rig's VPX while another player is up and captures
# its sound (process loopback) while this rig is up (audio-helper/README.md).
#
#   cmake -B build -A x64                       (any Visual Studio generator; x64)
#   cmake --build build --config Release        → build/Release/castcade-audio.exe
#
# Windows x64, MSVC, no dependency but the Windows SDK (CoreAudio). Process loopback needs Windows 10 2004+ at run
# time only: ActivateAudioInterfaceAsync is looked up at run time, so the exe starts (and mutes) on older Windows.
cmake_minimum_required(VERSION 3.20)
project(castcade_audio VERSION 0.1.0 LANGUAGES CXX)

if(NOT WIN32 OR NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
  message(FATAL_ERROR "castcade-audio builds for Windows x64 only")
endif()

# Static CRT (/MT): the helper ships without the VC++ redistributable. Set before any target exists.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

add_executable(castcade-audio src/main.cpp)
target_compile_features(castcade-audio PRIVATE cxx_std_17)
target_compile_definitions(castcade-audio PRIVATE
  WIN32_LEAN_AND_MEAN NOMINMAX UNICODE _UNICODE
  "CASTCADE_AUDIO_VERSION=\"${PROJECT_VERSION}\"")
if(MSVC)
  target_compile_options(castcade-audio PRIVATE /W4 /permissive- /utf-8 /EHsc "$<$<CONFIG:Release>:/O2;/GL>")
  target_link_options(castcade-audio PRIVATE "$<$<CONFIG:Release>:/LTCG;/OPT:REF;/OPT:ICF>")
endif()
target_link_libraries(castcade-audio PRIVATE ole32)
