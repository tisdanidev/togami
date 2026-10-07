# Togami menu: design notes

The menu takes its feel from the Persona 4 Revival pause menu without copying it. Open `menu.html` in a browser to try it.

**Controls**
- Move: **↑/↓**, **W/S** or the mouse wheel.
- Open a section: **Enter** or click.
- Go back: **Esc** or right-click.
- Screenshot shortcuts: `?select=profile` highlights a section, and `?section=library` opens one directly.

Every section name and all text are placeholders.

## What carries the feel

| From P4R | How it's used here |
| --- | --- |
| Loud flat yellow everywhere | Yellow base with a soft light falloff, slow light rays, a halftone fade in the corner and film grain on top, so it reads as printed rather than flat |
| Menu words riding the character's coat | An abstract dark plum ribbon with a stitched seam. The words sit on it, tilted −15° and stepping down the ribbon in clusters |
| Heavy serif menu words | Bodoni Moda 900. Words get a hard ink shadow, never a glow |
| Glitchy cursor | White slab with cobalt and magenta shards. The word turns magenta→blue with an RGB split and a 0.3s sliced glitch |
| Each submenu is its own colour world | Each section owns a colour world, previewed through a slanted window on the right. Entering a section opens that window to fill the screen |
| TV motif | A short scanline + RGB flicker plays when a section opens or closes |
| Six-petal flowers | Three placements only: big yellow with a red/green fringe, small ink, soft white. The date block uses one as its weather icon |
| Calendar header | Big condensed date, a day-of-week tag, and a time of day taken from the clock |
| Neon double edge on selection | Rows in section screens: ink fill, green edge up-left, red edge down-right, nudged right |

## Palette

| Token | Hex | Use |
| --- | --- | --- |
| `--yellow` | `#ffe81a` | Base, menu words, keys |
| `--yellow-lit` / `--yellow-shade` | `#fff45c` / `#f5c400` | Light falloff |
| `--ribbon` | `#2b0f33` → `#4a1a52` | The ribbon |
| `--ink` | `#17111f` | Text, chrome, shadows |
| `--paper` | `#fffaf0` | Detail card, window edge |
| `--magenta` / `--cobalt` | `#ff2d8a` / `#2f3bff` | Cursor and selected word |
| `--cyan` / `--lime` | `#2ee6ff` / `#a6ff2e` | Meters, RGB split |
| `--edge-a` / `--edge-b` | `#57ff4a` / `#ff2148` | Selection double edge, flower fringe |

Section worlds:

| Section | Colour |
| --- | --- |
| Home | Sky blue with soft clouds |
| Library | Turquoise |
| Create | Pink |
| Activity | Tangerine |
| Profile | Ultramarine |
| Calendar | Violet |
| Settings | Graphite |

Every world except Home gets thin diagonal light lines.

## Type

- **Bodoni Moda 900** for words: menu items, section titles, the outlined ghost words behind them, and detail headings.
- **Barlow Condensed** for UI: dates, numbers, labels, help text and keys. Mostly italic, with tight caps and tracking for small labels. **Bahnschrift** is the Windows fallback.
- Bundle both fonts with the app. Don't load them from Google at runtime.

## Motion

| Moment | What happens |
| --- | --- |
| Menu appears | Words slide in along the ribbon, staggered 35ms |
| Cursor move | The slab springs in, the word glitches for 0.3s, and the preview window wipes to the next colour world (0.42s) |
| Enter a section | The window expands to full screen (0.55s ease-out) with a TV flicker, then the title, rows, detail card and footer rise in |
| Leave a section | The reverse, faster (0.38s) |
| Ambient | Rays rotate, clouds drift and flowers spin very slowly |

`prefers-reduced-motion` cuts all of this to instant. The real app should also have its own toggle for it.

## Building it for Windows

The mockup is plain HTML/CSS/JS. Content sits on a 1920×1080 stage scaled to the window, and backgrounds bleed past the stage so any window shape stays filled.

- **Tauri** (WebView2) or **Electron**: run frameless (`decorations: false` / `frame: false`). The custom title bar is already drag-enabled.
- **Porting to React like `sona`:**
  - Each piece becomes a component: `Menu`, `Cursor`, `PreviewWindow`, `Section`.
  - The colour tokens go in a Tailwind `@theme`.
  - framer-motion `layoutId` can drive the cursor between words.
- Swap the key glyphs for controller buttons when a gamepad is connected.
