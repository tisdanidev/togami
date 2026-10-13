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

/// Window title -> page title, for each supported browser:
///   Chrome:  "Funny cats - YouTube - Google Chrome"   -> "funny cats - youtube"
///   Firefox: "Funny cats - YouTube — Mozilla Firefox" -> "funny cats - youtube"
///   Edge:    "Funny cats - YouTube and 3 more pages - Personal - Microsoft\u{200b} Edge"
///            -> "funny cats - youtube - personal"
fn page_title(title: &str) -> String {
    let mut t: String = title.chars().filter(|c| !matches!(c, '\u{200b}' | '\u{200c}' | '\u{200d}' | '\u{feff}')).collect::<String>().to_lowercase();
    // cut at the last separator of any kind (Firefox uses "—", Chrome and Edge "-")
    if let Some((i, sep)) = [" - ", " — ", " – "].iter().filter_map(|sep| t.rfind(sep).map(|i| (i, *sep))).max_by_key(|(i, _)| *i) {
        let tail = &t[i + sep.len()..];
        if BROWSER_NAMES.iter().any(|b| tail.trim() == *b || tail.contains(b)) {
            t.truncate(i);
        }
    }
    // Edge adds "and N more page(s)" after the tab title when a window has several tabs
    if let Some(i) = t.find(" and ") {
        let rest = &t[i + 5..];
        let digits = rest.chars().take_while(|c| c.is_ascii_digit()).count();
        if digits > 0 && rest[digits..].starts_with(" more page") {
            let end = rest[digits..].find(" - ").map(|j| i + 5 + digits + j).unwrap_or(t.len());
            t.replace_range(i..end, "");
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

pub fn is_browser(exe: &str) -> bool {
    let e = norm(exe);
    BROWSERS.iter().any(|b| e == *b)
}

/// Host of whatever is in a browser's address bar, if it looks like a web address.
/// "youtube.com/watch?v=1" / "https://www.YouTube.com/" -> "youtube.com"
pub fn url_host(url: &str) -> Option<String> {
    let s = url.trim().to_lowercase();
    if s.is_empty() || s.contains(' ') {
        return None; // empty, or a search being typed
    }
    let s = match s.find("://") {
        Some(i) => &s[i + 3..],
        None => &s[..],
    };
    let host = s.split(['/', '?', '#']).next()?;
    let host = host.rsplit('@').next()?; // user@host
    let host = host.split(':').next()?; // host:port
    let host = host.trim_start_matches("www.").trim_end_matches('.');
    if !host.contains('.') || host.starts_with('.') {
        return None;
    }
    Some(host.to_string())
}

/// "https://www.youtube.com/feed" -> "youtube.com"
fn site_domain(site: &str) -> String {
    url_host(site).unwrap_or_default()
}

/// The blocked site a URL belongs to: same domain or any subdomain, any page.
pub fn match_url(sites: &[String], url: &str) -> Option<String> {
    let host = url_host(url)?;
    sites.iter().find(|site| {
        let d = site_domain(site);
        !d.is_empty() && (host == d || host.ends_with(&format!(".{d}")))
    }).cloned()
}

/// Which blocklist entry (if any) the foreground window matches. `url` is the
/// browser's address bar when it could be read; otherwise the title is used.
pub fn match_target(apps: &[String], sites: &[String], exe: &str, title: &str, url: Option<&str>) -> Option<(String, &'static str)> {
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
        // either signal is enough: the address bar (any page or subdomain of a
        // blocked site) or the tab title naming the site
        if let Some(site) = url.and_then(|u| match_url(sites, u)) {
            return Some((site, "site"));
        }
        if let Some(site) = match_title(sites, title) {
            return Some((site, "site"));
        }
    }
    None
}

/// Separators sites use between page name and site name in titles.
const TITLE_SEPS: &[&str] = &[" - ", " | ", " • ", " — ", " – ", " · ", " : "];

/// The blocked site a browser tab title names. Sites put their name at the
/// start or end of the title ("Funny cats - YouTube", "Reddit - Dive into
/// anything", "user • Instagram photos and videos"); a page that only mentions
/// a site in the middle ("My essay about YouTube - Google Docs") doesn't count.
pub fn match_title(sites: &[String], title: &str) -> Option<String> {
    let page = page_title(title);
    let page = page.trim_start_matches(|c: char| c == '(' || c.is_ascii_digit() || c == ')' || c == ' '); // "(3) YouTube"
    let mut parts: Vec<&str> = vec![page];
    for sep in TITLE_SEPS {
        parts = parts.iter().flat_map(|p| p.split(sep)).collect();
    }
    let parts: Vec<&str> = parts.into_iter().map(str::trim).filter(|p| !p.is_empty()).collect();
    let last = parts.last().copied().unwrap_or("");
    sites.iter().find(|site| {
        let k = site_key(site);
        if k.is_empty() {
            return false;
        }
        if extra_hit(&k, page) || page == k {
            return true;
        }
        if k.len() < 3 {
            // short names like x.com: only an exact last part ("Home / X")
            return last == k || page.ends_with(&format!(" / {k}"));
        }
        // a part of the title that is the site's name ("YouTube") or starts with
        // it ("Instagram photos and videos"); the last part may also end with it
        parts.iter().any(|p| *p == k || p.starts_with(&format!("{k} "))) || (parts.len() > 1 && last.ends_with(&format!(" {k}")))
    }).cloned()
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
        match_target(&c.apps, &c.sites, exe, title, None)
    }

    fn mu(c: &Cfg, exe: &str, title: &str, url: &str) -> Option<(String, &'static str)> {
        match_target(&c.apps, &c.sites, exe, title, Some(url))
    }

    #[test]
    fn any_page_of_a_blocked_site_is_blocked() {
        let c = cfg();
        for url in [
            "youtube.com",
            "youtube.com/watch?v=dQw4w9WgXcQ",
            "https://www.youtube.com/feed/subscriptions",
            "m.youtube.com/shorts/abc",
            "music.youtube.com",
            "www.reddit.com/r/learnprogramming/comments/1",
            "x.com/someone/status/1",
            "https://user@tiktok.com:443/@creator/video/9",
        ] {
            assert!(mu(&c, "chrome", "Whatever - Google Chrome", url).is_some(), "{url}");
        }
    }

    #[test]
    fn address_or_title_is_enough() {
        let c = cfg();
        // address bar read correctly
        assert!(mu(&c, "chrome", "Whatever - Google Chrome", "youtube.com/watch?v=abc").is_some());
        // address bar read wrong (a page's search box) but the title names YouTube
        assert!(mu(&c, "chrome", "Lofi beats to study to - YouTube - Google Chrome", "").is_some());
        assert!(mu(&c, "chrome", "(3) Funny cats - YouTube - Google Chrome", "minecraft").is_some());
        assert!(mu(&c, "msedge", "Funny cats - YouTube and 3 more pages - Personal - Microsoft\u{200b} Edge", "").is_some());
        // a doc that mentions YouTube in its title is not YouTube
        assert!(mu(&c, "chrome", "My essay about YouTube - Google Docs - Google Chrome", "docs.google.com/document/d/1").is_none());
        // lookalike domains are not the blocked site
        assert!(mu(&c, "msedge", "Not You Tube", "notyoutube.com/watch").is_none());
        assert!(mu(&c, "msedge", "Box", "box.com").is_none());
        assert!(mu(&c, "msedge", "Example", "youtube.com.evil.example").is_none());
    }

    #[test]
    fn chrome_firefox_and_edge_titles() {
        let c = cfg();
        // a YouTube video, as each browser titles its window (address bar unreadable)
        for (exe, title) in [
            ("chrome", "Lofi beats to study to - YouTube - Google Chrome"),
            ("firefox", "Lofi beats to study to - YouTube — Mozilla Firefox"),
            ("msedge", "Lofi beats to study to - YouTube - Microsoft\u{200b} Edge"),
            ("msedge", "Lofi beats to study to - YouTube and 3 more pages - Personal - Microsoft\u{200b} Edge"),
            ("msedge", "Lofi beats to study to - YouTube and 1 more page - Work - Microsoft\u{200b} Edge"),
        ] {
            assert_eq!(m(&c, exe, title).map(|h| h.0).as_deref(), Some("youtube.com"), "{exe}: {title}");
        }
        // a Google Doc about YouTube, in each browser
        for (exe, title) in [
            ("chrome", "My essay about YouTube - Google Docs - Google Chrome"),
            ("firefox", "My essay about YouTube - Google Docs — Mozilla Firefox"),
            ("msedge", "My essay about YouTube - Google Docs and 2 more pages - Personal - Microsoft\u{200b} Edge"),
        ] {
            assert!(m(&c, exe, title).is_none(), "{exe}: {title}");
        }
        // address bar values as each browser shows them
        for (exe, url) in [("chrome", "youtube.com/watch?v=abc"), ("msedge", "https://www.youtube.com/watch?v=abc"), ("firefox", "https://www.youtube.com/watch?v=abc")] {
            assert!(mu(&c, exe, "x", url).is_some(), "{exe}: {url}");
        }
    }

    #[test]
    fn site_names_in_titles() {
        let sites: Vec<String> = ["youtube.com", "instagram.com", "reddit.com", "tiktok.com", "twitch.tv", "x.com"].iter().map(|s| s.to_string()).collect();
        for t in [
            "YouTube",
            "Funny cats - YouTube",
            "creator • Instagram photos and videos",
            "Instagram",
            "Reddit - Dive into anything",
            "r/learnprogramming",
            "What's your setup? : r/battlestations",
            "TikTok - Make Your Day",
            "streamer - Twitch",
            "Home / X",
        ] {
            assert!(match_title(&sites, t).is_some(), "{t}");
        }
        for t in ["My essay about YouTube - Google Docs", "Why Reddit changed its API | The Verge", "Inbox (3) - Gmail", "Excel boxes"] {
            assert!(match_title(&sites, t).is_none(), "{t}");
        }
    }

    #[test]
    fn url_hosts() {
        assert_eq!(url_host("https://www.YouTube.com/watch?v=1").as_deref(), Some("youtube.com"));
        assert_eq!(url_host("localhost:5173").as_deref(), None);
        assert_eq!(url_host("cats and dogs").as_deref(), None);
        assert_eq!(url_host("about:blank").as_deref(), None);
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
