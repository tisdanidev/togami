# Togami

A minimal focus timer and distraction blocker for students who get distracted, as a Windows and macOS (11+, universal) desktop app and an Android app (7+, built for the Galaxy S25) on Tauri 2, with a browser build for testing. GitHub: `tisdanidev/togami`. Current version: **0.5.0**.

## What it does

- **Session types.** Pomodoro-style plans: Essay, Revision and Deep work, plus Stopwatch and Custom (both set with steppers on the Focus page).
  - **Stopwatch** has no set length: one open focus phase that counts up, blocks on, all the usual rules. It can be finished (free) once its minimum (default 25 min, plus any debt) has passed; ending it before then is a quit. It finishes on its own after 8 h. Closing Togami past the minimum finishes it instead of quitting.
- **Session screen.** Red tint during focus, green during breaks, with the timer and now playing. F11 toggles full screen; it's never automatic.
- **Blocking.** One blocklist (apps and sites, `state.blocklist`) for every session type and lockout, plus an always-allowed list. Older saves with per-type lists are merged into it on load.
  - A blocked site gets a 5-second grace period (with a Windows notification), then Togami closes the tab with Ctrl+W. Blocked apps get WM_CLOSE.
  - Every page and subdomain counts as blocked. It must work in **Chrome, Edge and Firefox** (plus Safari, Brave and Arc on macOS).
  - macOS: apps via NSWorkspace (hide + terminate, no permission). Tab addresses via AppleScript (Safari/Chromium; Automation asked per browser) or Accessibility (Firefox). Titles and ⌘W need Accessibility; Settings → Permissions shows it.
- **Pause and quit rules.**
  - **Pause:** blocking stays on for 2 more minutes, then the pause lasts up to 10 minutes.
  - **Quit ceremony:** hold for 5 s, type a sentence, wait 60 s.
  - **Penalties:** a lockout of 10, 25 or 45 minutes (escalating within a week), focus debt (capped at 60 minutes), a streak reset and a permanent ledger entry. Settings are locked during sessions.
  - **Relief:** pardons (one per 5 finished sessions, max 3), a weekly emergency unlock, and a never-blocked list.
- **Click-to-pause.** Clicking the timer (or the pet's badge) stops only the timer. Blocking stays ON, even during a break.
- **Now playing.** From the Windows media controls (GSMTC); on macOS from Spotify and Music via AppleScript (MediaRemote is closed to third parties since 15.4).
- **Sounds.** Jingles for focus start, break start, break end and session end, plus notifications when the window isn't focused.
- **Auto-update** from GitHub releases. Since 0.3.1 updates are required: a full-window screen blocks Togami once no session or lockout is running.
- **Background mode.**
  - Closing the window hides Togami to a tray icon (open, show/hide pet, quit). Quitting mid-session asks first, because it counts as quitting.
  - A single-instance plugin is in place.
  - A native 1 s `heartbeat` event drives the UI clock while the window is hidden.
  - WebView2 throttling is disabled via `additionalBrowserArgs`. Every window must use the same args (`tray::BROWSER_ARGS`).
- **Desktop pet.**
  - A transparent, always-on-top window (`app/pet.html`, `app/js/pet.js`, `src-tauri/src/pet.rs`).
  - **The app has no pet look of its own.** Everything visual comes from the **pet pack**: `pet.json` (name, window size, timing, name highlight rule, expressions, lines), `style.css`, `layout.html`, frames (WebP/PNG) and fonts (WOFF2/WOFF/TTF/OTF), flat in one folder. Imported in Settings into the app data folder `pets/current`; packs without `style.css` and `layout.html` are rejected.
  - `pet.js` is the engine: it loads the pack's CSS (rewriting `url()` to pack files, dropping anything else) and layout (sanitised: no scripts, handlers or outside links), finds `#card`, `#sprite`, `#bubble`, `#text` (+ optional `#name`, `#menu`, `#badge`) and only toggles documented classes. Changing that contract means updating `blank_pet/README.md` and existing packs.
  - `blank_pet/` is the template pack and the format's documentation. It carries the Persona 5 style: a red card, a dark wedge box with a lightning-bolt point traced from P5, a white name strip at −14.65° (about −21° as drawn), the name with letters inverted (`nameHighlight`), tapered outlines, Optima Nova Black if installed otherwise Proza Libre ExtraBold (OFL, in the pack), and placeholder blob frames.
  - Text is centred; while typing, the rest of the line is laid out but hidden.
  - Clicks pass through everywhere except the pet's hit rectangles (a Rust cursor-polling thread toggles `set_ignore_cursor_events`).
  - Right-click menu: Start focus (choose a session type), Open Togami, Talk, Turn around, Hide. With AI help on, Talk opens the Ask chat and *Explain my screen* starts a snip.
  - `pet.json` may have a `personality` (up to 800 characters) that the Ask chat plays.
- **AI help (Groq).** Each user pastes their own free key from console.groq.com in Settings → AI help. It's stored in `groq-key` in the app data folder, and only its last four characters go back to the UI. Requests go from Rust (`ai.rs`, reqwest + rustls like the updater). **Never ship a key in the app.**
  - **Ask chat:** a window (`chat.html`). The pet's name and `personality` are used, or plain Togami with no pack. The pet says the first sentence of each reply. During focus the system prompt keeps it on the work; breaks are free chat. History is kept in localStorage without pictures.
  - **Snip and explain:** Windows grabs the monitor under the cursor with GDI (`capture.rs`) and opens `snip.html` full-screen to drag an area. macOS uses `screencapture -i` and needs Screen Recording (Settings → Permissions). The picture goes to the chat as a JPEG of 1568 px at most. Entry points: the pet menu, the chat's snip button, and the Ask button on the session screen and in the sidebar.
  - **Session planner:** "Plan this session with AI" on the Focus page fills the Custom session type and the intention, and offers sites and apps to add to the blocklist. It only ever adds blocks.
  - Models are in `MODELS` in `app/js/ai.js` (text: llama-3.3-70b-versatile, vision: llama-4-scout). Update them there if Groq retires one. The browser build answers with samples.
- **Android.** One APK (arm64 + armv7), targeting the base Galaxy S25 (Android 15, One UI 7, ~384 CSS px wide) but working on other phones. Same `app/` UI and Rust core; `lib.rs` is the entry for both (`main.rs` only calls `togami_lib::run()`). Android has one window, so:
  - **Blocking:** `BlockService.kt` (an Accessibility service) answers `foreground` (package, label, browser address bar by view id) and `pushAway` (home, then Togami on top). The Rust blocker loop and `rules.rs` are unchanged (`droid` module in `blocker.rs`). Browser packages map to the names in `BROWSERS`. Android can't close another app's tab.
  - **Permissions:** Accessibility (blocking) and notification access (`MediaListener.kt`, now playing via media sessions). Sideloaded apps need *App info → ⋮ → Allow restricted settings* first. Settings → Permissions shows both.
  - **Pet and Ask chat** run in iframes of the main page and use `parent.__TAURI__` (`isFramed` in `platform.js`). The pet is scaled to fit; the page lays tap targets over its hit rects and forwards taps/long-presses (`touch-*` messages in `pet.js`). Snips become "attach a picture" (`ai.canPick`).
  - **Updates:** `latest-android.json` ({ version, notes, url }) in the release, separate from `latest.json` so the desktop updater never sees an entry it can't parse. Togami downloads the APK itself and hands it to Android's PackageInstaller (`Updater.kt`, polled through `update_progress`). It starts on its own once the update screen is up; the first time, Android asks to allow *Install unknown apps* for Togami and shows its update dialog. On Android 12+ later updates install without a dialog. `UpdateReceiver` posts "Togami x is installed" and tries to reopen it.
  - Back on the first page and "Quit" move the task to the background (`moveTaskToBack`), so the WebView and its clock keep running. The status/navigation bar colour follows the page (`system_bars`).
  - Commands that call Kotlin must be `async` (sync commands run on the main thread, which the plugin needs).
  - The Kotlin lives in `src-tauri/gen/android/app/src/main/java/dev/tisdani/togami/` (committed; the `generated/` folder and `tauri.*` files are rebuilt by the CLI). Release signing: `gen/android/keystore.properties` (gitignored), written in CI from the `ANDROID_KEYSTORE`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD` secrets. **Never commit the keystore**; the owner keeps it. Every APK must use the same key.
  - No Togami Dev for Android yet.
- **Togami Dev.** A separate test app (`tauri.dev.conf.json`): its own ID and data, a DEV badge, a test bench, no penalties, an instant pause, no updates. Blocking is real.

## Layout

- `app/`: vanilla ES modules, no framework.
  - `js/engine.js`: pure rules (sessions, pause/hold, quit, lockout, debt, pardons). Unit-tested.
  - `js/main.js`: the UI. Views, overlays, the test bench, pet and tray wiring, the update screen.
  - `js/platform.js`: the boundary to native code (`window.__TAURI__`) with browser simulations: blocker, media, notify, updater, pet, ai, background.
  - `js/pet.js`: the pet engine (renders whatever the installed pack's style and layout describe).
  - `js/ai.js`: pure AI-help logic (prompts, chat request, planner parsing). Unit-tested. `js/chat.js` + `chat.html`: the Ask window. `js/snip.js` + `snip.html`: the Windows snip overlay. `js/image.js`: scaling snips.
  - `js/store.js`: localStorage. `js/clock.js`: the app clock (speed and skip for testing). `js/sounds.js`: Web Audio jingles. `js/voice.js`: Neutral and "Heir" copy.
  - `fonts/`: bundled woff2 files (Newsreader, IBM Plex).
- `blank_pet/`: the template pet pack (P5 style, placeholder frames), the format reference (`README.md`) and the step-by-step build guide for AI agents (`AI_PACK_GUIDE.md`). `scripts/check-pack.mjs` validates a pack.
- `src-tauri/src/`:
  - `blocker.rs`: foreground window watch, UIA address-bar read, grace period, close.
  - `rules.rs`: pure matching logic, with a test module.
  - `macos.rs`: macOS system calls (plain C / Objective-C runtime FFI, no extra crates): NSWorkspace, Accessibility, CGEvent, osascript. Platform code sits in `win` / `mac` modules inside `blocker.rs` and `media.rs`.
  - `media.rs`: GSMTC. `system.rs`: notify, the updaters, permissions, `app_exit`. `pet.rs`: the pet window and packs. `tray.rs` (desktop): tray, hide-on-close, heartbeat.
  - `ai.rs`: the Groq key and requests, the chat and snip windows, macOS Screen Recording. `capture.rs`: the Windows screen grab.
  - `lib.rs`: start-up for desktop and Android. `android.rs`: the bridge to the Kotlin plugin (`TogamiPlugin.kt`).
- `src-tauri/gen/android/`: the Android project (Gradle). Togami's Kotlin: `TogamiPlugin.kt`, `BlockService.kt`, `Updater.kt` (the auto-updater and `UpdateReceiver`), `MediaListener.kt`, `MainActivity.kt` (insets, back button, notification permission); `res/xml/block_service.xml`.
- `test/engine.test.js`, `test/ai.test.js`: node:test suites.
- `scripts/serve.mjs`: dev server on :5173. It also serves the gitignored `packs/` folder at `/packs/` for browser pet testing.
- `scripts/build-artifact.mjs`: the single-file browser build.

## Commands

```bash
npm ci
npm test                      # engine tests (node:test)
rustc --edition 2021 --test src-tauri/src/rules.rs -o rules-test && ./rules-test
npm run dev                   # browser build at http://localhost:5173 (simulated Windows layer, test bench)
npm run check-pack            # validate the pet pack in blank_pet/ (or: npm run check-pack -- <folder>)
npx tauri build                                            # on Windows
npx tauri build --config src-tauri/tauri.dev.conf.json     # Togami Dev
# on a Mac: npx tauri build --target universal-apple-darwin   (tauri.macos.conf.json is merged automatically)
# Android: npx tauri android build --apk --target aarch64 --target armv7   (needs SDK, NDK 27, JDK 17;
#   on Windows the CLI needs Developer Mode to symlink the .so; CI builds on Linux)
# cross-compile from Linux: add  --runner cargo-xwin --target x86_64-pc-windows-msvc
# (needs cargo-xwin, nsis/makensis, and libayatana-appindicator3-dev because the CLI checks for it once tray-icon is on)
```

## Releasing

1. Bump the version in `package.json`, `package-lock.json` (two places), `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`, then run `cargo update -p togami` so `Cargo.lock` follows.
2. Merge to `main`.
3. Run the **Release** workflow (`.github/workflows/release.yml`, `workflow_dispatch` on main), or push a `v*` tag. It runs the tests, builds on Windows, then on macOS (universal .dmg, ad-hoc signed, not notarized), signs with the `TAURI_SIGNING_PRIVATE_KEY` repository secret and publishes the release plus `latest.json`. Then the Android job adds the signed APK and `latest-android.json`. Installed copies update from `releases/latest/download/latest.json`.
4. Check that `latest.json` and `latest-android.json` show the new version.

The updater private key and the Android keystore are NOT in the repo; the owner keeps them. If either is lost, existing installs on that platform can't receive updates.

## Rules and preferences

- **Design:** minimal and sleek, in the style of the owner's qortfolio app (Notion-like sidebar, Newsreader and IBM Plex, lapis accent `#2a4aa6`). Avoid distracting UI. Pet styling lives in packs, never in the app (`blank_pet` is the P5 one).
- **Never commit game art.** Morgana and Byakuya sprites stay out of the repo and releases; pet packs are imported by the user.
- **Never commit the updater private key.**
- **Users must never build anything themselves.** Ship installers on the Releases tab.
- When asked to push an update to the real app, the whole flow is expected: bump the version, PR, merge, run the Release workflow, verify `latest.json`.
- Test risky changes in Togami Dev first, when the owner asks to try them.
- Keep the blocker compatible with Chrome, Edge and Firefox on every platform (plus Samsung Internet on Android), and keep macOS 11 working (no web features newer than Safari 16). `.github/workflows/check.yml` builds Windows, macOS and Android on every PR.
- The UI must work at phone width (~384 px, touch, no hover) as well as on the desktop. Add `rules.rs` tests for new title or URL formats.
