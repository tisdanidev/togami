# Togami

A focus timer and distraction blocker for students. Pick a session type, say what you're working on, and Togami blocks distracting apps and sites until the session is done. Quitting early has consequences.

## Features

- **Session types.** Pomodoro-style plans you can edit: focus length, break, long break and number of blocks. Ships with Essay (50/10 ×3), Revision (25/5 ×4) and Deep work (90/20 ×2), plus **Custom**, set with steppers right on the Focus page.
- **Session screen.** A running session takes over the window: a red tint with the timer, your intention and the music player during focus, a green tint with the time left and the music player during breaks, and a neutral tint while paused. Press **F11** for full screen.
- **Sidebar.** Notion-style navigation on the left with the status and a mini music player. Hide it with the button or Ctrl+\\.
- **Blocking.** Apps and websites per session type, plus an always-allowed list. Windows, Settings, Task Manager and Togami are never blocked. Breaks are unblocked unless you turn on *Block during breaks*.
- **Pausing.** Press Pause and blocking keeps running for 2 more minutes, then stops for up to 10 minutes. Only during focus time.
- **Pausing just the timer.** Click the timer (or the pet's timer badge) to stop it straight away; click again to carry on. Blocking stays on the whole time, even if you stop it during a break.
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
- **Jingles and notifications.** A short chime when focus starts, a break starts, a break ends and the session finishes (one at a time), plus a Windows notification when Togami isn't in front. Both can be turned off in Settings.
- **Runs in the background.** Closing the window hides Togami to the tray: the timer, blocking, jingles and the pet keep going. Click the tray icon to bring it back; quit from the tray menu (it asks first during a session, since that counts as quitting). Opening Togami again brings back the running copy.
- **Automatic updates.** Installed copies check GitHub releases on launch and every few hours. A new version is required: once no session or lockout is running, a full-window screen blocks Togami until it's installed (*Install and restart*).
- **Voices.** Neutral, or *Heir*: cold and superior.
- **Desktop pet.** Import a pet pack and a character sits in the corner of your desktop in the style the pack brings (the template is a Persona 5 cut-in card). It reacts to focus starts, breaks, blocked sites, pauses, quits, lockouts, pardons and updates with its own lines, blinks, and nags you now and then when no session runs. Drag it anywhere, click it, or right-click for *Start focus* (pick a session type), *Open Togami*, *Talk*, *Turn around* and *Hide*. While a session runs, a timer badge sits on its card. Clicks pass through everything except the pet. Settings → Desktop pet.

### Pet packs

Togami ships without characters, and without a pet look of its own: a pack brings the character, its lines and its whole style. A pack is a zip of one folder holding:

- `pet.json`: name, window size, timing, expressions (frames) and lines for each moment.
- `style.css`: everything the card, speech box, menu and timer badge look like, including animations.
- `layout.html`: the markup of those parts (`#card`, `#sprite`, `#bubble`, `#text`, and optionally `#name`, `#menu`, `#badge`). Scripts and event handlers are stripped.
- Frames (WebP or PNG) and fonts (WOFF2, WOFF, TTF or OTF).

[`blank_pet/`](blank_pet/) is a working template, with the Persona 5 dialogue style and placeholder frames, and [`blank_pet/README.md`](blank_pet/README.md) documents the format: every field, moment and placeholder, and the classes Togami toggles for `style.css` to animate.

- In the browser build, copy a pack folder to `packs/current/` (gitignored) and run `npm run dev`.
- Don't commit packs made from game art.

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
- **Website blocking:** works in Chrome, Edge and Firefox. A tab counts as a blocked site if its address (read from the browser's address bar through Windows UI Automation: any page or subdomain, e.g. `youtube.com/watch...`, `m.youtube.com`) or its title names the site ("Funny cats - YouTube"). Landing on one shows a Windows notification and gives you **5 seconds to close the tab**; after that Togami closes it (Ctrl+W, which also stops a playing video) and shows its block screen. Coming back to the same site within 30 seconds gets no new grace period.
- **Never touched:** Windows Explorer, Task Manager, Settings, the Start menu and Togami itself.
- **Now playing:** Windows' system media controls (Spotify, browsers, Apple Music, Media Player and others), with album art and play/pause/skip.
- **Full screen** with F11. Data is kept in the app's WebView storage under `%LOCALAPPDATA%\dev.tisdani.togami`.

Build on Windows (needs [Rust](https://rustup.rs) and Node):

```bash
npm install
npx tauri build          # src-tauri/target/release/bundle/nsis/Togami_0.2.0_x64-setup.exe
```

Cross-compile from Linux (needs `nsis`, `clang`, `lld` and `cargo install cargo-xwin`):

```bash
rustup target add x86_64-pc-windows-msvc
npx tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc
```

Native rule tests: `rustc --edition 2021 --test src-tauri/src/rules.rs -o rules-test && ./rules-test`

### Togami Dev (test build)

A separate app for trying things out without consequences:

```bash
npx tauri build --config src-tauri/tauri.dev.conf.json   # add the cross-compile flags above on Linux
```

- Installs as **Togami Dev** next to Togami, with its own icon (DEV badge), app ID and data, so your real ledger, streak and settings are untouched.
- Never updates itself and isn't part of releases.
- Quitting is instant with no lockout, debt, streak reset or ledger entry. Pausing takes effect immediately, and closing it mid-session isn't a quit.
- Has the test bench: clock speed (10×, 60×), +1/+5 min skips, simulated blocked attempts, and buttons that fire each jingle with its notification.
- Blocking is real.

### Releasing

Bump the version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`, then push a tag:

```bash
git tag v0.2.1 && git push origin v0.2.1
```

Or run the **Release** workflow from the Actions tab: it tags `v<version>` itself. `.github/workflows/release.yml` builds on Windows, runs the tests, signs the update with the `TAURI_SIGNING_PRIVATE_KEY` repository secret and publishes the release with `latest.json`. Installed copies pick it up automatically. Keep the private key safe: without it, existing installs can't receive updates.

### Known limits

- Site blocking is tested against Chrome, Edge and Firefox. In other browsers it relies on window titles, which can miss pages that don't name the site.
- Togami Dev's test bench shows what the blocker sees in front (program, title, address), which helps when a site slips through.
- Blocking only applies while Togami is running. Closing the window keeps it running in the tray; quitting it mid-session counts as quitting.

## Layout

| Path | What |
| --- | --- |
| `app/js/engine.js` | All session, pause, penalty and ledger rules. Pure functions, tested in `test/engine.test.js` |
| `app/js/platform.js` | Bridge to the native code (blocking, media, full screen); simulated in the browser |
| `src-tauri/` | Windows app: `blocker.rs` (foreground window watcher), `media.rs` (now playing), `system.rs` (notifications, updates), `rules.rs` (matching rules, tested) |
| `app/js/sounds.js` | The four jingles, synthesised with Web Audio |
| `app/fonts/` | Bundled Newsreader and IBM Plex (SIL Open Font License) |
| `app/js/main.js` | UI |
| `app/js/voice.js` | Copy for the Neutral and Heir voices |
| `app/styles.css` | Design tokens and styles (light and dark) |
