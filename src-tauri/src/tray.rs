// Running in the background. Closing the Togami window only hides it: the
// timer, the blocker and the desktop pet keep going, and a tray icon brings
// the window back or quits. Quitting goes through the UI, which asks first
// when a session is running (closing mid-session counts as quitting).
//
// A hidden WebView2 page has its timers slowed down, so the window gets a
// heartbeat event every second that drives the UI's clock loop, and every
// window is started with Chromium flags that turn background throttling off.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Window, WindowEvent};
use tauri_plugin_notification::NotificationExt;

/// WebView2 flags for every Togami window (all windows must use the same ones).
/// The first switch keeps wry's defaults.
pub const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,IntensiveWakeUpThrottling,CalculateNativeWinOcclusion --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows";

static TOLD_BACKGROUND: AtomicBool = AtomicBool::new(false);

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let name = app.package_info().name.clone();
    let open = MenuItem::with_id(app, "open", format!("Open {name}"), true, None::<&str>)?;
    let pet = MenuItem::with_id(app, "pet", "Show or hide the pet", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", format!("Quit {name}"), true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &pet, &quit])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip(&name)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => crate::pet::show_main(app.clone()),
            id => {
                let _ = app.emit_to("main", "tray-act", id);
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                crate::pet::show_main(tray.app_handle().clone());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;

    let handle = app.clone();
    std::thread::spawn(move || loop {
        let _ = handle.emit_to("main", "heartbeat", ());
        std::thread::sleep(Duration::from_secs(1));
    });
    Ok(())
}

/// Closing the main window hides it; the first time, a notification says where Togami went.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if window.label() != "main" {
        return;
    }
    match event {
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let _ = window.hide();
            if !TOLD_BACKGROUND.swap(true, Ordering::Relaxed) {
                let name = window.app_handle().package_info().name.clone();
                let _ = window
                    .app_handle()
                    .notification()
                    .builder()
                    .title(format!("{name} is still running"))
                    .body("The timer and blocking keep going. Use the tray icon to open or quit it.")
                    .show();
            }
        }
        // never leave the pet (and the blocker) running without the main window
        WindowEvent::Destroyed => window.app_handle().exit(0),
        _ => {}
    }
}

/// Quits Togami (the UI calls this after asking, if a session is running).
#[tauri::command]
pub fn app_exit(app: AppHandle) {
    app.exit(0);
}
