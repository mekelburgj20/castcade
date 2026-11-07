// castcade-video self tests (the CI smoke): the frame ring produced and consumed in one process, and two in-process
// peers streaming the bench picture to each other through real libwebrtc on the loopback adapter.
#pragma once

// `--ring-selftest`: a send ring as producer, consumed in the same process at 60 fps for 3 s; prints produced /
// consumed / skipped. Non-zero when the counts do not add up.
int RunRingSelftest();

// `--loopback-selftest`: two peers in one process (bench source → encoder → libwebrtc → decoder, no rings) for
// `seconds`; prints the receiver's fps and kbps once a second and a summary. Non-zero when nothing arrived.
int RunLoopbackSelftest(int seconds);

// `--window-selftest`: opens the sink window and feeds it the bench picture at 60 fps for `seconds`; prints the
// presented count and the mean upload / upload+present time. `warp` skips the hardware device (what a GPU-less CI
// runner falls back to on its own). Non-zero when the window did not open or nothing was presented.
int RunWindowSelftest(int seconds, bool warp);
