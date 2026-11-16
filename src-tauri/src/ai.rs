// AI help, through Groq (a free API key from console.groq.com): the Ask chat
// window (chat.html), screen snips that get explained, and the session
// planner on the Focus page. The UI builds the messages (app/js/ai.js); the
// requests are made here so the key never reaches a web view. It is kept in a
// file in the app data folder, and only its last four characters go back.
//
// Snips: on Windows, Togami grabs the screen under the cursor and opens a
// full-screen window (snip.html) over it where you drag out an area. On
// macOS the system's own selection (screencapture -i) does that; it needs the
// Screen Recording permission. Either way the picture is handed to the chat
// window, which asks about it.
//
// Android has one window: the Ask chat opens inside it (platform.js), and a
// screenshot or photo is attached from the gallery instead of a snip.

use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};
#[cfg(desktop)]
use tauri::{Emitter, WebviewUrl, WebviewWindowBuilder};

const API: &str = "https://api.groq.com/openai/v1";
#[cfg(desktop)]
const CHAT: &str = "chat";
#[cfg(desktop)]
const SNIP: &str = "snip";

#[derive(Default)]
pub struct Snip {
    /// Windows: the grabbed screen, as width and height (u32 LE) then RGBA pixels.
    shot: Mutex<Option<Vec<u8>>>,
    /// The picked area as a data URL, waiting for the chat window to take it.
    pending: Mutex<Option<String>>,
    /// The chat window was open (and hidden for the grab), so cancelling brings it back.
    chat_was_open: Mutex<bool>,
}

fn key_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("groq-key"))
}

fn read_key(app: &AppHandle) -> Option<String> {
    let key = std::fs::read_to_string(key_path(app).ok()?).ok()?;
    let key = key.trim().to_string();
    (!key.is_empty()).then_some(key)
}

fn masked(key: &str) -> String {
    let tail: String = key.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
    format!("…{tail}")
}

pub(crate) fn client() -> Result<reqwest::Client, String> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let builder = reqwest::Client::builder().user_agent(concat!("Togami/", env!("CARGO_PKG_VERSION"))).timeout(Duration::from_secs(60));
    // Android: reqwest's platform verifier needs Java set up first and panics
    // without it, so certificates are checked against the bundled Mozilla roots.
    #[cfg(target_os = "android")]
    let builder = {
        let roots = rustls::RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() };
        let mut tls = rustls::ClientConfig::builder().with_root_certificates(roots).with_no_client_auth();
        tls.alpn_protocols = vec![b"http/1.1".to_vec()];
        builder.tls_backend_preconfigured(tls)
    };
    builder
        .build()
        .map_err(|e| e.to_string())
}

fn net_error(e: reqwest::Error) -> String {
    if e.is_timeout() {
        "Groq took too long to answer. Try again.".into()
    } else {
        "Couldn't reach Groq. Are you online?".into()
    }
}

/// The saved key's last four characters (as "…abcd"), or None.
#[tauri::command]
pub fn ai_key_status(app: AppHandle) -> Option<String> {
    read_key(&app).map(|k| masked(&k))
}

/// Checks the key with Groq, then saves it.
#[tauri::command]
pub async fn ai_key_set(app: AppHandle, key: String) -> Result<String, String> {
    let key = key.trim().to_string();
    if key.len() < 20 || key.len() > 200 || key.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("That doesn't look like a Groq API key (they start with gsk_).".into());
    }
    let res = client()?.get(format!("{API}/models")).bearer_auth(&key).send().await.map_err(net_error)?;
    match res.status().as_u16() {
        200..=299 => {}
        401 | 403 => return Err("Groq didn't accept that key. Copy it again from console.groq.com/keys.".into()),
        code => return Err(format!("Groq answered with an error ({code}). Try again in a moment.")),
    }
    let path = key_path(&app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, &key).map_err(|e| e.to_string())?;
    Ok(masked(&key))
}

#[tauri::command]
pub fn ai_key_clear(app: AppHandle) -> Result<(), String> {
    let path = key_path(&app)?;
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// One chat completion. `messages` are OpenAI-style (text, or text and an
/// image as a data URL); `json` asks for a JSON object back. Returns the reply text.
#[tauri::command]
pub async fn ai_chat(app: AppHandle, model: String, messages: Value, json: bool) -> Result<String, String> {
    let key = read_key(&app).ok_or("Add a Groq API key in Settings → AI help first.")?;
    if !messages.is_array() || model.is_empty() || model.len() > 100 {
        return Err("Nothing to send.".into());
    }
    let mut body = json!({ "model": model, "messages": messages, "temperature": 0.6, "max_completion_tokens": 1024 });
    if json {
        body["response_format"] = json!({ "type": "json_object" });
    }
    let res = client()?.post(format!("{API}/chat/completions")).bearer_auth(key).json(&body).send().await.map_err(net_error)?;
    let status = res.status().as_u16();
    let reply: Value = res.json().await.unwrap_or(Value::Null);
    if !(200..300).contains(&status) {
        let detail = reply["error"]["message"].as_str().unwrap_or("").chars().take(200).collect::<String>();
        return Err(match status {
            401 | 403 => "Groq didn't accept the key. Add it again in Settings → AI help.".into(),
            413 => "That was too much to send at once. Try a smaller snip or a shorter message.".into(),
            429 => "Groq's free limit is used up for now. Wait a minute and try again.".into(),
            _ if detail.is_empty() => format!("Groq answered with an error ({status})."),
            _ => format!("Groq: {detail}"),
        });
    }
    reply["choices"][0]["message"]["content"].as_str().map(str::to_string).ok_or_else(|| "Groq sent an empty answer.".into())
}

// ---------- the chat window ----------

/// Opens the Ask window, or brings it to the front. (Android: platform.js
/// opens the chat inside the main window and never calls this.)
#[cfg(mobile)]
#[tauri::command]
pub async fn chat_open() -> Result<(), String> {
    Err("The Ask chat opens inside Togami here.".into())
}

#[cfg(desktop)]
#[tauri::command]
pub async fn chat_open(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(CHAT) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    let name = app.package_info().name.clone();
    WebviewWindowBuilder::new(&app, CHAT, WebviewUrl::App("chat.html".into()))
        .title(format!("Ask · {name}"))
        .additional_browser_args(crate::tray::BROWSER_ARGS)
        .inner_size(420.0, 620.0)
        .min_inner_size(340.0, 420.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// The chat window takes the last snip (once).
#[tauri::command]
pub fn chat_take_snip(snip: State<'_, Snip>) -> Option<String> {
    snip.pending.lock().unwrap().take()
}

/// Hands a picked area to the chat window, opening it if needed.
#[cfg(desktop)]
async fn deliver(app: &AppHandle, image: String) -> Result<(), String> {
    *app.state::<Snip>().pending.lock().unwrap() = Some(image);
    chat_open(app.clone()).await?;
    let _ = app.emit_to(CHAT, "chat-snip", ());
    Ok(())
}

/// Hides the chat window (so it isn't in the picture) and remembers whether it was open.
#[cfg(desktop)]
fn hide_chat(app: &AppHandle) {
    let open = app.get_webview_window(CHAT).is_some_and(|w| w.is_visible().unwrap_or(false));
    *app.state::<Snip>().chat_was_open.lock().unwrap() = open;
    if open {
        if let Some(w) = app.get_webview_window(CHAT) {
            let _ = w.hide();
        }
    }
}

#[cfg(desktop)]
fn restore_chat(app: &AppHandle) {
    if std::mem::take(&mut *app.state::<Snip>().chat_was_open.lock().unwrap()) {
        if let Some(w) = app.get_webview_window(CHAT) {
            let _ = w.show();
        }
    }
}

// ---------- snips ----------

/// Starts a snip: Windows opens snip.html over the screen under the cursor;
/// macOS runs the system's area selection.
#[tauri::command]
pub async fn snip_start(app: AppHandle) -> Result<(), String> {
    if read_key(&app).is_none() {
        return Err("Add a Groq API key in Settings → AI help first.".into());
    }
    #[cfg(desktop)]
    if let Some(w) = app.get_webview_window(SNIP) {
        let _ = w.set_focus();
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    return mac_snip(app).await;
    #[cfg(windows)]
    return win_snip(app).await;
    #[cfg(not(any(windows, target_os = "macos")))]
    Err("Snips aren't available here.".into())
}

#[cfg(windows)]
async fn win_snip(app: AppHandle) -> Result<(), String> {
    use tauri::{PhysicalPosition, PhysicalSize};
    let cursor = app.cursor_position().map_err(|e| e.to_string())?;
    let monitors = app.available_monitors().map_err(|e| e.to_string())?;
    let monitor = monitors
        .iter()
        .find(|m| {
            let (p, s) = (m.position(), m.size());
            cursor.x >= p.x as f64 && cursor.y >= p.y as f64 && cursor.x < (p.x + s.width as i32) as f64 && cursor.y < (p.y + s.height as i32) as f64
        })
        .cloned()
        .or_else(|| app.primary_monitor().ok().flatten())
        .ok_or("No screen found.")?;
    let (pos, size) = (*monitor.position(), *monitor.size());

    hide_chat(&app);
    let shot = tauri::async_runtime::spawn_blocking(move || {
        // give the chat window a moment to disappear from the screen
        std::thread::sleep(Duration::from_millis(180));
        crate::capture::grab(pos.x, pos.y, size.width as i32, size.height as i32)
    })
    .await
    .map_err(|e| e.to_string())?;
    let shot = match shot {
        Ok(s) => s,
        Err(e) => {
            restore_chat(&app);
            return Err(e);
        }
    };
    *app.state::<Snip>().shot.lock().unwrap() = Some(shot);

    let w = WebviewWindowBuilder::new(&app, SNIP, WebviewUrl::App("snip.html".into()))
        .title("Snip")
        .additional_browser_args(crate::tray::BROWSER_ARGS)
        .inner_size(400.0, 300.0)
        .decorations(false)
        .resizable(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
    let _ = w.set_position(PhysicalPosition::new(pos.x, pos.y));
    let _ = w.set_size(PhysicalSize::new(size.width, size.height));
    // the page shows itself once the picture is drawn (snip.js calls snip_ready)
    Ok(())
}

/// snip.html: the grabbed screen (width, height, RGBA).
#[tauri::command]
pub fn snip_image(snip: State<'_, Snip>) -> Result<tauri::ipc::Response, String> {
    let shot = snip.shot.lock().unwrap().clone().ok_or("No snip is running.")?;
    Ok(tauri::ipc::Response::new(shot))
}

/// snip.html has drawn the picture: show the window.
#[tauri::command]
pub fn snip_ready(app: AppHandle) {
    #[cfg(desktop)]
    if let Some(w) = app.get_webview_window(SNIP) {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// snip.html: the area was picked (a JPEG or PNG data URL).
#[tauri::command]
pub async fn snip_done(app: AppHandle, image: String) -> Result<(), String> {
    if !image.starts_with("data:image/") {
        return Err("That isn't a picture.".into());
    }
    close_snip(&app);
    *app.state::<Snip>().chat_was_open.lock().unwrap() = false;
    #[cfg(desktop)]
    return deliver(&app, image).await;
    #[cfg(mobile)]
    Err("Snips aren't available here.".into())
}

/// snip.html: Esc.
#[tauri::command]
pub fn snip_cancel(app: AppHandle) {
    close_snip(&app);
    #[cfg(desktop)]
    restore_chat(&app);
}

fn close_snip(app: &AppHandle) {
    *app.state::<Snip>().shot.lock().unwrap() = None;
    #[cfg(desktop)]
    if let Some(w) = app.get_webview_window(SNIP) {
        let _ = w.close();
    }
}

#[cfg(target_os = "macos")]
async fn mac_snip(app: AppHandle) -> Result<(), String> {
    use base64::Engine;
    if !crate::macos::screen_trusted(false) {
        screen_request();
        return Err("Allow Screen Recording for Togami in System Settings → Privacy & Security, then try again.".into());
    }
    hide_chat(&app);
    let path = std::env::temp_dir().join("togami-snip.png");
    let _ = std::fs::remove_file(&path);
    let p = path.clone();
    // -i: the system's own area selection (Space switches to a window, Esc cancels); -x: no sound
    let status = tauri::async_runtime::spawn_blocking(move || std::process::Command::new("/usr/sbin/screencapture").args(["-i", "-x", "-t", "png"]).arg(&p).status())
        .await
        .map_err(|e| e.to_string())?;
    let bytes = std::fs::read(&path).ok();
    let _ = std::fs::remove_file(&path);
    match (status, bytes) {
        (Ok(_), Some(bytes)) if !bytes.is_empty() => {
            *app.state::<Snip>().chat_was_open.lock().unwrap() = false;
            let data = base64::engine::general_purpose::STANDARD.encode(bytes);
            deliver(&app, format!("data:image/png;base64,{data}")).await
        }
        // cancelled with Esc
        (Ok(_), _) => {
            restore_chat(&app);
            Ok(())
        }
        (Err(e), _) => {
            restore_chat(&app);
            Err(format!("The screen couldn't be captured: {e}"))
        }
    }
}

/// macOS: may Togami capture the screen? None elsewhere.
#[tauri::command]
pub fn screen_status() -> Option<bool> {
    #[cfg(target_os = "macos")]
    return Some(crate::macos::screen_trusted(false));
    #[cfg(not(target_os = "macos"))]
    None
}

/// macOS: asks for Screen Recording, or opens its page in System Settings if
/// macOS has asked before.
#[tauri::command]
pub fn screen_request() {
    #[cfg(target_os = "macos")]
    if !crate::macos::screen_trusted(true) {
        let _ = std::process::Command::new("/usr/bin/open").arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture").spawn();
    }
}
