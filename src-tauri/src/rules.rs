// Pure rules shared by the native code: which window counts as a blocked
// app or site, and readable names for media sources. No Windows APIs here, so
// it is tested on any OS:  rustc --edition 2021 --test src/rules.rs

/// Processes that are never touched, whatever the lists say.
const NEVER: &[&str] = &[
    "togami", "explorer", "taskmgr", "systemsettings", "searchhost", "searchapp", "startmenuexperiencehost",
    "shellexperiencehost", "lockapp", "dwm", "winlogon", "applicationframehost", "textinputhost",
];

const BROWSERS: &[&str] = &[
    "chrome", "msedge", "firefox", "brave", "opera", "operagx", "vivaldi", "arc", "librewolf", "waterfox", "chromium", "zen", "floorp", "iexplore",
];

const BROWSER_NAMES: &[&str] = &[
    "google chrome", "microsoft edge", "mozilla firefox", "firefox", "brave", "opera", "vivaldi", "chromium", "arc", "zen browser", "librewolf", "waterfox", "floorp",
];

fn norm(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

/// "m.youtube.com/watch" -> "youtube"
fn site_key(site: &str) -> String {
    let s = site.to_lowercase();
    let s = s.trim_start_matches("https://").trim_start_matches("http://").trim_start_matches("www.");
    let host = s.split(['/', '?', '#']).next().unwrap_or("");
    let labels: Vec<&str> = host.split('.').filter(|l| !l.is_empty()).collect();
    match labels.len() {
        0 => String::new(),
        1 => labels[0].to_string(),
        n => labels[n - 2].to_string(),
    }
}

/// "Funny cats - YouTube - Google Chrome" -> "funny cats - youtube"
fn page_title(title: &str) -> String {
    let t = title.to_lowercase();
    for sep in [" - ", " — ", " – "] {
        if let Some(i) = t.rfind(sep) {
            let tail = &t[i + sep.len()..];
            if BROWSER_NAMES.iter().any(|b| tail.trim() == *b || tail.contains(b)) {
                return t[..i].trim().to_string();
            }
        }
    }
    t.trim().to_string()
}

/// Sites whose page titles often leave out the site name.
fn extra_hit(key: &str, page: &str) -> bool {
    match key {
        "reddit" => page.starts_with("r/") || page.contains(": r/"),
        "x" => page.ends_with("on x") || page.contains("twitter"),
        _ => false,
    }
}

/// Which blocklist entry (if any) the foreground window matches.
pub fn match_target(apps: &[String], sites: &[String], exe: &str, title: &str) -> Option<(String, &'static str)> {
    let exe_n = norm(exe);
    if exe_n.is_empty() || NEVER.contains(&exe_n.as_str()) {
        return None;
    }
    for app in apps {
        let a = norm(app);
        if a.len() >= 3 && exe_n.contains(&a) {
            return Some((app.clone(), "app"));
        }
    }
    if BROWSERS.iter().any(|b| exe_n == *b) {
        let page = page_title(title);
        for site in sites {
            let k = site_key(site);
            if k.is_empty() {
                continue;
            }
            let hit = if k.len() >= 3 {
                page.contains(&k) || extra_hit(&k, &page)
            } else if extra_hit(&k, &page) {
                true
            } else {
                // short names like x.com: match "... / X" or a bare "X"
                page == k || page.ends_with(&format!(" / {k}")) || page.ends_with(&format!(" - {k}"))
            };
            if hit {
                return Some((site.clone(), "site"));
            }
        }
    }
    None
}

/// "Spotify.exe" / "MSEdge" / "SpotifyAB.SpotifyMusic_...!Spotify" -> a readable name
pub fn source_name(app_id: &str) -> String {
    let l = app_id.to_lowercase();
    for (needle, name) in [
        ("spotify", "Spotify"),
        ("msedge", "Edge"),
        ("chrome", "Chrome"),
        ("firefox", "Firefox"),
        ("308046b0af4a39cb", "Firefox"),
        ("brave", "Brave"),
        ("opera", "Opera"),
        ("applemusic", "Apple Music"),
        ("itunes", "iTunes"),
        ("zunemusic", "Media Player"),
        ("mediaplayer", "Media Player"),
        ("vlc", "VLC"),
        ("youtubemusic", "YouTube Music"),
    ] {
        if l.contains(needle) {
            return name.to_string();
        }
    }
    let s = app_id.rsplit('!').next().unwrap_or(app_id);
    s.trim_end_matches(".exe").trim_end_matches(".EXE").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Cfg {
        apps: Vec<String>,
        sites: Vec<String>,
    }

    fn cfg() -> Cfg {
        Cfg {
            apps: vec!["Discord".into(), "Steam".into(), "Epic Games".into()],
            sites: vec!["youtube.com".into(), "reddit.com".into(), "x.com".into(), "tiktok.com".into()],
        }
    }

    fn m(c: &Cfg, exe: &str, title: &str) -> Option<(String, &'static str)> {
        match_target(&c.apps, &c.sites, exe, title)
    }

    #[test]
    fn apps_match_by_executable_name() {
        assert_eq!(m(&cfg(), "Discord", "Friends").unwrap().0, "Discord");
        assert_eq!(m(&cfg(), "steamwebhelper", "Steam").unwrap().0, "Steam");
        assert_eq!(m(&cfg(), "EpicGamesLauncher", "Epic Games Launcher").unwrap().0, "Epic Games");
        assert!(m(&cfg(), "WINWORD", "Essay.docx - Word").is_none());
    }

    #[test]
    fn sites_match_by_browser_title() {
        let hit = m(&cfg(), "chrome", "Funny cats - YouTube - Google Chrome").unwrap();
        assert_eq!((hit.0.as_str(), hit.1), ("youtube.com", "site"));
        assert!(m(&cfg(), "firefox", "r/learnprogramming — Mozilla Firefox").is_some());
        assert!(m(&cfg(), "firefox", "Rust tips — Mozilla Firefox").is_none());
        assert!(m(&cfg(), "firefox", "reddit - Dive into anything — Mozilla Firefox").is_some());
        assert!(m(&cfg(), "msedge", "Home / X - Microsoft Edge").is_some());
        assert!(m(&cfg(), "msedge", "Box of examples - Microsoft Edge").is_none());
        assert!(m(&cfg(), "chrome", "History essay - Google Docs - Google Chrome").is_none());
    }

    #[test]
    fn site_names_only_count_in_browsers() {
        assert!(m(&cfg(), "notepad", "youtube.txt - Notepad").is_none());
    }

    #[test]
    fn system_processes_are_never_blocked() {
        let mut c = cfg();
        c.apps.push("Task Manager".into());
        c.apps.push("Explorer".into());
        assert!(m(&c, "Taskmgr", "Task Manager").is_none());
        assert!(m(&c, "explorer", "Downloads").is_none());
        assert!(m(&c, "togami", "Togami").is_none());
    }

    #[test]
    fn site_keys() {
        assert_eq!(site_key("https://www.youtube.com/watch?v=1"), "youtube");
        assert_eq!(site_key("m.youtube.com"), "youtube");
        assert_eq!(site_key("x.com"), "x");
    }

    #[test]
    fn source_names_are_readable() {
        assert_eq!(source_name("Spotify.exe"), "Spotify");
        assert_eq!(source_name("MSEdge"), "Edge");
        assert_eq!(source_name("308046B0AF4A39CB"), "Firefox");
        assert_eq!(source_name("SomeApp.exe"), "SomeApp");
    }
}
