import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RANDOM_CASES, VECTORS_PATH, buildVectors, renderVectors, type ClearingVector } from "../scripts/vector-cases";

const vectors = buildVectors();

describe("parity vectors (crates/clearing/tests/vectors.json)", () => {
  it("are up to date; regenerate with: pnpm --filter @fairground/clearing vectors", () => {
    // Normalise line endings so a CRLF checkout still compares equal.
    const onDisk = readFileSync(VECTORS_PATH, "utf8").replace(/\r\n/g, "\n");
    expect(onDisk === renderVectors(vectors), "vectors.json is stale").toBe(true);
  });

  it("cover what the Rust port must match", () => {
    const random = vectors.clearing.filter((v) => v.name.startsWith("random "));
    expect(random.length).toBe(RANDOM_CASES);
    expect(RANDOM_CASES).toBeGreaterThanOrEqual(300);

    const settled = vectors.clearing.filter((v) => v.result?.status === "settled");
    const fills = vectors.clearing.flatMap((v) => (v.result?.fills ?? []) as unknown[][]);
    const reasons = new Set(fills.map((f) => f[7]));
    for (const reason of ["decrypt_failed", "bidder_mismatch", "zero_spend", "spend_above_deposit", "price_below_floor"]) {
      expect(reasons.has(reason), reason).toBe(true);
    }
    const failReasons = new Set(vectors.clearing.map((v) => v.result?.fail_reason));
    expect(failReasons.has("below_min_raise")).toBe(true);
    expect(failReasons.has("no_valid_bids")).toBe(true);
    expect(settled.some((v) => v.result!.oversubscribed)).toBe(true);
    expect(settled.some((v) => !v.result!.oversubscribed)).toBe(true);
    expect(settled.some(hasTieAtClearingPrice)).toBe(true);

    for (const d of [0, 6, 18, 24]) {
      expect(settled.filter((v) => v.params.decimals === d).length, `decimals ${d}`).toBeGreaterThan(10);
    }
    expect(settled.some((v) => BigInt(v.params.sale_supply as string) >= 10n ** 30n)).toBe(true);
    expect(settled.some((v) => v.params.max_price === null)).toBe(true);
    expect(settled.some(ceilingClamps)).toBe(true);

    const errors = new Set(vectors.clearing.map((v) => v.error).filter(Boolean));
    for (const code of ["sale_supply_not_positive", "floor_price_not_positive", "decimals_out_of_range", "ceiling_below_floor", "overflow"]) {
      expect(errors.has(code), code).toBe(true);
    }

    const failedChecks = new Set(vectors.checks.flatMap((c) => (c as { failed: string[] }).failed));
    for (const check of ["price_at_least_floor", "price_at_most_ceiling", "sold_at_most_supply", "one_fill_per_bid", "raise_sums_fills", "raise_at_least_min"]) {
      expect(failedChecks.has(check), check).toBe(true);
    }
  });
});

/** The bid's max price after the ceiling, or null if it did not decrypt. */
function clampedPrice(v: ClearingVector, bid: unknown[]): bigint | null {
  if (bid[2] === null) return null;
  const price = BigInt(bid[2] as string);
  const ceiling = v.params.max_price === null ? null : BigInt(v.params.max_price as string);
  return ceiling !== null && price > ceiling ? ceiling : price;
}

function hasTieAtClearingPrice(v: ClearingVector): boolean {
  if (!v.result!.oversubscribed) return false;
  const price = BigInt(v.result!.clearing_price as string);
  const fills = v.result!.fills as unknown[][];
  return v.bids.filter((b, i) => fills[i][6] === true && clampedPrice(v, b) === price).length >= 2;
}

function ceilingClamps(v: ClearingVector): boolean {
  return v.params.max_price !== null && v.bids.some((b) => b[2] !== null && BigInt(b[2] as string) > BigInt(v.params.max_price as string));
}
