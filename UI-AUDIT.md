# UI audit: Designeer, measured, and every style in the Fairground web app

Companion to `UI-REDESIGN-PLAN.md` (Codex owns the plan). This file supplies
numbers: what Designeer actually ships, measured from its computed styles on
2026-11-11, and an inventory of every colour, surface, control and type size in
`apps/web/src`, with the token each one should become.

- Part A: Designeer's design system, measured
- Part B: Fairground today, inventoried
- Part C: Replacement map (literal to token, control to recipe)
- Part D: Where the measurements disagree with the plan draft (owner decides)

Screenshots of Designeer (dark, 1440 and 375 wide, every top-level page) were
taken in a local session scratchpad and are not part of the repository.

---

## Part A: Designeer, measured

Captured from designeer.xyz with the browser's computed styles and its
stylesheets (`:root` and `.dark` custom properties, component classes,
keyframes). Values are exact unless marked approximate.

### A1. Why it looks expensive

It is not the colours. It is five habits applied without exception:

1. **One neutral ramp, no tinted greys.** Page `#121212`, well `#1b1b1e`,
   raised `#1f1f22`. Every other neutral is white at a fixed alpha
   (`#ffffff0d` wash, `#ffffff14` line, `#ffffff2e` strong line).
2. **One accent, used only for "yes".** Brand blue (`#1f78ff` body, `#4d94ff`
   text on dark) appears on the selected filter, the primary button and focus.
   Nothing else is blue. Colour in the page comes from the artwork, never the
   chrome.
3. **Every control is a lit object.** Buttons are not flat fills: a two-stop
   vertical gradient body, a gradient edge (lighter top, darker bottom), an
   inner shade at the bottom, and a two-layer drop shadow. All of it lives on
   a `::before` so the label stays crisp. Same recipe, three colourways.
4. **Structure is drawn with dashed hairlines**, not boxes: the sidebar edge,
   the top bar's bottom edge and section separators are 1px dashed
   `#ffffff2e`. The page gutters outside the 1300px frame carry a 6px diagonal
   hatch at 6% white. Cards have no border at all, only radius and a well fill.
5. **Small, dense, high-contrast type.** Root size 13px. Body 13px, labels
   12px, micro 10px, section heading 16px, page title 20px in a display face
   with -0.4px tracking. It reads sharp because primary text is `#fafafa` and
   secondary `#a8a8ad` on near-black, never mid-grey on grey.

### A2. Colour tokens (dark theme, with light values for reference)

| Token | Dark | Light | Role |
| --- | --- | --- | --- |
| `--page` | `#121212` | `#fff` | Canvas, sticky bars, scrims |
| `--well` | `#1b1b1e` | `#f2f2f3` | Recessed: card/tile fill, accordion, image wells |
| `--raised` | `#1f1f22` | `#fff` | Floating: menus, popovers, sheets |
| `--wash` | `#ffffff0d` | `#00000009` | Hover and selected fill on rows and nav items |
| `--wash-hover` | `#ffffff14` | `#0000000e` | Hover on an already-washed item |
| `--ink` | `#fafafa` | `#18181b` | Primary text, icons on hover |
| `--ink-2` | `#a8a8ad` | `#5d5d66` | Secondary text, idle nav and filter labels |
| `--ink-3` | `#8b8b92` | `#6b6b73` | Tertiary text, idle icons, placeholder |
| `--line` | `#ffffff14` | `#00000012` | Hairlines inside components |
| `--line-strong` | `#ffffff2e` | `#00000029` | Dashed structural lines |
| `--brand` | `#4d94ff` | `#0066fa` | Accent text, rings, focus |
| `--cyan` | `#00bbff` | same | Selection highlight only (`::selection` at 30%) |
| `--destructive` | `#ff6568` | `#e40014` | Errors |
| `--ring` | `var(--brand)` | | `:focus-visible` outline 2px, offset 2px |

shadcn aliases map onto these (`--background: var(--page)`, `--card:
var(--raised)`, `--muted: var(--wash)`, `--muted-foreground: var(--ink-2)`,
`--primary: var(--brand)`, `--border: var(--line)`), so library components
inherit the system for free.

### A3. Surfaces and elevation

| Class / token | Recipe (dark) | Used for |
| --- | --- | --- |
| `.layer-well` | bg `--well`, `inset 0 0 0 1px #ffffff0f` | Grouped content: FAQ accordion, info blocks |
| `.layer-field` | bg `--page`, `inset 0 0 0 1px #ffffff24`; focus `inset 0 0 0 1px brand, 0 0 0 4px brand` (brand at low alpha in practice) | Inputs |
| `.layer-float` | bg `--raised`, `inset 0 0 0 1px #ffffff1a, 0 4px 8px -4px #0000004d, 0 16px 36px -10px #0000008c` | Menus, popovers |
| `--layer-1-shadow` / hover | `inset 0 0 0 1px #ffffff12, 0 2px 6px -3px #0000004d` / `inset 0 0 0 1px #ffffff1f, 0 3px 8px -4px #0006` | Raised cards, `.layer-hover` |
| `.material` | `--page` at 72% + `backdrop-filter: blur(20px) saturate(180%)` | Sticky header, mobile dock |
| `.material-raised` | `--raised` at 78% + `inset 0 1px 0 #ffffff14, var(--shadow-float)` | Floating pills (search dock) |
| `--shadow-float` | `0 0 0 1px #ffffff14, 0 8px 24px -6px #0009, 0 2px 6px -2px #0006` | Cookie card, popovers |
| `--shadow-stage` | `0 12px 40px #00000080, 0 0 0 1px #ffffff12` | The big preview stage |
| `--shadow-plate` | `inset 0 0 0 1px #ffffff1a, inset 0 1px 0 #ffffff14, 0 2px 6px -4px #0009, 0 6px 14px -6px #0006` with `--plate-top #2a2a2a` to `--plate-bottom #202020` | Icon plates, sponsor logos |
| Tile | `rounded-tile` (20px), bg `--well`, no border, image `outline: 1px solid #ffffff0f` | Listing cards |
| Frame gutters | `--hatch-tile`: 6px SVG diagonal, white at 6% | Outside the content frame |

### A4. Buttons: one recipe, four looks

`.surface` puts the paint on `::before` so the label never sits on a gradient
edge. Variables per colourway:

| Variant | Body top to bottom | Edge top to bottom | Sheen | Shade / drops / glow |
| --- | --- | --- | --- | --- |
| `.surface-primary` | `#1f78ff` to `#0058e6` | `#6aa8ff` to `#0045c0` | `linear-gradient(#ffffff24, transparent 45%)` | shade `#00226b2e`, drop-near `#00000040`, drop `#00000060`, glow `#1f78ff4d` (`0 8px 20px -8px`) |
| `.surface-secondary` | `#2c2c30` to `#38383c` | `#56565b` to `#36363a` | none | drop `#0006` |
| `.surface-outline` | `#1b1b1e` to `#17171a` | transparent to `#0003` | none | drop-near `#0003`, drop `#00000040` |
| `.key` (Submit) | `linear-gradient(#2a2a2e, #1f1f22)`, inner cap `linear-gradient(90deg, #26262a, #45454b)` inset 3px 3px 5px, radius 11px (cap 8px) | cap edge `#0000008c` | cap light `#ffffff29` | rest `inset -6px 0 6px #00000026, inset 0 -6px 6px #00000040, 0 0 0 1px #ffffff1a, 4px 10px 16px #00000080` |

Shadow stack on every `.surface::before`:
`inset 0 -3px 6px -3px var(--surface-shade), 0 1px 1px 0 var(--surface-drop-near), 0 2px 4px 0 var(--surface-drop), 0 8px 20px -8px var(--surface-glow)`.

States:
- **Hover** (pointer devices only, `@media (hover: hover)`): body stops lighten
  by 4% white (`color-mix(in srgb, base, white 4%)`). No colour change, no
  movement.
- **Press**: `.key` drops 2px (`translate: 0 2px`) and swaps to a shallower
  shadow in 80ms; pill buttons `active:scale` slightly.
- **Selected filter pill**: `aria-pressed="true"` and the primary colourway.
- **Focus**: `outline: 2px solid var(--ring); outline-offset: 2px` everywhere;
  fields use the ring as a box-shadow instead.
- **Transitions**: colour only, 150ms, `cubic-bezier(.215,.61,.355,1)`
  (`--ease-surface`). Body stops animate as registered custom properties.

Sizes (13px root): pill `h-8` 26px tall, `px-3.5`, radius 999px, 13px/500.
Sidebar nav item 29px (h-9), radius 10px, 13px/400, active = `--wash` bg plus
`--ink` text, idle `--ink-2`. Icon button 28px round. Brand CTA ("Visit site")
full-width in its card, 26px, primary colourway. Search trigger 30px, radius
7px, 12px `--ink-3`.

### A5. Type

| Role | Face | Size / line height | Weight | Tracking | Colour |
| --- | --- | --- | --- | --- | --- |
| Page title | Funnel Display | 20px / 24px | 500 | -0.4px | `--ink` |
| Section heading (`text-heading`) | Funnel Sans | 16px / 1.25 | 500 | 0 | `--ink` |
| Lead paragraph | Funnel Sans | 15px / 24px | 400 | 0 | `--ink` |
| Body (`text-body`) | Funnel Sans | 13px / 1.45 | 400 | 0 | `--ink` or `--ink-2` |
| Control label | Funnel Sans | 13px | 500 | 0 | `--ink-2` idle, `--ink` active |
| Small (`text-small`) | Funnel Sans | 12px / 1.4 | 400 to 500 | 0 | `--ink-2` or `--ink-3` |
| Micro (`text-micro`) | Funnel Sans | 10px / 1.4 | 500 | 0 | `--ink-3` |
| Numbers and meta | Geist Mono | 13px | 400 to 500 | 0 | `--ink` |
| Ornament | Geist Pixel; PP Neue York (serif) | | | | Wordmark, rare accents |

Fonts are self-hosted variable woff2 (Funnel Display/Sans 300 to 800, Geist
Mono 100 to 900) with metric-matched Arial fallbacks. Reduced motion turns off
the shimmer text effect.

### A6. Layout frame

- Content frame about 1300px wide, centred; hatch gutters outside it, each
  frame edge a dashed `--line-strong` rule.
- Left sidebar 208px (16rem), sticky full height, dashed right border:
  wordmark row (52px, dashed bottom), one-line description, "Browse" group,
  "Folders" group, a sponsor carousel card pinned to the bottom, credits.
- Top bar 52px (h-16), dashed bottom border: text links left (Login,
  Favourites, Info), centred Search pill, right cluster of icon plates, a
  `.key` Submit button and a settings icon button.
- Page header centred: 20px display title (two lines max), 13 to 14px
  `--ink-2` lead, 40px below the top bar.
- Filter row: pills left (first is selected primary), view toggle and two
  dropdown pills right. Grid of tiles, 3 columns at 1440, 10px gaps, tiles
  with mixed heights in a masonry flow.
- Detail view is a shared-element morph: the tile scales into a centred stage
  (`--shadow-stage`, radius 28px) while a 300px side sheet slides in from the
  left with the listing's facts (`Views`, `Outbound`, `Added` as label/value
  rows with hairlines), similar listings, and a bottom action pair (Copy as
  outline, Visit as primary). Scrim is page colour at 28% plus 3px blur.
- Phone: no sidebar; translucent sticky header; a floating `.material-raised`
  dock at the bottom (Search, menu); detail becomes a bottom sheet with 20px
  top radius.

### A7. Motion

| Token | Value |
| --- | --- |
| `--ease-surface` | `cubic-bezier(.215,.61,.355,1)`, colour changes 150ms |
| `--ease-out` | `cubic-bezier(.23,1,.32,1)`, scale and press 150ms |
| `--ease-spring` | `cubic-bezier(.3,1.12,.4,1)` |
| `--ease-morph` | `cubic-bezier(.33,.55,.2,1)`, `--dur-morph` .38s |
| `--ease-drawer` | `cubic-bezier(.32,.72,0,1)`, sheets .26s |
| List enter / exit / stagger | .42s / .3s / 30ms per row (`list-row-in`: fade from -10px) |
| Popups | `popup-in`: scale .94 and -8px to rest; `popup-out` .96 and -4px |
| Route change | 0 to 1 opacity cross-fade |
| Loading text | `shimmer` sweep across `currentColor`, 2s linear, off under reduced motion |

Nothing bounces, nothing glows on idle, and nothing moves on hover except a
tile's 150ms scale.

### A8. Resources on Designeer worth using here

Taken from the Components, Icons, Motion & 3D and Type & Colour categories,
filtered for what Fairground needs:

| Need | Resource | Why |
| --- | --- | --- |
| Clearing price, countdown, live totals that change | NumberFlow | Digit-level transitions, accessible, dependency free |
| Dialogs, menus, popovers with correct focus | Base UI or Radix primitives | Unstyled, so the surface recipe above applies cleanly |
| One icon set | Lucide (already common) or Phosphor | One stroke and size across the app |
| Generated sale art and the seal | Paper Shaders, Book of Shaders | Real material for the "sealed" visual instead of CSS orbs |
| Colour checks | OKLCH, Huetone, APCA, Color.review | Build the ramp in OKLCH, check text contrast with APCA |
| Mono and pixel accents | Departure Mono, Geist Pixel | Ciphertext and hashes as a deliberate texture |
| Charts | Evil Charts | Animated SVG charts in shadcn style, for the demand curve |
| Motion primitives | Motion Primitives, Motion | Text reveal, tile morph, list stagger |

---

## Part B: Fairground today, inventoried

_In progress: the file-by-file inventory is being collected now and will be
added here._

## Part C: Replacement map

_Follows Part B._

## Part D: Measurements versus the plan draft

_Follows Part B._
