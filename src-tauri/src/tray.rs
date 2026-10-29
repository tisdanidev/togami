// Running in the background. Closing the Togami window only hides it: the
// timer, the blocker and the desktop pet keep going, and a tray icon brings
// the window back or quits. Quitting goes through the UI, which asks first
// when a session is running (closing mid-session counts as quitting).
//
// A hidden WebView2 page has its timers slowed down, so the window gets a
// heartbeat event every second that drives the UI's clock loop, and every
// window is started with Chromium flags that turn background throttling off.
//
// macOS: the tray icon sits in the menu bar (its menu opens on click), the
// Dock icon brings the window back, and ⌘Q in the app menu goes through the
// UI like the tray's Quit. App Nap is off (NSAppSleepDisabled in Info.plist).

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
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => crate::pet::show_main(app.clone()),
            id => {
                let _ = app.emit_to("main", "tray-act", id);
            }
        })
        .on_tray_icon_event(|tray, event| {
            if cfg!(target_os = "macos") {
                return;
            }
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
                    .body(if cfg!(target_os = "macos") {
                        "The timer and blocking keep going. Use the menu bar icon or the Dock to open it."
                    } else {
                        "The timer and blocking keep going. Use the tray icon to open or quit it."
                    })
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

/// macOS app menu. Quit is Togami's own item so that ⌘Q asks first during a
/// session; Edit makes copy and paste work in text fields.
#[cfg(target_os = "macos")]
pub fn app_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    use tauri::menu::{PredefinedMenuItem as P, Submenu};
    let name = app.package_info().name.clone();
    let quit = MenuItem::with_id(app, "app-quit", format!("Quit {name}"), true, Some("CmdOrCtrl+Q"))?;
    let about = P::about(app, Some(&format!("About {name}")), None)?;
    let main = Submenu::with_items(
        app,
        &name,
        true,
        &[&about, &P::separator(app)?, &P::hide(app, None)?, &P::hide_others(app, None)?, &P::show_all(app, None)?, &P::separator(app)?, &quit],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[&P::undo(app, None)?, &P::redo(app, None)?, &P::separator(app)?, &P::cut(app, None)?, &P::copy(app, None)?, &P::paste(app, None)?, &P::select_all(app, None)?],
    )?;
    let window = Submenu::with_items(app, "Window", true, &[&P::minimize(app, None)?, &P::fullscreen(app, None)?, &P::close_window(app, None)?])?;
    Menu::with_items(app, &[&main, &edit, &window])
}

#[cfg(target_os = "macos")]
pub fn on_app_menu(app: &AppHandle, event: tauri::menu::MenuEvent) {
    if event.id().as_ref() == "app-quit" {
        let _ = app.emit_to("main", "tray-act", "quit");
    }
}
