# Fairground UI redesign plan

**Reference for Claude's redesign.** The project owner delegated visual direction and implementation to Claude. The proposal below draws on the dark Gallery study for the frame and composition, the Catalogue study for sale hierarchy, and the Terminal study for ledger readability. Claude can select, combine or replace those ideas. Real routes, amounts, phases, permissions, and transaction states come from the Next.js app.

The visual identity comes from the auction itself. Ciphertext slips gather around a graphite seal. After clearing, a single cobalt line cuts across the result at the published price. Home explains that mechanism in one glance. Sale and Result put the current action and the money first.

## Baseline observations

- In the running Home, the sidebar, framed illustration, fact strip and repeated Judge entry compete with the headline. The board repeats the same orb composition in six hues, and the first sale sits below the opening screen. Move navigation to the top bar, let the seal carry the hero, and give sale phase and action a clear position on the board.
- In Fair Test, the media banner and sale metadata precede the live timer, while the funding panel reads like a second primary flow. Lead with the deadline and bid action. Show funding as a supporting action with the actual quote and swap mode visible at the point of use.
- In Lantern, the existing clearing figure and personal result provide the right structure. Reduce the banner, preserve the public ledger, and keep the evidence label explicit. The current mock shell shows “testnet” beside simulation copy. Give mock mode a persistent “Simulated” label in the shell, cards and flows where environment matters. Reserve network labels for the configured network.
- The bright end of the current button gradient puts white at about 3.02:1 against its blue before the white sheen. Make the action label readable across its full background and reserve gloss for the edge. [Current button style](apps/web/src/app/globals.css#L415)

## Reference decisions

The live Designeer review covered Finds, Inspiration, Resources, Tools, Portfolios, and Info, including all four Resources sections and selected listings. Its restrained navigation, compact filters, and separation of artwork from controls carry over. Its discovery mosaic informs the sales gallery. Fairground's transactional pages need a stable reading order. [Designeer resources](https://designeer.xyz/resources?category=resources-components)

| Reference | Decision for Fairground |
| --- | --- |
| [Designeer Finds](https://designeer.xyz/) and [SEESAW](https://www.seesaw.website/) | Give the home hero one large visual, align its edges with the listings below, and keep the surrounding chrome quiet. |
| [The Component Gallery](https://component.gallery/components/button/) | Check button roles, focus and disabled states against real design systems. Keep the current React primitives as the implementation base. |
| [Base UI Dialog](https://base-ui.com/react/components/dialog) and [Radix Dropdown Menu](https://www.radix-ui.com/primitives/docs/components/dropdown-menu) | Use as behavioral references for wallet, menus, and the review sheet. Check focus return, keyboard selection, Escape, collision, and dismissal. |
| [60fps](https://60fps.design/) and [NumberFlow](https://number-flow.barvian.me/) | Study how a state change leads the eye. Use existing Motion and CSS for the seal and optional digit transitions. Final prices and transfer amounts render at full precision immediately. |
| [Evil Charts](https://evilcharts.com/) | Use direct labels, clear series hierarchy, and readable tooltips in the existing Recharts components. |
| [Lucide](https://designeer.xyz/resources/lucide), [Ramps](https://designeer.xyz/resources/ramps) and [Color.review](https://designeer.xyz/resources/color-review) | Keep one icon family and validate role-based colors against their actual surfaces. |
| [Mobbin](https://designeer.xyz/inspiration/mobbin) and [Rauno Freiberg](https://designeer.xyz/portfolios/rauno-freiberg) | Use short confirmation flows and precise feedback as references for wallet, bid submission and claim. |

## Visual system

### Color and materials

| Role | Proposed treatment |
| --- | --- |
| Canvas and chrome | `#131316`. Use one continuous canvas, a quiet top navigation, and an occasional hairline. Remove competing full-page hatch, dashed frames, outer glow, and separate sidebar fills. |
| Recessed and raised | `#0E0E11` for inputs, code and ciphertext. `#1B1B20` for a single grouped surface such as the bid form. `#24242B` for menus and sheets. Use `#303039` dividers for grouping and a stronger functional border, starting at `#777782`, where an input or control needs a visible edge. |
| Text | `#F5F4F1` for primary text, `#B8B8C2` for secondary text, and `#9B9BA8` for tertiary text. Show the entire price at one contrast, including leading decimals and units. |
| Primary action | `#2D64EB` with `#FAFAFC` text. Hover `#285BDA`, press `#2855CF`. Put a subtle highlight at the top edge. Keep the label area flat enough to preserve contrast. The base pair is 4.87:1 before effects. |
| Focus and price | `#83AEFF` for a 2px focus ring with offset and for small links on dark. Use this family for the clearing line and selected indicators. |
| Status | Cobalt for live, amber `#E7B862` for attention or waiting on an action, mint `#81D2AD` for confirmed success, coral `#FFA29A` for errors or invalid bids. Use a label and a dot or icon. Routine upcoming, completed historical and informational states can stay neutral. |
| Artwork and charts | Use graphite, off-white, and controlled cobalt in the seal and sale art. Give sale art identity through geometry seeded by sale ID. Keep token and network colors in their marks. Chart colors belong to named series only, with purple reserved for known bots and additional series differentiated by labels and stroke patterns. |

Use existing `globals.css` tokens and aliases as the migration seam. Consolidate hardcoded color, gradient, opacity, shadow, border and radius values into role-based tokens. Review `arena.module.css` and inline styles in chart, token and motion components as well as Tailwind classes. Retire duplicate treatments after their callers migrate. Claude is preparing the exact replacement inventory in `UI-AUDIT.md`. [Workboard](WORKBOARD.md)

Start with the shell's [stacked surface treatments](apps/web/src/components/shell/app-shell.tsx#L363), the [home illustration's inline fills](apps/web/src/components/home/hero-mechanism.tsx#L234), [form choice focus colors](apps/web/src/components/create/form-kit.tsx#L117), and [funding's custom controls](apps/web/src/components/sale/fund-panel.tsx#L160). These are the places where replacing the theme variables alone will leave the old treatment visible.

### Layout, typography and motion

- Use a 1280px maximum content width with 16px phone, 24px tablet, and 40px desktop gutters. Align headers, action panels, ledgers, and footers. Start with 48–64px section spacing on desktop, 32px on phone, and 12–24px inside sections. Use 10–12px for controls and 14–16px for grouped panels and media.
- Keep Funnel Display, Funnel Sans, and Geist Mono during the first pass. Give the home headline a 44–88px fluid range and internal titles 28–48px. Use 15–16px for body, 13–14px for supporting information, and mono tabular figures for prices, timers, hashes and quantities. Reserve short badges for actual states. Use line breaks and placement before shrinking text.
- Keep texture inside the hero's artwork or a close-up of the seal. The home study's large posters become a single featured sale treatment and smaller, consistently cropped sale thumbnails. On Sale, place the countdown and current action before compact artwork on phones. Keep form and ledger surfaces steady.
- Home shows sealed slips, the seal and the clearing line with one sequence. Judge uses that sequence to explain the actual state transition. Result lands on the published line and price. Use 120–160ms control feedback and 200–240ms menus or sheets. Reduced motion shows the final state immediately. Countdown polling must preserve layout and avoid per-second screen reader announcements.

## Controls and states

| Control | Treatment and usage |
| --- | --- |
| Primary button and navigation CTA | One prominent blue action per decision area. Use for the current next step, including Run demo, Place sealed bid, Reveal bid, Claim, or Review sale. Keep the action verb visible with a spinner and status during submission. |
| Secondary button | Neutral filled or outlined surface for Create sale when secondary to browsing, fund from another chain, retry, review alternatives, back, or run again. Use a quiet neutral hover and a firm pressed state. |
| Text action and row link | Underlined or icon-led link with visible focus. Use for opening a sale, viewing the result, revealing supporting details, explorer links and secondary navigation. A sale card gets one main link target. Give separately actionable controls their own hit areas. |
| Icon action | Use a single size and stroke for copy, close, menu, overflow and replay. Label icon-only controls. Copied feedback stays at the control and announces once. |
| Choice, filter and tabs | Use a neutral segmented surface with a selected mark and clear text. Preserve arrow-key selection where implemented. Use a wrap or locally scrolling filter row on mobile. Scope true tabs, radio choices and toggles to their appropriate semantics. |
| Inputs and selects | Put labels above recessed fields and keep units attached. Make helper and error text part of the field description. Standardize selects, amount fields, presets, chain picker, date fields and secret-file controls. Keep entered data on a recoverable error. |
| Menu, dialog and mobile sheet | Use a single elevated surface. Wallet, paid fallback, reset and create review each get a clear title and action. Support keyboard navigation, focus return and short viewport scrolling. Confirmed destructive reset can use a danger treatment. Refunding a bidder is a normal monetary action. |
| Status, stepper and disclosure | Use short, precise phase labels. Stepper marks the current, complete and upcoming steps. Expandable activity, contract rules, proof checks and assumptions show an accessible expanded state and keep their important summaries visible. |
| Feedback and loading | Match skeletons to the settled layout. Distinguish empty, disconnected, loading, rejected, pending confirmation, confirmed and unavailable. Keep state and recovery inline near the action. An uncertain submission keeps retry disabled until its outcome is known. |

Inventory every `button`, `Button`, `ButtonLink`, styled link, input, select, textarea and summary before marking a route done. Check default, hover, focus-visible, press, selected, disabled, loading and error where applicable. Make mobile hit areas at least 44px, including icon-only and compact list controls. Include wallet, reset, chain and amount choices, paid fallback, bid secrets, claims, explorer and copy actions, verification, examples, simulator controls and chart toggles.

## Screens

### Shell and home

- Desktop top bar with wordmark, Sales, Launch a sale, Judge mode where supported, Bot Arena, How it works, environment and wallet. Phone header retains environment and wallet access, with an accessible menu for the other destinations. Retain skip navigation, wallet disconnect and mock reset confirmation.
- Set the headline around the existing promise, “Sealed bids. One price.” Pair it with the seal illustration and a short explanation. Lead with Run demo in mock mode and Browse sales in NEAR mode. Use a quieter Create a sale link. Give the artwork a fixed aspect ratio and a static first paint.
- Place sale phase, countdown or outcome price, and next action before secondary numbers. Show filters close to the listings, with current state and counts. Use one featured live sale when one exists, then consistent compact lots. Keep the first actionable listing easy to reach on a phone. Cover loading, no sales, no match, and RPC error.

### Sale

- Identity and environment, phase and deadline, then the current action. On desktop use a primary content column and a 340–380px action column. On phone place the action above media, rules and history. Avoid a fixed footer that obscures the keyboard or terms.
- Show a real deposit, private maximum spend and maximum price as distinct fields or facts. Put expected wallet debit, exact required NEAR when applicable, and gas payer by the action. Keep funding on the same route. Give wallet USDC, amount escrowed, a dry quote, a simulated swap and storage registration different labels.
- Design setup and retry, upcoming, open, bid recorded, ready to close, clearing and retry, reveal, missing secret and import, reveal expired, on-chain clearing, settled and timeout/refund states. Include wallet cancel, rejected bid, uncertain submission and confirmed receipt. Make the transaction path clear in the existing money and activity sections.

### Result

- Lead with the exact clearing price and “Every winner paid the same price” for successful sales. Show the viewer's tokens, refund, penalty where applicable, and next claim action early. Cover no bid, disconnected, claim pending, partial claim, complete, failed sale and refund-only outcomes.
- Use an accessible fill distribution derived from public allocations, spend and refunds. Show bot-versus-human comparisons only for known roles in the demo or simulator. Real TEE results keep individual maximum prices and spends private.
- Give proof checks a short outcome summary with details expandable. Distinguish contract checks, simulated evidence and an unavailable fresh attestation. Keep public fills and transaction evidence readable in a ledger with a text or table equivalent for charts.

### Create

- Group token identity and supply, sale allocation, price and minimum raise, window, limits and mode. Keep an updating terms summary. On phone show a compact summary before Review sale and surface the first invalid field when blocked.
- Review the locked terms, exact NEAR cost, network and signer before the existing create action. Keep draft fields through validation or cancelled signing. Design cost-loading, changed cost, pending, setup error and successful creation.

### Judge

- Put Run demo on the first screen with a visible simulated label. During the run show the current phase, elapsed time and sealed bid stream, then one clearing line with the same price for known bots and people. Keep the void bid and its consequence in the outcome, with a real results link.
- Cover idle, running, failed/retry, completed/run again, and unavailable in NEAR mode. The flow should be understandable with motion off and reachable without a wallet.

### Arena and How

- Arena opens with the mechanism comparison and its modeled outcome. Keep controls for seed and demand next to the run they affect, add keyboard-readable values and an accessible results table, and keep assumptions within reach. Use calm gridlines, direct labels and consistent series treatment. Retain replay and its simulated status.
- How uses an editorial reading column, an anchor index, and a worked example that remains legible on a phone. Explain what is public, the clearing rule, fallback, trust assumptions and failure cases. Give each diagram a text equivalent. Use only one mechanism illustration near the start.

## Coordination and delivery

| Owner | Work |
| --- | --- |
| Claude | Choose the visual direction and own implementation in `apps/web/src/app/**`, `apps/web/src/components/**`, and `apps/web/UI-DIRECTION.md`. Use `UI-AUDIT.md` and this plan as references. |
| Codex | Prepared this reference and transferred the redesign to Claude in `WORKBOARD.md`. |

1. Reconcile the audit with the proposed tokens and pick the direction. Keep one shared token source and one component API for each control.
2. Build shell and primitives, then integrate the home, active sale and result in React as the first review slice. Include desktop and phone layouts and use actual mock data.
3. Apply the same system to Create, Judge, Arena and How.
4. Review one full batch on the existing dev server at 375, 768 and 1440px. Check 320px for critical money actions and long account IDs. Inspect loading, errors, phases and wallet states alongside happy paths. Confirm keyboard order, focus containment and return, reduced motion, touch targets, 4.5:1 normal text contrast, 3:1 required control boundaries, and no page overflow. Check hover and focus against actual composited surfaces.
5. Exercise mock Home → Judge → Result, Home → Sale → Bid → Result → Claim and Create → Review. Exercise close, reveal, refund, wallet fallback and unknown submission with existing fixtures or a local sandbox where applicable. Run web lint, TypeScript and existing tests. Coordinate a separate build window if the shared Next dev server is active.

Keep protocol and client behavior behind the existing interfaces. The design gate is a working React slice with a buyer's next action, exact amounts and environment legible before the artwork.
