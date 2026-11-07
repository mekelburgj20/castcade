// castcade-video self tests (the CI smoke): the frame ring produced and consumed in one process, and two in-process
// peers streaming the bench picture to each other through real libwebrtc on the loopback adapter.
#pragma once

// `--ring-selftest`: a send ring as producer, consumed in the same process at 60 fps for 3 s; prints produced /
// consumed / skipped. Non-zero when the counts do not add up.
int RunRingSelftest();

// `--loopback-selftest`: two peers in one process (bench source → encoder → libwebrtc → decoder, no rings) for
// `seconds`; prints the receiver's fps and kbps once a second and a summary. Non-zero when nothing arrived.
int RunLoopbackSelftest(int seconds);
// D10.5: the rung controller, the ladder's geometry and the decimator through scripted input sequences (no libwebrtc).
int RunControllerSelftest();
