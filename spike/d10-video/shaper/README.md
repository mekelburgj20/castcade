# shaper — the D10.0.1 bandwidth shaper (Node ≥ 22, no dependencies)

```
node spike/d10-video/shaper/shaper.mjs --s 5000 --c 5001 --schedule 20000:30,2000:20,20000:40 --log results/<run>-shaper.csv --start-on-first-packet
```

A two-sided UDP relay. Port **S** faces the sender, port **C** faces the receiver, both on 0.0.0.0. The first
datagram on S from address X makes X the sender peer; the first on C from Y makes Y the receiver peer. S→C is
rate-limited by a token bucket following `--schedule kbps:seconds,...` (the last rate holds; no looping) with a
queue bounded to 150 ms of bytes at the current rate, tail-drop beyond, plus `--loss <pct>` random drops. C→S
(the receiver's RTCP: receiver reports, NACKs, PLIs, TWCC feedback) is unlimited. One CSV line a second to
stderr and `--log`: `t,rate_kbps,fwd_kbps,dropped,queued_ms` (`queued_ms` is that second's deepest queue;
`dropped` counts both tail drops and random loss). `--start-on-first-packet` starts the schedule clock when the
first S→C datagram arrives instead of at launch, so `t` lines up with the candidates' own clocks.

Pacing caveat: Windows gives Node 15.6 ms timers (measured here for `setTimeout(1)` and `Atomics.wait`), so
while the queue is non-empty the drain runs on a `setImmediate` loop (sub-millisecond, one core busy); with an
empty queue forwarding is arrival-driven and the process idles. The bucket's burst allowance is 5 ms of the rate.

## Routing a candidate through it

The shaper is a NAT between the two peers, nothing more: each side keeps talking to one address, which is the
shaper's port facing it.

1. Each side binds exactly **one** UDP socket (its real host candidate, e.g. `127.0.0.1:61000`).
2. The SDP each side hands to the other keeps **only one** `a=candidate:` line, that host candidate, with the
   **port replaced by the shaper port facing the other side** and the IP left as it was:
   - the sender's SDP (given to the receiver) names port **C**;
   - the receiver's SDP (given to the sender) names port **S**.
   Trickle candidates are dropped (never signalled).
3. The sender then sends everything to `ip:S`; the shaper forwards it out of C to the receiver, which sees it
   arriving from `ip:C`, its one remote candidate, and answers to `ip:C`; that goes out of S back to the sender.
   ICE sees a symmetric NAT on each side (the STUN mapped address is the shaper's port), learns a peer-reflexive
   local candidate and nominates it; DTLS and SRTP are unaffected.
4. The first connectivity checks may be dropped until both peers have sent once (the shaper forwards only to a
   peer it has seen); ICE retransmits, so the connection comes up a round trip or two later than direct.

The spike's candidates do steps 1–2 themselves when run with `--shaper S:C` (see `str0m/`).
