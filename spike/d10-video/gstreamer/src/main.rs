// spike-gst: the D10.0.1 GStreamer candidate (scratch code, not shipped).
//
//   spike-gst sender   --endpoint http://127.0.0.1:8090/whip/endpoint --out <prefix> [--harness <dll>] [--duration 90]
//   spike-gst receiver --listen http://127.0.0.1:8080 --out <prefix> [--duration 90]
//
// Sender:   appsrc (NV12 1354x1440 @ 60 from the harness dll, videotestsrc when it is absent) → queue →
//           whipclientsink (webrtcsink + WHIP signalling; it owns the encoder: nvh264enc by rank, x264enc
//           fallback; congestion-control=gcc drives the encoder bitrate). We only tune the encoder in
//           `encoder-setup` and read numbers.
// Receiver: whipserversrc (HTTP WHIP endpoint) → [decodebin3 inside it] → queue → videoconvert → appsink NV12,
//           counting frames, arrival gaps and the burned-in frame counter.
// One CSV line a second each, columns per spike/d10-video/README.md (extra columns after the required ones).
use gst::glib;
use gst::prelude::*;
use gstreamer as gst;
use gstreamer_app as gst_app;
use gstreamer_video as gst_video;
use std::collections::VecDeque;
use std::ffi::c_void;
use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

struct Args {
    role: String,
    harness: String,
    duration: u64,
    out: String,
    endpoint: String,
    listen: String,
    encoder: Option<String>,
    decoder: Option<String>,
    start_kbps: u32,
    min_kbps: u32,
    max_kbps: u32,
    width: i32,
    height: i32,
    fps: i32,
    strip_block: usize,
    port_min: u32,
    port_max: u32,
    mitigation: Option<String>,
}

fn parse_args() -> Args {
    let argv: Vec<String> = std::env::args().collect();
    let get = |k: &str| argv.iter().position(|a| a == k).and_then(|i| argv.get(i + 1).cloned());
    let num = |k: &str, d: u64| get(k).and_then(|v| v.parse().ok()).unwrap_or(d);
    Args {
        role: argv.get(1).cloned().unwrap_or_default(),
        harness: get("--harness").unwrap_or_else(|| "..\\harness\\build\\Release\\castcade_spike_harness.dll".into()),
        duration: num("--duration", 90),
        out: get("--out").unwrap_or_else(|| "spike-gst".into()),
        endpoint: get("--endpoint").unwrap_or_else(|| "http://127.0.0.1:8080/whip/endpoint".into()),
        listen: get("--listen").unwrap_or_else(|| "http://127.0.0.1:8080".into()),
        encoder: get("--encoder"),
        decoder: get("--decoder"),
        start_kbps: num("--start-kbps", 20000) as u32,
        min_kbps: num("--min-kbps", 500) as u32,
        max_kbps: num("--max-kbps", 20000) as u32,
        width: num("--width", 1354) as i32,
        height: num("--height", 1440) as i32,
        fps: num("--fps", 60) as i32,
        strip_block: num("--strip-block", 16) as usize,
        port_min: num("--port-min", 0) as u32,
        port_max: num("--port-max", 0) as u32,
        mitigation: get("--mitigation"),
    }
}

// ---- harness dll, loaded at run time (never linked) ------------------------------------------------------
type SourceOpen = unsafe extern "C" fn(i32, i32) -> *mut c_void;
type SourceFrame = unsafe extern "C" fn(*mut c_void, u64, *mut u8, usize) -> usize;
type SourceClose = unsafe extern "C" fn(*mut c_void);

struct Harness {
    _lib: libloading::Library,
    src: *mut c_void,
    frame: SourceFrame,
    close: SourceClose,
}
unsafe impl Send for Harness {}

impl Harness {
    fn open(path: &str, w: i32, h: i32) -> Option<Harness> {
        unsafe {
            let lib = libloading::Library::new(path).ok()?;
            let open: SourceOpen = *lib.get(b"spike_source_open\0").ok()?;
            let frame: SourceFrame = *lib.get(b"spike_source_frame\0").ok()?;
            let close: SourceClose = *lib.get(b"spike_source_close\0").ok()?;
            let src = open(w, h);
            if src.is_null() {
                return None;
            }
            Some(Harness { _lib: lib, src, frame, close })
        }
    }
    fn fill(&self, n: u64, dst: &mut [u8]) -> usize {
        unsafe { (self.frame)(self.src, n, dst.as_mut_ptr(), dst.len()) }
    }
}
impl Drop for Harness {
    fn drop(&mut self) {
        unsafe { (self.close)(self.src) }
    }
}

// ---- helpers ---------------------------------------------------------------------------------------------
fn num_field(s: &gst::StructureRef, f: &str) -> Option<f64> {
    let v = s.value(f).ok()?;
    v.get::<f64>()
        .ok()
        .or_else(|| v.get::<u64>().ok().map(|x| x as f64))
        .or_else(|| v.get::<i64>().ok().map(|x| x as f64))
        .or_else(|| v.get::<u32>().ok().map(|x| x as f64))
        .or_else(|| v.get::<i32>().ok().map(|x| x as f64))
}

fn find_in_bin(bin: &gst::Bin, pred: &dyn Fn(&gst::ElementFactory) -> bool) -> Option<gst::Element> {
    bin.iterate_recurse()
        .into_iter()
        .filter_map(Result::ok)
        .find(|e| e.factory().map(|f| pred(&f)).unwrap_or(false))
}

fn factory_name(e: &gst::Element) -> String {
    e.factory().map(|f| f.name().to_string()).unwrap_or_default()
}

// Pin the ICE agent to one UDP port range so the shaper rule (one host candidate a side) holds.
fn pin_ice_ports(webrtcbin: &gst::Element, lo: u32, hi: u32) {
    if lo == 0 {
        return;
    }
    if let Some(ice) = webrtcbin.property::<Option<glib::Object>>("ice-agent") {
        if ice.find_property("min-rtp-port").is_some() {
            ice.set_property("min-rtp-port", lo);
            ice.set_property("max-rtp-port", hi.max(lo));
            println!("ice: ports pinned to {lo}-{}", hi.max(lo));
        } else {
            println!("ice: agent has no min-rtp-port property; not pinned");
        }
    }
}

#[derive(Default)]
struct RtpStats {
    bytes: f64,
    packets_lost: f64,
    rtt_ms: f64,
    fraction_lost: f64,
    jitter_ms: f64,
}

// webrtcbin get-stats → the numbers we log. outbound/remote-inbound on the sender, inbound on the receiver.
fn request_stats(webrtcbin: &gst::Element, slot: Arc<Mutex<RtpStats>>) {
    let promise = gst::Promise::with_change_func(move |reply| {
        let Ok(Some(s)) = reply else { return };
        let mut acc = RtpStats::default();
        for (_, v) in s.iter() {
            let Ok(sub) = v.get::<gst::Structure>() else { continue };
            match sub.name().as_str() {
                "rtp-outbound-stream-stats" => acc.bytes += num_field(&sub, "bytes-sent").unwrap_or(0.0),
                "rtp-inbound-stream-stats" => {
                    acc.bytes += num_field(&sub, "bytes-received").unwrap_or(0.0);
                    acc.packets_lost += num_field(&sub, "packets-lost").unwrap_or(0.0);
                    acc.jitter_ms = num_field(&sub, "jitter").unwrap_or(0.0) * 1000.0;
                }
                "rtp-remote-inbound-stream-stats" => {
                    acc.rtt_ms = num_field(&sub, "round-trip-time").unwrap_or(0.0) * 1000.0;
                    acc.fraction_lost = num_field(&sub, "fraction-lost").unwrap_or(0.0);
                    acc.packets_lost += num_field(&sub, "packets-lost").unwrap_or(0.0);
                }
                _ => {}
            }
        }
        *slot.lock().unwrap() = acc;
    });
    webrtcbin.emit_by_name::<()>("get-stats", &[&None::<gst::Pad>, &promise]);
}

// ---- sender ----------------------------------------------------------------------------------------------
#[derive(Default)]
struct TxState {
    encoder: Option<gst::Element>,
    webrtcbin: Option<gst::Element>,
    bwe: Option<gst::Element>,
    frames_in: u64,
    frames_out: u64,
    bytes_out: u64,
    cost_sum_us: u64,
    cost_n: u64,
    pending: VecDeque<(u64, Instant)>, // (pts ns, arrival at the encoder sink pad)
    first_out: Option<Instant>,
}

fn run_sender(a: &Args) {
    let w = a.width;
    let h = a.height;
    let info = gst_video::VideoInfo::builder(gst_video::VideoFormat::Nv12, w as u32, h as u32)
        .fps(gst::Fraction::new(a.fps, 1))
        .build()
        .unwrap();
    let caps = info.to_caps().unwrap();
    let pipeline = gst::Pipeline::new();
    let harness = Harness::open(&a.harness, w, h);
    let (src, appsrc) = if harness.is_some() {
        let s = gst_app::AppSrc::builder()
            .caps(&caps)
            .format(gst::Format::Time)
            .is_live(true)
            .property("max-buffers", 4u64)
            .property_from_str("leaky-type", "downstream")
            .build();
        (s.clone().upcast::<gst::Element>(), Some(s))
    } else {
        println!("harness: {} not loadable, using videotestsrc", a.harness);
        let s = gst::ElementFactory::make("videotestsrc").property("is-live", true).property_from_str("pattern", "ball").build().unwrap();
        (s, None)
    };
    let capsf = gst::ElementFactory::make("capsfilter").property("caps", &caps).build().unwrap();
    let queue = gst::ElementFactory::make("queue").property("max-size-buffers", 3u32).property("max-size-time", 0u64).property("max-size-bytes", 0u32).property_from_str("leaky", "downstream").build().unwrap();
    let sink = gst::ElementFactory::make("whipclientsink")
        .property("video-caps", gst::Caps::builder("video/x-h264").build())
        .property_from_str("congestion-control", "gcc")
        .property("start-bitrate", a.start_kbps * 1000)
        .property("min-bitrate", a.min_kbps * 1000)
        .property("max-bitrate", a.max_kbps * 1000)
        .property("do-retransmission", true)
        .build()
        .unwrap();
    if let Some(m) = &a.mitigation {
        sink.set_property_from_str("enable-mitigation-modes", m);
    }
    sink.property::<glib::Object>("signaller").set_property("whip-endpoint", &a.endpoint);
    pipeline.add_many([&src, &capsf, &queue, &sink]).unwrap();
    gst::Element::link_many([&src, &capsf, &queue, &sink]).unwrap();

    let st = Arc::new(Mutex::new(TxState::default()));
    let rtp = Arc::new(Mutex::new(RtpStats::default()));

    // webrtcsink hands us the encoder it picked; we add low-latency knobs and probes, return false so it
    // still applies its own defaults (bitrate, cbr-ld-hq, zerolatency, gop) on top.
    let st2 = st.clone();
    sink.connect("encoder-setup", false, move |args| {
        let enc = args[3].get::<gst::Element>().unwrap();
        let name = factory_name(&enc);
        println!("encoder: {name}");
        let set = |p: &str, v: &str| {
            if enc.find_property(p).is_some() {
                enc.set_property_from_str(p, v);
            }
        };
        match name.as_str() {
            "nvh264enc" => {
                set("preset", "p4");
                set("tune", "ultra-low-latency");
                set("bframes", "0");
                set("rc-lookahead", "0");
                set("aud", "false");
            }
            "amfh264enc" => {
                set("usage", "ultra-low-latency");
                set("rate-control", "cbr");
            }
            "qsvh264enc" => {
                set("low-latency", "true");
                set("rate-control", "cbr");
            }
            _ => {}
        }
        let st3 = st2.clone();
        enc.static_pad("sink").unwrap().add_probe(gst::PadProbeType::BUFFER, move |_, info| {
            if let Some(b) = info.buffer() {
                let mut s = st3.lock().unwrap();
                s.frames_in += 1;
                s.pending.push_back((b.pts().map(|p| p.nseconds()).unwrap_or(0), Instant::now()));
                if s.pending.len() > 64 {
                    s.pending.pop_front();
                }
            }
            gst::PadProbeReturn::Ok
        });
        let st4 = st2.clone();
        enc.static_pad("src").unwrap().add_probe(gst::PadProbeType::BUFFER, move |_, info| {
            if let Some(b) = info.buffer() {
                let now = Instant::now();
                let mut s = st4.lock().unwrap();
                s.frames_out += 1;
                s.bytes_out += b.size() as u64;
                s.first_out.get_or_insert(now);
                let pts = b.pts().map(|p| p.nseconds()).unwrap_or(0);
                if let Some(i) = s.pending.iter().position(|(p, _)| *p == pts) {
                    let (_, t) = s.pending.remove(i).unwrap();
                    s.cost_sum_us += now.duration_since(t).as_micros() as u64;
                    s.cost_n += 1;
                }
            }
            gst::PadProbeReturn::Ok
        });
        st2.lock().unwrap().encoder = Some(enc);
        Some(false.to_value())
    });
    let st2 = st.clone();
    let (lo, hi) = (a.port_min, a.port_max);
    sink.connect("consumer-added", false, move |args| {
        let wb = args[2].get::<gst::Element>().unwrap();
        pin_ice_ports(&wb, lo, hi);
        st2.lock().unwrap().webrtcbin = Some(wb);
        None
    });

    let main_loop = glib::MainLoop::new(None, false);
    let bus = pipeline.bus().unwrap();
    let ml = main_loop.clone();
    let _watch = bus
        .add_watch(move |_, msg| {
            match msg.view() {
                gst::MessageView::Error(e) => {
                    eprintln!("ERROR {}: {} ({:?})", e.src().map(|s| s.path_string()).unwrap_or_default(), e.error(), e.debug());
                    ml.quit();
                }
                gst::MessageView::Eos(_) => ml.quit(),
                _ => {}
            }
            glib::ControlFlow::Continue
        })
        .unwrap();

    pipeline.set_state(gst::State::Playing).unwrap();

    // Frame pump: frame n at t0 + n/fps, pts = n/fps.
    let duration = a.duration;
    let fps = a.fps as u64;
    if let (Some(appsrc), Some(h)) = (appsrc, harness) {
        let size = (w as usize) * (h as usize) * 3 / 2;
        std::thread::spawn(move || {
            let t0 = Instant::now();
            let frame_ns = 1_000_000_000u64 / fps;
            let mut n: u64 = 0;
            while n < duration * fps {
                let due = t0 + Duration::from_nanos(n * frame_ns);
                let now = Instant::now();
                if due > now {
                    std::thread::sleep(due - now);
                }
                let mut buf = gst::Buffer::with_size(size).unwrap();
                {
                    let b = buf.get_mut().unwrap();
                    b.set_pts(gst::ClockTime::from_nseconds(n * frame_ns));
                    b.set_duration(gst::ClockTime::from_nseconds(frame_ns));
                    let mut map = b.map_writable().unwrap();
                    h.fill(n, map.as_mut_slice());
                }
                if appsrc.push_buffer(buf).is_err() {
                    break;
                }
                n += 1;
            }
            let _ = appsrc.end_of_stream();
        });
    } else {
        let ml = main_loop.clone();
        glib::timeout_add_once(Duration::from_secs(duration), move || ml.quit());
    }

    let mut csv = std::fs::File::create(format!("{}-sender.csv", a.out)).unwrap();
    writeln!(csv, "t,encoder,fps_sent,kbps_sent,target_kbps,enc_cost_us_avg,rtt_ms,loss_pct,bwe_kbps,enc_kbps,frames_in,mitigation,enc_bitrate_kbps").unwrap();
    let sink2 = sink.clone();
    let st2 = st.clone();
    let rtp2 = rtp.clone();
    let (mut last_out, mut last_bytes, mut last_cost, mut last_n, mut last_rtp_bytes, mut t) = (0u64, 0u64, 0u64, 0u64, 0f64, 0u64);
    glib::timeout_add(Duration::from_secs(1), move || {
        let mut s = st2.lock().unwrap();
        if s.first_out.is_none() {
            return glib::ControlFlow::Continue;
        }
        let name = s.encoder.as_ref().map(factory_name).unwrap_or_default();
        let fps_sent = s.frames_out - last_out;
        let enc_kbps = (s.bytes_out - last_bytes) as f64 * 8.0 / 1000.0;
        let cost = if s.cost_n > last_n { (s.cost_sum_us - last_cost) / (s.cost_n - last_n) } else { 0 };
        last_out = s.frames_out;
        last_bytes = s.bytes_out;
        last_cost = s.cost_sum_us;
        last_n = s.cost_n;
        // encoder bitrate property: kbit/s on nvh264enc / x264enc / qsv / amf, bit/s on openh264enc
        let enc_bitrate_kbps = s.encoder.as_ref().and_then(|e| e.find_property("bitrate").map(|_| e.property_value("bitrate"))).and_then(|v| v.get::<u32>().ok().map(|x| x as f64).or_else(|| v.get::<i32>().ok().map(|x| x as f64))).map(|v| if v > 200_000.0 { v / 1000.0 } else { v }).unwrap_or(0.0);
        if s.bwe.is_none() {
            if let Some(wb) = s.webrtcbin.as_ref().and_then(|w| w.downcast_ref::<gst::Bin>()) {
                s.bwe = find_in_bin(wb, &|f| f.name() == "rtpgccbwe");
            }
        }
        let bwe_kbps = s.bwe.as_ref().map(|b| b.property::<u32>("estimated-bitrate") as f64 / 1000.0).unwrap_or(0.0);
        // webrtcsink's own view: consumer-stats.video-encoders[0].{bitrate (bit/s), mitigation-mode}
        let (mut target_kbps, mut mitigation) = (enc_bitrate_kbps, String::new());
        let stats = sink2.property::<gst::Structure>("stats");
        for (_, v) in stats.iter() {
            let Ok(sess) = v.get::<gst::Structure>() else { continue };
            let Ok(cs) = sess.get::<gst::Structure>("consumer-stats") else { continue };
            let Ok(encs) = cs.get::<gst::Array>("video-encoders") else { continue };
            if let Some(e) = encs.first().and_then(|e| e.get::<gst::Structure>().ok()) {
                target_kbps = num_field(&e, "bitrate").map(|b| b / 1000.0).unwrap_or(target_kbps);
                mitigation = e.value("mitigation-mode").ok().and_then(|m| m.serialize().ok()).map(|g| g.to_string()).unwrap_or_default();
            }
        }
        let r = rtp2.lock().unwrap();
        let kbps_sent = if last_rtp_bytes > 0.0 { (r.bytes - last_rtp_bytes) * 8.0 / 1000.0 } else { enc_kbps };
        last_rtp_bytes = r.bytes;
        let line = format!("{t},{name},{fps_sent},{kbps_sent:.0},{target_kbps:.0},{cost},{:.1},{:.2},{bwe_kbps:.0},{enc_kbps:.0},{},{mitigation},{enc_bitrate_kbps:.0}", r.rtt_ms, r.fraction_lost * 100.0, s.frames_in);
        drop(r);
        println!("tx {line}");
        writeln!(csv, "{line}").unwrap();
        t += 1;
        if let Some(wb) = s.webrtcbin.clone() {
            request_stats(&wb, rtp2.clone());
        }
        glib::ControlFlow::Continue
    });

    main_loop.run();
    pipeline.set_state(gst::State::Null).unwrap();
    let s = st.lock().unwrap();
    println!("sender done: {} frames in, {} out, encoder {}", s.frames_in, s.frames_out, s.encoder.as_ref().map(factory_name).unwrap_or_default());
}

// ---- receiver --------------------------------------------------------------------------------------------
#[derive(Default)]
struct RxState {
    frames: u64,
    first: Option<Instant>,
    last: Option<Instant>,
    gap_max_ms: f64,
    counter_last: i64,
    counter_ok: u64,
    counter_bad: u64,
    width: i32,
    height: i32,
    decode_err: bool,
    webrtcbin: Option<gst::Element>,
    decoder: String,
}

// Harness frame counter: 16 bits burned in as 16 blocks across the top-left, MSB first, luma > 128 = 1.
// TODO(D10.0.1): confirm block size / bit order against spike/d10-video/harness once it lands.
fn read_counter(y: &[u8], stride: usize, block: usize) -> i64 {
    if block == 0 || stride < 16 * block {
        return -1;
    }
    let mut v: i64 = 0;
    for i in 0..16 {
        let (cx, cy) = (i * block + block / 2, block / 2);
        let mut sum = 0u32;
        for dy in 0..3 {
            for dx in 0..3 {
                sum += y[(cy + dy - 1) * stride + cx + dx - 1] as u32;
            }
        }
        v = (v << 1) | ((sum / 9 > 128) as i64);
    }
    v
}

fn run_receiver(a: &Args) {
    let pipeline = gst::Pipeline::new();
    let src = gst::ElementFactory::make("whipserversrc")
        .property("video-codecs", gst::Array::new(["H264"]))
        .property("do-retransmission", true)
        .build()
        .unwrap();
    src.property::<glib::Object>("signaller").set_property("host-addr", &a.listen);
    pipeline.add(&src).unwrap();
    let st = Arc::new(Mutex::new(RxState { counter_last: -1, ..Default::default() }));
    let rtp = Arc::new(Mutex::new(RtpStats::default()));

    let pl = pipeline.clone();
    let st2 = st.clone();
    let block = a.strip_block;
    src.connect_pad_added(move |_, pad| {
        if !pad.name().starts_with("video") {
            return;
        }
        println!("receiver: pad {} added", pad.name());
        let queue = gst::ElementFactory::make("queue").property("max-size-buffers", 8u32).property("max-size-time", 0u64).property("max-size-bytes", 0u32).build().unwrap();
        let conv = gst::ElementFactory::make("videoconvert").build().unwrap();
        let caps = gst::Caps::builder("video/x-raw").field("format", "NV12").build();
        let sink = gst_app::AppSink::builder().caps(&caps).sync(false).max_buffers(4).drop(false).build();
        let st3 = st2.clone();
        sink.set_callbacks(
            gst_app::AppSinkCallbacks::builder()
                .new_sample(move |s| {
                    let sample = s.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                    let now = Instant::now();
                    let mut counter = -1;
                    let mut wh = (0, 0);
                    if let (Some(buf), Some(caps)) = (sample.buffer(), sample.caps()) {
                        if let Ok(info) = gst_video::VideoInfo::from_caps(caps) {
                            wh = (info.width() as i32, info.height() as i32);
                            if let Ok(frame) = gst_video::VideoFrameRef::from_buffer_ref_readable(buf, &info) {
                                counter = read_counter(frame.plane_data(0).unwrap(), frame.plane_stride()[0] as usize, block);
                            }
                        }
                    }
                    let mut st = st3.lock().unwrap();
                    st.frames += 1;
                    st.first.get_or_insert(now);
                    if let Some(l) = st.last {
                        st.gap_max_ms = st.gap_max_ms.max(now.duration_since(l).as_secs_f64() * 1000.0);
                    }
                    st.last = Some(now);
                    (st.width, st.height) = wh;
                    if counter >= 0 {
                        if st.counter_last >= 0 && (counter <= st.counter_last || counter > st.counter_last + 120) {
                            st.counter_bad += 1;
                        } else {
                            st.counter_ok += 1;
                        }
                        st.counter_last = counter;
                    }
                    Ok(gst::FlowSuccess::Ok)
                })
                .build(),
        );
        let sink_el = sink.upcast::<gst::Element>();
        pl.add_many([&queue, &conv, &sink_el]).unwrap();
        gst::Element::link_many([&queue, &conv, &sink_el]).unwrap();
        for e in [&queue, &conv, &sink_el] {
            e.sync_state_with_parent().unwrap();
        }
        pad.link(&queue.static_pad("sink").unwrap()).unwrap();
    });

    let main_loop = glib::MainLoop::new(None, false);
    let bus = pipeline.bus().unwrap();
    let ml = main_loop.clone();
    let st2 = st.clone();
    let _watch = bus
        .add_watch(move |_, msg| {
            match msg.view() {
                gst::MessageView::Error(e) => {
                    eprintln!("ERROR {}: {} ({:?})", e.src().map(|s| s.path_string()).unwrap_or_default(), e.error(), e.debug());
                    ml.quit();
                }
                gst::MessageView::Warning(w) => {
                    let who = w.src().map(|s| s.path_string()).unwrap_or_default();
                    if who.contains("dec") {
                        st2.lock().unwrap().decode_err = true;
                    }
                    eprintln!("WARN {who}: {}", w.error());
                }
                gst::MessageView::Eos(_) => ml.quit(),
                _ => {}
            }
            glib::ControlFlow::Continue
        })
        .unwrap();
    pipeline.set_state(gst::State::Playing).unwrap();
    println!("receiver: WHIP endpoint {}/whip/endpoint", a.listen);

    let mut csv = std::fs::File::create(format!("{}-receiver.csv", a.out)).unwrap();
    writeln!(csv, "t,frames_delivered,fps,kbps_received,decode_ok,freeze_ms_max,width,height,decoder,counter_last,counter_ok,counter_bad,packets_lost,jitter_ms").unwrap();
    let (st2, rtp2, pl, ml) = (st.clone(), rtp.clone(), pipeline.clone(), main_loop.clone());
    let (lo, hi) = (a.port_min, a.port_max);
    let decoder_hint = a.decoder.clone();
    let duration = a.duration;
    let (mut last_frames, mut last_bytes, mut t, mut idle) = (0u64, 0f64, 0u64, 0u64);
    glib::timeout_add(Duration::from_secs(1), move || {
        let mut s = st2.lock().unwrap();
        if s.webrtcbin.is_none() {
            if let Some(wb) = find_in_bin(&pl, &|f| f.name() == "webrtcbin") {
                pin_ice_ports(&wb, lo, hi); // may be late for the first session; the proxy keeps one candidate anyway
                s.webrtcbin = Some(wb);
            }
        }
        if s.decoder.is_empty() {
            if let Some(d) = find_in_bin(&pl, &|f| f.has_type(gst::ElementFactoryType::DECODER | gst::ElementFactoryType::MEDIA_VIDEO)) {
                s.decoder = factory_name(&d);
                println!("decoder: {} (hint {:?})", s.decoder, decoder_hint);
            }
        }
        let Some(first) = s.first else {
            idle += 1;
            if idle > duration + 30 {
                ml.quit();
            }
            return glib::ControlFlow::Continue;
        };
        let now = Instant::now();
        let fps = s.frames - last_frames;
        last_frames = s.frames;
        let ongoing = s.last.map(|l| now.duration_since(l).as_secs_f64() * 1000.0).unwrap_or(0.0);
        let freeze = s.gap_max_ms.max(ongoing);
        s.gap_max_ms = 0.0;
        let r = rtp2.lock().unwrap();
        let kbps = if last_bytes > 0.0 { (r.bytes - last_bytes) * 8.0 / 1000.0 } else { 0.0 };
        last_bytes = r.bytes;
        let decode_ok = if s.decode_err { 0 } else { 1 };
        s.decode_err = false;
        let line = format!("{t},{},{fps},{kbps:.0},{decode_ok},{freeze:.0},{},{},{},{},{},{},{:.0},{:.1}", s.frames, s.width, s.height, s.decoder, s.counter_last, s.counter_ok, s.counter_bad, r.packets_lost, r.jitter_ms);
        drop(r);
        println!("rx {line}");
        writeln!(csv, "{line}").unwrap();
        t += 1;
        if let Some(wb) = s.webrtcbin.clone() {
            request_stats(&wb, rtp2.clone());
        }
        if now.duration_since(first).as_secs() > duration + 3 {
            ml.quit();
        }
        glib::ControlFlow::Continue
    });

    main_loop.run();
    pipeline.set_state(gst::State::Null).unwrap();
    let s = st.lock().unwrap();
    println!("receiver done: {} frames, decoder {}, counter ok/bad {}/{}", s.frames, s.decoder, s.counter_ok, s.counter_bad);
}

fn main() {
    let a = parse_args();
    // Rank overrides steer webrtcsink's encoder pick (first factory by rank that yields H264) and
    // decodebin3's decoder pick; set before gst::init so the registry sees them.
    let mut ranks: Vec<String> = std::env::var("GST_PLUGIN_FEATURE_RANK").ok().into_iter().filter(|s| !s.is_empty()).collect();
    for e in [&a.encoder, &a.decoder].into_iter().flatten() {
        ranks.push(format!("{e}:MAX"));
    }
    if !ranks.is_empty() {
        std::env::set_var("GST_PLUGIN_FEATURE_RANK", ranks.join(","));
    }
    gst::init().unwrap();
    println!("gstreamer {}", gst::version_string());
    match a.role.as_str() {
        "sender" => run_sender(&a),
        "receiver" => run_receiver(&a),
        _ => {
            eprintln!("usage: spike-gst sender|receiver [--endpoint URL] [--listen URL] [--out PREFIX] [--harness DLL] [--duration S] [--encoder NAME] [--decoder NAME] [--start-kbps N] [--min-kbps N] [--max-kbps N] [--port-min N --port-max N] [--mitigation none|downscaled|downsampled|all] [--strip-block PX]");
            std::process::exit(2);
        }
    }
}
