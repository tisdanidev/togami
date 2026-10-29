// Blocking. The UI sends the current lists (only while blocking is on). A
// background thread checks the window in front a few times a second:
//   - a blocked app is asked to close
//   - a browser tab on a blocked site gets 5 seconds (with a notification) to
//     be closed, then Togami closes it (Ctrl+W, or ⌘W on macOS). A tab counts
//     if its address (any page or subdomain) or its title names a blocked site.
//     Windows: Chrome, Edge, Firefox; the address bar is read with UI Automation.
//     macOS: Safari, Chrome, Edge, Brave, Arc (address read with AppleScript)
//     and Firefox (address bar read with Accessibility).
// Then Togami comes to the front and the UI shows its block screen.

use crate::rules::{is_browser, match_target};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
#[cfg(any(windows, target_os = "macos"))]
use tauri_plugin_notification::NotificationExt;

#[cfg(target_os = "macos")]
use mac as os;
#[cfg(windows)]
use win as os;

#[derive(Default, Clone, Deserialize, Debug)]
pub struct Config {
    pub active: bool,
    pub apps: Vec<String>,
    pub sites: Vec<String>,
}

#[derive(Default)]
pub struct Shared(pub Arc<Mutex<Config>>);

/// What the watcher last saw in front (shown in Togami Dev's test bench).
#[derive(Default, Clone, Serialize)]
pub struct Seen {
    exe: String,
    title: String,
    url: Option<String>,
    target: Option<String>,
}

#[derive(Default)]
pub struct LastSeen(pub Arc<Mutex<Option<Seen>>>);

#[tauri::command]
pub fn blocker_sync(state: State<'_, Shared>, config: Config) {
    *state.0.lock().unwrap() = config;
}

#[tauri::command]
pub fn blocker_seen(seen: State<'_, LastSeen>) -> Option<Seen> {
    seen.0.lock().unwrap().clone()
}

#[derive(Clone, Serialize)]
struct Attempt {
    target: String,
    kind: &'static str,
    /// "warn": landed on a blocked site, grace period started (nothing shown in Togami).
    /// "block": the window was pushed away and Togami shows its block screen.
    stage: &'static str,
    /// For "block": true if this attempt was already counted at the "warn" stage.
    warned: bool,
}

/// Time to close a blocked tab before the browser is minimised.
const GRACE: Duration = Duration::from_secs(5);
/// Coming back to the same site within this time gets no new grace period,
/// so the grace can't be used to watch in 5-second bursts.
const GRACE_COOLDOWN: Duration = Duration::from_secs(30);

struct Grace {
    window: isize,
    target: String,
    since: Instant,
}

pub fn start(app: AppHandle) {
    let shared = app.state::<Shared>().0.clone();
    let seen = app.state::<LastSeen>().0.clone();
    std::thread::spawn(move || {
        let mut last_emit: Option<(String, Instant)> = None;
        let mut grace: Option<Grace> = None;
        let mut recent: HashMap<String, Instant> = HashMap::new();
        #[cfg(any(windows, target_os = "macos"))]
        let mut address_bar = os::AddressBar::new();
        #[cfg(target_os = "macos")]
        let mut asked_access = false;
        loop {
            std::thread::sleep(Duration::from_millis(400));
            let cfg = shared.lock().unwrap().clone();
            if !cfg.active {
                grace = None;
                continue;
            }
            // macOS: tab titles and closing tabs need Accessibility; ask once per run
            #[cfg(target_os = "macos")]
            if !asked_access && !cfg.sites.is_empty() {
                asked_access = true;
                crate::macos::trusted(true);
            }
            #[cfg(any(windows, target_os = "macos"))]
            {
                let hit = os::foreground().and_then(|fg| {
                    let url = if is_browser(&fg.exe) && !cfg.sites.is_empty() { address_bar.as_mut().and_then(|a| a.read(&fg)) } else { None };
                    let found = match_target(&cfg.apps, &cfg.sites, &fg.exe, &fg.title, url.as_deref());
                    *seen.lock().unwrap() = Some(Seen { exe: fg.exe.clone(), title: fg.title.clone(), url, target: found.as_ref().map(|f| f.0.clone()) });
                    found.map(|(t, k)| (fg, t, k))
                });
                let Some((fg, target, kind)) = hit else {
                    // moved away (closed the tab, switched window) during the grace period
                    if let Some(g) = grace.take() {
                        recent.insert(g.target, Instant::now());
                    }
                    continue;
                };
                let window = fg.key();
                let mut warned = false;
                if kind == "site" {
                    match &grace {
                        Some(g) if g.window == window && g.target == target => {
                            if g.since.elapsed() < GRACE {
                                continue; // still counting down
                            }
                            grace = None;
                            warned = true;
                        }
                        _ => {
                            if let Some(g) = grace.take() {
                                recent.insert(g.target, Instant::now());
                            }
                            let fresh = recent.get(&target).is_none_or(|t| t.elapsed() >= GRACE_COOLDOWN);
                            if fresh {
                                grace = Some(Grace { window, target: target.clone(), since: Instant::now() });
                                let _ = app
                                    .notification()
                                    .builder()
                                    .title(format!("{target} is blocked"))
                                    .body("Close the tab within 5 seconds or Togami closes it.")
                                    .show();
                                let _ = app.emit("blocked-attempt", Attempt { target, kind, stage: "warn", warned: false });
                                continue;
                            }
                        }
                    }
                    recent.insert(target.clone(), Instant::now());
                }
                os::push_away(&fg, kind);
                let again = last_emit.as_ref().is_some_and(|(t, at)| *t == target && at.elapsed() < Duration::from_millis(1500));
                if !again {
                    last_emit = Some((target.clone(), Instant::now()));
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.unminimize();
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                    let _ = app.emit("blocked-attempt", Attempt { target, kind, stage: "block", warned });
                }
            }
            #[cfg(not(any(windows, target_os = "macos")))]
            let _ = (&cfg, &mut last_emit, &mut grace, &mut recent, &app, &seen);
        }
    });
}

// ---------- Windows ----------

#[cfg(windows)]
mod win {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, WPARAM};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
    use windows::core::BSTR;
    use windows::Win32::System::Variant::VARIANT;
    use windows::Win32::UI::Input::KeyboardAndMouse::{SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, VIRTUAL_KEY, VK_CONTROL};
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, IUIAutomationCondition, IUIAutomationElement, IUIAutomationValuePattern, TreeScope_Descendants, UIA_AutomationIdPropertyId,
        UIA_ClassNamePropertyId, UIA_ControlTypePropertyId, UIA_EditControlTypeId, UIA_ValuePatternId,
    };
    use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId, PostMessageW, ShowWindow, SW_MINIMIZE, WM_CLOSE};

    pub struct Foreground {
        pub hwnd: HWND,
        pub exe: String,
        pub title: String,
    }

    impl Foreground {
        /// Tells windows apart for the grace period.
        pub fn key(&self) -> isize {
            self.hwnd.0 as isize
        }
    }

    pub fn foreground() -> Option<Foreground> {
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.0.is_null() {
                return None;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == 0 || pid == std::process::id() {
                return None;
            }
            let exe = exe_stem(pid).unwrap_or_default();
            let mut buf = [0u16; 512];
            let n = GetWindowTextW(hwnd, &mut buf);
            let title = String::from_utf16_lossy(&buf[..n.max(0) as usize]);
            Some(Foreground { hwnd, exe, title })
        }
    }

    fn exe_stem(pid: u32) -> Option<String> {
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len);
            let _ = CloseHandle(h);
            ok.ok()?;
            let path = String::from_utf16_lossy(&buf[..len as usize]);
            let file = path.rsplit(['\\', '/']).next()?.to_string();
            Some(file.strip_suffix(".exe").or_else(|| file.strip_suffix(".EXE")).unwrap_or(&file).to_string())
        }
    }

    /// Reads the address bar of the browser window in front. Chrome and Edge
    /// (and other Chromium browsers) expose it with class "OmniboxViewViews",
    /// Firefox with id "urlbar-input". The first text box is only a fallback, as
    /// on some sites that can be the page's own search box. Found once per
    /// window, then re-read on each check.
    pub struct AddressBar {
        uia: IUIAutomation,
        address: IUIAutomationCondition,
        edit: IUIAutomationCondition,
        cached: Option<(isize, IUIAutomationElement)>,
    }

    impl AddressBar {
        pub fn new() -> Option<Self> {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
                let uia: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
                let chromium = uia.CreatePropertyCondition(UIA_ClassNamePropertyId, &VARIANT::from(BSTR::from("OmniboxViewViews"))).ok()?;
                let firefox = uia.CreatePropertyCondition(UIA_AutomationIdPropertyId, &VARIANT::from(BSTR::from("urlbar-input"))).ok()?;
                let address = uia.CreateOrCondition(&chromium, &firefox).ok()?;
                let edit = uia.CreatePropertyCondition(UIA_ControlTypePropertyId, &VARIANT::from(UIA_EditControlTypeId.0)).ok()?;
                Some(Self { uia, address, edit, cached: None })
            }
        }

        pub fn read(&mut self, fg: &Foreground) -> Option<String> {
            let hwnd = fg.hwnd;
            let key = hwnd.0 as isize;
            if let Some((k, el)) = &self.cached {
                if *k == key {
                    if let Some(v) = value(el) {
                        return Some(v);
                    }
                }
            }
            self.cached = None;
            let el = unsafe {
                let root = self.uia.ElementFromHandle(hwnd).ok()?;
                root.FindFirst(TreeScope_Descendants, &self.address).or_else(|_| root.FindFirst(TreeScope_Descendants, &self.edit)).ok()?
            };
            let v = value(&el);
            self.cached = Some((key, el));
            v
        }
    }

    fn value(el: &IUIAutomationElement) -> Option<String> {
        unsafe {
            let p: IUIAutomationValuePattern = el.GetCurrentPatternAs(UIA_ValuePatternId).ok()?;
            Some(p.CurrentValue().ok()?.to_string())
        }
    }

    /// Close a blocked app's window; minimise a browser on a blocked site.
    /// Blocked app: ask it to close and minimise it. Blocked site: close the tab
    /// with Ctrl+W (works in Chrome, Edge and Firefox), which also stops a
    /// playing video; only sent while that browser window is still in front.
    pub fn push_away(fg: &Foreground, kind: &str) {
        unsafe {
            if kind == "app" {
                let _ = PostMessageW(Some(fg.hwnd), WM_CLOSE, WPARAM(0), LPARAM(0));
                let _ = ShowWindow(fg.hwnd, SW_MINIMIZE);
                return;
            }
            if GetForegroundWindow() != fg.hwnd {
                return;
            }
            let key = |vk: VIRTUAL_KEY, up: bool| INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT { wVk: vk, wScan: 0, dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) }, time: 0, dwExtraInfo: 0 },
                },
            };
            let w = VIRTUAL_KEY(b'W' as u16);
            let keys = [key(VK_CONTROL, false), key(w, false), key(w, true), key(VK_CONTROL, true)];
            SendInput(&keys, std::mem::size_of::<INPUT>() as i32);
        }
    }
}

// ---------- macOS ----------

#[cfg(target_os = "macos")]
mod mac {
    use crate::macos::{self, Cf};
    use std::collections::HashMap;
    use std::time::{Duration, Instant};

    pub struct Foreground {
        pub pid: i32,
        pub exe: String,
        pub title: String,
    }

    impl Foreground {
        /// Tells apps apart for the grace period.
        pub fn key(&self) -> isize {
            self.pid as isize
        }
    }

    /// The app in front, by its bundle name ("Google Chrome", "Discord"), and
    /// its focused window's title (empty without Accessibility).
    pub fn foreground() -> Option<Foreground> {
        let pid = macos::frontmost_pid()?;
        if pid as u32 == std::process::id() {
            return None;
        }
        let exe = macos::app_name(pid)?;
        let title = macos::focused_window(pid).and_then(|w| macos::ax_text(&w, "AXTitle")).unwrap_or_default();
        Some(Foreground { pid, exe, title })
    }

    /// The front tab in AppleScript, for browsers that can be asked for it.
    /// Others (Firefox and its forks) have their address bar read with Accessibility.
    fn scripted_tab(exe: &str) -> Option<&'static str> {
        match exe {
            "Safari" | "Safari Technology Preview" => Some("current tab of front window"),
            "Google Chrome" | "Google Chrome Beta" | "Google Chrome Canary" | "Chromium" | "Microsoft Edge" | "Microsoft Edge Beta" | "Brave Browser" | "Vivaldi" | "Arc" => {
                Some("active tab of front window")
            }
            _ => None,
        }
    }

    fn tell(exe: &str, what: &str) -> String {
        format!("tell application \"{}\" to {what}", exe.replace('"', ""))
    }

    /// An address is re-read when the tab title changes, or after this long.
    const REREAD: Duration = Duration::from_millis(1500);
    /// After AppleScript was refused (or timed out), wait this long before asking that browser again.
    const RETRY: Duration = Duration::from_secs(60);
    /// The first AppleScript to a browser waits for the user to answer macOS's question.
    const ASK_TIMEOUT: Duration = Duration::from_secs(20);

    /// Reads the address of the tab in front.
    pub struct AddressBar {
        last: Option<(i32, String, Instant, Option<String>)>,
        refused: HashMap<String, Instant>,
        field: Option<(Cf, Cf)>,
    }

    impl AddressBar {
        pub fn new() -> Option<Self> {
            Some(Self { last: None, refused: HashMap::new(), field: None })
        }

        pub fn read(&mut self, fg: &Foreground) -> Option<String> {
            let Some(tab) = scripted_tab(&fg.exe) else { return self.read_field(fg) };
            if let Some((pid, title, at, url)) = &self.last {
                if *pid == fg.pid && *title == fg.title && at.elapsed() < REREAD {
                    return url.clone();
                }
            }
            if self.refused.get(&fg.exe).is_some_and(|t| t.elapsed() < RETRY) {
                return None;
            }
            let url = match macos::osascript(&tell(&fg.exe, &format!("get URL of {tab}")), ASK_TIMEOUT) {
                Ok(u) => Some(u),
                Err(_) => {
                    self.refused.insert(fg.exe.clone(), Instant::now());
                    None
                }
            };
            self.last = Some((fg.pid, fg.title.clone(), Instant::now(), url.clone()));
            url
        }

        /// Firefox exposes its address bar with the id "urlbar-input". Found once
        /// per window, then re-read on each check.
        fn read_field(&mut self, fg: &Foreground) -> Option<String> {
            let window = macos::focused_window(fg.pid)?;
            if let Some((w, field)) = &self.field {
                if w.same(&window) {
                    if let Some(v) = macos::ax_text(field, "AXValue") {
                        return Some(v);
                    }
                }
            }
            self.field = None;
            let field = macos::find_text_field(&window, |el| macos::ax_text(el, "AXDOMIdentifier").as_deref() == Some("urlbar-input"), 800)?;
            let v = macos::ax_text(&field, "AXValue");
            self.field = Some((window, field));
            v
        }
    }

    const KEY_W: u16 = 13; // kVK_ANSI_W

    /// Blocked app: hide it and ask it to quit. Blocked site: close the tab
    /// (with AppleScript where the browser allows it, otherwise ⌘W), which also
    /// stops a playing video; only while that browser is still in front.
    pub fn push_away(fg: &Foreground, kind: &str) {
        if kind == "app" {
            macos::hide_and_quit(fg.pid);
            return;
        }
        if macos::frontmost_pid() != Some(fg.pid) {
            return;
        }
        if let Some(tab) = scripted_tab(&fg.exe) {
            if macos::osascript(&tell(&fg.exe, &format!("close {tab}")), Duration::from_secs(3)).is_ok() {
                return;
            }
        }
        macos::command_key(fg.pid, KEY_W);
    }
}
