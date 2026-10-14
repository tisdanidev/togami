// The desktop pet: a small always-on-top window (pet.html) that sits on the
// desktop and reacts to the session. Characters come from a pet pack, a zip
// with pet.json and its frames, imported by the user into the app data folder
// (packs are never bundled with Togami). The window is transparent and lets
// clicks through everywhere except the rectangles pet.html reports (the pet,
// its speech box and its menu): a thread checks the cursor against them.

use serde_json::{json, Value};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager, PhysicalPosition, State, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "pet";
const WIDTH: f64 = 470.0;
const HEIGHT: f64 = 340.0;
const MAX_PACK_BYTES: u64 = 64 * 1024 * 1024;

/// Hit rectangles from pet.html, in CSS pixels: [x, y, width, height].
#[derive(Default)]
pub struct Hit(pub Arc<Mutex<Vec<[f64; 4]>>>);

fn pack_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("pets").join("current"))
}

fn read_manifest(dir: &Path) -> Result<Value, String> {
    let text = std::fs::read_to_string(dir.join("pet.json")).map_err(|_| "No pet pack is installed.".to_string())?;
    let manifest: Value = serde_json::from_str(&text).map_err(|e| format!("pet.json is not valid: {e}"))?;
    if !manifest["expressions"].is_object() {
        return Err("pet.json has no expressions.".into());
    }
    Ok(manifest)
}

fn image_type(name: &str) -> Option<&'static str> {
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".webp") {
        Some("image/webp")
    } else if lower.ends_with(".png") {
        Some("image/png")
    } else {
        None
    }
}

/// The installed pack's name, if there is one.
#[tauri::command]
pub fn pet_has_pack(app: AppHandle) -> Option<String> {
    let manifest = read_manifest(&pack_dir(&app).ok()?).ok()?;
    Some(manifest["name"].as_str().unwrap_or("Pet").to_string())
}

/// The installed pack for pet.html: { manifest, files: { name: data URL } }.
#[tauri::command]
pub fn pet_pack(app: AppHandle) -> Result<Value, String> {
    use base64::Engine;
    let dir = pack_dir(&app)?;
    let manifest = read_manifest(&dir)?;
    let mut files = serde_json::Map::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(mime) = image_type(&name) else { continue };
        let bytes = std::fs::read(entry.path()).map_err(|e| e.to_string())?;
        let data = base64::engine::general_purpose::STANDARD.encode(bytes);
        files.insert(name, Value::String(format!("data:{mime};base64,{data}")));
    }
    Ok(json!({ "manifest": manifest, "files": files }))
}

/// Installs a pet pack from the zip's bytes (sent raw from the file picker).
/// Accepts pet.json at the top of the zip or inside one folder.
#[tauri::command]
pub async fn pet_import(app: AppHandle, request: Request<'_>) -> Result<String, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected the zip file.".into());
    };
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes.as_slice())).map_err(|_| "That file is not a zip.".to_string())?;

    let mut root: Option<PathBuf> = None;
    for i in 0..zip.len() {
        let f = zip.by_index(i).map_err(|e| e.to_string())?;
        if let Some(p) = f.enclosed_name() {
            if p.file_name().is_some_and(|n| n == "pet.json") && p.components().count() <= 2 {
                root = Some(p.parent().map(Path::to_path_buf).unwrap_or_default());
                break;
            }
        }
    }
    let root = root.ok_or("No pet.json in that zip. Is it a pet pack?")?;

    let dir = pack_dir(&app)?;
    let incoming = dir.with_file_name("incoming");
    let _ = std::fs::remove_dir_all(&incoming);
    std::fs::create_dir_all(&incoming).map_err(|e| e.to_string())?;
    let mut total = 0u64;
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).map_err(|e| e.to_string())?;
        let Some(p) = f.enclosed_name() else { continue };
        if p.parent() != Some(root.as_path()) {
            continue;
        }
        let Some(name) = p.file_name().map(|n| n.to_string_lossy().to_string()) else { continue };
        if name != "pet.json" && image_type(&name).is_none() {
            continue;
        }
        total += f.size();
        if total > MAX_PACK_BYTES {
            let _ = std::fs::remove_dir_all(&incoming);
            return Err("That pack is too big (over 64 MB).".into());
        }
        let mut buf = Vec::with_capacity(f.size() as usize);
        f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        std::fs::write(incoming.join(&name), buf).map_err(|e| e.to_string())?;
    }
    let name = match read_manifest(&incoming) {
        Ok(m) => m["name"].as_str().unwrap_or("Pet").to_string(),
        Err(e) => {
            let _ = std::fs::remove_dir_all(&incoming);
            return Err(e);
        }
    };
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::rename(&incoming, &dir).map_err(|e| e.to_string())?;
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.eval("location.reload()");
    }
    Ok(name)
}

#[tauri::command]
pub fn pet_remove(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.close();
    }
    let dir = pack_dir(&app)?;
    if dir.exists() {
        std::fs::remove_dir_all(dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Shows the pet (creating its window the first time) at `pos`, a saved
/// physical position, or bottom right of the primary screen.
#[tauri::command]
pub async fn pet_show(app: AppHandle, pos: Option<(i32, i32)>) -> Result<(), String> {
    read_manifest(&pack_dir(&app)?)?;
    if let Some(w) = app.get_webview_window(LABEL) {
        return w.show().map_err(|e| e.to_string());
    }
    let w = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("pet.html".into()))
        .title("Togami pet")
        .inner_size(WIDTH, HEIGHT)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
    let _ = w.set_ignore_cursor_events(true);
    let on_screen = |(x, y): (i32, i32)| {
        app.available_monitors().unwrap_or_default().iter().any(|m| {
            let a = m.work_area();
            x + 80 >= a.position.x
                && y + 80 >= a.position.y
                && x + 80 <= a.position.x + a.size.width as i32
                && y + 80 <= a.position.y + a.size.height as i32
        })
    };
    let at = match pos.filter(|p| on_screen(*p)) {
        Some(p) => Some(p),
        None => app.primary_monitor().ok().flatten().map(|m| {
            let a = m.work_area();
            let s = m.scale_factor();
            (
                a.position.x + a.size.width as i32 - (WIDTH * s) as i32,
                a.position.y + a.size.height as i32 - (HEIGHT * s) as i32,
            )
        }),
    };
    if let Some((x, y)) = at {
        let _ = w.set_position(PhysicalPosition::new(x, y));
    }
    w.show().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pet_hide(app: AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.hide();
    }
}

#[tauri::command]
pub fn pet_hit(hit: State<'_, Hit>, rects: Vec<[f64; 4]>) {
    *hit.0.lock().unwrap() = rects;
}

/// Brings the main Togami window to the front (from the pet's menu).
#[tauri::command]
pub fn show_main(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Lets clicks through the pet window except over the reported rectangles.
pub fn start(app: AppHandle) {
    let rects = app.state::<Hit>().0.clone();
    std::thread::spawn(move || {
        let mut last: Option<bool> = None;
        loop {
            let Some(w) = app.get_webview_window(LABEL) else {
                last = None;
                std::thread::sleep(Duration::from_millis(300));
                continue;
            };
            if !w.is_visible().unwrap_or(false) {
                std::thread::sleep(Duration::from_millis(300));
                continue;
            }
            if let (Ok(cursor), Ok(origin), Ok(scale)) = (app.cursor_position(), w.inner_position(), w.scale_factor()) {
                let x = (cursor.x - origin.x as f64) / scale;
                let y = (cursor.y - origin.y as f64) / scale;
                let over = rects.lock().unwrap().iter().any(|r| x >= r[0] && y >= r[1] && x < r[0] + r[2] && y < r[1] + r[3]);
                if last != Some(over) {
                    let _ = w.set_ignore_cursor_events(!over);
                    last = Some(over);
                }
            }
            std::thread::sleep(Duration::from_millis(40));
        }
    });
}
