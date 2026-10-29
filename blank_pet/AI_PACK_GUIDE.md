# Building a Togami pet pack: the complete guide for AI agents

This file tells an AI agent (or a person) everything needed to turn a character into a working Togami pet pack. It covers what to ask the user, exact file specs, every rule the app enforces, image processing commands, writing the lines, styling, validation, testing and zipping. Follow the steps in order. `README.md` in this folder is the shorter format reference; where the two overlap they say the same thing.

---

## 0. What you are building

Togami is a focus timer for Windows. Its **desktop pet** is a small character that sits in a transparent, always-on-top window in the corner of the screen and reacts to the user's study sessions with short typed lines in a speech box.

**The app has no look of its own for the pet.** Everything the user sees comes from the **pet pack**:

- the character's frames (images),
- what it says, and when,
- the HTML of its parts (card, speech box, menu, timer badge),
- all CSS: shapes, colours, fonts, animations.

A pack is **one flat folder** that gets zipped and imported in Togami (Settings → Desktop pet → Import pet pack).

**Where to build it:** in this folder, `blank_pet/` (at the root of the Togami project). It already contains a complete, valid pack, the "Blank" character: an outlined blob in a Persona 5 style dialogue card. You replace its parts with the new character's.

### The finished folder

```
blank_pet/
├── pet.json                  REQUIRED  name, settings, expressions, lines
├── style.css                 REQUIRED  the whole look
├── layout.html               REQUIRED  the parts' markup
├── <expression>-open.webp    frames (WebP or PNG), one set per expression
├── <expression>-closed.webp
├── <expression>-in0.webp …
├── <font>.woff2              fonts used by style.css (optional)
├── OFL-<font>.txt            font licence (ignored on import, keep it)
├── README.md                 format reference (ignored on import)
└── AI_PACK_GUIDE.md          this file (ignored on import)
```

---

## 1. Hard rules (the app enforces these; breaking one means the pack fails or parts vanish)

1. **Flat folder.** Every file sits next to `pet.json`. Subfolders are ignored on import, so a frame in `frames/happy.webp` will not exist.
2. **Allowed file types:** `.webp` `.png` (images), `.woff2` `.woff` `.ttf` `.otf` (fonts), `.css`, `.html`, plus `pet.json`. Anything else (`.jpg`, `.gif`, `.svg`, `.txt`, `.md`, `.js`) is **silently left out** on import. Convert JPG/GIF to WebP or PNG. SVG art goes inline in `layout.html`, not as a file.
3. **`pet.json`, `style.css` and `layout.html` must all exist**, or the import is rejected.
4. **`pet.json` must be valid JSON**: double quotes, no comments, no trailing commas.
5. **File names are case-sensitive and must match exactly** what `pet.json`, `style.css` and `layout.html` reference. Use only `a-z 0-9 - _ .` in file names: lowercase, no spaces.
6. **Total size at most 64 MB.** Aim for under 5 MB; every frame is loaded into memory.
7. **`layout.html` must contain `id="card"`, `id="sprite"` (on an `<img>`), `id="bubble"` and `id="text"`.**
8. **No JavaScript.** `<script>`, `onclick=` and every other `on…=` attribute, `<iframe>`, `<form>`, `<a>`, `<style>`, `<link>`, `<button>`, `<input>` and `<foreignObject>` are deleted from `layout.html` on load.
9. **No outside resources.** In `style.css`, `@import` is removed and every `url()` that isn't a pack file name or a `#id` becomes `none`. In `layout.html`, `src` and `href` may only name a pack file or a `#id`. Web fonts from Google Fonts or anywhere else **will not load**: put the font file in the pack.
10. **Placeholders in lines must exist for that moment** (table in section 5), or the line is never used.
11. **Never put art you don't have the rights to in a pack that will be shared or committed.** `blank_pet/` is tracked by git in the Togami repo. If the user's art is copyrighted (game sprites, for example), say so to the user, don't commit those files, and keep the finished zip in the gitignored `packs/` folder (section 9).

---

## 2. Before you start: what to ask the user

Ask only for what you can't decide yourself. Sensible defaults are in brackets.

1. **The character's name**, as it should appear in the speech box. [required]
2. **The frames.** Images of the character in different expressions. At minimum one image. Ideally per expression: a resting image, an eyes-closed version for blinking, and 1–4 frames of an intro animation.
3. **Personality and voice**: e.g. cheerful coach, cold aristocrat, sarcastic cat. [friendly and encouraging]
4. **Style**: keep the Persona 5 style card and box from the template, or something new (colours, shapes, font)? [keep the template's style, recoloured to suit the character]
5. **Which way the character faces** in the art. [check the images; see 3.4]
6. **Whether the art may be committed** to the repo. [assume no for characters from games, films or anime]

If the user gives no frames, you can't invent copyrighted art. Either keep the template's placeholder blob frames (only change the lines and style) or draw simple original art in code, as the template's frames were.

---

## 3. Frames

### 3.1 How frames are used

Each **expression** (e.g. `neutral`, `happy`, `angry`) has:

| Field | Required | What happens |
| --- | --- | --- |
| `open` | yes | The resting frame, shown whenever the pet sits in this expression. |
| `closed` | no | Shown for 110 ms to blink, every 2.2–6.4 s at random (sometimes twice in a row). Without it the expression never blinks. Must line up exactly with `open`, with only the eyes changed. |
| `intro` | no | A list of frames played in order, each for `timing.introFrame` ms (default 70), when the pet **switches to** this expression to speak. Then `open` is shown. Use it for a pose change, a head turn or a squash and stretch. 1–6 frames. |

There is **no mouth or lip-sync animation**. While a line is typed, the CSS class `.chatter` makes the template's sprite bob; that's all. Don't make talking frames: there is no field for them.

### 3.2 Canvas size and registration

The sprite is drawn inside `#card`. In the template the card is **226 × 164 CSS px** and the sprite is **96.5% of the card's width (about 218 px)**, anchored at the **bottom**, with its height following the image's aspect ratio.

- **Use one canvas size for every frame in the pack.** Recommended: **660 × 480 px** (crisp at 200% display scaling) or **440 × 320 px** (smaller files). Both are 11:8, which fills the template card exactly.
- **Transparent background** (alpha). No white boxes.
- **Same registration in every frame**: the character must stand in the same place, same scale, in `open`, `closed` and `intro` frames, or it will jump while blinking.
- **Bottom-anchored.** Put the character's body touching or near the bottom edge (the template card hides the bottom ~10% behind its frame), with the face in the upper-middle. Leave about 5% clear at the left and right edges: the card is slanted, and its corners cut into the image.
- A bust (head and shoulders) reads far better at this size than a full body. Crop to chest-up if the source is a full body.
- If you change the card size in `style.css`, keep the frame aspect ratio equal to the card's (width ÷ height), or the sprite will overflow or leave a gap.

### 3.3 Format and file size

- **WebP** (preferred, lossy quality 80–90 with alpha) or **PNG**.
- Target **under 150 KB per frame**.
- Naming convention (any names work, but this keeps things clear):
  - `<expression>-open.webp`
  - `<expression>-closed.webp`
  - `<expression>-in0.webp`, `<expression>-in1.webp`, …

### 3.4 Facing

The speech box opens to the **right** of the card, so the character should **face right** (towards the box) or straight at the viewer. If the art faces left, mirror every frame when processing (ImageMagick `-flop`, Pillow `ImageOps.mirror`). The user can also mirror it any time with *Turn around* in the pet's menu (CSS class `.flip`).

### 3.5 Processing commands

Pick whichever tool is installed. Each example takes one source image and makes a 660 × 480 transparent, bottom-centred WebP. Replace names as needed.

**ImageMagick 7**

```bash
magick source.png -trim +repage -resize 660x480 -background none -gravity south -extent 660x480 -quality 85 happy-open.webp
# mirror (character faced left):  add -flop after source.png
# from a sprite sheet: crop first:  magick sheet.png -crop 512x512+1024+0 +repage …
```

**Python with Pillow** (`pip install pillow`)

```python
from PIL import Image, ImageOps

def frame(src, out, w=660, h=480, mirror=False):
    im = Image.open(src).convert("RGBA")
    im = im.crop(im.getbbox())                 # trim transparent edges
    if mirror:
        im = ImageOps.mirror(im)
    im.thumbnail((w, h), Image.LANCZOS)        # fit inside the canvas
    canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    canvas.paste(im, ((w - im.width) // 2, h - im.height), im)   # bottom-centred
    canvas.save(out, "WEBP", quality=85, method=6)

frame("raw/happy.png", "happy-open.webp")
```

**Important for blink and intro frames:** don't trim each frame on its own. Different trims shift the character between frames. Crop every frame of a character with **the same box**: compute the union of all frames' bounding boxes once, crop all of them to it, then scale them all by the same factor:

```python
from PIL import Image
srcs = ["raw/happy.png", "raw/happy-blink.png", "raw/happy-in0.png"]
ims = [Image.open(s).convert("RGBA") for s in srcs]
boxes = [im.getbbox() for im in ims]
box = (min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes))
# then crop each with im.crop(box) and paste exactly as in frame() above, without the getbbox() trim
```

**Node with sharp** (`npm i sharp` in a scratch folder, not the Togami project):

```js
import sharp from 'sharp';
await sharp('source.png').trim().resize(660, 480, { fit: 'contain', position: 'south', background: { r: 0, g: 0, b: 0, alpha: 0 } }).webp({ quality: 85 }).toFile('happy-open.webp');
```

**No image tools at all:** PNGs can be written with Node's built-in `zlib` (the template's blob frames were drawn that way: a signed-distance raster, 440 × 320, deflated into PNG chunks).

### 3.6 Checking frames

Open a few frames and look at them (if you can view images). Check that:

- the background is transparent,
- the character is bottom-anchored and the face sits in the upper-middle,
- `open` and `closed` line up exactly,
- it faces right.

Then delete the template's `neutral-*`, `happy-*` and `annoyed-*` PNGs if the new pack no longer uses them.

---

## 4. pet.json

### 4.1 Full annotated example

(JSON can't hold comments; the notes are in the table below.)

```json
{
  "format": 1,
  "name": "Kiri",
  "window": { "width": 560, "height": 340 },
  "timing": { "introFrame": 70, "type": 24, "punctuation": 144, "hold": 3200, "holdPerChar": 55 },
  "nameHighlight": { "1": 1, "8": 2, "16": 3 },
  "idle": "neutral",
  "expressions": {
    "neutral": { "open": "neutral-open.webp", "closed": "neutral-closed.webp" },
    "happy": { "intro": ["happy-in0.webp", "happy-in1.webp"], "open": "happy-open.webp", "closed": "happy-closed.webp" },
    "stern": { "intro": ["stern-in0.webp"], "open": "stern-open.webp", "closed": "stern-closed.webp" },
    "sleepy": { "open": "sleepy-open.webp" }
  },
  "lines": {
    "hello": [{ "e": "happy", "t": "Kiri, reporting for study duty!" }],
    "workStart": [
      { "e": "happy", "t": "{min} minutes of {intention}. Let's go!" },
      { "e": "stern", "t": "{min} minutes. Phone face down." }
    ]
  }
}
```

### 4.2 Every field

| Field | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `format` | number | no | — | Always `1`. Reserved for future format changes. |
| `name` | string | **yes** | — | Shown in the speech box (`#name`) and in Togami's settings ("Show Kiri"). Keep it short: 1–16 characters fit the template's name strip. |
| `window.width`, `window.height` | number (CSS px) | no | 560, 340 | Size of the transparent window. Clamped to 120–1600. The window opens at the **bottom-right** of the screen, so build the pet near the **bottom-left** of the window, with the speech box extending right and up. Only change this when your layout needs more or less room. |
| `timing.introFrame` | ms | no | 70 | Duration of each intro frame. |
| `timing.type` | ms | no | 24 | Delay per typed character. |
| `timing.punctuation` | ms | no | 144 | Delay after `.` `,` `!` `?`. |
| `timing.hold` | ms | no | 3200 | Minimum time a finished line stays up. |
| `timing.holdPerChar` | ms | no | 55 | A line stays up for `max(hold, length × holdPerChar)`. |
| `nameHighlight` | object | no | none | Wraps random letters of the name in `<b>` (the Persona 5 look inverts them). Keys are minimum name lengths and values are letter counts: `{"1":1,"8":2,"16":3}` gives 1 letter, or 2 from 8 characters, or 3 from 16. Leave it out for a plain name. |
| `idle` | string | **yes** | — | Expression the pet rests in and returns to after speaking. Must be a key of `expressions`. |
| `expressions` | object | **yes** | — | `name → { intro?, open, closed? }`, see 3.1. Expression names are free text; use lowercase words. |
| `lines` | object | no | — | `moment → [ { "e": expression, "t": text }, … ]`, see section 5. |

Any `timing` field you leave out keeps its default.

---

## 5. Lines: every moment

When something happens, Togami sends the pet a **moment**. The pet picks one random line from that moment's list (never the same one twice in a row), switches to the line's expression `e` (playing its intro), and types `t`. A line whose placeholder has no value is skipped. If no line fits, a plain built-in line is used. If `e` is missing or unknown, the idle expression is used.

### 5.1 The moments

| Moment | When it fires | Placeholders it gets | Suggested tone and expression |
| --- | --- | --- | --- |
| `hello` | The pet window loads: Togami starts, the pet is switched on, or a pack is imported. | none | greeting · happy |
| `workStart` | A focus session starts. | `{min}` focus block length in minutes, `{intention}` what the user said they'd work on (**can be empty**) | motivating · happy or determined |
| `breakStart` | A focus block ends and a break begins. | `{min}` break length, `{intention}` | praise, relax · happy |
| `breakEnd` | A break ends and the next focus block begins. | `{min}` focus block length, `{intention}` | back to work · neutral or determined |
| `sessionEnd` | The whole session is finished. | none | big praise · happy |
| `blockWarn` | The user opened a blocked site or app; they have 5 seconds to close it. | `{target}` e.g. `youtube.com` or an app name | urgent warning · angry or stern |
| `block` | They didn't close it in time; Togami closed it. | `{target}` | scolding · angry |
| `pauseRequested` | The user asked to pause; the pause starts in 2 minutes. | none | reluctant OK · neutral |
| `paused` | The pause has started. | none | neutral |
| `resumed` | The pause ended (by the user or after 10 minutes). | none | back to it · neutral or happy |
| `quit` | The user quit a session early (no lockout). | none | disappointed · sad or stern |
| `lockout` | The user quit and got locked out; also when they pick *Locked* in the pet's menu. | `{min}` minutes of lockout left | stern |
| `lockoutEnded` | The lockout is over. | none | second chance · neutral |
| `pardon` | The user earned a pardon (a free quit) after 5 finished sessions. | none | proud · happy |
| `update` | A new Togami version is ready to install. | `{version}` e.g. `0.4.0` | informative · neutral |
| `idle` | No session is running and the pet hasn't spoken for 30 minutes (checked every minute); also from *Talk* in the menu. | none | nudge to start · neutral or bored |
| `late` | Between midnight and 5 a.m. with no session (at most every 90 minutes); also from *Talk* at that hour. | none | go to sleep · sleepy |
| `poke` | The user clicks the pet; also from *Talk*. | none | playful reaction · happy or surprised |

Placeholders not listed for a moment (e.g. `{target}` in `workStart`, or anything in `sessionEnd`) make that line **never** show. `{intention}` is empty when the user typed nothing, so every moment that uses it needs **at least one line without it**.

### 5.2 Writing good lines

- **Length: 15–70 characters; never more than about 90.** The template box fits about 3 short lines of 15 px text. Longer text overflows.
- **2–5 lines per moment** for variety; at least 1 for every moment. Prioritise `workStart`, `breakStart`, `breakEnd`, `sessionEnd`, `blockWarn`, `block`, `poke` and `idle`: they're seen most.
- Stay in character, but stay **supportive of studying**. The pet's job is to keep the user focused. Scolding is fine; cruelty, slurs or guilt-tripping about real-life matters are not.
- Plain text only: no HTML, no markdown, no emoji that the font can't draw (most custom fonts lack emoji).
- JSON-escape quotes inside lines (`\"`) or use typographic quotes (“ ” ’). Apostrophes (`'`) are fine as they are.
- Match `e` to the line's mood, and only use expressions that exist.
- Don't reference specific durations in text; use `{min}`. Don't promise features Togami doesn't have.

### 5.3 Example set (cheerful coach)

```json
"lines": {
  "hello": [{ "e": "happy", "t": "Hey! Ready when you are." }, { "e": "happy", "t": "Back again? Good. Let's get something done." }],
  "workStart": [{ "e": "happy", "t": "{min} minutes on {intention}. You've got this!" }, { "e": "stern", "t": "{min} minutes. Eyes on the work." }],
  "breakStart": [{ "e": "happy", "t": "Nice block! Take {min} minutes, stretch a bit." }, { "e": "happy", "t": "Break time. Water, then rest your eyes." }],
  "breakEnd": [{ "e": "neutral", "t": "Break's over. {min} more minutes, let's go." }],
  "sessionEnd": [{ "e": "happy", "t": "Session complete! That's real progress." }],
  "blockWarn": [{ "e": "stern", "t": "{target}? Close it. Five seconds." }],
  "block": [{ "e": "stern", "t": "I closed {target} for you. Back to work." }],
  "pauseRequested": [{ "e": "neutral", "t": "Okay, pausing in two minutes." }],
  "paused": [{ "e": "neutral", "t": "Paused. Don't wander off for long." }],
  "resumed": [{ "e": "happy", "t": "And we're back!" }],
  "quit": [{ "e": "stern", "t": "Quitting already? We'll try again." }],
  "lockout": [{ "e": "stern", "t": "Locked for {min} minutes. Think it over." }],
  "lockoutEnded": [{ "e": "neutral", "t": "Lockout's over. Clean slate." }],
  "pardon": [{ "e": "happy", "t": "You earned a pardon. Use it wisely." }],
  "update": [{ "e": "neutral", "t": "Togami {version} is ready. Install it soon!" }],
  "idle": [{ "e": "neutral", "t": "Want to start a session?" }, { "e": "neutral", "t": "Just one block. Twenty-five minutes." }],
  "late": [{ "e": "sleepy", "t": "It's really late. Sleep is studying too." }],
  "poke": [{ "e": "happy", "t": "Hey! That tickles." }, { "e": "happy", "t": "Yes? I'm watching your timer." }]
}
```

---

## 6. layout.html

### 6.1 Required and optional parts

| Element | Required | Behaviour Togami gives it |
| --- | --- | --- |
| `#card` | **yes** | The pet. Left-drag moves the window; a click without dragging is a *poke*; right-click opens the menu. Gets classes `.pop` `.wiggle` `.chatter` `.flip` and `data-expression`. |
| `#sprite` | **yes**, must be an `<img>` | Inside `#card`. Togami sets its `src` to the current frame. Don't give it a `src` yourself. |
| `#bubble` | **yes** | The speech box. Hidden (`hidden` attribute) when the pet is quiet; gets `.show` each time it opens. Clicking it dismisses the line. |
| `#text` | **yes** | Inside `#bubble`. Togami writes the typed line into it. |
| `#name` | no | Togami writes the name into it (with `<b>` around highlighted letters). Usually inside `#bubble`. |
| `#menu` | no | The right-click menu. Togami fills it with buttons. If it's missing, an empty `<div id="menu">` is added at the end of the layout (unstyled unless your CSS targets `#menu`). |
| `#badge` | no | The timer badge during sessions; clicking it pauses or restarts the timer. Added at the end if missing. |
| `[data-speak]` | no, any number | Gets class `.on` while the pet speaks. Use it for effects behind or around the pet (the template's slash bands). |

**Clicks:** only the rectangles of `#card`, `#bubble`, `#menu` and `#badge` (when visible) catch the mouse. Everything else in the window, including `[data-speak]` decorations, lets clicks through to the desktop. Keep decorations `pointer-events: none`.

**Stacking:** later elements in the file are drawn on top, unless CSS sets `z-index`.

### 6.2 Allowed elements and attributes

Allowed elements: `div span p b i em strong small br img`, and SVG: `svg g defs symbol use path polygon polyline rect circle ellipse line text tspan linearGradient radialGradient stop clipPath mask pattern filter feGaussianBlur feOffset feFlood feComposite feMerge feMergeNode feColorMatrix title desc`. Any other element is **deleted, together with everything inside it**.

All attributes are kept (`class`, `id`, `style`, `viewBox`, `fill`, `points`, `aria-*` …) except `on…` handlers and `srcset`. `src`/`href`/`xlink:href` must be a pack file name or (for `href`) a `#id`. Inline `style` may use `url()` with pack files.

### 6.3 Minimal valid layout

```html
<div class="aura" data-speak></div>
<div class="bubble" id="bubble">
  <div class="name" id="name"></div>
  <p id="text"></p>
</div>
<div class="card" id="card"><img class="sprite" id="sprite" alt="" /></div>
<div class="badge" id="badge"></div>
<div class="menu" id="menu"></div>
```

### 6.4 What Togami writes inside the parts (style these)

```html
<!-- #text while typing "Hello there" (5 letters typed so far) -->
<span>Hello<span class="rest"> there</span></span>

<!-- #name with nameHighlight -->
Ki<b>r</b>i

<!-- #menu, main page (the first item depends on state: "Start focus", or "Locked · 12 min" with class "off", or nothing during a session) -->
<button type="button" data-act="startMenu"><span>Start focus</span></button>
<button type="button" data-act="open"><span>Open Togami</span></button>
<button type="button" data-act="talk"><span>Talk</span></button>
<button type="button" data-act="flip"><span>Turn around</span></button>
<button type="button" data-act="hide"><span>Hide</span></button>

<!-- #menu, "Start focus" page: one button per session type, then Back -->
<button type="button" data-act="start" data-id="essay"><span>Essay <small>50/10 ×3</small></span></button>
<button type="button" data-act="back"><span>Back</span></button>

<!-- #badge -->
<small>Focus</small><b>24:13</b>
```

The menu can have up to about 6 buttons. Badge labels: `Focus`, `Break`, `Long break`, `Paused`, `Timer paused`.

---

## 7. style.css

### 7.1 The hooks (the only things Togami changes)

| Selector | When it applies | Template uses it for |
| --- | --- | --- |
| `#card.pop` / `.card.pop` | Added (restarted) each time the pet starts a line | Pop-in animation |
| `.card.wiggle` | Added (restarted) on a poke | Wiggle animation |
| `.card.chatter` | While characters are being typed | Sprite bobbing |
| `.card.flip` | The user chose *Turn around* (remembered) | `.flip .sprite { scale: -1 1; }` |
| `.card[data-expression="happy"]` | Current expression | (unused; can recolour the card per mood) |
| `.bubble.show` | Added (restarted) when the box opens | Box pop animation |
| `[hidden]` | `#bubble`, `#menu`, `#badge` when not shown | Already `display: none !important` in the app; don't override it |
| `[data-speak].on` | While speaking | Bands slash in |
| `.menu.show` | Menu opened or changed page | Menu pop animation |
| `.menu button.off` | Unavailable item (*Locked*) | Greyed out |
| `.badge.focus` `.badge.brk` `.badge.paused` | Session phase | Badge colours |
| `#text .rest` | The not-yet-typed part of the line | **Must be `visibility: hidden`**, so the text is laid out in full from the start and centred text doesn't shift |

Animations that should replay (`pop`, `wiggle`, `show`) are triggered by these classes being re-added, so put them in `animation:` on those selectors, not in transitions.

### 7.2 Things the app already sets (don't fight them)

```css
html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; user-select: none; }
#stage { position: absolute; inset: 0; }   /* your layout lives in here */
[hidden] { display: none !important; }
```

- **Keep `html` and `body` transparent.** A background on them covers the whole window and makes the desktop disappear behind a box.
- Position parts with `position: absolute` and `left`/`bottom` inside the window size from `pet.json`.
- Keep everything inside the window. Anything outside it is cut off.

### 7.3 Fonts

```css
@font-face {
  font-family: 'Pet Text';
  font-weight: 800;
  font-display: block;
  src: local('Some Installed Font Black'), url(MyFont-Black.woff2) format('woff2');
}
body { font-family: 'Pet Text', sans-serif; }
```

`local()` uses a font installed on the user's PC if there is one; `url()` must name a font file in the pack. Only bundle fonts whose licence allows it (SIL OFL fonts from Google Fonts are fine; include their licence `.txt`). Subset or pick WOFF2 to keep the size down.

### 7.4 Restyling the template

The template's `style.css` is commented section by section: card, bands, dialogue box, menu, badge. Common changes:

- **Recolour:** edit the custom properties in `:root` (`--red`, `--red-deep`, `--ink`, `--box`, `--paper`) and the `fill` colours of the polygons in `layout.html`. Change `.badge.brk`'s green to match.
- **Card shape:** `.card .edge`, `.rim` and `.fill` are three `clip-path` polygons, each inset a little more, so the outline swells and thins. Change the percentages together.
- **Speech box shape:** the `<svg>` in `layout.html` (viewBox 950 × 284, stretched to `.bubble`'s size). The first three polygons are the box (black outline, white rim, dark fill); the next two are the name strip; the last two are the triangle. `#text` is positioned with percentages in `.bubble p`, and `#name` in `.bubble .name`. If you move the shapes, move those too.
- **Bigger pet:** scale `.card` width and height (keep the frame aspect ratio), then move `.bubble`, `.menu` and `.badge`, and raise `window` in `pet.json` if they no longer fit.

### 7.5 Starting a style from scratch

A complete, minimal alternative (a rounded card with a plain speech bubble) to adapt:

```css
:root { --accent: #2a4aa6; --ink: #111; --paper: #fff; }
body { font: 600 15px/1.3 system-ui, sans-serif; }
.card { position: absolute; left: 12px; bottom: 12px; width: 200px; height: 145px; border-radius: 18px;
  background: var(--accent); border: 3px solid var(--paper); box-shadow: 0 6px 18px rgba(0,0,0,.35); overflow: hidden; cursor: grab; }
.sprite { position: absolute; left: 2%; bottom: 0; width: 96%; pointer-events: none; }
.flip .sprite { scale: -1 1; }
.chatter .sprite { animation: bob .25s ease-in-out infinite alternate; }
@keyframes bob { to { translate: 0 -3px; } }
.card.pop { animation: pop .35s cubic-bezier(.2,1.5,.4,1); }
@keyframes pop { from { scale: .85; } }
.card.wiggle { animation: wig .3s; }
@keyframes wig { 30% { rotate: -6deg; } 70% { rotate: 3deg; } }
.bubble { position: absolute; left: 190px; bottom: 110px; width: 330px; padding: 12px 16px 14px; border-radius: 16px;
  background: var(--paper); color: var(--ink); border: 3px solid var(--ink); }
.bubble.show { animation: pop .25s ease-out; }
.bubble .name { font-weight: 800; color: var(--accent); margin-bottom: 4px; }
.bubble p { margin: 0; }
.bubble p .rest { visibility: hidden; }
.menu { position: absolute; left: 220px; bottom: 20px; display: flex; flex-direction: column; gap: 4px; }
.menu button { all: unset; cursor: pointer; padding: 6px 14px; border-radius: 10px; background: var(--ink); color: #fff; }
.menu button:hover { background: var(--accent); }
.menu button small { opacity: .7; margin-left: 6px; }
.menu button.off { opacity: .5; }
.badge { position: absolute; left: 20px; bottom: 165px; padding: 4px 10px; border-radius: 10px; background: var(--ink); color: #fff; cursor: pointer; }
.badge b { font-size: 20px; margin-left: 6px; }
.badge.brk { background: #1f9d55; }
.badge.paused { background: #555; }
```

With this, use the minimal layout from 6.3 and a frame aspect of 200:145 (e.g. 600 × 435).

---

## 8. Validate

From the Togami project root:

```bash
npm run check-pack              # checks blank_pet
npm run check-pack -- path/to/other_pack
```

It reports **errors** (the pack will fail or a part won't show) and **warnings** (it works, but something is probably unintended). It checks:

- `pet.json` parses and `name`, `idle` and the expressions are valid;
- every referenced frame exists, with the right type;
- every line uses known moments, existing expressions and placeholders the moment actually gets;
- `layout.html` has the required ids, `#sprite` is an `<img>`, and every `src` points at a pack file;
- every `style.css` `url()` points at a pack file;
- there are no subfolders and the pack is under 64 MB.

**Fix every error.** Warnings about `README.md`, `AI_PACK_GUIDE.md` and licence `.txt` files are expected.

Then check by hand:

- [ ] Every expression has an `open` frame; the ones with eyes have a `closed` frame that lines up.
- [ ] All frames share one canvas size, a transparent background, are bottom-anchored and face right.
- [ ] Every one of the 18 moments has at least one line, all 15–90 characters, all in character.
- [ ] Moments using `{intention}` also have a line without it.
- [ ] `html` and `body` have no background in `style.css`; `#text .rest` is `visibility: hidden`.
- [ ] Unused template frames are deleted.
- [ ] No copyrighted art will be committed (rule 11).

---

## 9. Test and package

### 9.1 Look at it in the browser build

From the project root, copy the pack to the gitignored test slot and start the dev server. PowerShell:

```powershell
if (Test-Path packs\current) { Remove-Item packs\current -Recurse -Force }
New-Item -ItemType Directory -Force packs | Out-Null
Copy-Item blank_pet packs\current -Recurse
npm run dev
```

POSIX shell:

```bash
rm -rf packs/current && mkdir -p packs && cp -r blank_pet packs/current && npm run dev
```

Open http://localhost:5173 and go to **Settings → Desktop pet → Show <name>**. The pet appears bottom-right. Then:

- **Test bench** (button at the bottom right) → "<name> says" has a button for each moment. Click through all of them. Check that each line fits the box, the expression and intro look right, and the name shows.
- Click the pet (poke), right-click it (menu), and try *Turn around*.
- Start a session to see the timer badge.

To see the pet page alone: http://localhost:5173/pet.html (it says `hello` after 0.7 s). The dev server reads files on every request, so edit and reload.

If nothing shows, open DevTools on `pet.html`. A console error such as "Pet pack layout.html needs #card…" names the problem, and a 404 means a misspelled file name.

### 9.2 Zip it

The zip must contain the files **at its top level, or inside exactly one folder**. Put it in the gitignored `packs/` folder so it can't be committed. PowerShell:

```powershell
Compress-Archive -Path blank_pet\* -DestinationPath packs\kiri-pet.zip -Force
```

POSIX shell:

```bash
(cd blank_pet && zip -r ../packs/kiri-pet.zip . -x '*.md')
```

Extra files like `README.md` in the zip are harmless; they're skipped on import.

### 9.3 Install in the desktop app

Togami → **Settings → Desktop pet → Import pet pack** (or *Replace pet pack*) → choose the zip. The pet reloads straight away. An import error message says exactly what's wrong (for example "The pack has no style.css…", "pet.json is not valid: …", "No pet.json in that zip").

---

## 10. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Import says "No pet.json in that zip" | The zip has two folder levels, or pet.json is misspelled. Zip the folder's contents (`blank_pet\*`). |
| Import says "The pack has no style.css / layout.html" | Missing file, or wrong name or case. |
| Nothing appears | Required id missing from `layout.html` (see console), or `pet.json`'s `idle` / `open` frame is wrong. |
| A frame is blank | File name mismatch (case matters), an unsupported type (`.jpg`), or the file is in a subfolder. |
| Whole window has a coloured box | `html` or `body` has a background in `style.css`. Remove it. |
| Font looks wrong | Font file not in the pack, a `url()` pointing at the web, or the `font-weight` in `@font-face` doesn't match the one used. |
| Text jumps while typing | `#text .rest` isn't `visibility: hidden`, or uses `display: none`. |
| Text overflows the box | Lines are too long. Shorten them, or shrink `font-size` in `.bubble p`. |
| Character jumps when blinking | `open` and `closed` frames have different crops or scales. Re-export with the shared crop box (3.5). |
| A line never appears | It uses a placeholder its moment doesn't get, or `{intention}` when the user typed none. Run `npm run check-pack`. |
| Clicks don't reach the pet | The element is outside `#card`/`#bubble`/`#menu`/`#badge`, or a decoration on top lacks `pointer-events: none`. |
| Pet is cut off at the window edge | Raise `window.width`/`height` in `pet.json`, or move the parts left and down. |
| A layout element vanished | It isn't in the allowed list (6.2), so it was removed with its children. |
| Background image from the web missing | Only pack files load. Download it into the pack (if the licence allows) and use `url(file.webp)`. |

---

## 11. Done checklist

1. `npm run check-pack` prints `OK`.
2. Every moment was clicked through in the test bench and looked right.
3. `packs/<name>-pet.zip` exists, with the files at its top level.
4. You told the user:
   - where the zip is and how to import it (Settings → Desktop pet → Import pet pack),
   - which expressions and frames the pack has, and anything you had to approximate (missing blink frames, mirrored art),
   - that `blank_pet/` now holds this character rather than the blank template, and whether its files are safe to commit (rule 11).
