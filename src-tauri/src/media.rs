// Now playing. Windows: the system media controls (the same source as the
// volume flyout): Spotify, browsers, Apple Music, Media Player and others.
// macOS: Spotify and Apple Music, asked with AppleScript (macOS keeps its
// system-wide now playing to Apple's own apps since 15.4).

use serde::Serialize;

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    pub title: String,
    pub artist: String,
    pub source: String,
    pub playing: bool,
    pub position_ms: i64,
    pub duration_ms: i64,
    pub art: Option<String>,
}

#[tauri::command]
pub async fn media_now() -> Option<NowPlaying> {
    #[cfg(windows)]
    {
        return tauri::async_runtime::spawn_blocking(|| win::now().ok().flatten()).await.ok().flatten();
    }
    #[cfg(target_os = "macos")]
    {
        return tauri::async_runtime::spawn_blocking(mac::now).await.ok().flatten();
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    None
}

#[tauri::command]
pub async fn media_control(action: String) {
    #[cfg(windows)]
    {
        let _ = tauri::async_runtime::spawn_blocking(move || win::control(&action)).await;
    }
    #[cfg(target_os = "macos")]
    {
        let _ = tauri::async_runtime::spawn_blocking(move || mac::control(&action)).await;
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    let _ = action;
}

#[cfg(windows)]
mod win {
    use super::NowPlaying;
    use crate::rules::source_name;
    use base64::Engine;
    use std::sync::Mutex;
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSession as Session, GlobalSystemMediaTransportControlsSessionManager as Manager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    };
    use windows::Storage::Streams::DataReader;

    // album art is re-encoded only when the track changes
    static ART: Mutex<Option<(String, Option<String>)>> = Mutex::new(None);

    fn session() -> windows::core::Result<Option<Session>> {
        let mgr = Manager::RequestAsync()?.join()?;
        Ok(mgr.GetCurrentSession().ok())
    }

    pub fn now() -> windows::core::Result<Option<NowPlaying>> {
        let Some(s) = session()? else { return Ok(None) };
        let props = s.TryGetMediaPropertiesAsync()?.join()?;
        let title = props.Title()?.to_string_lossy();
        if title.is_empty() {
            return Ok(None);
        }
        let artist = props.Artist()?.to_string_lossy();
        let source = source_name(&s.SourceAppUserModelId()?.to_string_lossy());
        let playing = s.GetPlaybackInfo()?.PlaybackStatus()? == Status::Playing;
        let tl = s.GetTimelineProperties()?;
        let mut position_ms = tl.Position()?.Duration / 10_000;
        let duration_ms = (tl.EndTime()?.Duration - tl.StartTime()?.Duration) / 10_000;
        if playing {
            // position is as of the last update; move it forward to now
            let updated = tl.LastUpdatedTime()?.UniversalTime; // 100 ns since 1601
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as i64 / 100).unwrap_or(0) + 116_444_736_000_000_000;
            if updated > 0 && now > updated {
                position_ms += (now - updated) / 10_000;
            }
        }
        if duration_ms > 0 {
            position_ms = position_ms.clamp(0, duration_ms);
        }
        let key = format!("{title}\u{1}{artist}");
        let art = {
            let mut cache = ART.lock().unwrap();
            match cache.as_ref() {
                Some((k, a)) if *k == key => a.clone(),
                _ => {
                    let a = thumbnail(&props).ok().flatten();
                    *cache = Some((key, a.clone()));
                    a
                }
            }
        };
        Ok(Some(NowPlaying { title, artist, source, playing, position_ms, duration_ms: duration_ms.max(0), art }))
    }

    fn thumbnail(props: &windows::Media::Control::GlobalSystemMediaTransportControlsSessionMediaProperties) -> windows::core::Result<Option<String>> {
        let Ok(r) = props.Thumbnail() else { return Ok(None) };
        let stream = r.OpenReadAsync()?.join()?;
        let size = stream.Size()? as u32;
        if size == 0 || size > 4_000_000 {
            return Ok(None);
        }
        let mime = stream.ContentType()?.to_string_lossy();
        let reader = DataReader::CreateDataReader(&stream.GetInputStreamAt(0)?)?;
        reader.LoadAsync(size)?.join()?;
        let mut buf = vec![0u8; size as usize];
        reader.ReadBytes(&mut buf)?;
        let mime = if mime.starts_with("image/") { mime } else { "image/png".into() };
        Ok(Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(buf))))
    }

    pub fn control(action: &str) -> windows::core::Result<()> {
        let Some(s) = session()? else { return Ok(()) };
        match action {
            "toggle" => s.TryTogglePlayPauseAsync()?.join()?,
            "next" => s.TrySkipNextAsync()?.join()?,
            "previous" => s.TrySkipPreviousAsync()?.join()?,
            _ => false,
        };
        Ok(())
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use super::NowPlaying;
    use crate::macos;
    use std::sync::Mutex;
    use std::time::Duration;

    const SPOTIFY: &str = "com.spotify.client";
    const MUSIC: &str = "com.apple.Music";
    const PLAYERS: &[(&str, &str)] = &[(SPOTIFY, "Spotify"), (MUSIC, "Apple Music")];

    /// The player shown last, for the play/pause and skip buttons.
    static SOURCE: Mutex<Option<&'static str>> = Mutex::new(None);
    /// The last answer, given again while a script is still running (such as
    /// while macOS asks whether Togami may control the player).
    static LAST: Mutex<Option<NowPlaying>> = Mutex::new(None);
    static BUSY: Mutex<()> = Mutex::new(());

    pub fn now() -> Option<NowPlaying> {
        let Ok(_busy) = BUSY.try_lock() else { return LAST.lock().unwrap().clone() };
        let mut found: Option<(&'static str, NowPlaying)> = None;
        for &(id, name) in PLAYERS {
            // only players that are already open: asking one would launch it
            if !macos::is_running(id) {
                continue;
            }
            let Some(np) = query(id, name) else { continue };
            let playing = np.playing;
            if found.is_none() || playing {
                found = Some((id, np));
            }
            if playing {
                break;
            }
        }
        *SOURCE.lock().unwrap() = found.as_ref().map(|(id, _)| *id);
        let np = found.map(|(_, np)| np);
        *LAST.lock().unwrap() = np.clone();
        np
    }

    /// Title, artist, state, position and length (ms), and the artwork's address (Spotify only).
    fn query(id: &str, name: &str) -> Option<NowPlaying> {
        let (duration, art) = if id == SPOTIFY { ("duration of t", "artwork url of t") } else { ("(duration of t) * 1000", "\"\"") };
        let script = format!(
            r#"tell application id "{id}"
	if player state is stopped then return ""
	set sep to character id 31
	try
		set t to current track
		set st to "paused"
		if player state is playing then set st to "playing"
		set a to ""
		try
			set a to ({art}) as text
		end try
		return (name of t) & sep & (artist of t) & sep & st & sep & ((player position * 1000) as integer) & sep & (({duration}) as integer) & sep & a
	on error
		return ""
	end try
end tell"#
        );
        let out = macos::osascript(&script, Duration::from_secs(60)).ok()?;
        let f: Vec<&str> = out.split('\u{1f}').collect();
        if f.len() < 6 || f[0].is_empty() {
            return None;
        }
        let duration_ms = f[4].trim().parse::<i64>().unwrap_or(0).max(0);
        let mut position_ms = f[3].trim().parse::<i64>().unwrap_or(0).max(0);
        if duration_ms > 0 {
            position_ms = position_ms.min(duration_ms);
        }
        let art = f[5].trim();
        Some(NowPlaying {
            title: f[0].to_string(),
            artist: f[1].to_string(),
            source: name.to_string(),
            playing: f[2] == "playing",
            position_ms,
            duration_ms,
            art: art.starts_with("https://").then(|| art.to_string()),
        })
    }

    pub fn control(action: &str) {
        let Some(id) = *SOURCE.lock().unwrap() else { return };
        let command = match action {
            "toggle" => "playpause",
            "next" => "next track",
            "previous" => "previous track",
            _ => return,
        };
        let _ = macos::osascript(&format!("tell application id \"{id}\" to {command}"), Duration::from_secs(5));
    }
}
