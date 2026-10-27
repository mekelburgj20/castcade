# ADR 0007 — Functionality before ease of setup

**Status:** Accepted (2026-10-27)
**Owner rulings:** 2026-10-27, "Desired functionality is more important than ease of install/setup. VPX users are
used to having to configure complex apps to get things to work. I do want to make install and setup as easy as
possible without sacrificing the desired outcome." Not reopened without asking.

## Context

Tester Krobs, on the multiplayer stream URL (WORK item D5): "would it be a simple process or would we need a special
vpx setup? I know on VR Pinball group their working on similiar system but it looked kinda confusing." Several open
designs trade a capability against setup steps:

- D2 match streaming runs WebRTC between players' machines. Some home networks block a direct connection even with
  STUN; the fallbacks are a TURN relay or the player opening a port on their router.
- VR players stream only with VPX's `VRPreview` window on (D1.0, `docs/design/solo-streaming-and-recording.md`).
- D5's open question: an ArcAid watch page fed by the host, a Twitch / YouTube push of the host's composite, or both.
- Live scores already need a one-time per-table patch (ADR 0004, C8 "Patch my tables").

## Decision

1. When a capability and a setup step conflict, keep the capability. Do not cut multiplayer streaming, voice, live
   scores or fairness evidence to remove a setup step.
2. Spend the effort on the setup instead: automate it where possible (one click, like "Patch my tables"); where it
   can't be automated, detect the problem and say exactly what to change (a check on Status, a guided step).
3. Tell testers and players "guided setup", never "no setup".

## Consequences

### Easier
- D2 can ask for a router port when STUN and TURN both fail, instead of giving up on the match.
- D5 can offer both the ArcAid watch page and a Twitch / YouTube push.
- VR streaming can require `VRPreview` on.

### Harder
- Every required setup step needs a check that names the fix; that is product work (WORK item D6).

### Locked out
- Nothing. This ruling does not reopen ADR 0001 (VPX 10.8.0, script hook): that target follows which VPX version
  players run, not how much setup is asked of them.

## Alternatives rejected

- **Simplest setup wins**: cuts features VPX players expect (VR streaming, matches across home networks) to save
  steps those players are used to doing.
