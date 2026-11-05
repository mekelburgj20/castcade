# Letter to basbi (VPX Duo) — I10's first step

Owner ruling 2026-11-05: yes, write to him. The owner sends this from his own VPForums account, as a private
message to **basbi** or a reply in topic 58028 ("VPX Duo: Head-to-head online multiplayer Visual Pinball X").
Edit freely; the ask is the modified VPinMAME source and a conversation, not a licence dispute.

---

Hi basbi,

I'm Justin, the person behind Castcade (https://github.com/mekelburgj20/castcade, GPLv3) and ArcAid
(https://arcaid.app): remote alternating-turn pinball on the same VPX table, with turn handoff, spectating,
voice and tournament scoring. I saw your VPX Duo thread and the video. It's great work, and it solves the
one thing we can't solve from the outside.

What we do today: each player runs the table in their own VPX, Castcade hands the turn around and streams
the player up to the others as video. That works, but every player has their own machine, so the DMD, the
bonus and the end-of-game sequence are per player, not one shared game. Your approach of streaming the state
and migrating the VPinMAME machine between PCs at ball end is exactly what makes it one game. We'd like to
build on it rather than reinvent it.

Would you be willing to share the source of your modified VPinMAME64.dll (and your VPX changes, if you're
open to it)? Both projects are source-available by licence, VPX under GPLv3 and PinMAME under the MAME
licence, so a binary release normally comes with its source anyway, but I'd much rather ask than point at a
licence. We'd credit you, keep the fork public, and send fixes back. If you'd prefer to keep it under your
own roof, I'd still value a conversation about the design.

The questions I'd most like to ask, if you have the time:

1. How do you serialise the machine state for the migration: MAME's save-state machinery, a raw RAM plus CPU
   context capture, or something else? Which platforms work today (WPC only, or also Sys11 / DCS / SAM)?
2. How do you capture switch changes at sub-frame timing on the sender, and replay them on the receiver?
3. How do you keep the two VPX physics simulations in step, or do you not need to because only the player
   up runs physics?
4. Do you fence the migration at a safe point in the emulation (a time fence, a VBlank), or is a mid-frame
   snapshot good enough in practice?

Happy to talk here, on Discord, or by email. Thanks for putting VPX Duo out there.

Justin (MekelburgJ)
