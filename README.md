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
npm run dev      # http://localhost:5173
npm test         # session and penalty rules
npm run build    # dist/togami.html, a single-file test build
```

The browser build simulates Windows. Its **Test bench** button (bottom right) speeds up the clock, fakes opening blocked apps and sites, and fakes closing Togami.

## Layout

| Path | What |
| --- | --- |
| `app/js/engine.js` | All session, pause, penalty and ledger rules. Pure functions, tested in `test/engine.test.js` |
| `app/js/platform.js` | Windows integration point: blocking, media, window. Simulated in the browser |
| `app/js/main.js` | UI |
| `app/js/voice.js` | Copy for the Neutral and Heir voices |
| `app/styles.css` | Design tokens and styles (light and dark) |

## Windows build (next)

The plan is a [Tauri](https://tauri.app) app wrapping `app/`, with native code behind `platform.js`:

- **App blocking:** watch the foreground window and minimise or close blocked apps, then show Togami's block screen.
- **Website blocking:** a small Chrome/Edge/Firefox extension that redirects to the block screen, with a window-title check as a fallback.
- **Now playing:** the Windows media session API (Spotify, browsers and other players).
- **Window:** tray icon, start with Windows, compact always-on-top mode.
- **Storage:** state saved to the app data folder instead of `localStorage`.
