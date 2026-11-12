# Sealround UI direction

The rule book for every page. Read it once, then use the tokens and components it names. If a shared piece
needs to change, ask its owner (see `WORKBOARD.md`) instead of hand-rolling a one-off.

**In one sentence:** a quiet, exact product UI in the manner of Linear, on a neutral near-black canvas (white in light mode) with one Base blue (`#0052FF`) accent,
hairline borders, medium-weight Inter set tight, lit controls that press like keys, and the product's own data
as the picture.

**Try the controls:** `http://localhost:3000/lab` shows every shared control in every state (not linked from
the app). Change a control there first, then check the routes.

**The reference is code, not a mockup:** the home page (`src/app/page.tsx`, `src/components/home/*`). Open
`http://localhost:3000/` and match its level of finish. When this text and the home page disagree, the home
page wins and this file should be corrected.

Why this direction: two earlier attempts (glossy orbs and gradients; then heavy expanded type with generative
poster cards) were rejected by the owner as looking machine-made. Measured against Linear, Vercel, Echo and
MetaDAO, what reads as professional is restraint: headings at weight 400 to 510 with tight tracking, 13 to 16px
body, flat 6 to 10px controls, hairline cards, and real numbers instead of decoration.

## 1. Rules

1. **Nothing is decoration.** No illustrations, orbs, glows, gradients, textures, hatches, dashed frames or
   generated artwork. If a block needs a picture, show the real thing: a countdown, a ledger of sealed bids, a
   chart of real data. The exceptions are material, not pictures: a button's two-stop body, lit edge, sheen
   and (primary only) the blue glow under it (`.btn-lit`); a card's lit top edge and faint sheen (`panel`);
   the cursor light on interactive cards (`spotlight`); the app's dot-grid backdrop with its slow scan band
   (`.backdrop`); and on the landing page only, the hero's breathing blue light (`hero-backdrop`) and the glow
   under the hero stage (`stage-glow`). Nothing else gets a gradient or a glow.
2. **One neutral ramp, one accent.** Surfaces and text come from the tokens below. Blue (`accent`) is for
   primary actions, selections, progress, links, focus and "you". Sale phases use small neutral icons with text labels. Simulation and
   network labels use neutral text. Use green, amber and red for outcomes, warnings and errors. Violet marks bots.
3. **Hierarchy by size and weight, not by boxes.** Each page's first screen answers: what is this, what state
   is it in, what is the number that matters, what do I do next. Everything else sits below.
4. **Borders group; space separates.** A card (`panel`) is a hairline box one step lighter than the canvas.
   Never put a bordered box inside a card: divide the inside with hairlines and spacing. Depth comes from four
   tokens only: `shadow-card` (a card's lit top edge), `shadow-well` (inputs sit in), `shadow-float` (menus,
   popovers) and the button recipe. No other shadows.
5. **Text discipline.** Sentence case. No all-caps labels. No em dashes. A label does not need a sentence
   repeating it. Helper text is one line and only where a mistake is likely. Say a thing once per page.
   Nothing below 13px except a `Tag` (12px) and mono ciphertext (12 to 12.5px).
6. **Money is exact.** Every price and amount is shown in full, at full contrast, with its unit, in tabular
   figures (`.num`). Never dim part of a number. Never round what a bidder pays. Never count up a price.
7. **Honest labels stay.** "Simulated", "sim tx" and "estimate" stay visible, once per block, as a `Tag` or
   one quiet line. Never show an individual max price of a real sealed sale.

## 2. Tokens (`src/app/globals.css`)

The app follows the device theme until the user switches it. The switch is in the top bar and in the phone menu.
Both themes use the same component tokens.

| Utility | Dark / Light | Use |
| --- | --- | --- |
| `bg-bg` | `#08090a` / `#fcfcfd` | Canvas |
| `bg-elev` | `#0f1011` / `#ffffff` | Cards (`panel`) |
| `bg-elev-2` | `#17181a` / `#f6f7f9` | Popovers, raised tiles |
| `bg-elev-3` | `#1f2023` / `#eef0f3` | A step above elev-2 |
| `bg-wash-soft`, `bg-wash`, `bg-wash-strong` | Neutral overlays (white on dark, black on light) | Subtle hover, secondary controls and pressed states |
| `border-line` / `border-line-strong` | Neutral hairlines: white 8% / 14% on dark, `#e6e8ec` / `#d2d6dc` on light | Dividers and outlines |
| `border-control` | `#3b3e44` / `#c5cad2` | Input boundaries |
| `text-fg` | `#f7f8f8` / `#0a0b0d` | Primary text, numbers |
| `text-muted` | `#9ea2aa` / `#555b66` | Secondary text |
| `text-subtle` | `#80848c` / `#646a75` | Tertiary text and labels |
| `accent`, `accent-bright`, `accent-soft` | Base blue: `#3d7eff` text on dark, `#0052ff` on light; primary buttons fill `#0052ff` in both | Progress, links, focus and selected controls |
| `live`/`ok`, `warn`, `bad` | green, amber, red | Outcome, warning and error feedback |
| `bot` | violet | Bots |
| `viz-fairground`, `-bonding`, `-fixed`, `-bot`, `-people` | blue (Sealround), grey and dim grey (the two launch types it is compared with: highlight one, grey the rest), violet, grey | Chart series only. Values and labels stay in text colours |

Radii are concentric: controls and inputs `rounded-btn`/`rounded-tile` (10px; a 32px button 8px, a 44px
one 12px); menus 14px with 8px items; cards `rounded-panel` (16px); sheets and the hero stage
`rounded-stage` (24px); status chips and segmented controls `rounded-full`; tags 5px; cipher slips 6px. An
element inside a padded box uses the outer radius minus the padding.

Surfaces: `panel` (card: elev colour, a `--card-sheen` fade over the top 200px, a `--card-line` border and
`shadow-card`), `inset` (recessed well), `layer-float` (menus and popovers), `material` (the sticky top bar:
translucent canvas with the page blurred behind).

`spotlight`, added to a `panel` that is a link or holds the main action (the live sale, the sales table, the
landing cards): a soft accent rim and fill follow the pointer. `SpotlightTracker` (in both shells) sets
`--mx`/`--my` on the `.spotlight` card under the pointer, from one `pointermove` listener, at most once per
frame, for mouse and pen only.

The app's background is `.backdrop`, rendered once by `AppShell`: a fixed dot grid that fades out down the
page, with a band of brighter dots that sweeps down every 14s. Only `html` paints the canvas colour, so the
backdrop sits between the canvas and the content. Reduced motion stops the sweep.

No colour literals in components (`#hex`, `rgb()`, `hsl()`); no arbitrary font sizes except the few half-pixel
steps already in the shared components. If a value is missing, it belongs in `globals.css`.

## 3. Type

Inter (with its optical-size axis) for everything; Geist Mono (`font-mono`, `.cipher`) for ciphertext and
hashes only. Weights are 400, 510 (medium) and 590 (semibold), written `font-[510]`. Each token sets size,
line height, tracking and weight.

| Utility | Size | Use |
| --- | --- | --- |
| `text-display` | 40 to 64px, 510 (84px on the landing hero) | The landing headline and `PageHeader size="lg"` only |
| `text-h1` | 32 to 48px, 510 | Page titles |
| `text-h2` | 24px, 510 | Section titles |
| `text-h3` | 16px, 590 | Card titles, row titles |
| `text-lead` | 17px | One intro sentence under a page title, `max-w-[58ch]`, `text-muted` |
| `text-prose` | 16px / 1.7 | Long reading (How it works), `max-w-[68ch]` |
| `text-body` | 15px | Default |
| `text-small` | 14px | Table cells, secondary lines |
| `text-label` | 13px | Labels over numbers, captions, hints. **Floor** |
| `text-tag` | 12px | Inside `Tag` only |
| `num text-num-hero` | 48 to 72px | The countdown, the clearing price |
| `num text-num-xl` / `-lg` / `-md` / `-sm` | 40 / 28 / 22 / 16px | Stat values |

`.num` = tabular figures. Put it on every number that can change or sits in a column.

## 4. Layout

- The shell gives a 56px top bar and a 1240px column with 32px gutters (16px on phones). Pages add no
  horizontal padding. A reading or form page may narrow itself (`max-w-[1120px]`, prose `max-w-[68ch]`).
- Page top: an optional back link, the title (`text-h1`), one lead sentence. Then the page's main block.
- Rhythm: 56 to 64px between sections, 16px between cards in a column, 20px card padding (`Panel` does it),
  12 to 16px between items inside a card. Section title (`text-h2`) sits 16 to 20px above its content.
- Two columns: `grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]` (content plus a 340 to 380px action column),
  the action column sticky at `lg:top-[72px]`. On phones the action comes first.
- Lists and tables are rows divided by hairlines inside one card, with a 36px header row and 44 to 68px rows;
  the whole row is the link when it leads somewhere (see `home/sale-row.tsx`).
- Check 375, 768 and 1440: no horizontal page scroll; wide tables scroll inside their own `overflow-x-auto`.

## 5. Components

Shared, in `src/components/ui`:

- `Button` / `ButtonLink`: `primary` (lit Base blue with a glow, one per decision area), `tactile` (default
  secondary, a lit charcoal key on dark and a white key on light), `outline`, `ghost`, `danger` (irreversible
  actions). Sizes `sm` 32, `md` 36, `lg` 44px, and `square` (44px, icon only, needs an `aria-label`). Use them
  for every clickable control that is not a link in text; do not hand-build buttons. The paint is
  `.btn-lit` with a colourway class; flat buttons use `.btn-press` for the same press.
- `Segmented`: a radio group in a recessed track; a lit thumb slides to the chosen option. `Field`: 40px
  recessed input, label above, 4px soft focus ring (red when it has an error).
- `Panel` (`base`, `raised`, `outline`, `inset`; `feature` is the same as `base`), `PageHeader`,
  `SectionHeader`, `Empty`, `Rule`, `KV`.
- `Stat` (label over number), `StatRow` (cells divided by hairlines between two hairlines), `Progress`
  (4px bar), `Price` (exact amount with unit).
- `Badge` supports an optional dot. `SaleStatusBadge` pairs a neutral icon with the phase label.
  `Tag` applies its tone to the text at 12px.
- `TokenAvatar` (neutral monogram square), `Countdown`, `TxLink`, `CheckRow`, `SimulatedNote`, `Skeleton`,
  `LoadingRegion`.

In `src/components/visual`: `CipherChip` (one sealed bid as a mono slip), `PriceLine` + `LineDot` (a hairline
in the accent with the price in a pill), `SealMark` (the logo mark), `AnimatedNumber`, `Reveal`, and
`chart-bits` (`PricePill`, `TipCard`, `TipRow`, `Legend`, `LegendItem`, `useSeriesMotion`).

Legacy class names that are now plain or empty and should disappear from markup as files are touched:
`panel-feature` (use `panel`), `hatch`, `hatch-fine`, `dots`, `canvas`, `icon-well` on every panel header,
`orb-arrow`, `rule-dashed`, `border-dashed` as frame decoration, a bare `btn-tactile` on a hand-built button.

## 6. Motion

150ms for hover colour, 180ms for menus (`popup-in`: from 94% scale and 8px up), 400ms for entrances. Easing
`ease-out` (`cubic-bezier(.23,1,.32,1)`); colour changes `ease-surface`; release and settle `ease-spring`
(`cubic-bezier(.3,1.12,.4,1)`, a slight overshoot and nothing more). Press: a button sinks to 97% in 90ms and
springs back in 320ms. Sliding indicators (segmented thumb, desktop nav hover) use a motion spring
(stiffness 520, damping 38 to 40). Animate `opacity`, `transform`, `translate`, `scale` and the registered
button colours only. Above the fold use `anim-rise` / `anim-fade` (stagger with `style={{ "--i": n }}`);
`Reveal` below it, sparingly. Hover never moves a control; only a trailing arrow icon leans 2px toward where
the button goes. App pages enter through `src/app/(app)/template.tsx` (fade and an 8px rise, 320ms). In the
app nothing loops except a live dot's ring, the loading shimmer and the backdrop's scan band. Reduced motion
shows the final state at once.

## 6a. Landing page (`src/app/(site)`, `src/components/site`)

The landing page sells the idea; the app at `/sales` stays a tool with a compact page header. Its pictures
are the product working, never stock art:

- `BidField` (hero, canvas): one sale in about 12 seconds. Sealed bids arrive as rings (bots violet and
  early), the sale closes, the enclave opens every bid at its real price, the clearing line drops, winners
  turn blue and settle on the line, losers fade. Paused off screen and in a hidden tab; reduced motion shows
  the settled frame. Colours come from the `--field-*` tokens, read again when the theme changes.
- `step-visuals.tsx`: four small loops for the four steps (seal, ledger, enclave, one price), each running
  only while on screen.
- `proof.tsx`: `ArenaBars` (the Bot Arena's real averages from `src/data/arena-results.json`, bars grow
  once in view), `ChecksDemo` (the five result checks ticking over, with "Run again") and `SwapRoute` (a
  1Click route stepping through quote, deposit, swap, ready).
- Headline words enter with `anim-blur` (blur, fade and rise, 90ms stagger); the hero stage with
  `anim-stage`. Sections below use `Reveal`.
- Links into the app go through `appHref()` (`src/lib/site.ts`), so they point at the app host when
  `NEXT_PUBLIC_APP_URL` is set.

## 7. Data viz (recharts)

No chart borders or backgrounds; the card is the frame. Horizontal grid only (`var(--viz-grid)`). Axis ticks
12 to 13px in the sans, `var(--viz-axis)`, no axis lines, at most 5 ticks. Series use the `viz-*` tokens (never
hex), lines 1.5 to 2px, bars with 2px top radius. Sealround and the clearing price are always blue. The
clearing price is a `ReferenceLine` with a `PricePill`. Tooltips: `bg-elev-2`, 8px radius, `shadow-pop`.
Legends are inline text with 6px dots. Every chart has a text or table equivalent.

## 8. Working rules

- Keep every behaviour: data hooks, wallet and relayer flows, phases, error and gas states, focus moves,
  `aria-live` regions, keyboard handling.
- Do not run `next build`, `next typegen` or a second dev server (root `AGENTS.md`). Check from `apps/web`
  with `npx tsc --noEmit --incremental false`, `npx eslint src` and `npx vitest run`.
- Read `node_modules/next/dist/docs/` before using a Next API you have not used in this repo.
- Gotchas: `cn` is plain `clsx` (no tailwind-merge, so two classes for one property do not override by
  order); elements with `anim-*` animate `transform`, so position them with `translate-*` or a wrapper; no
  `Date.now()` or other impure calls during render (React Compiler lint); a changing `key` remounts and drops
  focus; edit files in place (Turbopack can miss a rename-over write).
