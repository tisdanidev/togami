// Blocking. The UI sends the current lists (only while blocking is on). A
// background thread checks the foreground window a few times a second:
//   - a blocked app is asked to close
//   - a browser showing a blocked site (judged by its window title) is minimised
// Then Togami comes to the front and the UI shows its block screen.

use crate::rules::match_target;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

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
}

pub fn start(app: AppHandle) {
    let shared = app.state::<Shared>().0.clone();
    std::thread::spawn(move || {
        let mut last_emit: Option<(String, Instant)> = None;
        loop {
            std::thread::sleep(Duration::from_millis(400));
            let cfg = shared.lock().unwrap().clone();
            if !cfg.active {
                continue;
            }
            #[cfg(windows)]
            if let Some(fg) = win::foreground() {
                if let Some((target, kind)) = match_target(&cfg.apps, &cfg.sites, &fg.exe, &fg.title) {
                    win::push_away(&fg, kind);
                    let again = last_emit.as_ref().is_some_and(|(t, at)| *t == target && at.elapsed() < Duration::from_millis(1500));
                    if !again {
                        last_emit = Some((target.clone(), Instant::now()));
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.unminimize();
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                        let _ = app.emit("blocked-attempt", Attempt { target, kind });
                    }
                }
            }
            #[cfg(not(windows))]
            let _ = (&cfg, &mut last_emit, &app);
        }
    });
}

// ---------- Windows ----------

#[cfg(windows)]
mod win {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, WPARAM};
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
