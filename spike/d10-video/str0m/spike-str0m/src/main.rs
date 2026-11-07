//! spike-str0m: the Rust + str0m candidate of the D10.0.1 spectator-video spike (spike/d10-video/README.md).
//! Two str0m peers in one process, a sender thread and a receiver thread, one UDP socket each, SDP exchanged in
//! memory (optionally rewritten to route through the shaper, shaper/README.md). The sender encodes the harness's
//! synthetic 1354x1440 playfield at 60 fps and follows str0m's bandwidth estimate; the receiver decodes and reads
//! the burned-in frame counter. One CSV line a second each into results/<stamp>-str0m-{sender,receiver}.csv.
//!
//!   spike-str0m [--duration 90] [--shaper S:C] [--harness <dll>] [--results <dir>] [--ip 127.0.0.1]
//!               [--encoder <name>] [--decoder <name>] [--start-kbps 20000] [--print-sdp]
mod harness;

use std::fs::File;
use std::io::{ErrorKind, Write};
use std::net::{SocketAddr, UdpSocket};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime};

use str0m::bwe::{Bitrate, BweKind};
use str0m::change::{SdpAnswer, SdpOffer};
use str0m::format::Codec;
use str0m::media::{Direction, Frequency, KeyframeRequestKind, MediaKind, MediaTime, Mid};
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, IceConnectionState, Input, Output, Rtc};

use harness::{Decoder, Encoder, Harness, Source};

const W: i32 = 1354;
const H: i32 = 1440;
const FPS: u64 = 60;
const CAP_KBPS: u64 = 20000; // the ladder's top rung
const FLOOR_KBPS: u64 = 1500;

#[link(name = "winmm")]
unsafe extern "system" {
    fn timeBeginPeriod(period: u32) -> u32;
}

struct Opts {
    duration: u64,
    shaper: Option<(u16, u16)>,
    harness: PathBuf,
    results: PathBuf,
    ip: String,
    encoder: Option<String>,
    decoder: Option<String>,
    start_kbps: u64,
    print_sdp: bool,
}

fn parse_opts() -> Opts {
    let mut o = Opts {
        duration: 90,
        shaper: None,
        harness: PathBuf::from(r"..\harness\build\Release\castcade_spike_harness.dll"),
        results: PathBuf::from(r"..\results"),
        ip: "127.0.0.1".into(),
        encoder: None,
        decoder: None,
        start_kbps: CAP_KBPS,
        print_sdp: false,
    };
    // Relative defaults are resolved against this crate's folder, so the exe runs from anywhere.
    let here = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    o.harness = std::path::absolute(here.join(&o.harness)).unwrap();
    o.results = std::path::absolute(here.join(&o.results)).unwrap();
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        let mut val = || args.next().unwrap_or_else(|| panic!("{a} needs a value"));
        match a.as_str() {
            "--duration" => o.duration = val().parse().expect("--duration seconds"),
            "--shaper" => {
                let v = val();
                let (s, c) = v.split_once(':').expect("--shaper S:C");
                o.shaper = Some((s.parse().expect("port S"), c.parse().expect("port C")));
            }
            "--harness" => o.harness = PathBuf::from(val()),
            "--results" => o.results = PathBuf::from(val()),
            "--ip" => o.ip = val(),
            "--encoder" => o.encoder = Some(val()),
            "--decoder" => o.decoder = Some(val()),
            "--start-kbps" => o.start_kbps = val().parse().expect("--start-kbps"),
            "--print-sdp" => o.print_sdp = true,
            _ => {
                eprintln!("unknown argument {a}");
                std::process::exit(2);
            }
        }
    }
    o
}

/// Keeps the first `a=candidate:` line only and, through the shaper, swaps its port for the shaper's (shaper/README.md).
fn rewrite_candidates(sdp: &str, port: Option<u16>) -> String {
    let mut out = String::new();
    let mut kept = false;
    for line in sdp.lines() {
        if line.starts_with("a=candidate:") {
            if kept {
                continue;
            }
            kept = true;
            if let Some(p) = port {
                let mut toks: Vec<String> = line.split(' ').map(String::from).collect();
                toks[5] = p.to_string(); // candidate:<f> <comp> <proto> <prio> <ip> <port> typ host
                out.push_str(&toks.join(" "));
                out.push_str("\r\n");
                continue;
            }
        }
        out.push_str(line);
        out.push_str("\r\n");
    }
    out
}

fn stamp() -> String {
    // UTC yyyymmdd-hhmmss from the Unix time (Howard Hinnant's civil-from-days), no time crate.
    let secs = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_secs() as i64;
    let (days, rem) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}{m:02}{d:02}-{:02}{:02}{:02}", rem / 3600, rem % 3600 / 60, rem % 60)
}

static SEND_FAILS: AtomicU64 = AtomicU64::new(0); // datagrams the OS refused (would be invisible loss otherwise)

/// Drives one Rtc's outputs: sends datagrams, hands events to `on_event`, returns str0m's next timeout.
fn drive(rtc: &mut Rtc, sock: &UdpSocket, on_event: &mut dyn FnMut(&mut Rtc, Event)) -> Result<Instant, String> {
    loop {
        match rtc.poll_output().map_err(|e| format!("poll_output: {e}"))? {
            Output::Transmit(t) => {
                if let Err(e) = sock.send_to(&t.contents, t.destination) {
                    if e.kind() != ErrorKind::WouldBlock && e.kind() != ErrorKind::ConnectionReset {
                        return Err(format!("send_to {}: {e}", t.destination));
                    }
                    SEND_FAILS.fetch_add(1, Ordering::Relaxed);
                }
            }
            Output::Timeout(t) => return Ok(t),
            Output::Event(e) => on_event(rtc, e),
        }
    }
}

/// Waits for one datagram until `deadline` (socket read timeouts have 1 ms granularity; the last stretch spins).
fn wait_input(rtc: &mut Rtc, sock: &UdpSocket, local: SocketAddr, buf: &mut [u8], deadline: Instant) -> Result<(), String> {
    let now = Instant::now();
    let remaining = deadline.saturating_duration_since(now);
    let n_src = if remaining >= Duration::from_millis(1) {
        sock.set_nonblocking(false).ok();
        sock.set_read_timeout(Some(remaining)).ok();
        sock.recv_from(buf)
    } else {
        sock.set_nonblocking(true).ok();
        let r = sock.recv_from(buf);
        if r.is_err() {
            while Instant::now() < deadline {
                std::hint::spin_loop();
            }
        }
        r
    };
    match n_src {
        Ok((n, source)) => {
            if let Ok(contents) = buf[..n].try_into() {
                let input = Input::Receive(Instant::now(), Receive { proto: Protocol::Udp, source, destination: local, contents });
                rtc.handle_input(input).map_err(|e| format!("handle_input: {e}"))?;
            }
        }
        Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::ConnectionReset) => {}
        Err(e) => return Err(format!("recv_from: {e}")),
    }
    Ok(())
}

#[link(name = "ws2_32")]
unsafe extern "system" {
    fn setsockopt(s: usize, level: i32, optname: i32, optval: *const i32, optlen: i32) -> i32;
}

fn bind(ip: &str) -> (UdpSocket, SocketAddr) {
    use std::os::windows::io::AsRawSocket;
    let sock = UdpSocket::bind(format!("{ip}:0")).expect("bind udp");
    // 4 MB socket buffers: Windows' 64 KB default holds 25 ms of a 20 Mbps stream, less than one decode stall.
    let size: i32 = 4 << 20;
    for opt in [0x1002 /* SO_RCVBUF */, 0x1001 /* SO_SNDBUF */] {
        unsafe { setsockopt(sock.as_raw_socket() as usize, 0xffff /* SOL_SOCKET */, opt, &size, 4) };
    }
    let addr = sock.local_addr().unwrap();
    (sock, addr)
}

fn new_rtc(start_kbps: Option<u64>) -> Rtc {
    let mut b = Rtc::builder().set_stats_interval(Some(Duration::from_secs(1))).clear_codecs().enable_h264(true);
    if let Some(k) = start_kbps {
        b = b.enable_bwe(Some(Bitrate::kbps(k)));
    }
    b.build(Instant::now())
}

struct SenderStats {
    frames: u64,
    bytes: u64,
    cost_sum: i64,
    rtt_ms: f64,
    loss_pct: f64,
    bwe_kbps: u64,
    nacks: u64,
    plis: u64,
    firs: u64,
    keyframes: u64,
}

fn run_sender(mut rtc: Rtc, sock: UdpSocket, local: SocketAddr, mid: Mid, h: Arc<Harness>, opts: &Opts, epoch: Instant, csv: &mut File) -> Result<String, String> {
    let src = Source::open(&h, W, H)?;
    let mut enc = Encoder::open(&h, W, H, FPS as i32, opts.start_kbps as i32, opts.encoder.as_deref())?;
    let encoder_name = enc.name.clone();
    eprintln!("sender: encoder {encoder_name}, local {local}");
    let mut nv12 = vec![0u8; src.frame_bytes];
    let frame_interval = Duration::from_nanos(1_000_000_000 / FPS);
    let end = epoch + Duration::from_secs(opts.duration);
    let mut next_frame: Option<Instant> = None;
    let mut frame_n: u64 = 0;
    let mut target_kbps = opts.start_kbps.clamp(FLOOR_KBPS, CAP_KBPS);
    let mut last_change = Instant::now();
    let mut want_keyframe = false;
    let mut connected = false;
    let mut pt = None;
    let mut s = SenderStats { frames: 0, bytes: 0, cost_sum: 0, rtt_ms: 0.0, loss_pct: 0.0, bwe_kbps: target_kbps, nacks: 0, plis: 0, firs: 0, keyframes: 0 };
    let mut next_log = epoch + Duration::from_secs(1);
    let mut buf = vec![0u8; 2000];
    writeln!(csv, "t,encoder,fps_sent,kbps_sent,target_kbps,enc_cost_us_avg,rtt_ms,loss_pct,bwe_kbps").ok();
    let mut pending_target: Option<u64> = None;

    loop {
        let timeout = drive(&mut rtc, &sock, &mut |rtc, e| match e {
            Event::Connected => {
                connected = true;
                next_frame = Some(Instant::now());
                rtc.bwe().set_bitrate(Bitrate::kbps(target_kbps), Bitrate::kbps(CAP_KBPS));
                eprintln!("sender: connected at t={:.2}", epoch.elapsed().as_secs_f64());
            }
            Event::IceConnectionStateChange(st) => {
                eprintln!("sender: ice {st:?}");
                if st == IceConnectionState::Disconnected {
                    rtc.disconnect();
                }
            }
            Event::EgressBitrateEstimate(BweKind::Twcc { estimate, .. }) => {
                s.bwe_kbps = estimate.as_u64() / 1000;
                pending_target = Some(s.bwe_kbps.clamp(FLOOR_KBPS, CAP_KBPS));
            }
            Event::EgressBitrateEstimate(_) => {}
            Event::KeyframeRequest(req) => {
                want_keyframe = true;
                match req.kind {
                    KeyframeRequestKind::Pli => s.plis += 1,
                    KeyframeRequestKind::Fir => s.firs += 1,
                }
            }
            Event::MediaEgressStats(st) => {
                if let Some(r) = st.rtt {
                    s.rtt_ms = r.as_secs_f64() * 1000.0;
                }
                if let Some(l) = st.loss {
                    s.loss_pct = l as f64 * 100.0;
                }
                s.nacks = st.nacks;
            }
            _ => {}
        })?;
        if !rtc.is_alive() {
            return Err("sender: rtc died".into());
        }
        // Bitrate policy: follow the estimate, but each nvenc reconfigure costs an IDR, so move only on a
        // >= 10 % change and at most once a second, except a drop of >= 30 % which applies at once.
        if let Some(t) = pending_target.take() {
            let diff = t.abs_diff(target_kbps) as f64 / target_kbps as f64;
            let down_hard = t < target_kbps && diff >= 0.30;
            if t != target_kbps && (down_hard || (diff >= 0.10 && last_change.elapsed() >= Duration::from_secs(1))) {
                target_kbps = t;
                last_change = Instant::now();
                enc.set_bitrate(t as i32);
                rtc.bwe().set_bitrate(Bitrate::kbps(t), Bitrate::kbps(CAP_KBPS));
            }
        }
        let now = Instant::now();
        if now >= end {
            break;
        }
        if let Some(nf) = next_frame {
            if now >= nf {
                if want_keyframe {
                    enc.request_keyframe();
                    want_keyframe = false;
                }
                src.frame(frame_n, &mut nv12);
                let pts = frame_n * 90000 / FPS;
                match enc.encode(&nv12, pts) {
                    Ok(Some((au, key))) => {
                        if pt.is_none() {
                            let w = rtc.writer(mid).ok_or("no writer")?;
                            // packetization-mode=1: FU-A allowed, which 40 KB IDR slices need.
                            pt = w.payload_params().find(|p| p.spec().codec == Codec::H264 && p.spec().format.packetization_mode == Some(1)).map(|p| p.pt());
                        }
                        if let Some(pt) = pt {
                            let w = rtc.writer(mid).ok_or("no writer")?;
                            let data: Vec<u8> = au.to_vec();
                            s.bytes += data.len() as u64;
                            s.frames += 1;
                            s.keyframes += key as u64;
                            s.cost_sum += enc.last_cost_us();
                            w.write(pt, now, MediaTime::new(pts, Frequency::NINETY_KHZ), data).map_err(|e| format!("write: {e}"))?;
                        }
                    }
                    Ok(None) => {}
                    Err(e) => return Err(format!("encode error {e}")),
                }
                frame_n += 1;
                let mut nxt = nf + frame_interval;
                while nxt + frame_interval < Instant::now() {
                    nxt += frame_interval; // fell behind by more than a frame: skip, do not burst
                }
                next_frame = Some(nxt);
                continue;
            }
        }
        if now >= next_log {
            let t = (next_log - epoch).as_secs();
            let line = format!(
                "{t},{encoder_name},{},{},{target_kbps},{},{:.1},{:.2},{}",
                s.frames,
                s.bytes * 8 / 1000,
                if s.frames > 0 { s.cost_sum / s.frames as i64 } else { 0 },
                s.rtt_ms,
                s.loss_pct,
                s.bwe_kbps
            );
            writeln!(csv, "{line}").ok();
            eprintln!("S {line}{}", if connected { "" } else { " (not connected)" });
            s.frames = 0;
            s.bytes = 0;
            s.cost_sum = 0;
            next_log += Duration::from_secs(1);
        }
        let deadline = [timeout, next_frame.unwrap_or(end), next_log, end].into_iter().min().unwrap();
        wait_input(&mut rtc, &sock, local, &mut buf, deadline)?;
        rtc.handle_input(Input::Timeout(Instant::now())).map_err(|e| format!("timeout: {e}"))?;
    }
    rtc.disconnect();
    Ok(format!("sender: {encoder_name}, {} frames, {} keyframes, nacks {}, plis {}, firs {}, send failures {}", frame_n, s.keyframes, s.nacks, s.plis, s.firs, SEND_FAILS.load(Ordering::Relaxed)))
}

fn run_receiver(mut rtc: Rtc, sock: UdpSocket, local: SocketAddr, h: Arc<Harness>, decoder_force: Option<String>, epoch: Instant, stop: Arc<AtomicBool>, mut csv: File) -> Result<String, String> {
    let mut dec = Decoder::open(&h, decoder_force.as_deref())?;
    let decoder_name = dec.name.clone();
    eprintln!("receiver: decoder {decoder_name}, local {local}");
    let (mut delivered_total, mut delivered, mut bytes, mut decoded_ok, mut decoded_bad, mut noncontig) = (0u64, 0u64, 0u64, 0u64, 0u64, 0u64);
    let mut last_delivery: Option<Instant> = None;
    let mut freeze_max = Duration::ZERO;
    let mut last_pli = Instant::now() - Duration::from_secs(10);
    let mut next_log = epoch + Duration::from_secs(1);
    let mut buf = vec![0u8; 2000];
    writeln!(csv, "t,frames_delivered,fps,kbps_received,decode_ok,freeze_ms_max").ok();
    let mut media: Vec<(Vec<u8>, bool, Mid)> = Vec::new();

    while !stop.load(Ordering::Relaxed) {
        let timeout = drive(&mut rtc, &sock, &mut |rtc, e| match e {
            Event::Connected => eprintln!("receiver: connected at t={:.2}", epoch.elapsed().as_secs_f64()),
            Event::IceConnectionStateChange(st) => {
                eprintln!("receiver: ice {st:?}");
                if st == IceConnectionState::Disconnected {
                    rtc.disconnect();
                }
            }
            Event::MediaAdded(m) => eprintln!("receiver: media {:?} {:?} {:?}", m.mid, m.kind, m.direction),
            Event::MediaData(d) => media.push((d.data.to_vec(), d.contiguous, d.mid)),
            _ => {}
        })?;
        if !rtc.is_alive() {
            return Err("receiver: rtc died".into());
        }
        for (au, contiguous, mid) in media.drain(..) {
            let now = Instant::now();
            if !contiguous {
                noncontig += 1;
                if last_pli.elapsed() >= Duration::from_millis(500) {
                    if let Some(mut w) = rtc.writer(mid) {
                        w.request_keyframe(None, KeyframeRequestKind::Pli).ok();
                    }
                    last_pli = now;
                }
            }
            if let Some(prev) = last_delivery {
                freeze_max = freeze_max.max(now - prev);
            }
            last_delivery = Some(now);
            delivered += 1;
            delivered_total += 1;
            bytes += au.len() as u64;
            match dec.decode(&au) {
                Ok((n, counter)) => {
                    if n > 0 && counter >= 0 {
                        decoded_ok += n as u64;
                    } else if n > 0 {
                        decoded_bad += n as u64;
                    }
                }
                Err(e) => {
                    decoded_bad += 1;
                    eprintln!("receiver: decode error {e}");
                }
            }
        }
        let now = Instant::now();
        if now >= next_log {
            let t = (next_log - epoch).as_secs();
            let ongoing = last_delivery.map_or(Duration::ZERO, |p| now - p);
            let freeze = if delivered == 0 { ongoing } else { freeze_max };
            let line = format!("{t},{delivered_total},{delivered},{},{decoded_ok},{}", bytes * 8 / 1000, freeze.as_millis());
            writeln!(csv, "{line}").ok();
            eprintln!("R {line}");
            delivered = 0;
            bytes = 0;
            decoded_ok = 0;
            freeze_max = Duration::ZERO;
            next_log += Duration::from_secs(1);
        }
        let deadline = timeout.min(next_log);
        wait_input(&mut rtc, &sock, local, &mut buf, deadline)?;
        rtc.handle_input(Input::Timeout(Instant::now())).map_err(|e| format!("timeout: {e}"))?;
    }
    rtc.disconnect();
    Ok(format!("receiver: {decoder_name}, {delivered_total} frames delivered, {decoded_bad} undecodable/unreadable, {noncontig} non-contiguous"))
}

fn main() {
    tracing_subscriber::fmt().with_env_filter(tracing_subscriber::EnvFilter::from_default_env()).with_writer(std::io::stderr).init();
    unsafe { timeBeginPeriod(1) }; // 1 ms timer resolution for socket timeouts and the frame clock (Windows default: 15.6 ms)
    let opts = parse_opts();
    let h = Harness::load(&opts.harness).unwrap_or_else(|e| {
        eprintln!("harness: {e}");
        std::process::exit(1)
    });
    str0m::crypto::from_feature_flags().install_process_default();
    std::fs::create_dir_all(&opts.results).expect("results dir");
    let stamp = stamp();
    let mut csv_s = File::create(opts.results.join(format!("{stamp}-str0m-sender.csv"))).expect("sender csv");
    let csv_r = File::create(opts.results.join(format!("{stamp}-str0m-receiver.csv"))).expect("receiver csv");
    eprintln!("spike-str0m: {} s, shaper {:?}, results {}/{stamp}-str0m-*.csv", opts.duration, opts.shaper, opts.results.display());

    // One socket each, real host candidates; the SDP the other side sees is rewritten for the shaper.
    let (sock_s, local_s) = bind(&opts.ip);
    let (sock_r, local_r) = bind(&opts.ip);
    let mut sender = new_rtc(Some(opts.start_kbps));
    let mut receiver = new_rtc(None);
    sender.add_local_candidate(Candidate::host(local_s, "udp").unwrap());
    receiver.add_local_candidate(Candidate::host(local_r, "udp").unwrap());

    let mut api = sender.sdp_api();
    let mid = api.add_media(MediaKind::Video, Direction::SendOnly, Some("castcade".into()), Some("playfield".into()), None);
    let (offer, pending) = api.apply().expect("offer");
    let offer_sdp = rewrite_candidates(&offer.to_sdp_string(), opts.shaper.map(|(_, c)| c));
    if opts.print_sdp {
        eprintln!("--- offer as the receiver sees it ---\n{offer_sdp}");
    }
    let answer = receiver.sdp_api().accept_offer(SdpOffer::from_sdp_string(&offer_sdp).expect("offer parse")).expect("accept offer");
    let answer_sdp = rewrite_candidates(&answer.to_sdp_string(), opts.shaper.map(|(s, _)| s));
    if opts.print_sdp {
        eprintln!("--- answer as the sender sees it ---\n{answer_sdp}");
    }
    sender.sdp_api().accept_answer(pending, SdpAnswer::from_sdp_string(&answer_sdp).expect("answer parse")).expect("accept answer");

    let epoch = Instant::now();
    let stop = Arc::new(AtomicBool::new(false));
    let rx_thread = {
        let (h, stop, dec) = (h.clone(), stop.clone(), opts.decoder.clone());
        std::thread::spawn(move || run_receiver(receiver, sock_r, local_r, h, dec, epoch, stop, csv_r))
    };
    let s_result = run_sender(sender, sock_s, local_s, mid, h, &opts, epoch, &mut csv_s);
    stop.store(true, Ordering::Relaxed);
    let r_result = rx_thread.join().unwrap_or_else(|_| Err("receiver thread panicked".into()));
    for r in [s_result, r_result] {
        match r {
            Ok(s) => eprintln!("{s}"),
            Err(e) => eprintln!("error: {e}"),
        }
    }
}
