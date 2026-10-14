// Togami desktop shell. The UI lives in ../app; this adds what a web page
// can't do: watching the foreground window to block apps and sites, and
// reading what's playing from Windows' media controls, notifications,
// updating itself from GitHub releases, the desktop pet window, and running
// in the background with a tray icon.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod blocker;
mod media;
mod pet;
mod rules;
mod system;
mod tray;

fn main() {
    tauri::Builder::default()
        // a second launch brings back the running Togami (it may be hidden in the tray)
        .plugin(tauri_plugin_single_instance::init(|app, _, _| pet::show_main(app.clone())))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(blocker::Shared::default())
        .manage(blocker::LastSeen::default())
        .manage(system::PendingUpdate::default())
        .manage(pet::Hit::default())
        .setup(|app| {
            blocker::start(app.handle().clone());
            pet::start(app.handle().clone());
            tray::setup(app.handle())?;
            Ok(())
        })
        .on_window_event(tray::on_window_event)
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
            pet::show_main,
            tray::app_exit
        ])
        .run(tauri::generate_context!())
        .expect("Togami failed to start");
}
