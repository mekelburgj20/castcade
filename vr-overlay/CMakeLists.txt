# castcade-vr-overlay: draws the match panel in the headset as an OpenVR overlay (D7; docs/design/alpha-match.md §5).
#
#   cmake -B build -A x64                       (any Visual Studio generator; x64)
#   cmake --build build --config Release        → build/Release/castcade-vr-overlay.exe + openvr_api.dll
#
# Windows x64, MSVC, no dependency but the OpenVR SDK, which FetchContent takes from a pinned release tag (URL + sha256).
cmake_minimum_required(VERSION 3.20)
project(castcade_vr_overlay VERSION 0.1.0 LANGUAGES CXX)

if(NOT WIN32 OR NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
  message(FATAL_ERROR "castcade-vr-overlay builds for Windows x64 only (it links lib/win64/openvr_api.lib)")
endif()

# Static CRT (/MT): the helper ships without the VC++ redistributable. Set before any target exists.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

# OpenVR SDK, BSD-3 (THIRD-PARTY.md). To move the pin: pick a tag (git ls-remote --tags
# https://github.com/ValveSoftware/openvr), download its tag archive once, put its sha256 here. The archive is ~150 MB
# (samples and every platform's binaries); only headers/, lib/win64/ and bin/win64/ are used.
set(OPENVR_TAG v2.15.6)
if(POLICY CMP0135)
  cmake_policy(SET CMP0135 NEW) # extracted files get the extraction time (3.24+; the option spelling would need 3.24)
endif()
include(FetchContent)
FetchContent_Declare(openvr
  URL https://github.com/ValveSoftware/openvr/archive/refs/tags/${OPENVR_TAG}.tar.gz
  URL_HASH SHA256=e184cb625010fab7043a9d5e1e000fdeb3067a152bb3169ef53f64dfac37164c
)
# Populate only: the SDK's own CMakeLists builds openvr_api from source; we link Valve's prebuilt binary instead.
FetchContent_GetProperties(openvr)
if(NOT openvr_POPULATED)
  if(POLICY CMP0169)
    cmake_policy(SET CMP0169 OLD) # one-argument FetchContent_Populate (no add_subdirectory); deprecated in 3.30, still supported
  endif()
  FetchContent_Populate(openvr)
endif()

add_library(openvr_api SHARED IMPORTED)
set_target_properties(openvr_api PROPERTIES
  IMPORTED_IMPLIB "${openvr_SOURCE_DIR}/lib/win64/openvr_api.lib"
  IMPORTED_LOCATION "${openvr_SOURCE_DIR}/bin/win64/openvr_api.dll"
  INTERFACE_INCLUDE_DIRECTORIES "${openvr_SOURCE_DIR}/headers"
)

add_executable(castcade-vr-overlay src/main.cpp)
target_compile_features(castcade-vr-overlay PRIVATE cxx_std_17)
target_compile_definitions(castcade-vr-overlay PRIVATE
  WIN32_LEAN_AND_MEAN NOMINMAX
  "CASTCADE_VR_OVERLAY_VERSION=\"${PROJECT_VERSION}\"" "CASTCADE_OPENVR_TAG=\"${OPENVR_TAG}\"")
target_compile_options(castcade-vr-overlay PRIVATE /W4 /permissive- /utf-8 "$<$<CONFIG:Release>:/O2;/GL>")
target_link_options(castcade-vr-overlay PRIVATE "$<$<CONFIG:Release>:/LTCG;/OPT:REF;/OPT:ICF>")
target_link_libraries(castcade-vr-overlay PRIVATE openvr_api)

# openvr_api.dll and THIRD-PARTY.md beside the exe, so build/Release/ is the shippable set as-is (CI zips it; the
# companion's dev fallback runs the exe from there).
add_custom_command(TARGET castcade-vr-overlay POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_if_different "${openvr_SOURCE_DIR}/bin/win64/openvr_api.dll" "$<TARGET_FILE_DIR:castcade-vr-overlay>"
  COMMAND ${CMAKE_COMMAND} -E copy_if_different "${CMAKE_CURRENT_SOURCE_DIR}/THIRD-PARTY.md" "$<TARGET_FILE_DIR:castcade-vr-overlay>"
)
