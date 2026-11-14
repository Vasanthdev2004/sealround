/**
 * The token page's share card and title: the mapping from the contract's
 * views, the fall back to the sale's card before settlement, and the image
 * route's fall back to the generic card.
 */
import { describe, expect, it, vi } from "vitest";
import type { ResultView, SaleView } from "../near/views";
import type { SaleCardViews } from "./sale-data";
import { tokenCard, tokenMeta } from "./token-card";
import { tokenImage } from "./token-image";

const E18 = 10n ** 18n;

const SALE: SaleView = {
  sale_id: "lantern",
  status: "settled",
  creator: "alice.testnet",
  token: "lantern.fairground.testnet",
  quote_token: "usdc.fakes.testnet",
  token_name: "Lantern Network",
  token_symbol: "LNTN",
  decimals: 18,
  icon: null,
  description: null,
  website: null,
  total_supply: (1_000_000n * E18).toString(),
  sale_supply: (100_000n * E18).toString(),
  creator_allocation: (900_000n * E18).toString(),
  floor_price: "1000",
  max_price: null,
  min_raise: "50000000",
  bid_start: "1",
  bid_end: "2",
  min_deposit: "1000000",
  max_deposit_per_account: "10000000",
  max_bids: 100,
  reveal_mode: "Tee",
  reveal_window: null,
  reveal_end: null,
  settle_timeout: "1",
  refund_mode_at: null,
  unsold_rule: "Burn",
  sealer_code_hash: "f8408a87",
  sealer_pubkey: null,
  token_setup: "done",
  sealer_key_setup: "done",
  created_at: "1",
  closed_at: "2",
  bid_count: 54,
  total_deposits: "300000000",
  bid_set_hash: "",
};

const RESULT: ResultView = {
  sale_id: "lantern",
  status: "settled",
  fail_reason: null,
  clearing_price: "1956",
  total_sold: (82_400n * E18).toString(),
  total_raised: "161174400",
  unsold: (17_600n * E18).toString(),
  n_valid: 52,
  n_invalid: 2,
  n_winners: 40,
  failed_checks: [],
  failed_checks_total: 0,
  result_sha256: null,
  input_sha256: null,
  clear_requests: 1,
  clear_attempts: 1,
  total_penalties: "0",
  proceeds: { raise_paid: false, allocation_paid: false, unsold_burned: true, reserve_returned: false },
};

const views = (over: Partial<SaleCardViews> = {}): SaleCardViews => ({ sale: SALE, result: RESULT, network: "testnet", ...over });

const isPng = (b: Uint8Array) => Buffer.from(b.slice(1, 4)).toString() === "PNG";
const pngSize = (b: Uint8Array) => {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { width: v.getUint32(16), height: v.getUint32(20) };
};

describe("tokenCard", () => {
  it("shows a settled sale's launch price, supply, burn, holders and raise", () => {
    const card = tokenCard(views())!;
    expect(card.name).toBe("Lantern Network");
    expect(card.phase).toBe("Launched");
    expect(card.hero).toEqual({ label: "Launch price", value: "0.001956", unit: "USDC per LNTN" });
    expect(card.lineAccent).toBe(true);
    expect(card.note).toBeNull();
    expect(card.stats).toEqual([
      { label: "Supply now", value: "982.4K", unit: "LNTN" },
      { label: "Burned", value: "17.6K", unit: "LNTN" },
      { label: "Holders at launch", value: "40" },
      { label: "Raised", value: "161.17", unit: "USDC" },
    ]);
  });

  it("says the burn is still to come before the creator payout", () => {
    const card = tokenCard(views({ result: { ...RESULT, proceeds: { ...RESULT.proceeds, unsold_burned: false } } }))!;
    expect(card.stats[0]).toEqual({ label: "Supply now", value: "1M", unit: "LNTN" });
    expect(card.stats[1].label).toBe("To burn");
  });

  it("names Rhea and the pool's opening price once the pool is seeded", () => {
    const usdc = 32_234_880n;
    const tokens = (usdc * E18) / 1956n;
    const card = tokenCard(
      views({
        sale: { ...SALE, liquidity: { dex: "ref-finance-101.testnet", raise_share_bps: 2000, pool_tokens: (20_000n * E18).toString(), fee_bps: 30 } } as SaleView,
        result: {
          ...RESULT,
          liquidity: {
            status: "seeded",
            next_step: null,
            in_flight: null,
            dex: "ref-finance-101.testnet",
            pool_id: 12,
            usdc: usdc.toString(),
            tokens: tokens.toString(),
            shares: (10n ** 24n).toString(),
            usdc_on_dex: "0",
            tokens_on_dex: "0",
            failures: 0,
            deadline: null,
          },
        },
      }),
    )!;
    expect(card.phase).toBe("Trading on Rhea");
    expect(card.note).toBe("Pool opened at 0.001956 USDC per LNTN.");
  });

  it("takes the supply from the token contract when the caller read it", () => {
    // Holders burned 12,400 more after the launch burn: ft_total_supply says 970K.
    const card = tokenCard(views(), 970_000n * E18)!;
    expect(card.stats[0]).toEqual({ label: "Supply now", value: "970K", unit: "LNTN" });
    expect(card.stats[1]).toEqual({ label: "Burned", value: "17.6K", unit: "LNTN" });
    // Before the burn landed the views can only say "after the burn"; the token says what it holds now.
    const owed = views({ result: { ...RESULT, proceeds: { ...RESULT.proceeds, unsold_burned: false } } });
    expect(tokenCard(owed, 1_000_000n * E18)!.stats[0]).toEqual({ label: "Supply now", value: "1M", unit: "LNTN" });
    expect(tokenCard(views(), null)!.stats[0]).toEqual(tokenCard(views())!.stats[0]);
  });

  it("is null before settlement, for a failed sale and without the result", () => {
    expect(tokenCard(views({ sale: { ...SALE, status: "open" } }))).toBeNull();
    expect(tokenCard(views({ sale: { ...SALE, status: "failed" }, result: { ...RESULT, status: "failed" } }))).toBeNull();
    expect(tokenCard(views({ result: null }))).toBeNull();
  });
});

describe("tokenMeta", () => {
  it("titles the page by symbol and describes the launch", () => {
    expect(tokenMeta(views())).toEqual({
      title: "$LNTN on Sealround",
      description:
        "Lantern Network launched at 0.001956 USDC per LNTN, one price for every winner. 40 holders at launch. 17.6K LNTN burned.",
    });
  });

  it("describes a failed sale and one that has not settled", () => {
    const failed = tokenMeta(views({ sale: { ...SALE, status: "failed" }, result: { ...RESULT, status: "failed" } }));
    expect(failed.description).toBe("The Lantern Network sale did not clear, so no LNTN trades. Every valid bid gets its deposit back.");
    const open = tokenMeta(views({ sale: { ...SALE, status: "open" }, result: null }));
    expect(open).toEqual({ title: "$LNTN on Sealround", description: "Lantern Network (LNTN) launches when its sealed-bid sale on Sealround settles." });
  });
});

describe("tokenImage", () => {
  const noFonts = async () => undefined;

  it("draws the token card, and the sale's card before settlement, as 1200 x 630 PNGs", async () => {
    for (const v of [views(), views({ sale: { ...SALE, status: "open" }, result: null })]) {
      const res = await tokenImage("lantern", { read: async () => v, fonts: noFonts });
      const png = new Uint8Array(await res.arrayBuffer());
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("cache-control")).toContain("s-maxage=300");
      expect(isPng(png)).toBe(true);
      expect(pngSize(png)).toEqual({ width: 1200, height: 630 });
    }
  });

  it("reads the token's supply once per drawing, and draws the card without it when that read fails", async () => {
    const seen: SaleCardViews[] = [];
    const supply = async (v: SaleCardViews) => {
      seen.push(v);
      return 970_000n * E18;
    };
    const res = await tokenImage("lantern", { read: async () => views(), fonts: noFonts, supply });
    expect(res.headers.get("cache-control")).toContain("s-maxage=300");
    expect(seen).toHaveLength(1);

    const failing = async () => {
      throw new Error("rpc down");
    };
    const fallback = await tokenImage("lantern", { read: async () => views(), fonts: noFonts, supply: failing });
    expect(fallback.headers.get("cache-control")).toContain("s-maxage=300");
    expect(isPng(new Uint8Array(await fallback.arrayBuffer()))).toBe(true);
  });

  it("falls back to the generic card when the sale cannot be read or drawn", async () => {
    const cases = [
      async () => null,
      async () => {
        throw new Error("rpc down");
      },
      async () => views({ sale: { ...SALE, total_supply: "lots" } }),
    ];
    for (const read of cases) {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const res = await tokenImage("lantern", { read, fonts: noFonts });
      const png = new Uint8Array(await res.arrayBuffer());
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).not.toContain("s-maxage");
      expect(isPng(png)).toBe(true);
      expect(pngSize(png)).toEqual({ width: 1200, height: 630 });
      warn.mockRestore();
    }
  });
});
