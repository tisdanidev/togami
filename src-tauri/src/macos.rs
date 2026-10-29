// macOS system calls shared by the blocker and now playing, as plain C and
// Objective-C runtime calls (no extra crates):
//   - which app is in front, hiding and quitting it (NSWorkspace; needs no permission)
//   - its focused window's title and the browser's address bar (Accessibility)
//   - keystrokes to an app (CGEvent; needs Accessibility)
//   - AppleScript through /usr/bin/osascript (Automation, asked per app by macOS)

#![allow(non_upper_case_globals)]

use std::collections::VecDeque;
use std::ffi::{c_char, c_void, CStr};
use std::io::Read;
use std::process::{Command, Stdio};
use std::ptr::null;
use std::sync::Once;
use std::time::{Duration, Instant};

type CFTypeRef = *const c_void;
type Id = *mut c_void;

#[repr(C)]
struct Opaque {
    _private: [u8; 0],
}

const UTF8: u32 = 0x0800_0100; // kCFStringEncodingUTF8

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRetain(cf: CFTypeRef) -> CFTypeRef;
    fn CFRelease(cf: CFTypeRef);
    fn CFEqual(a: CFTypeRef, b: CFTypeRef) -> u8;
    fn CFGetTypeID(cf: CFTypeRef) -> usize;
    fn CFStringGetTypeID() -> usize;
    fn CFArrayGetTypeID() -> usize;
    fn CFStringCreateWithBytes(alloc: CFTypeRef, bytes: *const u8, len: isize, encoding: u32, external: u8) -> CFTypeRef;
    fn CFStringGetLength(s: CFTypeRef) -> isize;
    fn CFStringGetMaximumSizeForEncoding(len: isize, encoding: u32) -> isize;
    fn CFStringGetCString(s: CFTypeRef, buf: *mut c_char, size: isize, encoding: u32) -> u8;
    fn CFArrayGetCount(a: CFTypeRef) -> isize;
    fn CFArrayGetValueAtIndex(a: CFTypeRef, i: isize) -> CFTypeRef;
    fn CFDictionaryCreate(alloc: CFTypeRef, keys: *const CFTypeRef, values: *const CFTypeRef, n: isize, key_cb: *const Opaque, value_cb: *const Opaque) -> CFTypeRef;
    static kCFTypeDictionaryKeyCallBacks: Opaque;
    static kCFTypeDictionaryValueCallBacks: Opaque;
    static kCFBooleanTrue: CFTypeRef;
}

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> u8;
    fn AXIsProcessTrustedWithOptions(options: CFTypeRef) -> u8;
    static kAXTrustedCheckOptionPrompt: CFTypeRef;
    fn AXUIElementCreateApplication(pid: i32) -> CFTypeRef;
    fn AXUIElementCreateSystemWide() -> CFTypeRef;
    fn AXUIElementCopyAttributeValue(el: CFTypeRef, attr: CFTypeRef, value: *mut CFTypeRef) -> i32;
    fn AXUIElementSetMessagingTimeout(el: CFTypeRef, seconds: f32) -> i32;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventSourceCreate(state: i32) -> CFTypeRef;
    fn CGEventCreateKeyboardEvent(source: CFTypeRef, key: u16, down: bool) -> CFTypeRef;
    fn CGEventSetFlags(event: CFTypeRef, flags: u64);
    fn CGEventPostToPid(pid: i32, event: CFTypeRef);
}

#[link(name = "objc")]
extern "C" {
    fn objc_getClass(name: *const c_char) -> Id;
    fn sel_registerName(name: *const c_char) -> Id;
    fn objc_msgSend();
    fn objc_autoreleasePoolPush() -> *mut c_void;
    fn objc_autoreleasePoolPop(pool: *mut c_void);
}

// NSWorkspace and NSRunningApplication live in AppKit (Tauri links it already)
#[link(name = "AppKit", kind = "framework")]
extern "C" {}

extern "C" {
    fn proc_pidpath(pid: i32, buf: *mut c_void, size: u32) -> i32;
}

// ---------- Core Foundation ----------

/// An owned Core Foundation object, released when dropped.
pub struct Cf(CFTypeRef);

unsafe impl Send for Cf {}

impl Drop for Cf {
    fn drop(&mut self) {
        unsafe { CFRelease(self.0) }
    }
}

impl Clone for Cf {
    fn clone(&self) -> Self {
        unsafe { Cf(CFRetain(self.0)) }
    }
}

impl Cf {
    /// Takes ownership of a +1 reference (from a Create or Copy call).
    fn owned(r: CFTypeRef) -> Option<Self> {
        (!r.is_null()).then_some(Cf(r))
    }

    /// Retains a reference we don't own (from a Get call).
    fn retained(r: CFTypeRef) -> Option<Self> {
        (!r.is_null()).then(|| unsafe { Cf(CFRetain(r)) })
    }

    pub fn str(s: &str) -> Self {
        unsafe { Cf(CFStringCreateWithBytes(null(), s.as_ptr(), s.len() as isize, UTF8, 0)) }
    }

    pub fn same(&self, other: &Cf) -> bool {
        unsafe { CFEqual(self.0, other.0) != 0 }
    }

    pub fn text(&self) -> Option<String> {
        unsafe {
            if CFGetTypeID(self.0) != CFStringGetTypeID() {
                return None;
            }
            let size = CFStringGetMaximumSizeForEncoding(CFStringGetLength(self.0), UTF8) + 1;
            let mut buf = vec![0 as c_char; size as usize];
            if CFStringGetCString(self.0, buf.as_mut_ptr(), size, UTF8) == 0 {
                return None;
            }
            Some(CStr::from_ptr(buf.as_ptr()).to_string_lossy().into_owned())
        }
    }
}

// ---------- Accessibility ----------

static TIMEOUT: Once = Once::new();

/// Is Togami allowed to use Accessibility? With `prompt`, macOS asks the user
/// (once; after that it's System Settings > Privacy & Security > Accessibility).
pub fn trusted(prompt: bool) -> bool {
    unsafe {
        if !prompt {
            return AXIsProcessTrusted() != 0;
        }
        let keys = [kAXTrustedCheckOptionPrompt];
        let values = [kCFBooleanTrue];
        let Some(options) = Cf::owned(CFDictionaryCreate(null(), keys.as_ptr(), values.as_ptr(), 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks)) else {
            return AXIsProcessTrusted() != 0;
        };
        AXIsProcessTrustedWithOptions(options.0) != 0
    }
}

/// An attribute of an Accessibility element.
pub fn ax_get(el: &Cf, attr: &str) -> Option<Cf> {
    let name = Cf::str(attr);
    let mut value: CFTypeRef = null();
    unsafe {
        if AXUIElementCopyAttributeValue(el.0, name.0, &mut value) != 0 {
            return None;
        }
    }
    Cf::owned(value)
}

pub fn ax_text(el: &Cf, attr: &str) -> Option<String> {
    ax_get(el, attr)?.text()
}

fn ax_children(el: &Cf) -> Vec<Cf> {
    let Some(list) = ax_get(el, "AXChildren") else { return Vec::new() };
    unsafe {
        if CFGetTypeID(list.0) != CFArrayGetTypeID() {
            return Vec::new();
        }
        (0..CFArrayGetCount(list.0)).filter_map(|i| Cf::retained(CFArrayGetValueAtIndex(list.0, i))).collect()
    }
}

/// The focused window of an app (needs Accessibility).
pub fn focused_window(pid: i32) -> Option<Cf> {
    TIMEOUT.call_once(|| unsafe {
        // a hung app must not stall the blocker: give up on any AX call after half a second
        if let Some(all) = Cf::owned(AXUIElementCreateSystemWide()) {
            AXUIElementSetMessagingTimeout(all.0, 0.5);
        }
    });
    let app = Cf::owned(unsafe { AXUIElementCreateApplication(pid) })?;
    ax_get(&app, "AXFocusedWindow")
}

/// Searches a window's own controls (not the web page) for a text field:
/// the one `wanted` accepts, or else the first one. At most `limit` elements.
pub fn find_text_field(window: &Cf, wanted: impl Fn(&Cf) -> bool, limit: usize) -> Option<Cf> {
    let mut queue: VecDeque<(Cf, u32)> = ax_children(window).into_iter().map(|c| (c, 1)).collect();
    let mut first = None;
    let mut seen = 0;
    while let Some((el, depth)) = queue.pop_front() {
        seen += 1;
        if seen > limit {
            break;
        }
        let role = ax_text(&el, "AXRole").unwrap_or_default();
        match role.as_str() {
            "AXWebArea" => continue,
            "AXTextField" | "AXComboBox" => {
                if wanted(&el) {
                    return Some(el);
                }
                first.get_or_insert(el);
                continue;
            }
            _ => {}
        }
        if depth < 14 {
            queue.extend(ax_children(&el).into_iter().map(|c| (c, depth + 1)));
        }
    }
    first
}

// ---------- apps ----------

unsafe fn msg<R>(obj: Id, sel: &CStr) -> R {
    let f: unsafe extern "C" fn(Id, Id) -> R = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    f(obj, sel_registerName(sel.as_ptr()))
}

unsafe fn msg1<A, R>(obj: Id, sel: &CStr, a: A) -> R {
    let f: unsafe extern "C" fn(Id, Id, A) -> R = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    f(obj, sel_registerName(sel.as_ptr()), a)
}

fn with_pool<T>(f: impl FnOnce() -> T) -> T {
    unsafe {
        let pool = objc_autoreleasePoolPush();
        let out = f();
        objc_autoreleasePoolPop(pool);
        out
    }
}

/// The process id of the app in front.
pub fn frontmost_pid() -> Option<i32> {
    with_pool(|| unsafe {
        let ws: Id = msg(objc_getClass(c"NSWorkspace".as_ptr()), c"sharedWorkspace");
        if ws.is_null() {
            return None;
        }
        let app: Id = msg(ws, c"frontmostApplication");
        if app.is_null() {
            return None;
        }
        let pid: i32 = msg(app, c"processIdentifier");
        (pid > 0).then_some(pid)
    })
}

/// Hides an app and asks it to quit (as choosing Quit in its menu would).
pub fn hide_and_quit(pid: i32) {
    with_pool(|| unsafe {
        let app: Id = msg1(objc_getClass(c"NSRunningApplication".as_ptr()), c"runningApplicationWithProcessIdentifier:", pid);
        if !app.is_null() {
            let _: u8 = msg(app, c"hide");
            let _: u8 = msg(app, c"terminate");
        }
    })
}

/// Is an app with this bundle id running? (Never launches it.)
pub fn is_running(bundle_id: &str) -> bool {
    let id = Cf::str(bundle_id); // a CFString is an NSString
    with_pool(|| unsafe {
        let list: Id = msg1(objc_getClass(c"NSRunningApplication".as_ptr()), c"runningApplicationsWithBundleIdentifier:", id.0 as Id);
        !list.is_null() && msg::<usize>(list, c"count") > 0
    })
}

/// The app's name as its bundle is called, which doesn't change with the
/// system language: ".../Google Chrome.app/Contents/MacOS/Google Chrome" ->
/// "Google Chrome". Without a .app bundle, the executable's name.
pub fn app_name(pid: i32) -> Option<String> {
    let mut buf = vec![0u8; 4096];
    let n = unsafe { proc_pidpath(pid, buf.as_mut_ptr().cast(), buf.len() as u32) };
    if n <= 0 {
        return None;
    }
    let path = String::from_utf8_lossy(&buf[..n as usize]).into_owned();
    let name = path.split('/').find_map(|c| c.strip_suffix(".app")).or_else(|| path.rsplit('/').next())?;
    Some(name.to_string())
}

/// Presses ⌘ + a key in the given app (needs Accessibility).
pub fn command_key(pid: i32, key: u16) {
    const COMMAND: u64 = 0x0010_0000; // kCGEventFlagMaskCommand
    unsafe {
        let source = Cf::owned(CGEventSourceCreate(1)); // kCGEventSourceStateHIDSystemState
        let src = source.as_ref().map_or(null(), |s| s.0);
        for down in [true, false] {
            if let Some(event) = Cf::owned(CGEventCreateKeyboardEvent(src, key, down)) {
                CGEventSetFlags(event.0, COMMAND);
                CGEventPostToPid(pid, event.0);
            }
        }
    }
}

// ---------- AppleScript ----------

/// Runs an AppleScript and returns what it printed. The first time a script
/// talks to an app, macOS asks the user (Automation); until they answer the
/// script waits, so `timeout` should allow for that.
pub fn osascript(script: &str, timeout: Duration) -> Result<String, String> {
    let mut child = Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(script)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut out = String::new();
                if let Some(mut s) = child.stdout.take() {
                    let _ = s.read_to_string(&mut out);
                }
                if status.success() {
                    return Ok(out.trim_end_matches(['\r', '\n']).to_string());
                }
                let mut err = String::new();
                if let Some(mut s) = child.stderr.take() {
                    let _ = s.read_to_string(&mut err);
                }
                return Err(err.trim().to_string());
            }
            Ok(None) if started.elapsed() < timeout => std::thread::sleep(Duration::from_millis(15)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("osascript timed out".into());
            }
        }
    }
}
