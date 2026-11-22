// scoreboard_place_test: the proof of the scoreboard's place in the room that can be had without a headset (D8.12.3,
// 2026-11-21). A console program, built with the layer and run by its build (CMakeLists.txt: a failed check fails the
// build, in CI too); never shipped. It checks the pure parts: the pose maths (src/scoreboard_place.h) and the reading
// of the control's "scoreboard" object (src/panel_pipe.cpp), which is where an older companion and this layer meet.
// What it cannot show: that LOCAL space holds still on a given runtime, and how the place looks.
#include <cmath>
#include <cstdio>
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
  control();
  if (g_failed) {
    std::printf("scoreboard_place_test: %d of %d checks FAILED\n", g_failed, g_checked);
    return 1;
  }
  std::printf("scoreboard_place_test: %d checks passed\n", g_checked);
  return 0;
}
