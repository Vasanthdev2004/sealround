import { describe, expect, it } from "vitest";
import { CREATOR_SEEDS, simulateCreatorLevel, type CreatorLevel, type CreatorRules } from "@fairground/arena";
import { validateConfig } from "@/lib/client/mock";
import { MAX_POOL_FEE_BPS, MAX_RAISE_SHARE_BPS } from "@/lib/liquidity";
import {
  CREATOR_WARN_BPS,
  DEFAULT_DRAFT,
  DURATION_PRESETS,
  buildConfig,
  derive,
  type Draft,
} from "./model";
import { PRESETS, PRESET_KEYS, matchPreset, presetDraft, presetFields, type PresetId } from "./presets";
import { simRules } from "./use-launch-sim";

const USDC = "usdc.fakes.testnet";
const DEX = "ref-finance-101.testnet";
const preset = (id: PresetId) => PRESETS.find((p) => p.id === id)!;
/** The form after picking `id` over the defaults, with a name and symbol typed in. */
const draftOf = (id: PresetId, network: "testnet" | "mainnet" = "testnet"): Draft => ({
  ...DEFAULT_DRAFT,
  name: "Lantern",
  symbol: "LNTRN",
  ...presetDraft(preset(id), network),
});
const derived = (d: Draft) => derive(d, new Set(), null, { pool: true });

describe("launch presets: valid sales", () => {
  for (const p of PRESETS) {
    for (const network of ["testnet", "mainnet"] as const) {
      it(`${p.title} on ${network}: no errors, no warnings, and the contract's rules accept it`, () => {
        const d = draftOf(p.id, network);
        const r = derived(d);
        expect(r.errors).toEqual({});
        expect(r.notices.filter((n) => n.tone !== "neutral")).toEqual([]);
        expect(r.shares!.creator).toBeLessThanOrEqual(CREATOR_WARN_BPS);
        const now = Date.now();
        const config = buildConfig(d, r.ready!, now, USDC, DEX);
        expect(() => validateConfig(config)).not.toThrow();
        if (p.pool) {
          const l = config.liquidity!;
          expect(l.raiseShareBps).toBeGreaterThanOrEqual(1);
          expect(l.raiseShareBps).toBeLessThanOrEqual(MAX_RAISE_SHARE_BPS);
          expect(l.feeBps).toBeGreaterThanOrEqual(1);
          expect(l.feeBps).toBeLessThanOrEqual(MAX_POOL_FEE_BPS);
          // The reserve is exactly what a sell-out fills: no "pool-short" or "pool-burn" notice.
          expect(r.pool!.reserve).toBe(r.pool!.sellOut);
          expect(r.notices.map((n) => n.id)).not.toContain("pool-short");
          expect(r.notices.map((n) => n.id)).not.toContain("pool-burn");
        } else {
          expect(config.liquidity).toBeUndefined();
        }
      });
    }
  }

  it("uses the testnet-only window off mainnet and a real one on mainnet", () => {
    const testnetOnly = DURATION_PRESETS.filter((d) => d.testnet).map((d) => d.value);
    for (const p of PRESETS) {
      expect(testnetOnly).toContain(presetDraft(p, "testnet").duration);
      expect(testnetOnly).toContain(presetDraft(p, "sandbox").duration);
      expect(testnetOnly).not.toContain(presetDraft(p, "mainnet").duration);
      expect(presetDraft(p, "mainnet").duration).not.toBe("custom");
    }
  });

  it("never sets the token's name, symbol, icon or description", () => {
    const own: (keyof Draft)[] = ["name", "symbol", "description", "hue", "iconMode", "mark", "iconUpload"];
    for (const p of PRESETS) {
      for (const network of ["testnet", "mainnet"] as const) {
        const keys = Object.keys(presetDraft(p, network)) as (keyof Draft)[];
        expect(keys.filter((k) => own.includes(k))).toEqual([]);
        // Undo puts back everything a preset can change.
        expect(keys.filter((k) => !PRESET_KEYS.includes(k))).toEqual([]);
      }
    }
  });

  it("marks the fields it fills, the pool's only with a pool", () => {
    expect(presetFields(preset("fair"))).not.toContain("poolShare");
    expect(presetFields(preset("pool"))).toEqual(expect.arrayContaining(["poolShare", "poolTokens", "saleSupply"]));
  });
});

describe("matchPreset: the picker's choice follows the form", () => {
  it("is Custom for the defaults", () => {
    expect(matchPreset({ ...DEFAULT_DRAFT }, "testnet")).toBeNull();
  });

  it("finds the preset just picked, on either network", () => {
    for (const p of PRESETS) {
      expect(matchPreset(draftOf(p.id, "testnet"), "testnet")).toBe(p.id);
      expect(matchPreset(draftOf(p.id, "mainnet"), "mainnet")).toBe(p.id);
      // A testnet window is not the mainnet preset.
      expect(matchPreset(draftOf(p.id, "testnet"), "mainnet")).toBeNull();
    }
  });

  it("turns to Custom when a field it covers changes, not when the token's own fields do", () => {
    const d = draftOf("burn");
    expect(matchPreset({ ...d, name: "Other", symbol: "OTHR", description: "x" }, "testnet")).toBe("burn");
    expect(matchPreset({ ...d, minRaise: "901" }, "testnet")).toBeNull();
    expect(matchPreset({ ...d, duration: "30" }, "testnet")).toBeNull();
    expect(matchPreset({ ...d, ceilingOn: true }, "testnet")).toBeNull();
    // Digit groups as typed, before the field regroups them on blur.
    expect(matchPreset({ ...d, saleSupply: "900000" }, "testnet")).toBe("burn");
    const pool = draftOf("pool");
    expect(matchPreset({ ...pool, poolFee: "100" }, "testnet")).toBeNull();
    expect(matchPreset({ ...pool, poolOn: false }, "testnet")).toBeNull();
  });

  it("ignores Pool first when the contract takes no launch pool", () => {
    const others = PRESETS.filter((p) => !p.pool);
    expect(matchPreset(draftOf("pool"), "testnet", others)).toBeNull();
    expect(matchPreset(draftOf("fair"), "testnet", others)).toBe("fair");
  });
});

/**
 * What the simulator says each preset does, with the "Simulate this launch"
 * defaults: 200 people and 5 bots per crowd, the same 5 crowds at each level.
 */
describe("launch presets: simulated behaviour at 0.5×, 1×, 2× and 4× demand", () => {
  const LEVELS = [0.5, 1, 2, 4] as const;
  const sweep = (id: PresetId) => {
    const rules = simRules(derived(draftOf(id)))!;
    expect(rules).not.toBeNull();
    const levels = LEVELS.map((demand) => simulateCreatorLevel(rules, demand, { humans: 200 }));
    return { rules, at: (demand: (typeof LEVELS)[number]) => levels[LEVELS.indexOf(demand)] };
  };
  /** Share of the sale supply burned, 0 to 1. */
  const burnt = (l: CreatorLevel, r: CreatorRules) => Number((l.burned * 10_000n) / r.supply) / 10_000;
  const fair = sweep("fair");
  const pool = sweep("pool");
  const burn = sweep("burn");

  it("Pure fair launch settles at every level, burns less as demand grows and sells out above the floor", () => {
    const { at, rules } = fair;
    for (const d of LEVELS) expect(at(d).settled).toBe(CREATOR_SEEDS);
    expect(burnt(at(0.5), rules)).toBeGreaterThan(burnt(at(1), rules));
    expect(burnt(at(1), rules)).toBeGreaterThan(burnt(at(2), rules));
    expect(burnt(at(2), rules)).toBeLessThan(0.05);
    expect(at(4).burned).toBe(0n);
    expect(at(4).clearingPrice!).toBeGreaterThan(rules.floor);
    expect(rules.pool).toBeNull();
  });

  it("Pool first opens its pool at the clearing price at every level", () => {
    const { at, rules } = pool;
    expect(rules.pool).not.toBeNull();
    for (const d of LEVELS) {
      const l = at(d);
      expect(l.settled).toBe(CREATOR_SEEDS);
      for (const run of l.runs) {
        expect(run.pool).not.toBeNull();
        expect(run.poolPrice).toBe(run.clearingPrice);
      }
    }
    // The reserve covers a sell-out exactly: none of it is burned once every token sells.
    expect(at(2).burned).toBe(0n);
    expect(at(2).reserveBurned).toBe(0n);
    expect(at(4).reserveBurned).toBe(0n);
  });

  it("Community burn fails on weak demand, burns more than Pure fair and still sells out at 4×", () => {
    const { at, rules } = burn;
    // 0.5×: no crowd meets the min raise, so every bid is refunded and the whole sale supply burns.
    expect(at(0.5).settled).toBe(0);
    expect(at(0.5).burned).toBe(rules.supply);
    expect(at(1).settled).toBe(CREATOR_SEEDS);
    for (const d of [0.5, 1, 2] as const) {
      expect(burnt(at(d), rules)).toBeGreaterThan(burnt(fair.at(d), fair.rules));
    }
    expect(burnt(at(1), rules)).toBeGreaterThan(burnt(fair.at(1), fair.rules) + 0.05);
    // Steep: from all of it at 0.5× to none at 4×, still falling between 1× and 2×.
    expect(burnt(at(1), rules)).toBeGreaterThan(burnt(at(2), rules));
    expect(at(4).burned).toBe(0n);
    expect(burnt(at(0.5), rules) - burnt(at(2), rules)).toBeGreaterThan(0.8);
  });

  it("keeps bots' after-sale profit small next to the raise", () => {
    for (const { at } of [fair, pool, burn]) {
      for (const d of LEVELS) {
        const l = at(d);
        const raised = Number(l.raised) / 1e6;
        expect(l.botProfit).toBeLessThanOrEqual(Math.max(1, raised * 0.03));
      }
    }
  });
});
