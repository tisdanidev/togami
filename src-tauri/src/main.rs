// Togami desktop shell. The UI lives in ../app; this adds what a web page
// can't do: watching the foreground window to block apps and sites, and
// reading what's playing from Windows' media controls, notifications, and
// updating itself from GitHub releases.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod blocker;
mod media;
mod rules;
mod system;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(blocker::Shared::default())
        .manage(blocker::LastSeen::default())
        .manage(system::PendingUpdate::default())
        .setup(|app| {
            blocker::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            blocker::blocker_sync,
            blocker::blocker_seen,
            media::media_now,
            media::media_control,
            system::notify,
            system::app_version,
            system::update_check,
            system::update_install
        ])
        .run(tauri::generate_context!())
        .expect("Togami failed to start");
}
