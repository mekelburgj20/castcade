// eye_crop.h: the one rule for which part of an eye's render the camera sends and theater places (D7.5.8, 2026-11-03).
//
// A headset's eye renders are lopsided: the Quest 3's right eye sees 40 degrees toward the nose and 54 outward, so the
// eye's optical axis (tangent 0) is not at the centre of its render but 15 degrees toward the nose, and the left eye is
// the mirror. Layer 0.5.0 cropped the centre of each render, so the left eye's window stood 15 degrees left of where
// the receiver looked and the right eye's 15 degrees right: every pixel was placed where it was rendered (the table
// fused), but the two window frames stood in different directions, the black border differed per eye and the outer
// edge reached the lens (the owner's solo bench, 2026-11-03: "the right eye view image is too far to the right").
//
// The camera's crop is now centred on the eye's axis horizontally (clamped inside the render) and still centred
// vertically: both eyes share the vertical asymmetry (44 up, 55 down), so a window that sits low fuses, and the full
// height keeps the flippers. The frame header and the stereo signal carry the crop (`rect`), and theater places the
// crop it is told (layer.cpp eyeCrop, control `eyes`); a picture with no `eyes` (VPX's own "both eyes" preview through
// the screen capture, an older companion) is placed by VPX's centre-crop rule as before.
#pragma once

#include <algorithm>
#include <cmath>

namespace castcade {

// The crop's left edge, in pixels from the render's left, for a crop `fw` wide in a render `rw` wide whose horizontal
// fov spans the tangents tanL (negative) .. tanR: centred on the column where the tangent is 0 and clamped to
// [0, rw - fw]. A fov that cannot place the axis (not finite, empty, or the axis outside the render) centres the crop.
inline double axisCropX(double rw, double fw, double tanL, double tanR) {
  double x = (rw - fw) * 0.5;
  if (std::isfinite(tanL) && std::isfinite(tanR) && tanR > tanL && tanL < 0.0 && tanR > 0.0) x = rw * (-tanL) / (tanR - tanL) - fw * 0.5;
  return std::max(0.0, std::min(rw - fw, x));
}

}  // namespace castcade
