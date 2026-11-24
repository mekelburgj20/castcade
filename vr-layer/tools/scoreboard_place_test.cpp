// scoreboard_place_test: the proof of the scoreboard's place in the room that can be had without a headset (D8.12.3,
// 2026-11-21). A console program, built with the layer and run by its build (CMakeLists.txt: a failed check fails the
// build, in CI too); never shipped. It checks the pure parts: the pose maths (src/scoreboard_place.h) and the reading
// of the control's "scoreboard" object (src/panel_pipe.cpp), which is where an older companion and this layer meet.
// What it cannot show: that LOCAL space holds still on a given runtime, and how the place looks.
// D8.12.3.2 (2026-11-24, layer 0.8.1): also the rule that puts the board back in view (sight, hold): which head poses
// count as "out of view", and the hold as the layer steps it. Not shown here: what a runtime reports for a headset
// that was taken off, and whether 90 degrees and 8 s feel right in play.
#include <cmath>
#include <cstdio>
#include <initializer_list>
#include <limits>
#include <string>

#include "panel_pipe.h"
#include "scoreboard_place.h"

using namespace castcade;

namespace {

int g_failed = 0;
int g_checked = 0;

void check(bool ok, const char* what, int line) {
  g_checked++;
  if (ok) return;
  g_failed++;
  std::printf("FAILED line %d: %s\n", line, what);
}
#define CHECK(x) check((x), #x, __LINE__)

constexpr float kPi = 3.14159265f;
float rad(float deg) { return deg * kPi / 180.0f; }
float deg(float r) { return r * 180.0f / kPi; }
bool almost(float a, float b, float tol) { return std::fabs(a - b) <= tol; }
bool almostVec(const PlaceVec& a, const PlaceVec& b, float tol) { return almost(a.x, b.x, tol) && almost(a.y, b.y, tol) && almost(a.z, b.z, tol); }
float length(const PlaceVec& v) { return std::sqrt(v.x * v.x + v.y * v.y + v.z * v.z); }
float norm(const PlaceQuat& q) { return std::sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w); }

PlaceQuat axisAngle(float ax, float ay, float az, float angle) {
  const float s = std::sin(angle * 0.5f);
  return {ax * s, ay * s, az * s, std::cos(angle * 0.5f)};
}
// A head turned `yaw` to the left, then pitched `pitch` up, then rolled `roll` about its own forward: the order a
// neck makes them in (each later turn in the head's own frame).
PlaceQuat head(float yawDeg, float pitchDeg, float rollDeg) {
  return placeQuatMul(placeQuatMul(axisAngle(0, 1, 0, rad(yawDeg)), axisAngle(1, 0, 0, rad(pitchDeg))), axisAngle(0, 0, 1, rad(rollDeg)));
}

// The board's front faces `target` and its right edge is level: what "turned to face the head, kept upright" means.
void checkFacesUpright(const PlacePose& p, const PlaceVec& target, int line) {
  const PlaceVec front = placeRotate(p.orientation, {0.0f, 0.0f, 1.0f});
  const PlaceVec right = placeRotate(p.orientation, {1.0f, 0.0f, 0.0f});
  const PlaceVec up = placeRotate(p.orientation, {0.0f, 1.0f, 0.0f});
  PlaceVec to{target.x - p.position.x, target.y - p.position.y, target.z - p.position.z};
  const float l = length(to);
  to = {to.x / l, to.y / l, to.z / l};
  check(almostVec(front, to, 1e-4f), "the board's front points at the place the head was", line);
  check(almost(right.y, 0.0f, 1e-5f), "the board's right edge is level (no roll)", line);
  check(up.y > 0.0f, "the board's top is up", line);
  check(almost(norm(p.orientation), 1.0f, 1e-4f), "the orientation is a unit quaternion (xrEndFrame refuses any other)", line);
}

void facing() {
  // The panel's "low" placement (layer.cpp kPanelLowOffset): its documented tilt back of about 25 degrees.
  const float low[3] = {0.0f, -0.42f, -0.9f};
  const PlacePose p = placeFacingOrigin(low);
  checkFacesUpright(p, {0, 0, 0}, __LINE__);
  const PlaceVec front = placeRotate(p.orientation, {0.0f, 0.0f, 1.0f});
  CHECK(almost(deg(std::atan2(front.y, front.z)), 25.0f, 0.5f));
  // The head-locked corner (layer.cpp kScoreboardOffset, mirrored for the left): faces the eye, upright.
  const float right[3] = {0.46f, 0.40f, -1.0f}, left[3] = {-0.46f, 0.40f, -1.0f};
  checkFacesUpright(placeFacingOrigin(right), {0, 0, 0}, __LINE__);
  checkFacesUpright(placeFacingOrigin(left), {0, 0, 0}, __LINE__);
  // Straight ahead: no turn at all. At the origin, and straight overhead: still a rotation.
  const float ahead[3] = {0.0f, 0.0f, -2.0f}, none[3] = {0.0f, 0.0f, 0.0f}, over[3] = {0.0f, 1.0f, 0.0f};
  const PlaceQuat q = placeFacingOrigin(ahead).orientation;
  CHECK(almost(q.x, 0, 1e-6f) && almost(q.y, 0, 1e-6f) && almost(q.z, 0, 1e-6f) && almost(q.w, 1, 1e-6f));
  CHECK(almost(norm(placeFacingOrigin(none).orientation), 1.0f, 1e-6f));
  CHECK(almost(norm(placeFacingOrigin(over).orientation), 1.0f, 1e-4f));
}

void angles() {
  float yaw = 9, pitch = 9;
  placeHeadAngles(head(0, 0, 0), yaw, pitch);
  CHECK(almost(yaw, 0, 1e-5f) && almost(pitch, 0, 1e-5f));
  placeHeadAngles(head(90, 0, 0), yaw, pitch);  // facing -X
  CHECK(almost(deg(yaw), 90, 0.01f) && almost(pitch, 0, 1e-4f));
  placeHeadAngles(head(-140, 0, 0), yaw, pitch);  // past a right angle to the right
  CHECK(almost(deg(yaw), -140, 0.01f));
  // A player looking down at the playfield with a tilted head: the yaw and the pitch come out, the roll changes neither.
  placeHeadAngles(head(30, -40, 20), yaw, pitch);
  CHECK(almost(deg(yaw), 30, 0.01f) && almost(deg(pitch), -40, 0.01f));
  placeHeadAngles(head(30, -40, -35), yaw, pitch);
  CHECK(almost(deg(yaw), 30, 0.01f) && almost(deg(pitch), -40, 0.01f));
  // Straight down and straight up: the forward has no heading; the top of the head gives the yaw the neck turned to.
  placeHeadAngles(head(50, -90, 0), yaw, pitch);
  CHECK(almost(deg(yaw), 50, 0.05f) && almost(deg(pitch), -90, 0.05f));
  placeHeadAngles(head(50, 90, 0), yaw, pitch);
  CHECK(almost(deg(yaw), 50, 0.05f) && almost(deg(pitch), 90, 0.05f));
  placeHeadAngles(head(-20, -88, 0), yaw, pitch);
  CHECK(almost(deg(yaw), -20, 0.05f));
  // Not a rotation (a runtime that filled nothing in): level, facing -Z; never NaN.
  const float nan = std::numeric_limits<float>::quiet_NaN();
  placeHeadAngles({0, 0, 0, 0}, yaw, pitch);
  CHECK(yaw == 0 && pitch == 0);
  placeHeadAngles({nan, 0, 0, 1}, yaw, pitch);
  CHECK(yaw == 0 && pitch == 0);
}

void cornerRule() {
  // The numbers the layer states: 33 degrees to the side, 10 degrees above eye level, 1.20 m away.
  const float* o = kScoreboardRoomOffset;
  CHECK(almost(deg(std::atan2(o[0], o[2])), 33.0f, 0.5f));
  CHECK(almost(deg(std::atan2(o[1], std::sqrt(o[0] * o[0] + o[2] * o[2]))), 10.0f, 0.5f));
  CHECK(almost(std::sqrt(o[0] * o[0] + o[1] * o[1] + o[2] * o[2]), 1.2f, 0.01f));
  CHECK(almost(kScoreboardGazeDistanceM, 1.2f, 1e-6f));

  // A level head at LOCAL's origin, facing -Z: the board is at the offset itself, to the right, above, ahead.
  const ScoreboardAnchor level = scoreboardAnchor({0, 0, 0}, head(0, 0, 0), false);
  const PlacePose right = scoreboardRoomPose(level, false, kScoreboardRoomOffset);
  CHECK(almostVec(right.position, {0.64f, 0.21f, -0.99f}, 1e-5f));
  checkFacesUpright(right, {0, 0, 0}, __LINE__);
  // The left corner is its mirror image.
  const PlacePose left = scoreboardRoomPose(level, true, kScoreboardRoomOffset);
  CHECK(almostVec(left.position, {-0.64f, 0.21f, -0.99f}, 1e-5f));
  checkFacesUpright(left, {0, 0, 0}, __LINE__);

  // "No roll, no pitch from a tilted head": looking down at the playfield with the head cocked gives the very place a
  // level head gives.
  const PlacePose tilted = scoreboardRoomPose(scoreboardAnchor({0, 0, 0}, head(0, -45, 25), false), false, kScoreboardRoomOffset);
  CHECK(almostVec(tilted.position, right.position, 1e-4f));
  CHECK(almost(tilted.orientation.x, right.orientation.x, 1e-4f) && almost(tilted.orientation.y, right.orientation.y, 1e-4f) &&
        almost(tilted.orientation.z, right.orientation.z, 1e-4f) && almost(tilted.orientation.w, right.orientation.w, 1e-4f));

  // A head somewhere else in the room, turned a quarter to the left (facing -X): ahead is -X, right is -Z. The board
  // is measured from the head's place and height, and faces that place.
  const PlaceVec at{1.0f, 1.5f, 2.0f};
  const PlacePose turned = scoreboardRoomPose(scoreboardAnchor(at, head(90, -30, 10), false), false, kScoreboardRoomOffset);
  CHECK(almostVec(turned.position, {1.0f - 0.99f, 1.5f + 0.21f, 2.0f - 0.64f}, 1e-4f));
  checkFacesUpright(turned, at, __LINE__);

  // The control's "offset" (match.json scoreboardPlace) replaces the layer's own, in the same level frame.
  const float tuned[3] = {0.5f, 0.0f, 1.5f};
  const PlacePose moved = scoreboardRoomPose(scoreboardAnchor(at, head(180, 0, 0), false), true, tuned);  // facing +Z, left corner
  CHECK(almostVec(moved.position, {1.0f + 0.5f, 1.5f, 2.0f + 1.5f}, 1e-4f));
  checkFacesUpright(moved, at, __LINE__);

  // The place is the capture's alone: nothing of the head after the capture enters it (the layer keeps the anchor and
  // draws in LOCAL space; this function has no other input).
  const ScoreboardAnchor kept = scoreboardAnchor(at, head(90, -30, 10), false);
  const PlacePose again = scoreboardRoomPose(kept, false, kScoreboardRoomOffset);
  CHECK(almostVec(again.position, turned.position, 0.0f));
  // A position that is not finite (no position tracking) reads as LOCAL's origin, never NaN in a pose.
  const float nan = std::numeric_limits<float>::quiet_NaN();
  const PlacePose lost = scoreboardRoomPose(scoreboardAnchor({nan, 0, 0}, {0, 0, 0, 0}, false), false, kScoreboardRoomOffset);
  CHECK(almostVec(lost.position, {0.64f, 0.21f, -0.99f}, 1e-5f));
  CHECK(almost(norm(lost.orientation), 1.0f, 1e-4f));
}

void gazeRule() {
  // "Place it again": the player points the head where the board should be: 20 degrees to the right, 30 down.
  const PlaceVec at{0.3f, 1.6f, -0.2f};
  const PlaceQuat q = head(-20, -30, 15);
  const ScoreboardAnchor a = scoreboardAnchor(at, q, true);
  const PlacePose p = scoreboardRoomPose(a, false, kScoreboardRoomOffset);
  const PlaceVec fwd = placeRotate(q, {0.0f, 0.0f, -1.0f});
  CHECK(almostVec(p.position, {at.x + 1.2f * fwd.x, at.y + 1.2f * fwd.y, at.z + 1.2f * fwd.z}, 1e-4f));
  checkFacesUpright(p, at, __LINE__);
  // The corner and the offset are not read: the board is where the head points.
  const float tuned[3] = {1.0f, 1.0f, 1.0f};
  CHECK(almostVec(scoreboardRoomPose(a, true, tuned).position, p.position, 0.0f));
  // The same capture read by the corner rule (the Match tab's corner changed afterwards): up and to the side of that yaw.
  ScoreboardAnchor corner = a;
  corner.atGaze = false;
  const PlacePose c = scoreboardRoomPose(corner, false, kScoreboardRoomOffset);
  CHECK(almost(c.position.y, at.y + 0.21f, 1e-5f));
  checkFacesUpright(c, at, __LINE__);
  // Never overhead or underfoot: the pitch stops at 75 degrees.
  const PlacePose down = scoreboardRoomPose(scoreboardAnchor({0, 0, 0}, head(0, -89, 0), true), false, kScoreboardRoomOffset);
  CHECK(almost(deg(std::atan2(-down.position.y, -down.position.z)), 75.0f, 0.05f));
  CHECK(almost(length(down.position), 1.2f, 1e-4f));
  checkFacesUpright(down, {0, 0, 0}, __LINE__);
}

// D8.12.3.2 (2026-11-24): the board puts itself back in view. What follows is the rule without a headset: when a head
// pose counts as "the board is out of view", and the hold that turns that into "place it again".

// The board the layer's own corner rule gives for a level head at LOCAL's origin facing -Z (the right corner): 33
// degrees to the right, so its heading as a yaw is -32.9 degrees.
const PlaceVec kBoard{0.64f, 0.21f, -0.99f};
const float kBoardYawDeg = -32.88f;
const float kPlaced = 1.2f;

bool outOfView(const PlaceVec& at, const PlaceQuat& q, const PlaceVec& board = kBoard, float placed = kPlaced) {
  return scoreboardOutOfView(scoreboardSight(at, q, board), placed);
}

// `seconds` of samples, ten a second as the layer takes them, of a head at `at` turned `yawDeg` to the left and
// stirring by `stirDeg` to either side as a head on a neck does. The time of the sample that said "place it again", or
// -1 when none did. The watch is the caller's, so one call can follow another.
float watchFor(ScoreboardWatch& w, const PlaceVec& at, float yawDeg, float seconds, float stirDeg = 1.0f, const PlaceVec& board = kBoard) {
  const int n = static_cast<int>(seconds * 10.0f + 0.5f);
  for (int i = 0; i < n; i++) {
    const ScoreboardSight sight = scoreboardSight(at, head(yawDeg + (i % 2 ? stirDeg : -stirDeg), -35, 5), board);
    if (scoreboardWatchStep(w, sight, kPlaced, 0.1f)) return static_cast<float>(i) * 0.1f;
  }
  return -1.0f;
}

void sight() {
  // The numbers the rule states.
  CHECK(almost(deg(kScoreboardLostAngleRad), 90.0f, 0.01f) && almost(deg(kScoreboardLostSteadyRad), 30.0f, 0.01f) && almost(deg(kScoreboardLostStirRad), 0.5f, 0.001f));
  CHECK(kScoreboardLostHoldSec == 8.0f);
  CHECK(almost(deg(std::atan(kScoreboardNoSideTan)), 60.0f, 0.01f));

  // From where it was placed: 33 degrees to the side, 1.20 m away, in view.
  const ScoreboardSight placed = scoreboardSight({0, 0, 0}, head(0, 0, 0), kBoard);
  CHECK(placed.known && almost(deg(placed.angle), 33.0f, 0.5f) && almost(placed.distance, 1.2f, 0.01f) && almost(placed.yaw, 0, 1e-5f));
  CHECK(almost(scoreboardPlacedDistance(scoreboardAnchor({0, 0, 0}, head(0, 0, 0), false), kBoard), 1.2f, 0.01f));
  CHECK(!scoreboardOutOfView(placed, kPlaced));
  // Facing it: no angle at all.
  const ScoreboardSight towards = scoreboardSight({0, 0, 0}, head(kBoardYawDeg, 0, 0), kBoard);
  CHECK(almost(deg(towards.angle), 0.0f, 0.1f) && !scoreboardOutOfView(towards, kPlaced));
  // To either side of it: 89 degrees is in view, 91 is not; 111 and straight behind are not. The angle has no sign.
  for (float side : {1.0f, -1.0f}) {
    CHECK(almost(deg(scoreboardSight({0, 0, 0}, head(kBoardYawDeg + side * 60, 0, 0), kBoard).angle), 60.0f, 0.1f));
    CHECK(!outOfView({0, 0, 0}, head(kBoardYawDeg + side * 89, 0, 0)));
    CHECK(outOfView({0, 0, 0}, head(kBoardYawDeg + side * 91, 0, 0)));
    CHECK(outOfView({0, 0, 0}, head(kBoardYawDeg + side * 111, 0, 0)));
  }
  CHECK(almost(deg(scoreboardSight({0, 0, 0}, head(kBoardYawDeg + 180, 0, 0), kBoard).angle), 180.0f, 0.1f));
  CHECK(outOfView({0, 0, 0}, head(kBoardYawDeg + 180, 0, 0)));
  // The owner's evening (2026-11-23): placed facing the PC, then a turn of 130 degrees. Away from the board's side it
  // stands at 163 degrees, "almost behind me"; towards its side at 97, which the rule must catch as well.
  CHECK(almost(deg(scoreboardSight({0, 0, 0}, head(130, 0, 0), kBoard).angle), 163.0f, 0.5f) && outOfView({0, 0, 0}, head(130, 0, 0)));
  CHECK(almost(deg(scoreboardSight({0, 0, 0}, head(-130, 0, 0), kBoard).angle), 97.0f, 0.5f) && outOfView({0, 0, 0}, head(-130, 0, 0)));
  // The left corner is the mirror image.
  const PlaceVec leftBoard{-0.64f, 0.21f, -0.99f};
  CHECK(!outOfView({0, 0, 0}, head(-50, 0, 0), leftBoard) && outOfView({0, 0, 0}, head(-60, 0, 0), leftBoard));

  // A player looks down at the playfield, up at the backglass, straight down at the flippers, with the head tilted:
  // only the yaw is read, so the board is where it was for a level head, in view.
  for (float pitch : {-30.0f, -60.0f, -85.0f, -90.0f, 40.0f, 90.0f}) {
    for (float roll : {0.0f, 25.0f, -35.0f}) {
      if (std::fabs(pitch) > 80.0f && roll != 0.0f) continue;  // straight down or up, a roll IS a turn: the next check
      const ScoreboardSight s = scoreboardSight({0, 0, 0}, head(0, pitch, roll), kBoard);
      CHECK(s.known && almost(deg(s.angle), 33.0f, 0.6f) && !scoreboardOutOfView(s, kPlaced));
    }
  }
  // ... and a player turned away from it is turned away however the head is held.
  CHECK(outOfView({0, 0, 0}, head(130, -60, 20)) && outOfView({0, 0, 0}, head(130, -90, 0)) && outOfView({0, 0, 0}, head(-130, -45, -30)));

  // A pose that is no reading of a head: an orientation of zeros or with a NaN, a position that is not finite. Never
  // "out of view", and nothing to place from.
  const float nan = std::numeric_limits<float>::quiet_NaN(), inf = std::numeric_limits<float>::infinity();
  CHECK(!scoreboardSight({0, 0, 0}, {0, 0, 0, 0}, kBoard).known && !outOfView({0, 0, 0}, {0, 0, 0, 0}));
  CHECK(!scoreboardSight({0, 0, 0}, {nan, 0, 0, 1}, kBoard).known && !outOfView({0, 0, 0}, {nan, 0, 0, 1}));
  CHECK(!scoreboardSight({0, 0, 0}, {0, 3, 0, 3}, kBoard).known);
  CHECK(!scoreboardSight({nan, 0, 0}, head(180, 0, 0), kBoard).known && !outOfView({nan, 0, 0}, head(180, 0, 0)));
  CHECK(!scoreboardSight({0, inf, 0}, head(180, 0, 0), kBoard).known);

  // The distance: twice as far as it was placed, and at least a metre further. A lean, a chair or a step back from the
  // table is nothing; a player who walked away is out of view even when facing the board.
  CHECK(almost(scoreboardFarLimit(1.2f), 2.4f, 1e-5f) && almost(scoreboardFarLimit(0.3f), 1.3f, 1e-5f) && almost(scoreboardFarLimit(5.0f), 10.0f, 1e-4f));
  const PlaceVec away{-0.64f / 1.2f, -0.21f / 1.2f, 0.99f / 1.2f};  // one metre straight back from the board
  const auto backBy = [&](float m) { return PlaceVec{away.x * m, away.y * m, away.z * m}; };
  CHECK(!outOfView(backBy(0.4f), head(kBoardYawDeg, 0, 0)));  // 1.6 m: a lean back
  CHECK(!outOfView(backBy(1.1f), head(kBoardYawDeg, 0, 0)));  // 2.3 m
  CHECK(outOfView(backBy(1.3f), head(kBoardYawDeg, 0, 0)));   // 2.5 m
  CHECK(almost(scoreboardSight(backBy(1.3f), head(kBoardYawDeg, 0, 0), kBoard).distance, 2.5f, 0.01f));
  CHECK(!outOfView({0, -0.45f, 0}, head(0, 0, 0)));  // sat down
  // Seen from somewhere else in the room the heading to the board is taken from there: a head 1.5 m to the right of
  // where the place was taken, facing -Z as then, has the board 57 degrees to its LEFT; turned 40 degrees to the right
  // (which from the first place looked straight at it) the board is 97 degrees away.
  CHECK(almost(deg(scoreboardSight({1.5f, 0, -0.43f}, head(0, 0, 0), kBoard).angle), 57.0f, 0.5f) && !outOfView({1.5f, 0, -0.43f}, head(0, 0, 0)));
  CHECK(outOfView({1.5f, 0, -0.43f}, head(-40, 0, 0)));

  // A board with no side to be on: straight overhead, or put 75 degrees up with "place it again". A lean of 40 cm
  // takes its heading from ahead to behind; it is never out of view for that.
  CHECK(almost(scoreboardSight({0, 0, 0}, head(180, 0, 0), {0, 1.0f, 0}).angle, 0.0f, 1e-6f));
  const PlaceVec high = scoreboardRoomPose(scoreboardAnchor({0, 0, 0}, head(0, 75, 0), true), false, kScoreboardRoomOffset).position;
  CHECK(!outOfView({0, 0, 0}, head(0, -40, 0), high, kPlaced) && !outOfView({0, 0, -0.4f}, head(0, -40, 0), high, kPlaced));
  // One put where the head pointed, level and behind the player now: out of view like any other.
  const PlaceVec gazed = scoreboardRoomPose(scoreboardAnchor({0, 0, 0}, head(20, -10, 0), true), false, kScoreboardRoomOffset).position;
  CHECK(!outOfView({0, 0, 0}, head(-30, 0, 0), gazed, kPlaced) && outOfView({0, 0, 0}, head(150, 0, 0), gazed, kPlaced));
}

void hold() {
  // Out of view and facing one way: placed again after 8 s, not before.
  ScoreboardWatch w;
  CHECK(watchFor(w, {0, 0, 0}, 130, 7.5f) < 0.0f);
  CHECK(w.counting && w.heldSec > 7.0f && w.heldSec < 7.6f);
  const float t = watchFor(w, {0, 0, 0}, 130, 2.0f);
  CHECK(t >= 0.0f && t <= 0.8f && w.heldSec >= 8.0f && w.heldSec < 8.2f);
  // The 97 degrees of a turn towards the board's side, the same.
  w = {};
  const float t97 = watchFor(w, {0, 0, 0}, -130, 20.0f);
  CHECK(t97 >= 7.9f && t97 <= 8.3f);

  // In view: nothing, however long. A head that only looks down at the playfield for a minute: nothing.
  w = {};
  CHECK(watchFor(w, {0, 0, 0}, 0, 60.0f) < 0.0f && !w.counting && w.heldSec == 0.0f);
  CHECK(watchFor(w, {0, 0, 0}, 40, 60.0f) < 0.0f && !w.counting);

  // A glance over the shoulder: three seconds turned away, then back to the table. Nothing, and nothing is kept: the
  // next time away starts from zero, so glance after glance never adds up.
  w = {};
  for (int i = 0; i < 20; i++) {
    CHECK(watchFor(w, {0, 0, 0}, 130, 3.0f) < 0.0f);
    CHECK(watchFor(w, {0, 0, 0}, 0, 0.1f) < 0.0f && !w.counting && w.heldSec == 0.0f);
  }
  // A glance BACK at 7 s resets it too: the full 8 s again after it.
  w = {};
  CHECK(watchFor(w, {0, 0, 0}, 130, 7.0f) < 0.0f);
  CHECK(watchFor(w, {0, 0, 0}, 20, 0.5f) < 0.0f && w.heldSec == 0.0f);
  CHECK(watchFor(w, {0, 0, 0}, 130, 7.5f) < 0.0f);
  CHECK(watchFor(w, {0, 0, 0}, 130, 1.0f) >= 0.0f);

  // One way: a head still turning (out of view all the while) does not run the hold down. Here it sweeps 100 → 220
  // degrees over 12 s, more than 30 degrees from wherever a count began: no placement on the way, and one within 8 s
  // of settling (the last 30 degrees of the turn count), from the pose it settled at.
  w = {};
  bool fired = false;
  for (int i = 0; i < 120 && !fired; i++) fired = scoreboardWatchStep(w, scoreboardSight({0, 0, 0}, head(100.0f + static_cast<float>(i), 0, 0), kBoard), kPlaced, 0.1f);
  CHECK(!fired && w.heldSec < 4.0f);
  const float settled = watchFor(w, {0, 0, 0}, 220, 20.0f);
  CHECK(settled >= 4.0f && settled <= 8.3f);
  // Looking about within 30 degrees of where the count began (a table's width and more) does not restart it.
  w = {};
  CHECK(watchFor(w, {0, 0, 0}, 150, 12.0f, 14.0f) >= 0.0f);
  w = {};
  CHECK(watchFor(w, {0, 0, 0}, 150, 30.0f, 40.0f) < 0.0f);  // swinging 80 degrees wide: never one way

  // A pose that is no reading: not counted, and the count is neither lost nor run down by it. 4 s away, 30 s of a
  // runtime without a pose, 3 s away: 7 s counted, nothing placed; one more second and it is.
  w = {};
  CHECK(watchFor(w, {0, 0, 0}, 130, 4.0f) < 0.0f);
  const float before = w.heldSec;
  for (int i = 0; i < 300; i++) CHECK(!scoreboardWatchStep(w, scoreboardSight({0, 0, 0}, {0, 0, 0, 0}, kBoard), kPlaced, 0.1f));
  CHECK(w.counting && w.heldSec == before);
  CHECK(watchFor(w, {0, 0, 0}, 130, 3.0f) < 0.0f);
  CHECK(watchFor(w, {0, 0, 0}, 130, 2.0f) >= 0.0f);
  // A pose that is no reading is never the one placed from, even with the hold already full.
  w = {};
  w.counting = true, w.fromYaw = rad(130), w.heldSec = 60.0f, w.stirred = 1.0f;
  CHECK(!scoreboardWatchStep(w, scoreboardSight({0, 0, 0}, {0, 0, 0, 0}, kBoard), kPlaced, 0.1f));
  CHECK(scoreboardWatchStep(w, scoreboardSight({0, 0, 0}, head(131, 0, 0), kBoard), kPlaced, 0.1f));

  // Time nobody watched does not count: a frame that comes 3 s after the last (VPX stalled) counts for half a second,
  // and a time that is not a number or runs backwards for nothing.
  w = {};
  CHECK(!scoreboardWatchStep(w, scoreboardSight({0, 0, 0}, head(130, 0, 0), kBoard), kPlaced, 0.0f));
  CHECK(!scoreboardWatchStep(w, scoreboardSight({0, 0, 0}, head(131, 0, 0), kBoard), kPlaced, 3.0f));
  CHECK(almost(w.heldSec, 0.5f, 1e-6f));
  CHECK(!scoreboardWatchStep(w, scoreboardSight({0, 0, 0}, head(131, 0, 0), kBoard), kPlaced, std::numeric_limits<float>::quiet_NaN()));
  CHECK(!scoreboardWatchStep(w, scoreboardSight({0, 0, 0}, head(131, 0, 0), kBoard), kPlaced, -5.0f));
  CHECK(almost(w.heldSec, 0.5f, 1e-6f));

  // A headset on a desk, or a pose the runtime froze: turned away for ten minutes without stirring half a degree,
  // nothing is placed. On a head again (it stirs), the hold is long full: placed at once.
  w = {};
  CHECK(watchFor(w, {0, 0, 0}, 130, 600.0f, 0.0f) < 0.0f && w.counting);
  CHECK(watchFor(w, {0, 0, 0}, 130, 600.0f, 0.1f) < 0.0f);
  CHECK(watchFor(w, {0, 0, 0}, 130, 1.0f, 1.0f) >= 0.0f);

  // Walked away, facing the board from 2.6 m: the same hold.
  w = {};
  const PlaceVec walkedTo{-0.64f / 1.2f * 1.4f, 0.0f, 0.99f / 1.2f * 1.4f};
  const float walked = watchFor(w, walkedTo, kBoardYawDeg, 20.0f);
  CHECK(walked >= 7.9f && walked <= 8.3f);

  // The whole of it, as the layer does it: the first place taken facing the PC (the head at LOCAL's origin, yaw -8, as
  // the log of 2026-11-23 has it), the player then half a metre off and turned 130 degrees, either way, looking down
  // at the playfield. After the hold the board is placed from that pose by the corner rule: 33 degrees to the side
  // and 1.20 m from the head again, in view, and it stays (a minute more places nothing).
  for (float turn : {130.0f, -130.0f}) {
    for (bool left : {false, true}) {
      ScoreboardAnchor anchor = scoreboardAnchor({0, 0, 0}, head(-8, 0, 0), false);
      PlaceVec board = scoreboardRoomPose(anchor, left, kScoreboardRoomOffset).position;
      const PlaceVec at{0.3f, -0.1f, 0.4f};
      const float yawNow = -8.0f + turn;
      ScoreboardWatch watch;
      int placedAgain = 0;
      for (int i = 0; i < 700; i++) {
        const PlaceQuat q = head(yawNow + (i % 2 ? 2.0f : -2.0f), -40, 10);
        const ScoreboardSight s = scoreboardSight(at, q, board);
        if (!scoreboardWatchStep(watch, s, scoreboardPlacedDistance(anchor, board), 0.1f)) continue;
        placedAgain++;
        CHECK(i >= 79 && i <= 83);
        watch = {};
        anchor = scoreboardAnchor(at, q, false);
        board = scoreboardRoomPose(anchor, left, kScoreboardRoomOffset).position;
        const ScoreboardSight after = scoreboardSight(at, q, board);
        CHECK(almost(deg(after.angle), 33.0f, 0.5f) && almost(after.distance, 1.2f, 0.01f) && !scoreboardOutOfView(after, kPlaced));
      }
      CHECK(placedAgain == 1);
    }
  }
}

// The control's "scoreboard" object as each companion sends it.
void control() {
  Control c;
  // A protocol-4 companion (0.2.44 to 0.2.47): the corner alone → head-locked, as layer 0.7.0 drew it.
  CHECK(!panelPipeReadScoreboard(R"({"mode":"hidden","stereo":"mono","panelPos":"low","theaterScale":1,"camera":null,"scoreboard":{"corner":"top-right"}})", c));
  CHECK(c.scoreboard && !c.scoreboardLeft && !c.scoreboardRoom && !c.scoreboardPlaced);
  // This companion, "fixed in the room".
  CHECK(!panelPipeReadScoreboard(R"({"mode":"hidden","scoreboard":{"corner":"top-left","anchor":"room"}})", c));
  CHECK(c.scoreboard && c.scoreboardLeft && c.scoreboardRoom);
  // "Place it again": the request rides on one control; the state beside it is read as ever.
  CHECK(panelPipeReadScoreboard(R"({"mode":"panel","scoreboard":{"corner":"top-right","anchor":"room","offset":[0.5,0.1,1.2],"widthM":0.4,"place":true}})", c));
  CHECK(c.scoreboardRoom && c.scoreboardPlaced && almost(c.scoreboardOffset[0], 0.5f, 1e-6f) && almost(c.scoreboardOffset[2], 1.2f, 1e-6f) && almost(c.scoreboardWidthM, 0.4f, 1e-6f));
  // "Follows my head" from this companion is the protocol-4 control: no anchor. Any other anchor is head-locked too.
  CHECK(!panelPipeReadScoreboard(R"({"scoreboard":{"corner":"top-right","anchor":"head"}})", c));
  CHECK(c.scoreboard && !c.scoreboardRoom);
  CHECK(!panelPipeReadScoreboard(R"({"scoreboard":{"corner":"top-right","anchor":7,"place":"yes"}})", c));
  CHECK(c.scoreboard && !c.scoreboardRoom);
  // No scoreboard on the control: none, and a stray "place" elsewhere asks for nothing.
  c.scoreboardRoom = true;
  CHECK(!panelPipeReadScoreboard(R"({"mode":"hidden","place":true})", c));
  CHECK(!c.scoreboard && !c.scoreboardRoom);
  CHECK(!panelPipeReadScoreboard(R"({"mode":"hidden","scoreboard":null})", c));
  CHECK(!c.scoreboard && !c.scoreboardRoom);
  // The hello tells the companion the layer reads these keys.
  CHECK(kPipeProtocol == 5);
}

}  // namespace

int main() {
  facing();
  angles();
  cornerRule();
  gazeRule();
  sight();
  hold();
  control();
  if (g_failed) {
    std::printf("scoreboard_place_test: %d of %d checks FAILED\n", g_failed, g_checked);
    return 1;
  }
  std::printf("scoreboard_place_test: %d checks passed\n", g_checked);
  return 0;
}
