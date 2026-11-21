// scoreboard_place.h: where the scoreboard stands when it is fixed in the room (D8.12.3, 2026-11-21, layer 0.8.0).
//
// The owner after the first match night with the head-locked corner (2026-11-20): "the score panel in VR is annoying.
// It shouldn't move with head tracking. Perhaps it can be static somewhere and we have to turn our heads to look at
// it?" So the quad goes into LOCAL space (the space the theater screen has stood in since D7.4: gravity-aligned, fixed
// in the room while the head moves and turns), at a place worked out ONCE from the head's pose and kept for the
// session. This file is that working out, as plain functions of plain numbers (no OpenXR, no Windows), so
// tools/scoreboard_place_test.cpp can prove them at build time; layer.cpp reads the head with xrLocateSpace and draws.
//
// Two placements, both from one capture of the head (its position, its yaw, its pitch):
//   - the corner rule (the first time the scoreboard is shown in a session): up and to the side of where the head
//     FACED, by its yaw alone. A player looks down at the playfield and may tilt the head; neither moves the board:
//     the offset is measured in a level frame turned by the yaw, so "up" is the room's up and the height is the
//     head's own. kScoreboardRoomOffset: 0.64 m to the side, 0.21 m up, 0.99 m ahead = 33 degrees to the side, 10
//     degrees above eye level, 1.20 m away. Against the head-locked corner (0.46, 0.40, 1.0: 25 degrees to the side,
//     20 up, 1.17 m): further to the side, since the head can now turn to it and the eyes need not reach it (33
//     degrees clears a backbox, about 15 degrees to each side from the player's place, and the edge of a 2.4 m theater
//     screen 2.6 m away, 25 degrees), and lower, since it is no longer measured from a gaze that points down at the
//     playfield: 10 degrees above the horizon is a glance up and to the side from the backglass. The same width
//     (0.32 m: 15 degrees wide at 1.20 m, as it was), so the page's text is the size it was.
//   - the gaze rule ("place it again" in the in-game menu): the player points the head where the board should be and
//     chooses the line; the board's centre goes kScoreboardGazeDistanceM along the head's forward (yaw and pitch, the
//     pitch clamped to 75 degrees as theater's is: never overhead or underfoot).
// Either way the board is turned to face the place the head was at and kept upright: its right edge is level (no roll),
// whatever the head's roll was.
//
// Conventions (OpenXR's): +X right, +Y up, -Z ahead; a quad's front is its +Z. Yaw is a turn about +Y, 0 facing -Z,
// positive to the left; pitch is the angle of the forward above the horizon.
#pragma once

#include <cmath>

namespace castcade {

struct PlaceVec {
  float x = 0.0f, y = 0.0f, z = 0.0f;
};
struct PlaceQuat {
  float x = 0.0f, y = 0.0f, z = 0.0f, w = 1.0f;
};
struct PlacePose {
  PlaceQuat orientation;
  PlaceVec position;
};

// The corner rule's offset: right, up, ahead, in metres from where the head was, in the level frame of its yaw
// (`right` is mirrored for the left corner). The control's "offset" replaces it (panel_pipe.h), as it replaces the
// head-locked one.
constexpr float kScoreboardRoomOffset[3] = {0.64f, 0.21f, 0.99f};
// The gaze rule's distance: the corner rule's, so a board placed again is the size it was.
constexpr float kScoreboardGazeDistanceM = 1.2f;
constexpr float kScoreboardGazeMaxPitchRad = 1.308997f;  // 75 degrees

inline PlaceQuat placeQuatMul(const PlaceQuat& a, const PlaceQuat& b) {
  return {a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y, a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x, a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
          a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z};
}

// v rotated by the unit quaternion q: v + w t + q.xyz x t, t = 2 q.xyz x v.
inline PlaceVec placeRotate(const PlaceQuat& q, const PlaceVec& v) {
  const float tx = 2.0f * (q.y * v.z - q.z * v.y), ty = 2.0f * (q.z * v.x - q.x * v.z), tz = 2.0f * (q.x * v.y - q.y * v.x);
  return {v.x + q.w * tx + (q.y * tz - q.z * ty), v.y + q.w * ty + (q.z * tx - q.x * tz), v.z + q.w * tz + (q.x * ty - q.y * tx)};
}

// A quad at `offset` from the origin, turned so its front (+Z) faces the origin and kept upright (its right edge
// level): the SteamVR helper's facingOrigin() (vr-overlay/src/main.cpp) as a quaternion. This is the panel's and the
// head-locked scoreboard's placement too (layer.cpp facingEye, where the origin is the eye); the arithmetic is the
// one it has had since D7.3. Straight above or below the origin there is no level right to take: +X is used.
inline PlacePose placeFacingOrigin(const float offset[3]) {
  PlacePose p;
  p.position = {offset[0], offset[1], offset[2]};
  p.orientation = {0.0f, 0.0f, 0.0f, 1.0f};
  const float tx = -offset[0], ty = -offset[1], tz = -offset[2];
  const float tl = std::sqrt(tx * tx + ty * ty + tz * tz);
  if (tl < 1e-4f) return p;
  const float nx = tx / tl, ny = ty / tl, nz = tz / tl;  // front
  float rx = nz, ry = 0.0f, rz = -nx;                    // right = up(0,1,0) x front
  const float rl = std::sqrt(rx * rx + rz * rz);
  if (rl < 1e-4f) rx = 1.0f, rz = 0.0f;
  else rx /= rl, rz /= rl;
  const float ux = ny * rz - nz * ry, uy = nz * rx - nx * rz, uz = nx * ry - ny * rx;  // up = front x right
  // Columns right, up, front → quaternion (Shepperd).
  const float m00 = rx, m01 = ux, m02 = nx, m10 = ry, m11 = uy, m12 = ny, m20 = rz, m21 = uz, m22 = nz;
  const float tr = m00 + m11 + m22;
  PlaceQuat q;
  if (tr > 0.0f) {
    const float s = std::sqrt(tr + 1.0f) * 2.0f;
    q.w = 0.25f * s, q.x = (m21 - m12) / s, q.y = (m02 - m20) / s, q.z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const float s = std::sqrt(1.0f + m00 - m11 - m22) * 2.0f;
    q.w = (m21 - m12) / s, q.x = 0.25f * s, q.y = (m01 + m10) / s, q.z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const float s = std::sqrt(1.0f + m11 - m00 - m22) * 2.0f;
    q.w = (m02 - m20) / s, q.x = (m01 + m10) / s, q.y = 0.25f * s, q.z = (m12 + m21) / s;
  } else {
    const float s = std::sqrt(1.0f + m22 - m00 - m11) * 2.0f;
    q.w = (m10 - m01) / s, q.x = (m02 + m20) / s, q.y = (m12 + m21) / s, q.z = 0.25f * s;
  }
  p.orientation = q;
  return p;
}

// What a capture keeps of the head: where it was, which way it faced (yaw), how far up or down it pointed (pitch; the
// gaze rule reads it, the corner rule never does) and which of the two rules places the board.
struct ScoreboardAnchor {
  PlaceVec head;
  float yaw = 0.0f;
  float pitch = 0.0f;
  bool atGaze = false;
};

// The head's yaw and pitch from its orientation; its roll is not read at all. The yaw is the heading of the forward
// (-Z) on the floor; a head pointing nearly straight down or up (the forward within about 6 degrees of vertical) has
// no such heading, and the top of the head (+Y) gives it instead: looking down it points the way the player faces,
// looking up the opposite way. An orientation that is not a rotation (zeros, not finite: a runtime without a pose)
// reads as level and facing -Z.
inline void placeHeadAngles(const PlaceQuat& q, float& yaw, float& pitch) {
  yaw = 0.0f, pitch = 0.0f;
  const float n2 = q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w;
  if (!std::isfinite(n2) || n2 < 0.5f || n2 > 2.0f) return;
  const PlaceVec f = placeRotate(q, {0.0f, 0.0f, -1.0f});
  const float horiz2 = f.x * f.x + f.z * f.z;
  if (horiz2 > 0.01f) {
    yaw = std::atan2(-f.x, -f.z);
  } else {
    const PlaceVec u = placeRotate(q, {0.0f, 1.0f, 0.0f});
    const float sign = f.y < 0.0f ? 1.0f : -1.0f;
    yaw = std::atan2(-sign * u.x, -sign * u.z);
  }
  pitch = std::atan2(f.y, std::sqrt(horiz2));
  if (!std::isfinite(yaw)) yaw = 0.0f;
  if (!std::isfinite(pitch)) pitch = 0.0f;
}

// One capture: the head's pose in the room, and the rule that will place the board from it.
inline ScoreboardAnchor scoreboardAnchor(const PlaceVec& head, const PlaceQuat& orientation, bool atGaze) {
  ScoreboardAnchor a;
  if (std::isfinite(head.x) && std::isfinite(head.y) && std::isfinite(head.z)) a.head = head;
  placeHeadAngles(orientation, a.yaw, a.pitch);
  a.atGaze = atGaze;
  return a;
}

// The board's pose in the room for a capture. Corner rule: `offset` (right, up, ahead; `right` mirrored for `left`) in
// the level frame of the capture's yaw, from the capture's head position. Gaze rule: kScoreboardGazeDistanceM along
// the capture's forward (`offset` and `left` are not read). The board faces the capture's head position, upright.
inline PlacePose scoreboardRoomPose(const ScoreboardAnchor& a, bool left, const float offset[3]) {
  float o[3];
  if (a.atGaze) {
    const float p = std::fmax(-kScoreboardGazeMaxPitchRad, std::fmin(kScoreboardGazeMaxPitchRad, a.pitch));
    o[0] = 0.0f, o[1] = kScoreboardGazeDistanceM * std::sin(p), o[2] = -kScoreboardGazeDistanceM * std::cos(p);
  } else {
    o[0] = left ? -offset[0] : offset[0], o[1] = offset[1], o[2] = -offset[2];
  }
  const PlacePose level = placeFacingOrigin(o);
  // A turn about +Y keeps what is level level: the board stays upright in the room.
  const PlaceQuat qYaw{0.0f, std::sin(a.yaw * 0.5f), 0.0f, std::cos(a.yaw * 0.5f)};
  const PlaceVec at = placeRotate(qYaw, level.position);
  PlacePose out;
  out.orientation = placeQuatMul(qYaw, level.orientation);
  out.position = {a.head.x + at.x, a.head.y + at.y, a.head.z + at.z};
  return out;
}

}  // namespace castcade
