# Togami

A focus timer and distraction blocker for students. Pick a session type, say what you're working on, and Togami blocks distracting apps and sites until the session is done. Quitting early has consequences.

## Features

- **Session types.** Pomodoro-style plans you can edit: focus length, break, long break and number of blocks. Ships with Essay (50/10 ×3), Revision (25/5 ×4) and Deep work (90/20 ×2), plus **Custom**, set with steppers right on the Focus page.
- **Full-screen sessions.** A running session takes over the window: a red tint with just the timer and your intention during focus, a green tint with the time left and the music player during breaks, and a neutral tint while paused.
- **Sidebar.** Notion-style navigation on the left with the status and a mini music player. Hide it with the button or Ctrl+\\.
- **Blocking.** Apps and websites per session type, plus an always-allowed list. Windows, Settings, Task Manager and Togami are never blocked. Breaks are unblocked unless you turn on *Block during breaks*.
- **Pausing.** Press Pause and blocking keeps running for 2 more minutes, then stops for up to 10 minutes. Only during focus time.
- **Quitting.** Hold a button for 5 seconds, type a sentence, wait 60 seconds, then see the cost. You can back out at every step.
- **Penalties for quitting:**
  - **Lockout.** Blocks stay on for 10, then 25, then 45 minutes for each quit in a week.
  - **Focus debt.** Skipped focus time (up to 60 min) is added to your next session.
  - **Streak reset.**
  - **Ledger.** The quit and your reason are recorded permanently.
  - **Locked settings.** Blocklists, session types and data are locked during sessions and lockouts.
  - Closing Togami mid-session counts as quitting.
- **Pardons.** Earned every 5 finished sessions (max 3). A pardon cancels a quit's lockout, debt and streak reset; the quit stays in the ledger.
- **Emergency unlock.** Once a week, end the session or lockout immediately with no penalty.
- **Ledger.** Weekly focus time, finished sessions, streak, what you tried to open, and the full history.
- **Now playing.** The current track with play/pause/skip.
- **Voices.** Neutral, or *Heir*: cold and superior.

## Run it

```bash
npm install
npm run dev      # browser version on http://localhost:5173
npm test         # session and penalty rules
npm run build    # dist/togami.html, a single-file browser test build
```

The browser version simulates Windows. Its **Test bench** button (bottom right) speeds up the clock, fakes opening blocked apps and sites, and fakes closing Togami.

## Windows app

The desktop app is a [Tauri](https://tauri.app) shell around `app/` with native code in `src-tauri/`:

- **App blocking:** a background thread checks the foreground window every 0.4 s. A blocked app gets a close request and is minimised; Togami comes to the front with its block screen.
- **Website blocking:** browsers (Chrome, Edge, Firefox, Brave, Opera, Vivaldi and others) are matched by their window title, e.g. "Funny cats - YouTube - Google Chrome". A match minimises the browser.
- **Never touched:** Windows Explorer, Task Manager, Settings, the Start menu and Togami itself.
- **Now playing:** Windows' system media controls (Spotify, browsers, Apple Music, Media Player and others), with album art and play/pause/skip.
- **Full screen** during sessions. Data is kept in the app's WebView storage under `%LOCALAPPDATA%\dev.tisdani.togami`.

Build on Windows (needs [Rust](https://rustup.rs) and Node):

```bash
npm install
npx tauri build          # src-tauri/target/release/bundle/nsis/Togami_0.1.0_x64-setup.exe
```

Cross-compile from Linux (needs `nsis`, `clang`, `lld` and `cargo install cargo-xwin`):

```bash
rustup target add x86_64-pc-windows-msvc
npx tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc
```

Native rule tests: `rustc --edition 2021 --test src-tauri/src/rules.rs -o rules-test && ./rules-test`

### Known limits

- Site blocking reads window titles, so a site whose title doesn't name it can slip through, and a page that mentions a blocked site's name in its title gets blocked. A browser extension is the planned fix.
- Blocking only applies while Togami is running. Closing it mid-session counts as quitting.

## Layout

| Path | What |
| --- | --- |
| `app/js/engine.js` | All session, pause, penalty and ledger rules. Pure functions, tested in `test/engine.test.js` |
| `app/js/platform.js` | Bridge to the native code (blocking, media, full screen); simulated in the browser |
| `src-tauri/` | Windows app: `blocker.rs` (foreground window watcher), `media.rs` (now playing), `rules.rs` (matching rules, tested) |
| `app/fonts/` | Bundled Newsreader and IBM Plex (SIL Open Font License) |
| `app/js/main.js` | UI |
| `app/js/voice.js` | Copy for the Neutral and Heir voices |
| `app/styles.css` | Design tokens and styles (light and dark) |
