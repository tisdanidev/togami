// Togami desktop shell. The UI lives in ../app; this adds what a web page
// can't do: watching the app in front to block apps and sites, reading
// what's playing (Windows' media controls; Spotify and Music on macOS),
// notifications, updating itself from GitHub releases, the desktop pet
// window, and running in the background with a tray (menu bar) icon.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod blocker;
#[cfg(target_os = "macos")]
mod macos;
mod media;
mod pet;
mod rules;
mod system;
mod tray;

fn main() {
    let builder = tauri::Builder::default()
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
            system::access_status,
            system::access_request,
            pet::pet_has_pack,
            pet::pet_pack,
            pet::pet_import,
            pet::pet_remove,
            pet::pet_show,
            pet::pet_hide,
            pet::pet_hit,
            pet::show_main,
            tray::app_exit
        ]);
    #[cfg(target_os = "macos")]
    let builder = builder.menu(tray::app_menu).on_menu_event(tray::on_app_menu);
    let app = builder.build(tauri::generate_context!()).expect("Togami failed to start");
    app.run(|_app, _event| {
        // macOS: clicking the Dock icon brings the window back (it may be hidden)
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = _event {
            pet::show_main(_app.clone());
        }
    });
}
