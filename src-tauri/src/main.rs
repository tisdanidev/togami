// Togami desktop shell. The UI lives in ../app; this adds what a web page
// can't do: watching the foreground window to block apps and sites, and
// reading what's playing from Windows' media controls, notifications,
// updating itself from GitHub releases, and the desktop pet window.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod blocker;
mod media;
mod pet;
mod rules;
mod system;

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(blocker::Shared::default())
        .manage(blocker::LastSeen::default())
        .manage(system::PendingUpdate::default())
        .manage(pet::Hit::default())
        .setup(|app| {
            blocker::start(app.handle().clone());
            pet::start(app.handle().clone());
            Ok(())
        })
        // the pet window must not keep Togami (and its blocker) running once
        // the main window is closed
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                window.app_handle().exit(0);
            }
        })
        .invoke_handler(tauri::generate_handler![
            blocker::blocker_sync,
            blocker::blocker_seen,
            media::media_now,
            media::media_control,
            system::notify,
            system::app_version,
            system::update_check,
            system::update_install,
            pet::pet_has_pack,
            pet::pet_pack,
            pet::pet_import,
            pet::pet_remove,
            pet::pet_show,
            pet::pet_hide,
            pet::pet_hit,
            pet::show_main
        ])
        .run(tauri::generate_context!())
        .expect("Togami failed to start");
}
