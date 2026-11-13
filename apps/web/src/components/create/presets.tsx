"use client";

import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import type { NearNetwork } from "@/lib/config";
import { networkName } from "@/lib/format";
import { DURATION_PRESETS, type Draft, type DurationPreset, type FieldKey } from "./model";

/**
 * One-click launch presets for /create. Each fills the sale's numbers (supply,
 * allocation, price, window, limits, launch pool) and leaves the token's name,
 * symbol, icon and description alone.
 *
 * The numbers were picked by running the creator simulator (@fairground/arena
 * `simulateCreatorLevel`, the crowd behind "Simulate this launch") at 0.5×, 1×,
 * 2× and 4× demand with its default crowd of 200 people and 5 bots;
 * presets.test.ts holds each preset to the behaviour its name promises.
 *
 * Every sale made with this form has 100 bid slots (`BID_SLOTS`), and the
 * crowd has more people who want to bid than that. Whoever finds the slots
 * full can only buy after the sale, partly from bots, which is where the
 * simulated bots' small after-sale profit comes from. The levers left to a
 * preset are the minimum deposit (who takes a slot) and the per-account cap
 * (how much a slot, and so a bot, can buy).
 */

export type PresetId = "fair" | "pool" | "burn";

/** The draft fields a preset sets, apart from the bid window. */
type PresetValues = Pick<
  Draft,
  | "totalSupply"
  | "saleSupply"
  | "creatorAllocation"
  | "floor"
  | "ceilingOn"
  | "minRaise"
  | "minDeposit"
  | "maxDeposit"
  | "poolOn"
> &
  Partial<Pick<Draft, "poolShare" | "poolFee">>;

export type Preset = {
  id: PresetId;
  title: string;
  /** What it does, in one plain line. */
  line: string;
  /** Needs a contract that takes launch liquidity. */
  pool: boolean;
  values: PresetValues;
  /** The bid window on mainnet. Test networks use the testnet-only length (see `presetWindow`). */
  window: DurationPreset;
};

export const PRESETS: readonly Preset[] = [
  {
    // 900,000 for sale at 0.001 USDC (900 USDC at the floor), no pool, 10 % to the creator and
    // nothing left over. Settles at every demand level; about 57 % burns at 0.5×, 23 % at 1×,
    // none from 2×.
    // Slots and cap: a 2 USDC minimum keeps 1 USDC dust bids out of the 100 slots, and the
    // 25 USDC cap holds any account, bots included, to 2.8 % of the sale.
    id: "fair",
    title: "Pure fair launch",
    line: "No pool. A low floor and min raise, and at most 25 USDC per account. Unsold tokens are burned.",
    pool: false,
    values: {
      totalSupply: "1,000,000",
      saleSupply: "900,000",
      creatorAllocation: "100,000",
      floor: "0.001",
      ceilingOn: false,
      minRaise: "100",
      minDeposit: "2",
      maxDeposit: "25",
      poolOn: false,
    },
    window: "1440",
  },
  {
    // 750,000 for sale at 0.001 USDC, 150,000 reserved for the pool (20 % of 750,000: exactly
    // what a sell-out needs, so nothing is short or left over), 100,000 to the creator.
    // Settles at every level and the pool opens at the clearing price each time.
    // Slots and cap: the same 2 USDC minimum and 25 USDC cap as Pure fair launch. People who
    // find the slots full buy from the pool at the clearing price instead of from bots.
    id: "pool",
    title: "Pool first",
    line: "20 % of the raise and a token reserve open a Rhea pool at the clearing price, so the token can trade right after the sale.",
    pool: true,
    values: {
      totalSupply: "1,000,000",
      saleSupply: "750,000",
      creatorAllocation: "100,000",
      floor: "0.001",
      ceilingOn: false,
      minRaise: "150",
      minDeposit: "2",
      maxDeposit: "25",
      poolOn: true,
      poolShare: "20",
      poolFee: "30",
    },
    window: "360",
  },
  {
    // 900,000 for sale at 0.002 USDC (1,800 USDC at the floor) with a 900 USDC min raise: half
    // of a sell-out at the floor. Fails, and so burns the whole sale supply, at 0.5×; about
    // 32 % burns at 1× and 11 % at 2×; sells out at 4×.
    // Slots and cap: a 5 USDC minimum makes filling the 100 slots with junk bids cost 500 USDC
    // held and 5 USDC lost; the 25 USDC cap (1.4 % of the sale) leaves bots little to resell.
    id: "burn",
    title: "Community burn",
    line: "A higher floor and min raise. Weak demand burns most or all of the tokens for sale; strong demand sells out.",
    pool: false,
    values: {
      totalSupply: "1,000,000",
      saleSupply: "900,000",
      creatorAllocation: "100,000",
      floor: "0.002",
      ceilingOn: false,
      minRaise: "900",
      minDeposit: "5",
      maxDeposit: "25",
      poolOn: false,
    },
    window: "1440",
  },
];

/** Every draft field a preset can set: what Undo puts back. */
export const PRESET_KEYS: readonly (keyof Draft)[] = [
  "totalSupply",
  "saleSupply",
  "creatorAllocation",
  "floor",
  "ceilingOn",
  "minRaise",
  "duration",
  "minDeposit",
  "maxDeposit",
  "poolOn",
  "poolShare",
  "poolFee",
];

/**
 * The bid window a preset uses: its own on mainnet; elsewhere (testnet, the
 * mock, a sandbox) the testnet-only length, so a demo sale closes in minutes.
 */
export function presetWindow(p: Preset, network: NearNetwork): DurationPreset {
  if (network === "mainnet") return p.window;
  return DURATION_PRESETS.find((d) => d.testnet)?.value ?? p.window;
}

/** The draft fields picking `p` sets on `network`. */
export function presetDraft(p: Preset, network: NearNetwork): Partial<Draft> {
  return { ...p.values, duration: presetWindow(p, network) };
}

/** The fields whose errors show once the preset has filled them. */
export function presetFields(p: Preset): FieldKey[] {
  const keys: FieldKey[] = [
    "totalSupply",
    "saleSupply",
    "creatorAllocation",
    "floor",
    "ceiling",
    "minRaise",
    "minDeposit",
    "maxDeposit",
  ];
  return p.values.poolOn ? [...keys, "poolShare", "poolTokens"] : keys;
}

/** The same value as typed: digit groups and spaces do not count. */
const norm = (v: unknown) => (typeof v === "string" ? v.replace(/[,_\s]/g, "") : v);

/**
 * The preset the draft holds right now, or null (Custom). A pool's share and
 * fee count only when the preset has a pool.
 */
export function matchPreset(d: Draft, network: NearNetwork, presets: readonly Preset[] = PRESETS): PresetId | null {
  const found = presets.find((p) =>
    Object.entries(presetDraft(p, network)).every(([k, v]) => norm(d[k as keyof Draft]) === norm(v)),
  );
  return found?.id ?? null;
}

const pickKeys = (d: Draft): Partial<Draft> =>
  Object.fromEntries(PRESET_KEYS.map((k) => [k, d[k]])) as Partial<Draft>;

/**
 * The preset picker at the top of the form: three choice cards in a radio
 * group. Picking one fills the fields it covers through `onApply` (which also
 * marks them touched); editing any of those fields afterwards leaves no card
 * selected and the header says Custom. Undo puts back the values from before
 * the first preset picked over them.
 */
export function PresetPicker({
  draft,
  poolAvailable,
  onApply,
}: {
  draft: Draft;
  /** The contract takes launch liquidity (or the answer has not arrived yet). */
  poolAvailable: boolean;
  onApply: (values: Partial<Draft>, fields: FieldKey[]) => void;
}) {
  const headId = useId();
  const noteId = useId();
  const network = networkName();
  const presets = PRESETS.filter((p) => !p.pool || poolAvailable);
  const current = matchPreset(draft, network, presets);
  // The values a preset replaced, while a preset is still what the form holds.
  const [saved, setSaved] = useState<Partial<Draft> | null>(null);
  const groupRef = useRef<HTMLDivElement>(null);

  const pick = (p: Preset) => {
    if (p.id === current) return;
    if (current === null) setSaved(pickKeys(draft));
    onApply(presetDraft(p, network), presetFields(p));
  };
  const undo = () => {
    if (saved) onApply(saved, []);
    setSaved(null);
    // The button goes away with the preset: keep the keyboard in the picker.
    window.setTimeout(() => groupRef.current?.querySelector<HTMLElement>("[role=radio][tabindex=\"0\"]")?.focus(), 0);
  };

  // Arrow keys move the choice and the focus together, as in Segmented.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step =
      e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const radios = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')];
    const at = radios.indexOf(document.activeElement as HTMLElement);
    const from = at >= 0 ? at : Math.max(0, presets.findIndex((p) => p.id === current));
    const next = (from + step + presets.length) % presets.length;
    pick(presets[next]);
    radios[next]?.focus();
  };

  return (
    <section aria-labelledby={headId} className="flex flex-col gap-3">
      {/* Fixed height: the Undo button and the Custom label swap without moving the cards. */}
      <div className="flex h-8 items-center gap-3">
        <h2 id={headId} className="min-w-0 flex-1 text-h3 text-fg">
          Start from a preset
        </h2>
        {current === null ? (
          <span id={`${headId}-custom`} className="shrink-0 text-label text-subtle">
            Custom
          </span>
        ) : (
          saved && (
            <Button type="button" variant="ghost" size="sm" className="-mr-3 shrink-0 max-sm:h-10" onClick={undo}>
              Undo
            </Button>
          )
        )}
      </div>

      <div
        ref={groupRef}
        role="radiogroup"
        aria-labelledby={headId}
        aria-describedby={current === null ? `${headId}-custom ${noteId}` : noteId}
        onKeyDown={onKeyDown}
        className="grid gap-2 md:grid-cols-3"
      >
        {presets.map((p, i) => {
          const selected = p.id === current;
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-labelledby={`${headId}-${p.id}`}
              aria-describedby={`${headId}-${p.id}-line`}
              // With no preset chosen the first card takes the tab stop.
              tabIndex={selected || (current === null && i === 0) ? 0 : -1}
              onClick={() => pick(p)}
              className={cn(
                "flex w-full flex-col items-start gap-1 rounded-tile border p-3.5 text-left transition-[background-color,border-color] duration-[120ms] ease-surface",
                selected ? "border-accent/40 bg-accent-soft" : "border-line hover:bg-wash",
              )}
            >
              <span className="flex w-full items-center gap-2.5">
                <span
                  aria-hidden
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded-full border",
                    selected ? "border-accent" : "border-line-strong",
                  )}
                >
                  {selected && <span className="size-2 rounded-full bg-accent" />}
                </span>
                <span id={`${headId}-${p.id}`} className="text-h3 text-fg">
                  {p.title}
                </span>
              </span>
              <span id={`${headId}-${p.id}-line`} className="pl-[26px] text-small text-muted">
                {p.line}
              </span>
            </button>
          );
        })}
      </div>

      <p id={noteId} className="text-label text-subtle">
        Fills in the numbers below. Name, symbol, icon and description stay as you set them.
      </p>
    </section>
  );
}
