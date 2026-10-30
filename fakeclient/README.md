# fakeclient/

**Status (2026-10-18): implemented; the Phase 1 gate test passes in CI.**

```
npm run start -w fakeclient -- local --players 4 --balls 3 --transfer     # whole match in-process, prints RESULT + log heads
npm run start -w fakeclient -- host --players 3 --balls 3 --port 47891    # real host over WebSocket
npm run start -w fakeclient -- join ws://127.0.0.1:47891 --player p2      # one client; --table-hash ff.. to get refused
npx vitest run fakeclient                                                 # scenarios + gate + ws smoke
```

Scenarios live in `scenarios/*.json`; the gate is `src/gate.test.ts`. Host transfer runs over the
in-memory full mesh there, and over real WebSockets on localhost in `src/ws-transfer.test.ts` (A2,
2026-10-30: every participant reconnects to the new host's listener with `RECONNECT`).

A scripted Castcade participant that speaks the protocol with no emulator present. It lets the host
arbiter, the match log, host transfer and the ArcAid result path be tested on Linux CI long before
a real VPX table is connected, and it stays useful afterwards as the opponent in a one-PC match test.

## What lives here

- A CLI that connects to a host (or runs as the host), sends `HELLO` with configurable hashes,
  emits `STATE` at 10 Hz from a scripted score curve, fires `BALL_END` / `GAME_OVER` on cue, and
  signs `LOG_SIGN` with a throwaway keypair.
- Scenario files: a 3-ball 2-player match; a 4-player match with one forced `HOST_TRANSFER`; a hash
  mismatch that must be refused; a `BALL_END` from a non-grant-holder that must be ignored; a client
  that goes silent and triggers `PAUSE`.
- A replay mode that feeds a recorded journal from `fixtures/` through the companion's ball-end
  detector so the detector is tested as a pure function.

## Phase 1 gate (what this must prove)

Four fake clients complete a 3-ball match with correct rotation, one forced host transfer, and
matching log hashes, in CI.

## What does not live here

- Any VPX, RetroArch or NVRAM handling (the fake client never touches an emulator).
- Message schemas (`protocol/`), the real arbiter (`companion/match`).

## Read first

`protocol/README.md`, ADR 0002, and the Phase 1 row of the phases table in
`docs/design/arcaid-integration-gap-analysis.md`.
