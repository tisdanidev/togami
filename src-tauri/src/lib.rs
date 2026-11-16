// Togami's native side. The UI lives in ../app; this adds what a web page
// can't do: watching the app in front to block apps and sites, reading
// what's playing (Windows' media controls; Spotify and Music on macOS; media
// sessions on Android), notifications, updating itself from GitHub releases,
// the desktop pet window, AI help through Groq (the Ask chat, screen snips),
// and running in the background with a tray (menu bar) icon.
//
// Desktop (Windows, macOS) starts from main.rs; Android starts here through
// mobile_entry_point. Android has one window, so the pet and the Ask chat run
// inside it (see platform.js), and its system calls go through the Kotlin
// plugin in gen/android (android.rs).

mod ai;
#[cfg(target_os = "android")]
mod android;
mod blocker;
#[cfg(windows)]
mod capture;
#[cfg(target_os = "macos")]
mod macos;
mod media;
mod pet;
mod rules;
mod system;
#[cfg(desktop)]
mod tray;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // a second launch brings back the running Togami (it may be hidden in the tray)
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|app, _, _| pet::show_main(app.clone())))
        .plugin(tauri_plugin_updater::Builder::new().build());
    #[cfg(target_os = "android")]
    let builder = builder.plugin(android::init());
    let builder = builder
        .plugin(tauri_plugin_notification::init())
        .manage(blocker::Shared::default())
        .manage(blocker::LastSeen::default())
        .manage(system::PendingUpdate::default())
        .manage(pet::Hit::default())
        .manage(ai::Snip::default())
        .setup(|app| {
            blocker::start(app.handle().clone());
            #[cfg(desktop)]
            {
                pet::start(app.handle().clone());
                tray::setup(app.handle())?;
            }
            #[cfg(mobile)]
            system::heartbeat(app.handle().clone());
            Ok(())
        });
    #[cfg(desktop)]
    let builder = builder.on_window_event(tray::on_window_event);
    let builder = builder.invoke_handler(tauri::generate_handler![
        blocker::blocker_sync,
        blocker::blocker_seen,
        media::media_now,
        media::media_control,
        system::notify,
        system::app_version,
        system::update_check,
        system::update_install,
        system::update_progress,
        system::access_status,
        system::access_request,
        system::listener_status,
        system::listener_request,
        system::app_info,
        system::system_bars,
        pet::pet_has_pack,
        pet::pet_persona,
        pet::pet_pack,
        pet::pet_import,
        pet::pet_remove,
        pet::pet_show,
        pet::pet_hide,
        pet::pet_hit,
        pet::show_main,
        system::app_exit,
        ai::ai_key_status,
        ai::ai_key_set,
        ai::ai_key_clear,
        ai::ai_chat,
        ai::chat_open,
        ai::chat_take_snip,
        ai::snip_start,
        ai::snip_image,
        ai::snip_ready,
        ai::snip_done,
        ai::snip_cancel,
        ai::screen_status,
        ai::screen_request
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
