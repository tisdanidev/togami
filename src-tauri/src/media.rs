// Now playing, from Windows' system media controls (the same source as the
// volume flyout): Spotify, browsers, Apple Music, Media Player and others.

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
    #[cfg(not(windows))]
    None
}

#[tauri::command]
pub async fn media_control(action: String) {
    #[cfg(windows)]
    {
        let _ = tauri::async_runtime::spawn_blocking(move || win::control(&action)).await;
    }
    #[cfg(not(windows))]
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
