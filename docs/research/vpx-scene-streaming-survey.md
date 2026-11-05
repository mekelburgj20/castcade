# VPX 10.8.0 scene-streaming feasibility survey (2026-11-04)

**Status:** reference only. Shelved by ADR 0009 (spectating is 2D); WORK item I11. Kept so the question is not
re-researched if the ruling is reopened.

**Question.** A forked VPX where the ACTIVE player's VPX serialises the visible state of the table every frame
(balls, flippers, every animated or visible object property, sound events, DMD frames) and a PUPPET VPX on another
PC, with the same table file loaded, renders that state instead of running its own physics and script: live
spectating of any table (ROM or ROM-less) with native rendering, including VR, with no video.

**Source read.** `github.com/vpinball/vpinball`, release branch `10.8.0` (head `7cdbb55`, 2026-04-03; `vpversion.h`
says 10.8.0 Final). There is no `v10.8.0` tag; the last 10.8.0 build tag is `v10.8.0-2051-28dd6c3`. Read-only; a
scratch clone under `tmp/` (gitignored). Paths below are relative to the VPX repo root.

## 1. The per-frame loop (where a hook goes)

`src/core/player.cpp`. Entry `Player::OnIdle()` (3924). Two loop styles: frame pacing (3929–4036: `PrepareFrame` →
`SubmitFrame` → `Flip` / `FinishFrame`, with `ProcessKeys` + `UpdatePhysics` after each phase) and the legacy loop
(4038–4104: `ProcessKeys` 4049, `UpdatePhysics` 4053, `PrepareFrame` 4055, `SubmitFrame` 4057, optional second
`UpdatePhysics` 4063–4067, `Flip` 4071, `FinishFrame` 4079).

`Player::UpdatePhysics()` (2838) runs 1 kHz physics steps; per step: key events into the script (2982), every script
timer with `m_interval >= 0` (3003–3018, `ACCURATETIMERS` is defined in `stdafx.h:75`), nudge and plunger
(3029–3030), movers (`UpdateVelocities`, 3081–3082: spinner, gate, flipper, plunger, ball), `PhysicsSimulateCycle`
(3085; `UpdateDisplacements` 2717 and hit events).

`Player::PrepareFrame()` (4106): 4137–4147 `UpdateAnimation(diff_time_msec)` on every editable (primitives, reels,
gates, lights, bumper skirts, hit targets), skipped when `m_pause`; 4149–4157 the `-1` (per frame) and `-2`
(controller sync) timers, "after physics and animation update but before rendering"; 4166 `RenderStaticPrepass`;
4186 VR `UpdateVRPosition`; 4212 `RenderDynamics()` (3240: every hitable's `Render`, then every ball's); 4228
`PrepareVideoBuffers()` (post-processing, stereo, VR submit). `FinishFrame()` (4255) frees balls destroyed by script
(4337–4345).

**The hook "after simulation, before render":** `PrepareFrame()` between the end of the timer loop (4157) and
`RenderStaticPrepass()` (4166). All physics steps, script timers and `UpdateAnimation` calls have run; nothing has
been drawn. The sender serialises there; the puppet applies incoming state there and skips `UpdatePhysics` at 4035,
4053, 4066. Precedent: pause mode (comment at 4046; `m_pause` via `RecomputePauseState` 963) renders without input,
physics or script.

## 2. Balls

`src/physics/hitball.h:27` `class Ball : public HitObject`; state `BallS m_d` (17–24: `m_pos`, `m_vel`,
`m_radius`, `m_mass`, `m_lockedInKicker`), `m_angularmomentum` (70), `m_id` (77; monotonic per process,
`hitball.cpp:3-8`), `m_orientation` (80), trails `m_oldpos` (82), visuals `m_visible`, `m_decalMode`, `m_color`,
`m_pinballEnv`, `m_pinballDecal` (86–97). Creation `Player::CreateBall` (`player.cpp:2021-2054`): new `Ball`, COM
wrapper `BallEx`, pushed to `m_vball`, `m_vmover`, `m_vho_dynamic`, octree rebuilt; destruction `Player::DestroyBall`
2056–2082, deferred delete in `FinishFrame`. Callers: `Kicker::CreateBall/CreateSizedBall/CreateSizedBallWithMass`
(`src/parts/kicker.cpp:652-710`), `Kicker::DestroyBall` 712, `Plunger::CreateBall` (`plunger.cpp:1347`),
`Trigger::DestroyBall` (`trigger.cpp:1264`), `BallEx::DestroyBall` (`ball.cpp:834`). Renderer `BallEx::Render`
(`ball.cpp:88-300`) reads `m_visible`, `m_lockedInKicker`, `m_orientation` (256–259), `m_radius`, `m_pos`
(260–261), env/decal textures (270–287); `RenderDynamics` also pushes up to 8 ball positions to shaders for shadows.

## 3. Per-frame visual state per class

Every `Render()` reads the object directly each frame: the design struct `m_d` (also mutated by script) plus a few
runtime members. `UpdateAnimation` is empty for Kicker, Decal, Rubber, Ramp, Flasher, Textbox, Ball.

| Class | State the renderer reads |
|---|---|
| Flipper | `m_phitflipper->m_flipperMover.m_angleCur` (`src/physics/hitflipper.h:45`; `flipper.cpp:853`), `m_visible` (839). Physics-driven. |
| Light | runtime `m_inPlayState` (0..1, 2 = blinking), `m_currentIntensity` (`light.h:156-157`), blink fields, `m_duration/m_finalLightState` (290–295), `m_lockedByLS` (160); `UpdateAnimation` 330–386 fades; `Render` 783; script `put_State` → `setInPlayState` 1626. |
| Flasher | `m_d` (`flasher.h:13-30`: centre, height, colour, rotation, alpha, images A/B, `m_isVisible`, `m_isDMD`), `m_lockedByLS/m_inPlayState` (136), per-flasher `m_texdmd`. |
| Primitive | `m_d.m_vPosition`, `m_vSize`, `m_aRotAndTra[9]` (`primitive.h:58-60`) → `RecalculateMatrices` (680–711); `m_d.m_visible`, `m_szImage`, `m_szMaterial` (`iselect.h:54-68`), normal map, alpha, colour; animation `m_currentFrame/m_speed/m_doAnimation` (341–342); `Render` checks `m_skipRendering` (1288), `m_lockedByLS` (1298); script setters write `m_d` (`put_X` 2382, `put_Image` 2208, `put_Visible` 2353). |
| Rubber / Ramp / Surface | `m_d.m_visible`, images, materials; Rubber height/rotation (`rubber.cpp:1204-1212`); Surface side/top visibility and images (`surface.h:12-29`), runtime `m_isDropped` (166), slingshot `m_iframe/m_TimeReset` (`collideex.h:52-54`). |
| Textbox | `m_d.m_sztext`, box, colours, `m_visible`, `m_isDMD` (`textbox.h:16-25`); `put_Text` sets `m_textureDirty` (629–637); DMD mode draws `g_pplayer->m_texdmd` (423–428). |
| DispReel | `m_reelInfo[MAX_REELS]` (`dispreel.h:161-169`) stepped in `UpdateAnimation` 308+. |
| Gate / Spinner | `m_gateMover.m_angle` (`collideex.h:165`; `gate.cpp:438-443`), `m_spinnerMover.m_angle` (128; `spinner.cpp:419-428`). |
| HitTarget / DropTarget | `m_d.m_isDropped` (`hittarget.h:41`), `m_moveAnimationOffset`, `m_moveAnimation`, `m_moveDown`, `m_timeStamp` (205–208). |
| Bumper | `m_pbumperhitcircle->m_bumperanim_ringAnimOffset` (`collideex.h:21`; `bumper.cpp:379`), skirt `m_skirtCounter/m_doSkirtAnimation` (`bumper.h:126-131`), the four `m_d.*Visible`. |
| Trigger | `m_animHeightOffset` (`trigger.h:132`), `m_d.m_visible`. |
| Plunger | `m_plungerMover.m_pos` (`hitplunger.h:47`) → sprite frame (`plunger.cpp:853/1070`). |
| Player | nudge offset `SetScreenOffset` / `m_tableDisplacement` (`player.cpp:3063-3069`), `m_texdmd` (§6). |

**No generic enumeration.** Three partial mechanisms exist: BIFF save/load (`SaveData` / `LoadToken` per class, e.g.
`flipper.cpp:874-960`; the undo system snapshots a live editable with it, `pinundo.cpp:228`), which covers `m_d`
only; COM type info (23 `IDispatchImpl` classes, 609 `propput` / 667 `propget` in `vpinball.idl`; `disputil.cpp:11-24`
walks `ITypeInfo`), slow and not tied to what the renderer reads; the editor→live copy (`ieditable.h:171`,
`m_startupToLive`), per class. A serialiser is per class against the table above. Stable ids: `IEditable::m_wzName`
(`ieditable.h:47`) plus the index in `m_ptable->m_vedit`; balls by `Ball::m_id`.

## 4. Script hosting

`CodeViewer::InitializeScriptEngine` (`codeview.cpp:634-688`): `CoCreateInstance(CLSID_VBScript)`; `Compile`
(1460–1495) sets `SCRIPTSTATE_INITIALIZED`, adds the type library and every scriptable as a named item, parses;
`Start` (1497–1506) sets `SCRIPTSTATE_CONNECTED`. `PinTable::Play` (`src/parts/pintable.cpp:2098`) compiles at 2306
and continues only without a script error (2308); `Player::Init` starts the script at `player.cpp:1691` and fires
`Init` and the initial `Animate` events (1694–1706).

**Running without the script:** skip `Compile` / `Start` and the Init events; everything else in `Player::Init` is
independent of the script. Consequences: no `Table_Init` side effects (the puppet needs a full keyframe), timers and
key events become no-ops (`FireGroupEvent` iterates connection points, `eventproxy.h:58-89`), and **the VPinMAME
controller never exists**, because the script creates it (VPX has no reference to it: the only first-party hit is a
window-on-top hack at `player.cpp:4412`). A script-less puppet has no ROM, no VPinMAME DMD, no ROM sound.

**No single dispatch point** for script→VPX calls (per-class ATL `Invoke` → concrete setters). The one central
outbound point is `EventProxyBase::FireVoidEvent/FireVoidGroupEvent` (`eventproxy.h:10-89`). Capturing state at the
§1 hook is therefore the design, not intercepting calls.

## 5. Sound

`PinTable::PlaySound(name, loopcount, volume, pan, randompitch, pitch, usesame, restart, front_rear_fade)`
(`pintable.cpp:6961-6996`) → `m_vpinball->m_ps.Play(...)` (6993; `AudioMusicPlayer`, `src/audio/pinsound.h:237-276`,
DirectSound). `StopSound` 6946, `StopCopiedWavs` 6957. Music: `ScriptGlobalTable::PlayMusic` (193) →
`g_pplayer->m_audio->MusicInit` (205; BASS, proprietary, free for non-commercial use, `txt/license.txt:72-76`),
`EndMusic` 215, `MusicVolume` 227. Two choke points carry every script sound, mechanical sounds included; the puppet
has the same `.vpx`, so names resolve. Not covered: VPinMAME ROM audio (another process).

## 6. DMD and backglass

`Player::m_texdmd` (`player.h:758`, size `m_dmd` 757) filled by `ScriptGlobalTable::put_DMDWidth/Height/DMDPixels/
DMDColoredPixels` (`pintable.cpp:967-1070`; `SetDirty` 1022); per-flasher `Flasher::put_DMDPixels/DMDColoredPixels`
(`flasher.cpp:833/879`). Consumers: `Textbox::Render` in DMD mode (`textbox.cpp:423-462`), `Flasher::Render`
(`flasher.cpp:1219`). This is the `UseVPMDMD = True` path and the UltraDMD / FlexDMD-in-VPX path: capturable per
frame at `put_DMDPixels`. Otherwise the VPinMAME DMD is a window VPinMAME owns. The GL/VR build only
(`captureExt.cpp:9-22`) DXGI-captures windows titled "Virtual DMD", "pygame", "PUPSCREEN1", "formDMD",
"PUPSCREEN5" into `m_texdmd` and B2S / PUP windows into `m_texPUP` (started from `Player::Init` 1679–1686 when
`m_capExtDMD/m_capPUP`, updated in `SubmitFrame` 4250–4252). B2S: `backGlass.cpp` reads `DirectB2SData` only to
pick a background image for the VR backglass; the real server is external.

## 7. VR

`src/renderer/RenderDevice.cpp`: `isVRinstalled/isVRturnedOn` (2040–2066), `vr::VR_Init` (2082–2097), eye sizes
and projections (2137–2143), `UpdateVRPosition` (2195–2235), `SubmitVR` (1838). Player: `PrepareFrame` 4186,
4172–4176 (clear instead of the static-prepass blit), `PrepareVideoBuffers` 3777–3829 (per-eye targets → preview
blit → `SubmitVR`). `ENABLE_VR` only under `ENABLE_SDL` (`stdafx.h:110-113`), i.e. the GL build
(`cmake/CMakeLists_gl-win-x64.txt`, `openvr_api.lib` at 607). OpenVR only (matches the owner's OpenComposite setup).
The VR path consumes the same render lists and reads nothing from physics or the script: a puppet that skips both but
runs `PrepareFrame/SubmitFrame/FinishFrame` renders normally in VR. The headset runs at 72–120 Hz against the
sender's frame rate; the puppet must interpolate or extrapolate balls, flippers, gates, spinners from the streamed
positions and velocities.

## 8. Build and licence

CMake, one list per target in `cmake/` (`CMakeLists_win-x64.txt`, `_win-x86`, `_gl-win-x64`, `_gl-win-x86`), copied
to `CMakeLists.txt` by CI; C++20; the DX9 build needs the June 2010 DirectX SDK; the GL build defines
`ENABLE_INI_SETTINGS ENABLE_SDL_INPUT ENABLE_SDL USE_DINPUT8`. `.github/workflows/vpinball.yml` (`on: push`):
`build` (windows-2025, win-x64 / win-x86 × Release / Debug, `VPinballX64.exe`) and `build-gl` (`VPinballX_GL64.exe`);
`prerelease.yml` is a manual packaging job. A fork gets Windows x64 DX9 + GL/VR builds from CI with no local
compiler. No unit tests. **Licence** (`LICENSE`): mixed. Files whose first line is `// license:GPLv3+` are GPLv3+ (64
first-party files, `src/core/player.cpp` among them); unmarked files (`src/parts/pintable.cpp`, `codeview.cpp`,
`src/renderer/RenderDevice.cpp`, …) stay under the inherited old MAME-like licence (non-commercial redistribution).
Third party: BASS (proprietary, free non-commercial), OpenVR (BSD). A Castcade fork's binary inherits the
non-commercial clause from the unmarked files.

## 9. Existing capture or replay

Nothing usable: `stdafx.h:85-86` `//#define PLAYBACK // bitrotted` (a physics-frame-time replay from
`c:\badlog.txt`, `Player::ParseLog` 4793–4815); `BlackBox.*` is a crash ring buffer. Nearest precedents: the undo
serialiser (`pinundo.cpp:228`) and the editor→live copy (`PinTable::Play`, `m_startupToLive`).

## Interception points for a scene-streaming fork

Sender: `Player::PrepareFrame()` after 4157 (serialise `m_time_msec`, every ball, the nudge offset, every editable's
runtime state from §3 by `GetItemType()`); `Player::CreateBall` 2021 / `DestroyBall` 2056 (events, or derive from the
ball list by `m_id`); `PinTable::PlaySound` 6961, `StopSound` 6946, `StopCopiedWavs` 6957, `ScriptGlobalTable::
PlayMusic` 193, `EndMusic` 215, `MusicVolume` 227 (events); `put_DMDWidth/Height/DMDPixels/DMDColoredPixels`
967–1070 and `Flasher::put_DMDPixels/DMDColoredPixels` 833/879 (DMD frames, delta/RLE).

Puppet: `PinTable::Play` 2306 (skip `Compile`), `Player::Init` 1691–1706 (skip `Start` and the Init/Animate events),
`OnIdle` 4031–4036 / 4049–4053 / 4063–4067 (skip input and physics), `PrepareFrame` 4137–4157 (replace the
`UpdateAnimation` loop with "apply the latest network state": write the fields in §3, set the regenerate flags,
create/destroy balls through `Player::CreateBall/DestroyBall`, interpolate toward the next sample). Transport: a new
module, or a local pipe to the companion, which already has a WebRTC data channel; keyframe on join and periodically,
deltas between.

## What is not reachable

Anything in another process: the VPinMAME DMD window and all ROM sound (only `DMDPixels` the script copies is inside
VPX), the B2S server, PuP packs (the VR build's window capture is a workaround, not a data path), FlexDMD unless routed
through `DMDColoredPixels`. Script variables and script-created COM objects (score, player, modes): only their visible
effects are captured. Per-class fields a serialiser could miss (material and image edits through the table APIs,
`Light` colours, ball decal swaps, LightSeq locks): all plain fields, so reachable, but each is a line to write; the
risk is completeness, not access.

## Size and effort

Full snapshot 8–15 KB for a modern table; change-only deltas with quantisation under 1 KB a frame (60–100 KB/s at
60–90 Hz); mono DMD 4 KB raw a frame, coloured 16 KB, both compressible; sound events negligible; keyframes of
15 KB every few seconds. First proof (sender + puppet, one or two tables, no handoff): about 8–10 engineer-weeks on
CI builds only (fork + CI 1 wk; serialiser + sound/DMD hooks 2–3 wk; puppet mode 3 wk; transport + keyframes 1–2 wk;
VR validation 1 wk). "Works on most tables" is two to three times that.

Risks: (1) completeness of the per-class serialiser (no reflection; 609 `propput`s); (2) ROM tables lose their DMD and
sound on a script-less puppet unless the script pushes `DMDPixels`, and ROM audio is never in VPX; (3) temporal
quality in VR (interpolation, kicker captures, 1–3 frames of jitter buffer); (4) licence: mixed GPLv3+ / old-MAME
tree plus proprietary BASS; the binary inherits the non-commercial clause; GL build only for VR.
