// Blocking. The UI sends the current lists (only while blocking is on). A
// background thread checks the foreground window a few times a second:
//   - a blocked app is asked to close
//   - a browser on any page of a blocked site gets 5 seconds (with a Windows
//     notification) to close the tab, then it is minimised. The page is read
//     from the browser's address bar (UI Automation); the window title is the
//     fallback when the address can't be read.
// Then Togami comes to the front and the UI shows its block screen.

use crate::rules::{is_browser, match_target};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
#[cfg(windows)]
use tauri_plugin_notification::NotificationExt;

#[derive(Default, Clone, Deserialize, Debug)]
pub struct Config {
    pub active: bool,
    pub apps: Vec<String>,
    pub sites: Vec<String>,
}

#[derive(Default)]
pub struct Shared(pub Arc<Mutex<Config>>);

#[tauri::command]
pub fn blocker_sync(state: State<'_, Shared>, config: Config) {
    *state.0.lock().unwrap() = config;
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
    hwnd: isize,
    target: String,
    since: Instant,
}

pub fn start(app: AppHandle) {
    let shared = app.state::<Shared>().0.clone();
    std::thread::spawn(move || {
        let mut last_emit: Option<(String, Instant)> = None;
        let mut grace: Option<Grace> = None;
        let mut recent: HashMap<String, Instant> = HashMap::new();
        #[cfg(windows)]
        let mut address_bar = win::AddressBar::new();
        loop {
            std::thread::sleep(Duration::from_millis(400));
            let cfg = shared.lock().unwrap().clone();
            if !cfg.active {
                grace = None;
                continue;
            }
            #[cfg(windows)]
            {
                let hit = win::foreground().and_then(|fg| {
                    let url = if is_browser(&fg.exe) && !cfg.sites.is_empty() { address_bar.as_mut().and_then(|a| a.read(fg.hwnd)) } else { None };
                    match_target(&cfg.apps, &cfg.sites, &fg.exe, &fg.title, url.as_deref()).map(|(t, k)| (fg, t, k))
                });
                let Some((fg, target, kind)) = hit else {
                    // moved away (closed the tab, switched window) during the grace period
                    if let Some(g) = grace.take() {
                        recent.insert(g.target, Instant::now());
                    }
                    continue;
                };
                let hwnd = fg.hwnd.0 as isize;
                let mut warned = false;
                if kind == "site" {
                    match &grace {
                        Some(g) if g.hwnd == hwnd && g.target == target => {
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
                                grace = Some(Grace { hwnd, target: target.clone(), since: Instant::now() });
                                let _ = app
                                    .notification()
                                    .builder()
                                    .title(format!("{target} is blocked"))
                                    .body("Close the tab within 5 seconds or the browser gets minimised.")
                                    .show();
                                let _ = app.emit("blocked-attempt", Attempt { target, kind, stage: "warn", warned: false });
                                continue;
                            }
                        }
                    }
                    recent.insert(target.clone(), Instant::now());
                }
                win::push_away(&fg, kind);
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
            #[cfg(not(windows))]
            let _ = (&cfg, &mut last_emit, &mut grace, &mut recent, &app);
        }
    });
}

// ---------- Windows ----------

#[cfg(windows)]
mod win {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, WPARAM};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
    use windows::Win32::System::Variant::VARIANT;
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, IUIAutomationCondition, IUIAutomationElement, IUIAutomationValuePattern, TreeScope_Descendants, UIA_ControlTypePropertyId,
        UIA_EditControlTypeId, UIA_ValuePatternId,
    };
    use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId, PostMessageW, ShowWindow, SW_MINIMIZE, WM_CLOSE};

    pub struct Foreground {
        pub hwnd: HWND,
        pub exe: String,
        pub title: String,
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

    /// Reads the address bar of the browser window in front. The bar is the first
    /// text box in the browser's own UI (Chrome, Edge, Firefox, Brave, Opera...);
    /// it's looked up once per window and then re-read on each check.
    pub struct AddressBar {
        uia: IUIAutomation,
        edit: IUIAutomationCondition,
        cached: Option<(isize, IUIAutomationElement)>,
    }

    impl AddressBar {
        pub fn new() -> Option<Self> {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
                let uia: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
                let edit = uia.CreatePropertyCondition(UIA_ControlTypePropertyId, &VARIANT::from(UIA_EditControlTypeId.0)).ok()?;
                Some(Self { uia, edit, cached: None })
            }
        }

        pub fn read(&mut self, hwnd: HWND) -> Option<String> {
            let key = hwnd.0 as isize;
            if let Some((k, el)) = &self.cached {
                if *k == key {
                    if let Some(v) = value(el) {
                        return Some(v);
                    }
                }
            }
            self.cached = None;
            let el = unsafe { self.uia.ElementFromHandle(hwnd).ok()?.FindFirst(TreeScope_Descendants, &self.edit).ok()? };
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
    pub fn push_away(fg: &Foreground, kind: &str) {
        unsafe {
            if kind == "app" {
                let _ = PostMessageW(Some(fg.hwnd), WM_CLOSE, WPARAM(0), LPARAM(0));
            }
            let _ = ShowWindow(fg.hwnd, SW_MINIMIZE);
        }
    }
}
