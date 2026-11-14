/**
 * The contract and rule checks, as pure functions over what the chain
 * publishes. No network: verify/sources.ts reads the inputs.
 *
 * What they add to the attestation checks (near/attestation.ts):
 * - the sealer pin in get_sale only means something if the sale contract is
 *   the pinned fairground.wasm and nobody holds a key that could replace it;
 * - the attestation proves which bytes the sealer returned; these checks
 *   prove the contract stored exactly those bytes' price and fills;
 * - the rules every result must obey, recomputed here from public data with
 *   the reference code in @fairground/clearing (`contractChecks`), plus two
 *   the contract does not test: unsold supply only at the floor price, and
 *   no tokens for an invalid bid.
 *
 * The opened bids (max price, max spend) are published nowhere, so no one but
 * the enclave can recompute the clearing price. A bidder can still check its
 * own outcome from its own terms (your-bid.ts).
 */

import { contractChecks, formatUnits, poolPrice, poolPriceMatches, toHex, type Fill } from "@fairground/clearing";
import { fromB64, sealedBidLen } from "../crypto";
import type { SealerAnswer } from "../near/attestation";
import type { AttestationFact } from "../types";
import { base58Decode } from "./base58";
import type { SaleFacts } from "./facts";
import type { AccessKeyView } from "./rpc";
import type { ChainCheck, ChainCheckId } from "./types";

// ---------- small helpers ----------

export const fact = (label: string, value: string, ok: boolean): AttestationFact => ({ kind: "fact", label, value, ok });
/** Values that must be equal; `ok` is decided by the caller (amounts compare as numbers, not text). */
export const equal = (values: [string, string][], ok: boolean): AttestationFact => ({
  kind: "equal",
  values: values.map(([label, value]) => ({ label, value })),
  ok,
});
export const check = (id: ChainCheckId, items: AttestationFact[], note?: string): ChainCheck => ({
  id,
  ok: items.every((i) => i.ok),
  applies: true,
  items,
  ...(note ? { note } : {}),
});
export const notApplicable = (id: ChainCheckId, note: string): ChainCheck => ({ id, ok: null, applies: false, items: [], note });
export const notRun = (id: ChainCheckId, note: string): ChainCheck => ({ id, ok: null, applies: true, items: [], note });

export const usdcText = (v: bigint) => `${formatUnits(v, 6, 6)} USDC`;
export const priceText = (v: bigint) => `${formatUnits(v, 6, 6)} USDC`;
export const tokenText = (v: bigint, decimals: number) => formatUnits(v, decimals, 4);
/** Bids are numbered from 1 on the page; the contract counts from 0. */
export const place = (index: number) => `#${index + 1}`;
const plural = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
const list = (indices: number[], max = 6) =>
  indices.length === 0 ? "none" : indices.slice(0, max).map(place).join(", ") + (indices.length > max ? ` and ${indices.length - max} more` : "");

/** The code hash NEAR reports for an account with no contract. */
export const NO_CODE = "11111111111111111111111111111111";

// ---------- the contract account ----------

/** sha256 hex of a base58 code hash; null when it is not one. */
export function codeHashHex(codeHash: string): string | null {
  const bytes = base58Decode(codeHash);
  return bytes && bytes.length === 32 ? toHex(bytes) : null;
}

/** The sale contract runs the pinned build: view_account's code hash is the base58 of the pinned sha256. */
export function checkContractCode(account: string, codeHash: string | null, pinnedSha256: string): ChainCheck {
  if (codeHash === null) return notRun("contract_code", `Could not read ${account}'s code hash.`);
  const hex = codeHashHex(codeHash);
  const pinned = pinnedSha256.trim().toLowerCase();
  const ok = hex === pinned;
  const shown = codeHash === NO_CODE ? "no contract" : (hex ?? `${codeHash} (not a sha256)`);
  return check(
    "contract_code",
    [
      equal([[`${account} code, sha256`, shown], ["pinned fairground.wasm", pinned]], ok),
      fact("code_hash, base58", codeHash, ok),
    ],
    ok ? undefined : "This contract is not the pinned build: the sealer pin it reports cannot be taken on trust.",
  );
}

function keyText(k: AccessKeyView): string {
  const p = k.access_key.permission;
  return `${k.public_key} (${p === "FullAccess" ? "full access" : `function call to ${p.FunctionCall.receiver_id}`})`;
}

/** Nobody holds a key to the account: view_access_key_list is empty, so only the account's own code can act for it. */
export function checkNoKeys(id: "contract_keys" | "token_keys", account: string, keys: readonly AccessKeyView[] | null): ChainCheck {
  if (keys === null) return notRun(id, `Could not list ${account}'s access keys.`);
  const ok = keys.length === 0;
  return check(
    id,
    [fact(`${account} access keys`, ok ? "0" : `${keys.length}: ${keys.map(keyText).join(", ")}`, ok)],
    ok
      ? undefined
      : id === "contract_keys"
        ? "Whoever holds this key can deploy other code to the contract. The owner deletes it to lock the contract."
        : "Whoever holds this key can act for the token contract.",
  );
}

// ---------- the attested output, applied ----------

/** The sealer's clear answer (crates/sealer ClearResponse), amounts as bigint. */
export type ClearOutput = {
  saleId: string;
  bidSetHash: string;
  pubkey: string;
  price: bigint;
  nValid: number;
  nInvalid: number;
  invalid: number[];
  fills: [bigint, bigint][];
};

const digits = (v: unknown): bigint | null => (typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : null);
const count = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);

/** A complete `op: clear`, `ok: true` answer, or null (an error answer, another op, or a missing field). */
export function parseClearOutput(a: SealerAnswer | null): ClearOutput | null {
  if (!a || a.ok !== true || a.op !== "clear") return null;
  const price = digits(a.clearing_price);
  const nValid = count(a.n_valid);
  const nInvalid = count(a.n_invalid);
  if (price === null || nValid === null || nInvalid === null) return null;
  if (typeof a.sale_id !== "string" || typeof a.bid_set_hash !== "string" || typeof a.pubkey !== "string") return null;
  if (!Array.isArray(a.invalid) || !Array.isArray(a.fills)) return null;
  const invalid = (a.invalid as unknown[]).map(count);
  if (invalid.some((i) => i === null)) return null;
  const fills: [bigint, bigint][] = [];
  for (const f of a.fills as unknown[]) {
    if (!Array.isArray(f) || f.length !== 2) return null;
    const [tokens, spent] = [digits(f[0]), digits(f[1])];
    if (tokens === null || spent === null) return null;
    fills.push([tokens, spent]);
  }
  return { saleId: a.sale_id, bidSetHash: a.bid_set_hash, pubkey: a.pubkey, price, nValid, nInvalid, invalid: invalid as number[], fills };
}

/** Fail reasons where no trusted clearing named the invalid bids: nobody pays the penalty. */
const UNTRUSTED = new Set(["checks_failed", "refund_mode", "no_bids"]);

/**
 * The contract applied exactly the attested output: the price, the counts,
 * the invalid list (the bids it penalised) and every (tokens, spent) pair in
 * get_result and get_fills are the ones in the bytes the attestation and the
 * contract's result_sha256 name.
 */
export function checkApplied(out: ClearOutput | null, f: SaleFacts, output?: { bytes: number; sha256: string } | null): ChainCheck {
  if (f.mode === "commit_reveal") return notApplicable("applied", "No enclave output: the contract cleared the revealed bids itself.");
  if (f.status === "not_final") return notApplicable("applied", "The sale is not settled or failed yet.");
  if (f.failReason === "refund_mode" || f.failReason === "no_bids") {
    return notApplicable("applied", "No clearing result reached the contract: the sale moved to refunds.");
  }
  if (!out) return notRun("applied", "The clearing run's output could not be read, so there is nothing to compare.");

  const items: AttestationFact[] = [];
  if (output) {
    // The bytes read here are the ones the contract hashed when it received them.
    items.push(equal([[`sha256(${output.bytes} returned bytes)`, output.sha256], ["contract stored", f.resultSha256 ?? "none"]], output.sha256 === f.resultSha256));
  }
  items.push(equal([["attested price", priceText(out.price)], ["get_result", priceText(f.price)]], out.price === f.price));
  const counts = (v: number, i: number) => `${v} valid, ${i} invalid`;
  items.push(
    equal(
      [["attested", counts(out.nValid, out.nInvalid)], ["get_result", counts(f.nValid, f.nInvalid)]],
      out.nValid === f.nValid && out.nInvalid === f.nInvalid,
    ),
  );
  items.push(equal([["attested bid set", out.bidSetHash], ["frozen at close", f.bidSetHash ?? "none"]], out.bidSetHash === f.bidSetHash));

  const penalized = f.fills.filter((x) => x.penalty > 0n).map((x) => x.index);
  const trusted = !UNTRUSTED.has(f.failReason ?? "");
  const expected = trusted ? [...out.invalid].sort((a, b) => a - b) : [];
  items.push(
    equal(
      [[trusted ? "attested invalid" : "penalised (none: untrusted result)", list(expected)], ["penalised in get_fills", list(penalized)]],
      expected.length === penalized.length && expected.every((v, i) => v === penalized[i]),
    ),
  );

  const sameLength = out.fills.length === f.bidCount && f.fills.length === f.bidCount;
  if (f.status === "settled") {
    const wrong = f.fills.filter((x) => {
      const o = out.fills[x.index];
      return !o || o[0] !== x.tokens || o[1] !== x.spent;
    });
    items.push(
      fact(
        "fills",
        sameLength && wrong.length === 0
          ? `${plural(f.bidCount, "bid")}: every (tokens, spent) pair in get_fills is the attested one`
          : `${out.fills.length} attested, ${f.fills.length} in get_fills, ${f.bidCount} bids; differ at ${list(wrong.map((x) => x.index))}`,
        sameLength && wrong.length === 0,
      ),
    );
    for (const x of wrong.slice(0, 3)) {
      const o = out.fills[x.index];
      items.push(
        fact(
          place(x.index),
          `attested ${o ? `${tokenText(o[0], f.decimals)} for ${usdcText(o[1])}` : "nothing"}, contract ${tokenText(x.tokens, f.decimals)} for ${usdcText(x.spent)}`,
          false,
        ),
      );
    }
    const sold = out.fills.reduce((a, [t]) => a + t, 0n);
    const raised = out.fills.reduce((a, [, s]) => a + s, 0n);
    items.push(
      equal(
        [["attested sold, raised", `${tokenText(sold, f.decimals)}, ${usdcText(raised)}`], ["get_result", `${tokenText(f.totalSold, f.decimals)}, ${usdcText(f.totalRaised)}`]],
        sold === f.totalSold && raised === f.totalRaised,
      ),
    );
  } else {
    // A failed sale stores no fills: get_fills charges nothing and gives no tokens.
    const nothing = f.fills.every((x) => x.tokens === 0n && x.spent === 0n);
    items.push(fact("fills", nothing ? "the sale failed: get_fills gives no tokens and charges nothing" : "the sale failed, yet get_fills gives tokens or charges", nothing && f.fills.length === f.bidCount));
  }
  return check(
    "applied",
    items,
    "Parsed from the sealer output in the close transaction's receipts.",
  );
}

// ---------- the public rules ----------

/**
 * The rules every result obeys, recomputed from get_sale, get_result,
 * get_bids and get_fills: one price for every winner (spent = ceil(tokens x
 * price / ONE), as the contract rounds), spent never above the deposit, sold
 * never above the supply, the price within the floor and the ceiling, the
 * raise at least the minimum, unsold supply only at the floor, invalid bids
 * get nothing, and every refund adds up.
 */
export function checkRules(f: SaleFacts): ChainCheck {
  if (f.status === "not_final") return notApplicable("rules", "The sale is not settled or failed yet.");
  const items: AttestationFact[] = [];
  const fills = f.fills;
  const byIndex = new Map(f.bids.map((b) => [b.index, b]));
  const ceilPenalty = (deposit: bigint) => (deposit + 99n) / 100n;

  items.push(
    fact(
      "one fill per bid",
      fills.length === f.bidCount && f.bids.length === f.bidCount && fills.every((x, i) => x.index === i && byIndex.get(i)?.bidder === x.bidder)
        ? `${plural(f.bidCount, "fill")} for ${plural(f.bidCount, "bid")}, same bidders in the same order`
        : `${fills.length} fills, ${f.bids.length} bids listed, ${f.bidCount} counted`,
      fills.length === f.bidCount && f.bids.length === f.bidCount && fills.every((x, i) => x.index === i && byIndex.get(i)?.bidder === x.bidder),
    ),
  );

  // Refunds and penalties: deposit = spent + refund + penalty; a penalty is 1 % rounded up, and only from a trusted clearing.
  const trusted = !UNTRUSTED.has(f.failReason ?? "");
  const badMoney = fills.filter((x) => {
    const d = byIndex.get(x.index)?.deposit ?? -1n;
    const penaltyOk = x.penalty === 0n || (trusted && x.penalty === ceilPenalty(d));
    return x.spent + x.refund + x.penalty !== d || !penaltyOk;
  });
  items.push(
    fact(
      "refunds add up",
      badMoney.length === 0
        ? `deposit = spent + refund + penalty for ${plural(fills.length, "bid")}; each penalty is 1 % of the deposit`
        : `wrong at ${list(badMoney.map((x) => x.index))}`,
      badMoney.length === 0,
    ),
  );

  const invalid = fills.filter((x) => x.penalty > 0n);
  const invalidOk = invalid.every((x) => x.tokens === 0n && x.spent === 0n);
  items.push(
    fact(
      "invalid bids get nothing",
      invalid.length === 0
        ? "no bid was penalised as invalid"
        : invalidOk
          ? `${plural(invalid.length, "invalid bid")} (${list(invalid.map((x) => x.index))}): no tokens, nothing charged`
          : `filled anyway: ${list(invalid.filter((x) => x.tokens > 0n || x.spent > 0n).map((x) => x.index))}`,
      invalidOk && (!trusted || f.status !== "settled" || invalid.length === f.nInvalid),
    ),
  );

  if (f.status === "failed") {
    const nothing = fills.every((x) => x.tokens === 0n && x.spent === 0n);
    items.push(
      fact(
        "failed sale",
        nothing ? `${f.failReason ?? "failed"}: nobody got tokens and nobody was charged` : `${f.failReason ?? "failed"}, yet a bid got tokens or was charged`,
        nothing && f.totalSold === 0n && f.totalRaised === 0n,
      ),
    );
    return check("rules", items);
  }

  // Settled: the contract's own checks, run here with the reference code.
  const asFills: Fill[] = fills.map((x) => ({
    index: x.index,
    bidder: x.bidder,
    deposit: byIndex.get(x.index)?.deposit ?? 0n,
    tokens: x.tokens,
    spent: x.spent,
    refund: x.refund,
    valid: x.penalty === 0n,
  }));
  const failed = contractChecks(
    { saleSupply: f.saleSupply, floorPrice: f.floorPrice, minRaise: f.minRaise, decimals: f.decimals, maxPrice: f.maxPrice },
    f.bids.map((b) => ({ bidder: b.bidder, deposit: b.deposit })),
    { clearingPrice: f.price, fills: asFills, totalRaised: f.totalRaised },
  );
  const at = (prefix: string) => failed.filter((n) => n.startsWith(prefix)).map((n) => Number(n.slice(prefix.length)));

  const winners = fills.filter((x) => x.tokens > 0n);
  const overcharged = at("spent_equals_tokens_times_price_");
  items.push(
    fact(
      "one price",
      overcharged.length === 0
        ? `${winners.length === 1 ? "the winner paid" : winners.length === 2 ? "both winners paid" : `all ${winners.length} winners paid`} ceil(tokens x ${priceText(f.price)}), rounded up as the contract does${fills.length > winners.length ? `; ${plural(fills.length - winners.length, "bid")} with no tokens paid nothing` : ""}`
        : `not charged ceil(tokens x ${priceText(f.price)}): ${list(overcharged)}`,
      overcharged.length === 0,
    ),
  );
  const overDeposit = at("spent_within_deposit_");
  items.push(fact("spent within the deposit", overDeposit.length === 0 ? `${fills.length} of ${fills.length} bids` : `above it: ${list(overDeposit)}`, overDeposit.length === 0));

  const sold = fills.reduce((a, x) => a + x.tokens, 0n);
  items.push(
    fact(
      "sold within the supply",
      `${tokenText(sold, f.decimals)} of ${tokenText(f.saleSupply, f.decimals)} tokens`,
      !failed.includes("sold_at_most_supply"),
    ),
  );
  const priceOk = !failed.includes("price_at_least_floor") && !failed.includes("price_at_most_ceiling");
  items.push(
    fact("price within the terms", `${priceText(f.price)}, floor ${priceText(f.floorPrice)}${f.maxPrice !== null ? `, ceiling ${priceText(f.maxPrice)}` : ""}`, priceOk),
  );
  const unsold = f.saleSupply - sold;
  const unsoldOk = unsold <= 0n || f.price === f.floorPrice;
  items.push(
    fact(
      "unsold only at the floor",
      unsold <= 0n
        ? "sold out"
        : unsoldOk
          ? `${tokenText(unsold, f.decimals)} unsold, at the floor price: every valid bid was filled in full`
          : `${tokenText(unsold, f.decimals)} unsold at ${priceText(f.price)}, above the floor: the rule sells the whole supply at any price above the floor`,
      unsoldOk,
    ),
  );
  const raiseOk = !failed.includes("raise_sums_fills") && !failed.includes("raise_at_least_min");
  items.push(fact("raise", `${usdcText(f.totalRaised)}, the sum of the fills; minimum ${usdcText(f.minRaise)}`, raiseOk));
  const totalsOk = f.totalSold === sold && (f.nWinners === null || f.nWinners === winners.length);
  items.push(
    fact(
      "totals",
      `get_result sold ${tokenText(f.totalSold, f.decimals)}${f.nWinners === null ? "" : `, ${plural(f.nWinners, "winner")}`}; the fills add up to ${tokenText(sold, f.decimals)}, ${plural(winners.length, "winner")}`,
      totalsOk,
    ),
  );
  if (failed.includes("one_fill_per_bid") || at("bidder_matches_").length) items[0] = { ...items[0], ok: false };
  return check("rules", items);
}

// ---------- sealed bid lengths ----------

/** Every sealed bid is 224 + len(sale_id) + len(bidder) bytes (the contract refuses any other); a commitment is 32 bytes. */
export function checkLengths(f: Pick<SaleFacts, "saleId" | "bids" | "mode">): ChainCheck {
  if (f.bids.length === 0) return notApplicable("lengths", "The sale has no bids.");
  const tee = f.mode === "tee";
  const wrong: { index: number; got: number; want: number }[] = [];
  for (const b of f.bids) {
    let got = -1;
    try {
      got = fromB64(b.payload).length;
    } catch {
      // not base64: reported as wrong
    }
    const want = tee ? sealedBidLen(f.saleId, b.bidder) : 32;
    if (got !== want) wrong.push({ index: b.index, got, want });
  }
  const sizes = [...new Set(f.bids.map((b) => (tee ? sealedBidLen(f.saleId, b.bidder) : 32)))].sort((a, b) => a - b);
  return check("lengths", [
    fact(
      tee ? "sealed bids" : "commitments",
      wrong.length === 0
        ? tee
          ? `${f.bids.length} of ${f.bids.length} are 224 + len(sale id) + len(bidder) bytes (${sizes.join(", ")}), so a box says nothing about the amounts in it`
          : `${f.bids.length} of ${f.bids.length} are 32 bytes`
        : `${wrong.length} of ${f.bids.length} have another length`,
      wrong.length === 0,
    ),
    ...wrong.slice(0, 3).map((w) => fact(place(w.index), w.got < 0 ? "not base64" : `${w.got} bytes, expected ${w.want}`, false)),
  ]);
}

// ---------- the launch pool ----------

/** The pool as the exchange reports it: Ref get_pool and get_pool_shares for the sale contract. */
export type PoolRead = { tokenIds: string[]; amounts: bigint[]; sharesTotal: bigint; contractShares: bigint };

/**
 * A seeded launch pool opened at the clearing price (the amounts the contract
 * put in, within one base unit as poolPlan rounds), holds the sale token and
 * the quote token, and the LP shares the exchange credits to the sale
 * contract are the ones it recorded. Trades move the live price; what the
 * contract controls is the price the pool opened at.
 */
export function checkPool(f: SaleFacts, pool: PoolRead | null, readError?: string): ChainCheck {
  const l = f.liquidity;
  if (!l) return notApplicable("pool", "This sale has no launch pool.");
  if (f.status === "not_final") return notApplicable("pool", "The sale is not final yet.");
  if (l.status !== "seeded") {
    const why: Record<string, string> = {
      seeding: "The pool is not seeded yet.",
      skipped: "No pool: the plan came to zero tokens or zero USDC.",
      cancelled: "No pool: the sale failed, so its reserve is burned.",
      abandoned: "No pool: it was not seeded by its deadline.",
      waiting: "The sale is not final yet.",
    };
    return notApplicable("pool", why[l.status] ?? `The pool is ${l.status}.`);
  }
  const items: AttestationFact[] = [];
  const opened = poolPrice(l.usdc, l.tokens, f.decimals);
  const openedOk = poolPriceMatches(l.usdc, l.tokens, f.price, f.decimals);
  items.push(
    equal(
      [
        [`opened with ${usdcText(l.usdc)} and ${tokenText(l.tokens, f.decimals)} tokens`, opened === null ? "no price" : priceText(opened)],
        ["clearing price", priceText(f.price)],
      ],
      openedOk,
    ),
  );
  if (!pool) {
    return { id: "pool", ok: null, applies: true, items, note: `Could not read pool ${l.poolId ?? "?"} on ${l.dex}${readError ? `: ${readError}` : ""}.` };
  }
  const ti = pool.tokenIds.indexOf(f.token);
  const ui = pool.tokenIds.indexOf(f.quoteToken);
  const pairOk = pool.tokenIds.length === 2 && ti >= 0 && ui >= 0;
  const live = pairOk ? poolPrice(pool.amounts[ui], pool.amounts[ti], f.decimals) : null;
  const liveOk = pairOk && poolPriceMatches(pool.amounts[ui], pool.amounts[ti], f.price, f.decimals);
  items.push(
    fact(
      `pool ${l.poolId} on ${l.dex}`,
      !pairOk
        ? `holds ${pool.tokenIds.join(" and ")}, not the sale token and ${f.quoteToken}`
        : `${usdcText(pool.amounts[ui])} and ${tokenText(pool.amounts[ti], f.decimals)} tokens now${liveOk ? ", still at the clearing price" : `, ${live === null ? "empty" : `${priceText(live)} after trading`}`}`,
      pairOk,
    ),
  );
  items.push(
    equal(
      [["LP shares the exchange credits to the contract", pool.contractShares.toString()], ["recorded by the contract", l.shares.toString()]],
      l.shares > 0n && pool.contractShares === l.shares,
    ),
  );
  return check("pool", items);
}
