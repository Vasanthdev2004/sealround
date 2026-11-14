/**
 * The token's own supply (near/token-supply.ts) next to the sale's views, and
 * the creator payout row (views.ts `payoutNote`). The fixtures are the views
 * of testnet sale nosnipe-11140458 on sealround.itzbeast.testnet as read on
 * 14 Nov 2026 (icon and description left out): it sold out, seeded Rhea pool
 * 2971 and burned nothing, and its token's ft_total_supply was the 20,000
 * NOSNIPE minted.
 */
import { describe, expect, it } from "vitest";
import { supplyLedger, type SupplyLedger } from "@/components/result/supply";
import { readTokenSupply, supplyFigure, supplyFromView, supplyReading } from "../near/token-supply";
import { eventsFromViews, payoutNote, resultFromViews, saleFromView, type ResultView, type SaleView } from "../near/views";

const ONE = 10n ** 18n;
const T = (n: number | bigint) => BigInt(n) * ONE;

const SALE_VIEW: SaleView = {
  sale_id: "nosnipe-11140458",
  status: "settled",
  creator: "itzbeast.testnet",
  token: "nosnipe-11140458.sealround.itzbeast.testnet",
  quote_token: "usdc.fakes.testnet",
  token_name: "No Snipe",
  token_symbol: "NOSNIPE",
  decimals: 18,
  icon: null,
  description: null,
  website: null,
  total_supply: "20000000000000000000000",
  sale_supply: "10000000000000000000000",
  creator_allocation: "8000000000000000000000",
  floor_price: "1000",
  max_price: null,
  min_raise: "5000000",
  bid_start: "1794632661768000000",
  bid_end: "1794633261768000000",
  min_deposit: "1000000",
  max_deposit_per_account: "10000000",
  max_bids: 8,
  reveal_mode: "Tee",
  reveal_window: null,
  reveal_end: null,
  settle_timeout: "3600000000000",
  refund_mode_at: null,
  unsold_rule: "Burn",
  sealer_code_hash: "f8408a875ec685394d00937cfc320c8b5e8c2a1e8398cfdf34987aa91001d8cb",
  sealer_pubkey: "e7fabf8dc3308c503fcceff06d7fed4da8b9762ef9b8c465adff82181a2d8a19",
  token_setup: "done",
  sealer_key_setup: "done",
  key_request_block: 277611314,
  created_at: "1794632391780591868",
  closed_at: "1794633342200302613",
  bid_count: 6,
  total_deposits: "30000000",
  bid_set_hash: "c2946fae413cb2592a2d8f7986a7255bbfd55ea7e34a8782facbe1a560f20943",
  liquidity: { dex: "ref-finance-101.testnet", raise_share_bps: 2000, pool_tokens: "2000000000000000000000", fee_bps: 30 },
};

const RESULT_VIEW: ResultView = {
  sale_id: "nosnipe-11140458",
  status: "settled",
  fail_reason: null,
  clearing_price: "2000",
  total_sold: "10000000000000000000000",
  total_raised: "20000000",
  unsold: "0",
  n_valid: 5,
  n_invalid: 1,
  n_winners: 4,
  failed_checks: [],
  failed_checks_total: 0,
  result_sha256: "b6e3e851c2e3d3e15039b45e2f84e8047d33b5f5f269cf67d8e36ce2dc628426",
  input_sha256: "167e4ab1ae74d8665bbd41dbbd962d06d504e533f82f1e199c7b94d31dfe6339",
  clear_requests: 1,
  clear_request_block: 277612913,
  clear_attempts: 0,
  total_penalties: "50000",
  proceeds: { raise_paid: true, allocation_paid: true, unsold_burned: false, reserve_returned: true },
  liquidity: {
    status: "seeded",
    next_step: null,
    in_flight: null,
    dex: "ref-finance-101.testnet",
    pool_id: 2971,
    usdc: "4000000",
    tokens: "2000000000000000000000",
    shares: "1000000000000000000000000",
    usdc_on_dex: "0",
    tokens_on_dex: "0",
    failures: 0,
    deadline: "1794636992374810092",
  },
};

/** ft_total_supply on nosnipe-11140458.sealround.itzbeast.testnet. */
const FT_TOTAL_SUPPLY = "20000000000000000000000";

const ledgerOf = (sale: SaleView, result: ResultView): SupplyLedger => {
  const r = resultFromViews(sale, [], result, [], [], 0n);
  if (!r) throw new Error("not final");
  return supplyLedger(saleFromView(sale), r);
};

describe("ft_total_supply", () => {
  it("parses the token's answer and refuses anything that is not a u128", () => {
    expect(supplyFromView(FT_TOTAL_SUPPLY)).toBe(T(20_000));
    expect(supplyFromView("0")).toBe(0n);
    for (const bad of [20000, null, "", "-1", "1.5", "1e21", " 1", "1".repeat(40), { total: "1" }]) {
      expect(() => supplyFromView(bad)).toThrow(/ft_total_supply/);
    }
  });

  it("reads ft_total_supply on the token account, with no arguments", async () => {
    const calls: unknown[][] = [];
    const view = async (...args: unknown[]) => {
      calls.push(args);
      return FT_TOTAL_SUPPLY;
    };
    expect(await readTokenSupply({ view } as never, SALE_VIEW.token)).toBe(T(20_000));
    expect(calls).toEqual([["nosnipe-11140458.sealround.itzbeast.testnet", "ft_total_supply"]]);
  });
});

describe("the token's supply next to the sale's views", () => {
  it("testnet nosnipe-11140458: sold out, nothing burned, the token holds what was minted", () => {
    const l = ledgerOf(SALE_VIEW, RESULT_VIEW);
    expect(l).toMatchObject({ total: T(20_000), sold: T(10_000), pool: T(2_000), creator: T(8_000), burn: 0n, gap: 0n, burnState: "none" });
    expect(supplyReading(l, supplyFromView(FT_TOTAL_SUPPLY))).toEqual({
      now: T(20_000),
      burnedSoFar: 0n,
      saleBurned: 0n,
      holderBurned: 0n,
      excess: 0n,
    });
  });

  it("counts a holder's burn after launch that the sale's views cannot see", () => {
    const l = ledgerOf(SALE_VIEW, RESULT_VIEW);
    const r = supplyReading(l, T(20_000) - 1234n);
    expect(r).toMatchObject({ burnedSoFar: 1234n, saleBurned: 0n, holderBurned: 1234n, excess: 0n });
  });

  // An undersold sale: 3,000 of the 10,000 for sale sold, so 7,000 plus the pool's spare reserve burn at the payout.
  const undersold = (proceeds: Partial<ResultView["proceeds"]>): SupplyLedger =>
    ledgerOf(SALE_VIEW, {
      ...RESULT_VIEW,
      clearing_price: "1000",
      total_sold: T(3_000).toString(),
      total_raised: "3000000",
      unsold: T(7_000 + 1_400).toString(),
      proceeds: { ...RESULT_VIEW.proceeds, ...proceeds },
      liquidity: { ...RESULT_VIEW.liquidity!, usdc: "600000", tokens: T(600).toString() },
    });

  it("an owed burn: the token still holds it all, and any drop is a holder's burn", () => {
    const l = undersold({ unsold_burned: false });
    expect(l.burnState).toBe("owed");
    expect(supplyReading(l, T(20_000))).toMatchObject({ burnedSoFar: 0n, saleBurned: 0n, holderBurned: 0n, excess: 0n });
    expect(supplyReading(l, T(19_999))).toMatchObject({ burnedSoFar: T(1), holderBurned: T(1) });
  });

  it("a landed burn: the token's drop is the sale's burn, and anything past it a holder's", () => {
    const l = undersold({ unsold_burned: true });
    expect(l.burnState).toBe("burned");
    expect(supplyReading(l, T(20_000 - 8_400))).toMatchObject({ burnedSoFar: T(8_400), saleBurned: T(8_400), holderBurned: 0n, excess: 0n });
    expect(supplyReading(l, T(20_000 - 8_400 - 5))).toMatchObject({ saleBurned: T(8_400), holderBurned: T(5) });
  });

  it("flags a token that holds more than the views allow, and splits nothing then", () => {
    const l = undersold({ unsold_burned: true });
    const r = supplyReading(l, T(20_000));
    expect(r).toMatchObject({ burnedSoFar: 0n, excess: T(8_400), holderBurned: null });
    // A supply above the minted total (the token has no mint method, so a wrong token account) is flagged too.
    expect(supplyReading(ledgerOf(SALE_VIEW, RESULT_VIEW), T(20_001)).excess).toBe(T(1));
  });

  it("a burn the views cannot size (abandoned pool after an earlier payout): only the total since launch", () => {
    const l = ledgerOf(SALE_VIEW, {
      ...RESULT_VIEW,
      unsold: T(2_000).toString(),
      proceeds: { raise_paid: true, allocation_paid: true, unsold_burned: false, reserve_returned: true },
      liquidity: { ...RESULT_VIEW.liquidity!, status: "abandoned", pool_id: null, shares: "0" },
    });
    expect(l.burnState).toBe("partial");
    expect(l.supplyNow).toBeNull();
    expect(supplyReading(l, T(19_000))).toEqual({ now: T(19_000), burnedSoFar: T(1_000), saleBurned: null, holderBurned: null, excess: 0n });
  });

  it("the token page's supply figure takes the reading when there is one", () => {
    const fallback = { label: "Supply after the burn", value: T(11_600) };
    expect(supplyFigure(fallback, undefined)).toBe(fallback);
    expect(supplyFigure(fallback, null)).toBe(fallback);
    expect(supplyFigure(fallback, T(19_000))).toEqual({ label: "Supply now", value: T(19_000) });
  });
});

describe("the creator payout row", () => {
  it("testnet nosnipe-11140458: names the raise and the allocation, and no burn on a sale that sold out", () => {
    const row = eventsFromViews(SALE_VIEW, [], RESULT_VIEW, []).find((e) => e.detail === "proceeds_claimed");
    // 20 USDC raised less the pool's 4.
    expect(row).toMatchObject({ amount: 16_000_000n, account: "itzbeast.testnet" });
    expect(row?.note).toBe("Creator paid: 16 USDC raised and the creator allocation.");
    expect(row?.note).not.toMatch(/burn/i);
  });

  it("names the burn only when one landed, with its amount", () => {
    const result = { ...RESULT_VIEW, unsold: T(8_400).toString(), proceeds: { ...RESULT_VIEW.proceeds, unsold_burned: true } };
    expect(payoutNote(SALE_VIEW, result, 2_400_000n)).toBe("Creator paid: 2.4 USDC raised and the creator allocation. 8,400 NOSNIPE burned.");
  });

  it("says the allocation waits while the pool is seeded, and leaves out an allocation the sale never had", () => {
    const seeding = {
      ...RESULT_VIEW,
      proceeds: { raise_paid: true, allocation_paid: false, unsold_burned: false, reserve_returned: true },
      liquidity: { ...RESULT_VIEW.liquidity!, status: "seeding" as const },
    };
    expect(payoutNote(SALE_VIEW, seeding, 16_000_000n)).toBe(
      "Creator paid: 16 USDC raised. The creator allocation unlocks once the launch pool is seeded.",
    );
    const allForSale = { ...SALE_VIEW, creator_allocation: "0" };
    expect(payoutNote(allForSale, RESULT_VIEW, 16_000_000n)).toBe("Creator paid: 16 USDC raised.");
  });

  it("a failed sale: the allocation and the burn, or only the NEAR reserve", () => {
    const failed = {
      ...RESULT_VIEW,
      status: "failed" as const,
      total_raised: "0",
      unsold: T(10_000).toString(),
      proceeds: { raise_paid: false, allocation_paid: true, unsold_burned: true, reserve_returned: true },
      liquidity: null,
    };
    expect(payoutNote(SALE_VIEW, failed, 0n)).toBe("Creator paid: the creator allocation. 10,000 NOSNIPE burned.");
    const reserveOnly = { ...failed, proceeds: { raise_paid: false, allocation_paid: false, unsold_burned: false, reserve_returned: true } };
    expect(payoutNote(SALE_VIEW, reserveOnly, 0n)).toBe("Creator payout: the unused NEAR reserve returned.");
  });
});
