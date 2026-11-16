// Notifications, self-updates, permissions and quitting.
//
// Desktop updates come from GitHub releases: the app reads latest.json from
// the newest release, and if it lists a newer version, downloads that
// installer, checks its signature against the public key in tauri.conf.json,
// installs it and restarts.
//
// Android reads latest-android.json from the same release ({ version, notes,
// url }), downloads the APK inside Togami and hands it to Android's installer
// (Updater.kt). Android installs it over the old one only if it is signed
// with the same key, which keeps the signature check. It is a separate file
// so the desktop updater never sees an entry it can't read.
//
// The UI only offers updates when no session or lockout is running, since a
// restart mid-session counts as quitting.
//
// Commands that reach the Kotlin plugin on Android are async: a plain command
// runs on the main thread, which the plugin needs to answer.

use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, State};
use tauri_plugin_notification::NotificationExt;

#[cfg(desktop)]
type Pending = tauri_plugin_updater::Update;
#[cfg(mobile)]
type Pending = String; // the APK's link

#[derive(Default)]
pub struct PendingUpdate(Mutex<Option<Pending>>);

#[derive(Serialize)]
pub struct UpdateInfo {
    version: String,
    notes: Option<String>,
}

#[tauri::command]
pub fn notify(app: AppHandle, title: String, body: String) {
    let _ = app.notification().builder().title(title).body(body).show();
}

#[tauri::command]
pub fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[cfg(desktop)]
#[tauri::command]
pub async fn update_check(app: AppHandle, pending: State<'_, PendingUpdate>) -> Result<Option<UpdateInfo>, String> {
    use tauri_plugin_updater::UpdaterExt;
    let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    let info = update.as_ref().map(|u| UpdateInfo { version: u.version.clone(), notes: u.body.clone() });
    *pending.0.lock().unwrap() = update;
    Ok(info)
}

#[cfg(desktop)]
#[tauri::command]
pub async fn update_install(app: AppHandle, pending: State<'_, PendingUpdate>) -> Result<(), String> {
    let update = pending.0.lock().unwrap().take().ok_or("No update has been found yet.")?;
    update.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    app.restart();
}

#[cfg(mobile)]
const ANDROID_LATEST: &str = "https://github.com/tisdanidev/togami/releases/latest/download/latest-android.json";

/// "0.4.10" > "0.4.9"
#[cfg(mobile)]
fn newer(remote: &str, local: &str) -> bool {
    let parts = |v: &str| v.trim_start_matches('v').split(['.', '-', '+']).take(3).map(|p| p.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    parts(remote) > parts(local)
}

#[cfg(mobile)]
#[tauri::command]
pub async fn update_check(app: AppHandle, pending: State<'_, PendingUpdate>) -> Result<Option<UpdateInfo>, String> {
    let res = crate::ai::client()?.get(ANDROID_LATEST).send().await.map_err(|_| "Couldn't reach GitHub. Are you online?".to_string())?;
    if !res.status().is_success() {
        return Err(format!("GitHub answered with an error ({}).", res.status().as_u16()));
    }
    let latest: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    let version = latest["version"].as_str().unwrap_or_default().to_string();
    let url = latest["url"].as_str().unwrap_or_default().to_string();
    let local = app.package_info().version.to_string();
    if version.is_empty() || !url.starts_with("https://github.com/tisdanidev/togami/") || !newer(&version, &local) {
        *pending.0.lock().unwrap() = None;
        return Ok(None);
    }
    *pending.0.lock().unwrap() = Some(url);
    Ok(Some(UpdateInfo { version, notes: latest["notes"].as_str().map(str::to_string) }))
}

/// Android: downloads the APK inside Togami and hands it to Android's
/// installer. Resolves to false when Android first needs "Install unknown
/// apps" for Togami (its settings page is opened); the UI then polls
/// update_progress.
#[cfg(mobile)]
#[tauri::command]
pub async fn update_install(pending: State<'_, PendingUpdate>) -> Result<bool, String> {
    let url = pending.0.lock().unwrap().clone().ok_or("No update has been found yet.")?;
    #[cfg(target_os = "android")]
    return crate::android::update_install(&url);
    #[cfg(not(target_os = "android"))]
    Err(format!("Download it from {url}"))
}

/// Android: how the download and install are going. Null elsewhere.
#[tauri::command]
pub async fn update_progress() -> serde_json::Value {
    #[cfg(target_os = "android")]
    return crate::android::update_state();
    #[cfg(not(target_os = "android"))]
    serde_json::Value::Null
}

/// Quits Togami (the UI calls this after asking, if a session is running).
/// Android only closes the screen; Android decides when the app stops.
#[tauri::command]
pub async fn app_exit(app: AppHandle) {
    #[cfg(target_os = "android")]
    {
        let _ = app;
        crate::android::exit();
    }
    #[cfg(not(target_os = "android"))]
    app.exit(0);
}

/// Blocking's permission: Accessibility on macOS (tab titles, closing tabs)
/// and Android (all blocking). None elsewhere.
#[tauri::command]
pub async fn access_status() -> Option<bool> {
    #[cfg(target_os = "macos")]
    return Some(crate::macos::trusted(false));
    #[cfg(target_os = "android")]
    return Some(crate::android::access_on());
    #[cfg(not(any(target_os = "macos", target_os = "android")))]
    None
}

/// macOS: asks for Accessibility, or opens its page in System Settings if
/// macOS has asked before (it only shows its own question once).
/// Android: opens the Accessibility settings, where Togami is switched on.
#[tauri::command]
pub async fn access_request() {
    #[cfg(target_os = "macos")]
    if !crate::macos::trusted(true) {
        let _ = std::process::Command::new("/usr/bin/open").arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility").spawn();
    }
    #[cfg(target_os = "android")]
    crate::android::access_request();
}

/// Android: may Togami read what's playing (notification access)? None elsewhere.
#[tauri::command]
pub async fn listener_status() -> Option<bool> {
    #[cfg(target_os = "android")]
    return Some(crate::android::listener_on());
    #[cfg(not(target_os = "android"))]
    None
}

#[tauri::command]
pub async fn listener_request() {
    #[cfg(target_os = "android")]
    crate::android::listener_request();
}

/// Android: opens Togami's App info (for "Allow restricted settings").
#[tauri::command]
pub async fn app_info() {
    #[cfg(target_os = "android")]
    crate::android::app_info();
}

/// Android: the colour behind the status and navigation bars, so they match the page.
#[tauri::command]
pub async fn system_bars(color: String, dark: bool) {
    #[cfg(target_os = "android")]
    crate::android::bars(&color, dark);
    #[cfg(not(target_os = "android"))]
    let _ = (color, dark);
}

/// Mobile: a tick every second for the UI's clock loop (the desktop one is in tray.rs).
#[cfg(mobile)]
pub fn heartbeat(app: AppHandle) {
    use tauri::Emitter;
    std::thread::spawn(move || loop {
        let _ = app.emit_to("main", "heartbeat", ());
        std::thread::sleep(std::time::Duration::from_secs(1));
    });
}
