# ADR 0008 — A sanctioned VPX build for Sanctioned play; Castcade stays the app for everything else

**Status:** Accepted (2026-10-30); design, timing and the trust mechanism are open items (WORK section I)
**Owner rulings:** 2026-10-30, "creating our own VPX fork that lets us control from within the actual VPX build so we
can have 100% guarantee no one is messing with the unfair play settings. This will be a sanctioned build that is used
for sanctioned tournaments. This does not negate the need for Castcade which can be used for open play and all other
play. Then in sanctioned play, we can use the VPX build as a requirement for score submission to ArcAid sanctioned
play. We will trust the signature/fingerprint of this build, as well as the Legends Unchained build from Mox's." Not
reopened without asking.
**Builds on:** ADR 0001 (script hook on stock VPX 10.8.0), ADR 0003 (one desktop app), ADR 0005 (Open / Sanctioned
play), ADR 0007 (functionality before ease of setup); ArcAid ADR 0027 (integrity mode)
**Design:** `docs/design/fairness-and-table-identity.md` §5 (the honest ceiling), §6 (build hashes); the build's own
design doc is WORK item I1

## Context

Everything Castcade measures for Sanctioned play (`docs/design/fairness-and-table-identity.md`: table identity,
playfield fingerprint, ini attestation, NVRAM adjustments, engine values from the live hook, script inspection,
build hashes) is measured *from outside* VPX by the companion, and the companion runs on the player's machine. §5
names the ceiling plainly: a modified Castcade, or a modified VPX whose binary still reports a known family, can lie,
and §6 says build families other than `official` are "declared by the binary, not proven". Signed official companion
builds at GA raise the bar; they do not close it. The owner wants the bar closed for the strict arena: a build of VPX
itself that cannot be put into an unfair state, so that "the build ran" is the proof.

The cabinet side already has this shape. The AtGames Legends cabinets run Mox's **Legends Unchained** fork, a closed
build the player cannot alter, and ArcAid's cabinet Witness trusts what it reports. VPX 10.8.0 is GPLv3, so a desktop
fork must publish its source; its trust therefore cannot come from secrecy, only from the identity of the binary we
ship (signature, hash, a build id baked in) and from what that binary refuses to do.

## Decision

### 1. Two trusted builds for Sanctioned play

A Sanctioned tournament may require that the play ran on a **trusted build**: Castcade's own **sanctioned VPX build**
(a fork of VPX 10.8.x) on the desktop, or **Legends Unchained** (Mox's) on the cabinet. ArcAid trusts the signature
or fingerprint of those two builds and nothing else for that rule. The rule is per tournament and sits beside the
existing Sanctioned rules (ADR 0005), not instead of them.

### 2. What the sanctioned build is

A fork whose Sanctioned mode is enforced inside the process: the settings a player could use to cheat (physics
overrides, difficulty, ini keys the fairness doc lists, VPinMAME's cheat flag, machine adjustments beyond a factory
reset) are locked or fixed while a Sanctioned game runs, and the fairness evidence Castcade gathers from outside today
is produced from inside the build and carried on the score. The build identifies itself to ArcAid in a way a stock or
modified VPX cannot fake cheaply: a signed binary plus an attestation that ArcAid can verify (mechanism: item I4).

### 3. Castcade stays, and stays primary for everything else

Open play, room boards, the Global Scoreboard, streaming, recording, matches, voice and every tester who runs stock
VPX keep using Castcade exactly as today (ADR 0003, ADR 0005 "badge, never gate"). The sanctioned build is a
requirement only where a runner turns it on. The script hook (ADR 0001) remains the producer on stock VPX; inside
the sanctioned build the same journal format is written natively, so the companion's detector, posting path and
evidence vocabulary are reused, never duplicated (ADR 0003's rule: shared contract and vocabulary, not code).

### 4. Honest ceiling, restated

Open source means anyone can build the fork with a change. The guarantee therefore rests on (a) only our signed
binary carrying the identity ArcAid trusts, (b) that identity being bound to the report in a way that a rebuilt
binary cannot reproduce without the signing material, and (c) the build refusing the unfair states. (b) is where the
design effort goes (I4); until it exists, "trusted build" is a stronger `engine` family check, not a proof, and the
docs must say so.

## Consequences

### Easier
- A Sanctioned ruling becomes "ran on the trusted build" instead of a stack of flags a runner has to read.
- Evidence gathered in-process is complete where the companion's is best-effort (ini keys set at runtime, the live
  engine values, machine adjustments before the game).
- The cabinet and desktop arenas get the same rule shape: one trusted build each.

### Harder
- A C++ fork of VPX to maintain against upstream releases, build and sign (code signing, E2, becomes a prerequisite
  rather than a GA nicety). A separate repository; the VPX build chain is not this repo's toolchain.
- GPLv3 obligations for the fork (source with every release), as for the bundled ffmpeg (E5).
- Players in Sanctioned tournaments install a second VPX. ADR 0007 applies: guide it, never drop the requirement.
- The Legends Unchained half depends on Mox: a build identity (hash list or signature) we can verify.

### Locked out
- Trusting any other community build (Panasony VR, nightlies) for the trusted-build rule. They stay allowed in
  Sanctioned play where a tournament does not turn the rule on (owner ruling 2026-10-19 stands for that case).
- Making the sanctioned build the only path: Castcade on stock VPX stays supported for everything except that rule.

## Alternatives rejected
- **Signed Castcade only.** The companion still measures from outside; a modified VPX under a signed companion is the
  ceiling §5 describes. Rejected as insufficient for the strict arena; it remains the Open-play answer.
- **A hash allowlist of community builds.** Proves which binary a stock build reports as, not what it does; the
  owner's "100 % guarantee" needs enforcement inside the process.
- **A VPX plugin (10.8.1+).** Deferred by ADR 0001; a plugin also runs inside a binary we do not control, so it
  cannot stop the host from lying about it.
