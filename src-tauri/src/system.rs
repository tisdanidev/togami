// Windows notifications and self-updates.
//
// Updates come from GitHub releases: the app reads latest.json from the newest
// release, and if it lists a newer version, downloads that installer, checks
// its signature against the public key in tauri.conf.json, installs it and
// restarts. The UI only offers this when no session or lockout is running,
// since a restart mid-session counts as quitting.

use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, State};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
pub struct PendingUpdate(Mutex<Option<Update>>);

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

#[tauri::command]
pub async fn update_check(app: AppHandle, pending: State<'_, PendingUpdate>) -> Result<Option<UpdateInfo>, String> {
    let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    let info = update.as_ref().map(|u| UpdateInfo { version: u.version.clone(), notes: u.body.clone() });
    *pending.0.lock().unwrap() = update;
    Ok(info)
}

#[tauri::command]
pub async fn update_install(app: AppHandle, pending: State<'_, PendingUpdate>) -> Result<(), String> {
    let update = pending.0.lock().unwrap().take().ok_or("No update has been found yet.")?;
    update.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    app.restart();
}
