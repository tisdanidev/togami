# P4R-style menu: design notes

Reference: Persona 4 Revival pause menu as shown in the July 2026 demo footage (pre-release build, may change). Open `p4r-menu.html` in a browser to try the mockup.

Controls: **↑/↓** or **W/S** or mouse wheel to move, **Enter** or click to open, **Esc** or right-click to go back. `?screen=item` (or `skill`, `equip`, `persona`, `status`, `quest`, …) opens a submenu directly.

All art in the mockup is placeholder: flat tonal blocks where the character renders go.

## Palette (sampled from the footage)

| Token | Hex | Where |
| --- | --- | --- |
| `--yellow` | `#fef400` | Base of everything; the root menu, Equip, Status |
| `--yellow-hot` | `#fff800` | Menu words, flowers, money |
| `--yellow-deep` / `--orange-deep` | `#ffd50a` / `#ffb000` | Tiled floor on the root screen |
| `--orange` | `#f4a807` | Status panel |
| `--sky` / `--sky-deep` | `#4ec7fe` / `#1f9df0` | Sky band on the root screen |
| `--turquoise` | `#3ce8f6` | Skill screen |
| `--persona-blue` / `--persona-navy` | `#0b23b8` / `#050c5e` | Persona screen |
| `--plum` / `--plum-deep` | `#4f034e` / `#2a0429` | Character's coat, which the menu sits on; text shadow |
| `--tan` | `#896a3b` | Lit fold of the coat behind Commu/Calendar/System |
| `--olive` | `#a49a00` | Equip slot labels |
| `--card-dark` / `--card-cream` | `#252724` / `#fcf7b5` | Party card selected / unselected |
| `--hp` / `--sp` | `#2ff0ff` / `#99fe0d` | HP and SP bars (plus deeper gradient ends) |
| `--edge-green` / `--edge-red` | `#5dff3c` / `#ff1638` | Double outline on any selected card or row |
| `--magenta` / `--cursor-blue` | `#ff2fa8` / `#2b3dff` | Selected menu word gradient and cursor shards |

Each submenu gets its own colour world. The yellow root ties them together, and a yellow wipe plays between screens.

## Type

- **Menu words** (`Skill`, `Item`…), giant background words, money: heavy high-contrast serif with ball terminals. Mockup uses *Playfair Display 900*.
- **UI text** (LEADER/PARTY, names, HP/SP, prompts, help line): condensed sans, mostly italic. Mockup uses *Barlow Condensed*; *Bahnschrift* is a good Windows-native fallback.
- **"Info" tag**: handwritten marker. Mockup uses *Kalam*.

For the Windows build, bundle the font files with the app instead of loading Google Fonts.

## Root menu layout (1920×1080)

- The whole list is rotated **−18°**. Each row steps right by 16px, with extra indent per group.
- Three groups of three (Skill/Item/Equip · Persona/Status/Quest · Commu/Calendar/System). Later groups set larger (64 → 70 → 82px).
- Unselected words are yellow with a hard `4px 5px 0` plum shadow.
- The selected word grows 1.5×. It gets a magenta→blue gradient fill, a dark stroke, a cyan/red RGB split, and sits on a white skewed slab with a blue shard bottom-left and a magenta shard top-right. It jitters for 0.26s on arrival.
- Composition: character art on the left, its coat sweeping diagonally across the lower half. Sky band at top right, tiled orange floor at bottom right.
- Ornaments: a six-petal flower in three versions (big yellow, white with red/green fringe, small black), plus drifting confetti.
- Bottom right: dark pill with ✦ and a help line, and button prompts under it. Right edge: party mini-portraits with HP/SP bars. Money at bottom centre.

## Submenus

| Screen | Background | Key components |
| --- | --- | --- |
| Skill | Turquoise with yellow blobs at the corners, giant yellow "Skill" bottom-left | Party cards, skill rows with cost, Info line |
| Item | 3D yellow desk in perspective, extruded cyan "ITEM" letters | Paper sheet with Q/E category tabs and pager, NEW tags, × count pills, Info tag |
| Equip | Yellow with a faint tile grid, ghosted "Equip" | Name-only party cards, WEAPON/PROTECTOR/ACCESSORY/CLOTHES slots, greyscale portrait at right |
| Persona | Deep blue with diagonal light lines, outlined "PERSONA" | Yellow-green header tab, dashed list, model at right |
| Status | Yellow left, slanted orange panel right with pink/lime edge stripes, outlined "Status" | White silhouette + grey character, party cards, stat bars |

Quest, Commu, Calendar and System haven't been shown in the footage yet, so they use a generic placeholder in the same style.

**Party card:** a parallelogram skewed −12°. It holds the PLV label with a big italic level number, a profile portrait with LEADER/PARTY over it, the name, and HP/SP with zero-padded numbers (leading zeros dimmed) and skewed gradient bars. The selected card is dark with the green/red double edge.

## Motion

- Screen change: a yellow skewed panel sweeps left→right with white and turquoise trailing slivers (≈0.46s). The scene swaps under it at ≈0.19s.
- Cards slide in from the left, staggered 50ms.
- A cyan streak draws across the root screen on return.
- Flowers spin slowly. Confetti drifts.
- `prefers-reduced-motion` turns all of it off. Fan feedback on the demo called the menu motion nauseating, so the real app should also have its own setting for this.

## Implementing it on Windows

The mockup is plain HTML/CSS/JS on a fixed 1920×1080 stage scaled to the window, so it drops straight into any WebView-based shell:

- **Tauri** (WebView2): small installer, frameless window with `decorations: false`; the custom title bar is already in the mockup (`-webkit-app-region: drag`).
- **Electron**: same idea, `frame: false`.
- Port to React like `sona`: the menu becomes a component with the cursor state; the wipe becomes a transition component; tokens go in a Tailwind `@theme`.

Swap the prompt glyphs (`Enter`/`Esc`) for controller buttons when a gamepad is in use (Gamepad API).
