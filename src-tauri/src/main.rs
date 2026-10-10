// Togami desktop shell. The UI lives in ../app; this adds what a web page
// can't do: watching the foreground window to block apps and sites, and
// reading what's playing from Windows' media controls.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod blocker;
mod media;
mod rules;

fn main() {
    tauri::Builder::default()
        .manage(blocker::Shared::default())
        .setup(|app| {
            blocker::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![blocker::blocker_sync, media::media_now, media::media_control])
        .run(tauri::generate_context!())
        .expect("Togami failed to start");
}
