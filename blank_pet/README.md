# Pet pack template

**Building a pack (or asking an AI to)? Follow [`AI_PACK_GUIDE.md`](AI_PACK_GUIDE.md)**: step by step, with frame specs, image commands, line writing and testing. Check a pack with `npm run check-pack`.

Togami has no pet look of its own. A pet pack brings the character, its lines **and** the whole style: the card, the speech box, the menu, the timer badge, fonts and animations. This folder is a working pack to copy from. It uses the Persona 5 dialogue style with placeholder frames (an outlined blob), so you can swap in your own frames and lines, or restyle it completely.

## Files

Everything sits in one folder, next to `pet.json` (no subfolders):

| File | What it is |
| --- | --- |
| `pet.json` | Name, window size, timing, expressions and lines. Required. |
| `style.css` | Every bit of styling and animation. Required. |
| `layout.html` | The markup of the pet's parts. Required. |
| `*.webp`, `*.png` | Frames, plus any images `style.css` or `layout.html` use. |
| `*.woff2`, `*.woff`, `*.ttf`, `*.otf` | Fonts for `style.css`. |

Other files (like this README or a font licence) are left out when the pack is imported. The pack can be up to 64 MB.

**To install:** zip the folder (right-click → *Send to* → *Compressed (zipped) folder*) and import the zip in Togami → Settings → Desktop pet. `pet.json` can be at the top of the zip or inside one folder. For the browser build, copy the folder to `packs/current/` and run `npm run dev`.

## pet.json

```json
{
  "format": 1,
  "name": "Blank",
  "window": { "width": 560, "height": 340 },
  "timing": { "introFrame": 70, "type": 24, "punctuation": 144, "hold": 3200, "holdPerChar": 55 },
  "nameHighlight": { "1": 1, "8": 2, "16": 3 },
  "idle": "neutral",
  "expressions": {
    "neutral": { "open": "neutral-open.png", "closed": "neutral-closed.png" },
    "happy": { "intro": ["happy-in0.png"], "open": "happy-open.png", "closed": "happy-closed.png" }
  },
  "lines": {
    "workStart": [{ "e": "happy", "t": "{min} minutes on {intention}. Let's go!" }]
  }
}
```

- `name` is shown in Togami's settings and in `#name`.
- `window` (optional) sets the transparent window the pet lives in, in CSS pixels (default 560 × 340). The window opens in the bottom-right corner, so keep the pet near the bottom left of it. Only the parts listed under *Clicks* catch the mouse; the rest of the window lets clicks through.
- `timing` (optional, milliseconds): `introFrame` is each intro frame, `type` each typed character, `punctuation` the pause after `. , ! ?`, and a line stays up for `hold` or `holdPerChar` × its length, whichever is longer.
- `nameHighlight` (optional) wraps random letters of the name in `<b>` (Persona 5 inverts one): `{ "minimum name length": letters }`. Leave it out for a plain name.
- `expressions`: `intro` frames play when the pet switches to that expression, `open` is the resting frame, `closed` (optional) is used for blinking.
- `idle` is the expression the pet goes back to after speaking.
- `lines`: for each moment, a list of `{ "e": expression, "t": text }`. One is picked at random. Moments: `hello`, `workStart`, `breakStart`, `breakEnd`, `sessionEnd`, `blockWarn`, `block`, `pauseRequested`, `paused`, `resumed`, `quit`, `lockout`, `lockoutEnded`, `pardon`, `update`, `idle`, `late`, `poke`. Text can use `{intention}`, `{min}`, `{target}` and `{version}`; a line is only used when every placeholder has a value. Moments with no usable line fall back to plain built-in ones.

## layout.html

The pet's parts, as plain HTML and inline SVG. Togami looks them up by id:

| id | Required | What Togami does with it |
| --- | --- | --- |
| `#card` | yes | The pet itself: drag to move, click to poke, right-click for the menu. |
| `#sprite` | yes | An `<img>` inside `#card`; Togami sets its frame. |
| `#bubble` | yes | The speech box. Hidden while the pet is quiet. |
| `#text` | yes | Inside `#bubble`; the line is typed here. |
| `#name` | no | Gets the pack's name. |
| `#menu` | no | The right-click menu. Added at the end if missing. |
| `#badge` | no | The timer badge while a session runs. Added at the end if missing. |

Anything with a `data-speak` attribute gets the class `on` while the pet speaks (the template's slash bands use it). Later elements stack on top of earlier ones.

Layouts are cleaned when they load: scripts, event handlers (`onclick` and so on), forms, iframes, links and `<style>` are removed, and `src`/`href` may only point at files in the pack or at `#ids`. Allowed elements: `div span p b i em strong small br img`, and SVG shapes, gradients, masks, clip paths and simple filters.

## style.css

All of the look. `url()` can point at files in the pack (`url(ProzaLibre-ExtraBold.woff2)`) or at `#ids` in the layout; anything else, including `@import` and web addresses, is removed. Fonts installed on the computer can be used with `local()`.

Togami only ever adds and removes these classes and attributes, so these are the hooks to style:

| Where | Class or attribute | When |
| --- | --- | --- |
| `#card` | `.pop` | The pet starts speaking (restarted each time). |
| `#card` | `.wiggle` | The pet was clicked (restarted each time). |
| `#card` | `.chatter` | While a line is being typed. |
| `#card` | `.flip` | *Turn around* in the menu. |
| `#card` | `data-expression="happy"` | The current expression. |
| `#bubble` | `.show` | The box opens (restarted each time). |
| `#bubble`, `#menu`, `#badge` | `hidden` | Not shown. The window's own CSS hides `[hidden]`. |
| `[data-speak]` | `.on` | While the pet speaks. |
| `#menu` | `.show` | The menu opens or changes page. |
| `#badge` | `.focus`, `.brk`, `.paused` | Focus, short or long break, or paused. |

What Togami writes inside them:

- `#text`: `<span>typed so far<span class="rest">the rest</span></span>`. Hide `.rest` with `visibility: hidden` so centred text doesn't shift while typing.
- `#name`: the name, with highlighted letters as `<b>k</b>`.
- `#menu`: `<button><span>Label <small>detail</small></span></button>` per item. A button with `.off` is shown but not available (*Locked*).
- `#badge`: `<small>Focus</small><b>24:13</b>`.

## Placeholder art

The frames here are simple placeholders. Don't put art you don't have the rights to into packs you share. Proza Libre is under the SIL Open Font License (`OFL-ProzaLibre.txt`).
