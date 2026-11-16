// Android: the bridge to the Kotlin plugin (gen/android/app/src/main/java/
// dev/tisdani/togami/TogamiPlugin.kt). The plugin talks to two services the
// user switches on in Android's settings:
//   - BlockService, an Accessibility service: which app is in front, the
//     browser's address bar, going home and bringing Togami back on top
//   - MediaListener, a notification listener: the media sessions that are
//     playing (now playing), and their play/pause/next/previous buttons
// It also runs the auto-updater (Updater.kt) and opens the system settings pages.

use crate::media::NowPlaying;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::OnceLock;
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::Wry;

static PLUGIN: OnceLock<PluginHandle<Wry>> = OnceLock::new();

pub fn init() -> TauriPlugin<Wry> {
    Builder::new("togami")
        .setup(|_app, api| {
            let handle = api.register_android_plugin("dev.tisdani.togami", "TogamiPlugin")?;
            let _ = PLUGIN.set(handle);
            Ok(())
        })
        .build()
}

fn call<T: DeserializeOwned>(command: &str, payload: Value) -> Option<T> {
    PLUGIN.get()?.run_mobile_plugin(command, payload).ok()
}

#[derive(Deserialize)]
pub struct Front {
    pub package: String,
    pub exe: String,
    pub title: Option<String>,
    pub url: Option<String>,
}

#[derive(Deserialize)]
struct MaybeFront {
    front: Option<Front>,
}

/// The app in front, or None (Togami itself, the home screen, system UI, or
/// the Accessibility service is off).
pub fn foreground() -> Option<Front> {
    call::<MaybeFront>("foreground", json!({}))?.front
}

pub fn push_away(package: &str, kind: &str) {
    let _ = call::<Value>("pushAway", json!({ "package": package, "kind": kind }));
}

#[derive(Deserialize)]
struct Flag {
    on: bool,
}

/// Is Togami's Accessibility service switched on?
pub fn access_on() -> bool {
    call::<Flag>("accessStatus", json!({})).is_some_and(|f| f.on)
}

/// Opens Android's Accessibility settings.
pub fn access_request() {
    let _ = call::<Value>("accessRequest", json!({}));
}

/// May Togami read media sessions (notification access)?
pub fn listener_on() -> bool {
    call::<Flag>("listenerStatus", json!({})).is_some_and(|f| f.on)
}

pub fn listener_request() {
    let _ = call::<Value>("listenerRequest", json!({}));
}

#[derive(Deserialize)]
struct MaybeMedia {
    media: Option<NowPlaying>,
}

pub fn media_now() -> Option<NowPlaying> {
    call::<MaybeMedia>("mediaNow", json!({}))?.media
}

pub fn media_control(action: &str) {
    let _ = call::<Value>("mediaControl", json!({ "action": action }));
}

/// Togami's App info page (Android 13+ asks for "Allow restricted settings"
/// there before an app installed from a file may use Accessibility).
pub fn app_info() {
    let _ = call::<Value>("appInfo", json!({}));
}

pub fn bars(color: &str, dark: bool) {
    let _ = call::<Value>("bars", json!({ "color": color, "dark": dark }));
}

/// Opens a link outside Togami (the browser).
#[allow(dead_code)]
pub fn open_url(url: &str) -> Result<(), String> {
    call::<Value>("openUrl", json!({ "url": url })).map(|_| ()).ok_or_else(|| "Couldn't open the link.".into())
}

#[derive(Deserialize)]
struct Started {
    started: bool,
}

/// The auto-updater (Updater.kt): downloads the APK and hands it to Android's
/// installer. false: Android first needs "Install unknown apps" for Togami,
/// and its settings page is open.
pub fn update_install(url: &str) -> Result<bool, String> {
    call::<Started>("updateInstall", json!({ "url": url })).map(|s| s.started).ok_or_else(|| "Couldn't start the update.".into())
}

/// { phase: idle|downloading|installing|confirm|error, done, total, error, allowed }
pub fn update_state() -> Value {
    call::<Value>("updateState", json!({})).unwrap_or(Value::Null)
}

/// "Quit": Togami goes to the background (the services keep running).
pub fn exit() {
    let _ = call::<Value>("exit", json!({}));
}
