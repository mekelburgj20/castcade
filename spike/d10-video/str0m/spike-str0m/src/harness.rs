//! The spike harness dll (harness/include/spike_harness.h) loaded at run time with libloading.
use std::ffi::{CStr, CString, c_char, c_int, c_void};
use std::path::Path;
use std::sync::Arc;

use libloading::Library;

#[repr(C)]
struct EncoderConfig {
    width: c_int,
    height: c_int,
    fps: c_int,
    bitrate_kbps: c_int,
    gop_frames: c_int,
    force: *const c_char,
}

type P = *mut c_void;
#[allow(non_snake_case)]
pub struct Harness {
    _lib: Library,
    source_open: unsafe extern "C" fn(c_int, c_int) -> P,
    source_frame: unsafe extern "C" fn(P, u64, *mut u8, usize) -> usize,
    source_close: unsafe extern "C" fn(P),
    encoder_open: unsafe extern "C" fn(*const EncoderConfig) -> P,
    encoder_name: unsafe extern "C" fn(P) -> *const c_char,
    encoder_encode: unsafe extern "C" fn(P, *const u8, u64, *mut *const u8, *mut usize, *mut c_int) -> c_int,
    encoder_set_bitrate: unsafe extern "C" fn(P, c_int) -> c_int,
    encoder_request_keyframe: unsafe extern "C" fn(P) -> c_int,
    encoder_last_cost_us: unsafe extern "C" fn(P) -> i64,
    encoder_close: unsafe extern "C" fn(P),
    decoder_open: unsafe extern "C" fn(*const c_char) -> P,
    decoder_name: unsafe extern "C" fn(P) -> *const c_char,
    decoder_decode: unsafe extern "C" fn(P, *const u8, usize, *mut i64) -> c_int,
    decoder_close: unsafe extern "C" fn(P),
    // spike_now_us is not loaded: both threads here stamp with std's Instant, the same QPC clock.
}

macro_rules! sym {
    ($lib:expr, $name:literal) => {
        *unsafe { $lib.get(concat!($name, "\0").as_bytes()) }.map_err(|e| format!("{}: {e}", $name))?
    };
}

impl Harness {
    pub fn load(path: &Path) -> Result<Arc<Harness>, String> {
        // An absolute path makes LoadLibraryEx search the dll's own folder for avcodec & co. (not canonicalize:
        // its \\?\ form is refused together with the search flags).
        let abs = std::path::absolute(path).map_err(|e| format!("{}: {e}", path.display()))?;
        if !abs.is_file() {
            return Err(format!("{}: not found (build the harness first)", abs.display()));
        }
        use libloading::os::windows::{LOAD_LIBRARY_SEARCH_DEFAULT_DIRS, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR, Library as WinLibrary};
        let lib: Library = unsafe { WinLibrary::load_with_flags(&abs, LOAD_LIBRARY_SEARCH_DEFAULT_DIRS | LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR) }
            .map_err(|e| format!("{}: {e:?}", abs.display()))?
            .into();
        Ok(Arc::new(Harness {
            source_open: sym!(lib, "spike_source_open"),
            source_frame: sym!(lib, "spike_source_frame"),
            source_close: sym!(lib, "spike_source_close"),
            encoder_open: sym!(lib, "spike_encoder_open"),
            encoder_name: sym!(lib, "spike_encoder_name"),
            encoder_encode: sym!(lib, "spike_encoder_encode"),
            encoder_set_bitrate: sym!(lib, "spike_encoder_set_bitrate"),
            encoder_request_keyframe: sym!(lib, "spike_encoder_request_keyframe"),
            encoder_last_cost_us: sym!(lib, "spike_encoder_last_cost_us"),
            encoder_close: sym!(lib, "spike_encoder_close"),
            decoder_open: sym!(lib, "spike_decoder_open"),
            decoder_name: sym!(lib, "spike_decoder_name"),
            decoder_decode: sym!(lib, "spike_decoder_decode"),
            decoder_close: sym!(lib, "spike_decoder_close"),
            _lib: lib,
        }))
    }
}

pub struct Source { h: Arc<Harness>, p: P, pub frame_bytes: usize }
unsafe impl Send for Source {}
impl Source {
    pub fn open(h: &Arc<Harness>, w: i32, hgt: i32) -> Result<Source, String> {
        let p = unsafe { (h.source_open)(w, hgt) };
        if p.is_null() { return Err("spike_source_open failed".into()); }
        Ok(Source { h: h.clone(), p, frame_bytes: (w as usize) * (hgt as usize) * 3 / 2 })
    }
    pub fn frame(&self, n: u64, dst: &mut [u8]) -> bool {
        unsafe { (self.h.source_frame)(self.p, n, dst.as_mut_ptr(), dst.len()) == self.frame_bytes }
    }
}
impl Drop for Source { fn drop(&mut self) { unsafe { (self.h.source_close)(self.p) } } }

pub struct Encoder { h: Arc<Harness>, p: P, pub name: String }
unsafe impl Send for Encoder {}
impl Encoder {
    pub fn open(h: &Arc<Harness>, w: i32, hgt: i32, fps: i32, kbps: i32, force: Option<&str>) -> Result<Encoder, String> {
        let force_c = force.map(|s| CString::new(s).unwrap());
        let cfg = EncoderConfig { width: w, height: hgt, fps, bitrate_kbps: kbps, gop_frames: 0, force: force_c.as_ref().map_or(std::ptr::null(), |c| c.as_ptr()) };
        let p = unsafe { (h.encoder_open)(&cfg) };
        if p.is_null() { return Err("spike_encoder_open: no encoder opened".into()); }
        let name = unsafe { CStr::from_ptr((h.encoder_name)(p)) }.to_string_lossy().into_owned();
        Ok(Encoder { h: h.clone(), p, name })
    }
    /// Ok(Some((annexb, keyframe))) on an access unit, Ok(None) if buffered, Err on error. The slice is valid until the next call.
    pub fn encode(&mut self, nv12: &[u8], pts_90k: u64) -> Result<Option<(&[u8], bool)>, i32> {
        let mut out: *const u8 = std::ptr::null();
        let mut size = 0usize;
        let mut key = 0;
        let r = unsafe { (self.h.encoder_encode)(self.p, nv12.as_ptr(), pts_90k, &mut out, &mut size, &mut key) };
        match r {
            0 => Ok(Some((unsafe { std::slice::from_raw_parts(out, size) }, key != 0))),
            1 => Ok(None),
            e => Err(e),
        }
    }
    pub fn set_bitrate(&mut self, kbps: i32) { unsafe { (self.h.encoder_set_bitrate)(self.p, kbps) }; }
    pub fn request_keyframe(&mut self) { unsafe { (self.h.encoder_request_keyframe)(self.p) }; }
    pub fn last_cost_us(&self) -> i64 { unsafe { (self.h.encoder_last_cost_us)(self.p) } }
}
impl Drop for Encoder { fn drop(&mut self) { unsafe { (self.h.encoder_close)(self.p) } } }

pub struct Decoder { h: Arc<Harness>, p: P, pub name: String }
unsafe impl Send for Decoder {}
impl Decoder {
    pub fn open(h: &Arc<Harness>, force: Option<&str>) -> Result<Decoder, String> {
        let force_c = force.map(|s| CString::new(s).unwrap());
        let p = unsafe { (h.decoder_open)(force_c.as_ref().map_or(std::ptr::null(), |c| c.as_ptr())) };
        if p.is_null() { return Err("spike_decoder_open: no decoder opened".into()); }
        let name = unsafe { CStr::from_ptr((h.decoder_name)(p)) }.to_string_lossy().into_owned();
        Ok(Decoder { h: h.clone(), p, name })
    }
    /// Returns (pictures that came out, counter read from the last one or -1).
    pub fn decode(&mut self, annexb: &[u8]) -> Result<(i32, i64), i32> {
        let mut counter: i64 = -1;
        let r = unsafe { (self.h.decoder_decode)(self.p, annexb.as_ptr(), annexb.len(), &mut counter) };
        if r < 0 { Err(r) } else { Ok((r, counter)) }
    }
}
impl Drop for Decoder { fn drop(&mut self) { unsafe { (self.h.decoder_close)(self.p) } } }
