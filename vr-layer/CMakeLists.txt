# XrApiLayer_castcade_panel: an implicit OpenXR API layer that draws the match panel in the headset inside VPinballX
# (D7.3, 2026-10-31; vr-layer/README.md). The SteamVR helper (vr-overlay/) cannot draw on rigs whose VPX reaches an
# OpenXR runtime (Virtual Desktop, Oculus) through OpenComposite; a layer loads inside VPX's process on any runtime.
#
#   cmake -B build -A x64                       (any Visual Studio generator; x64)
#   cmake --build build --config Release        → build/Release/XrApiLayer_castcade_panel.dll + .json + THIRD-PARTY.md
#
# Windows x64, MSVC. The only dependency is the OpenXR headers (Apache-2.0 OR MIT), which FetchContent takes from a
# pinned KhronosGroup/OpenXR-SDK release tag (URL + sha256). Headers only: the layer links neither the loader, D3D11
# nor OpenGL (it calls the app's D3D11 device through its interface and finds the GL entry points in the opengl32.dll
# the app already loaded, so a D3D or Vulkan app never gets opengl32 pulled in by us).
cmake_minimum_required(VERSION 3.20)
project(castcade_vr_layer VERSION 0.2.0 LANGUAGES CXX)  # 0.2.0: D7.4, pipe protocol 2 (modes, theater)

if(NOT WIN32 OR NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
  message(FATAL_ERROR "XrApiLayer_castcade_panel builds for Windows x64 only (VPinballX_GL64 and the OpenXR runtimes it reaches are x64)")
endif()

# Static CRT (/MT): the layer loads into VPX's process and must not depend on a Visual C++ redistributable being there.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

# OpenXR-SDK, headers only (THIRD-PARTY.md). To move the pin: pick a tag (git ls-remote --tags
# https://github.com/KhronosGroup/OpenXR-SDK), download its tag archive once (~1 MB), put its sha256 here.
set(OPENXR_SDK_TAG release-1.1.65)
if(POLICY CMP0135)
  cmake_policy(SET CMP0135 NEW) # extracted files get the extraction time
endif()
include(FetchContent)
FetchContent_Declare(openxr_sdk
  URL https://github.com/KhronosGroup/OpenXR-SDK/archive/refs/tags/${OPENXR_SDK_TAG}.tar.gz
  URL_HASH SHA256=27aa797baf680c5f836b6138e78e59e2f72d6becfef6d4587ed9a57756d6d3b3
)
# Populate only: the SDK's own CMakeLists builds the loader, which a layer must not carry.
FetchContent_GetProperties(openxr_sdk)
if(NOT openxr_sdk_POPULATED)
  if(POLICY CMP0169)
    cmake_policy(SET CMP0169 OLD) # one-argument FetchContent_Populate (no add_subdirectory); deprecated in 3.30, still supported
  endif()
  FetchContent_Populate(openxr_sdk)
endif()

add_library(XrApiLayer_castcade_panel SHARED src/layer.cpp src/panel_pipe.cpp src/layer_log.cpp)
target_include_directories(XrApiLayer_castcade_panel PRIVATE "${openxr_sdk_SOURCE_DIR}/include")
target_compile_features(XrApiLayer_castcade_panel PRIVATE cxx_std_17)
target_compile_definitions(XrApiLayer_castcade_panel PRIVATE
  WIN32_LEAN_AND_MEAN NOMINMAX
  "CASTCADE_VR_LAYER_VERSION=\"${PROJECT_VERSION}\"" "CASTCADE_OPENXR_SDK_TAG=\"${OPENXR_SDK_TAG}\"")
# /EHa: catch (...) also catches a structured exception (an access violation inside a driver call), so a fault in the
# layer turns the panel off for the process instead of taking VPX down mid-game (D7.3: never throw across the API).
target_compile_options(XrApiLayer_castcade_panel PRIVATE /W4 /permissive- /utf-8 /EHa "$<$<CONFIG:Release>:/O2;/GL>")
target_link_options(XrApiLayer_castcade_panel PRIVATE "$<$<CONFIG:Release>:/LTCG;/OPT:REF;/OPT:ICF>")

# The manifest and THIRD-PARTY.md beside the dll, so build/Release/ is the shippable set as-is (CI zips it; the
# companion's dev fallback registers the json from there).
add_custom_command(TARGET XrApiLayer_castcade_panel POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_if_different "${CMAKE_CURRENT_SOURCE_DIR}/XrApiLayer_castcade_panel.json" "$<TARGET_FILE_DIR:XrApiLayer_castcade_panel>"
  COMMAND ${CMAKE_COMMAND} -E copy_if_different "${CMAKE_CURRENT_SOURCE_DIR}/THIRD-PARTY.md" "$<TARGET_FILE_DIR:XrApiLayer_castcade_panel>"
)
