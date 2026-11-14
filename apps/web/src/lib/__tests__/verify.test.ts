/**
 * The contract and rule checks (lib/verify) against real testnet data:
 * contract sealround.itzbeast.testnet, sales nosnipe-11140458 (six bids, one
 * of them an invalid copycat, sold out above the floor, a seeded Rhea pool)
 * and nosnipe-11140429 (two bids, sold out at the floor, a seeded pool),
 * captured read-only on 14 Nov 2026 under fixtures/verify. Each check passes
 * on the saved data and fails when one byte or one base unit changes.
 * Everything runs offline.
 */
import { describe, expect, it } from "vitest";
import { costOf } from "@fairground/clearing";
import { PINNED_CONTRACT_SHA256 } from "../../components/deploy/chain";
import { fromB64, sealedBidLen, toB64 } from "../crypto";
import { sealerAnswer } from "../near/attestation";
import type { BidView, FillView, ResultView, SaleView } from "../near/views";
import { base58Decode, base58Encode } from "../verify/base58";
import {
  checkApplied,
  checkContractCode,
  checkLengths,
  checkNoKeys,
  checkPool,
  checkRules,
  codeHashHex,
  NO_CODE,
  parseClearOutput,
  type ClearOutput,
  type PoolRead,
} from "../verify/checks";
import { factsFromViews, type SaleFacts } from "../verify/facts";
import { jsonRpc, type AccessKeyView } from "../verify/rpc";
import { chainChecks, readChain } from "../verify/sources";
import type { ChainCheck } from "../verify/types";
import { checkYourBid, parseBidSecretFile, ruleOutcome, type BidTerms } from "../verify/your-bid";
import raw429 from "./fixtures/verify/nosnipe-11140429.json";
import fx458 from "./fixtures/verify/nosnipe-11140458.json";

type Fixture = typeof fx458;
const fx429 = raw429 as unknown as Fixture;
const SALES: Fixture[] = [fx458, fx429];

const PINNED_BASE58 = "GhTHg5s7c97X8gALyghMchc8o51AnjYD4qDeStHPvMM2";

const factsOf = (fx: Fixture): SaleFacts =>
  factsFromViews(
    fx.contract,
    fx.views.get_sale as unknown as SaleView,
    fx.views.get_result as unknown as ResultView,
    fx.views.get_bids as unknown as BidView[],
    fx.views.get_fills as unknown as FillView[],
  );

const outputOf = (fx: Fixture) => {
  const bytes = fromB64(fx.clearOutputB64);
  return { bytes, answer: sealerAnswer(bytes) };
};

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function applied(fx: Fixture, f: SaleFacts = factsOf(fx), bytes: Uint8Array = outputOf(fx).bytes, out?: ClearOutput | null) {
  const parsed = out === undefined ? parseClearOutput(sealerAnswer(bytes)) : out;
  return checkApplied(parsed, f, { bytes: bytes.length, sha256: await sha256Hex(bytes) });
}

const poolOf = (fx: Fixture): PoolRead => ({
  tokenIds: fx.pool.get_pool.token_account_ids,
  amounts: fx.pool.get_pool.amounts.map((a) => BigInt(a)),
  sharesTotal: BigInt(fx.pool.get_pool.shares_total_supply),
  contractShares: BigInt(fx.pool.get_pool_shares),
});

const keysOf = (fx: Fixture, account: string) => (fx.keys as Record<string, { keys: AccessKeyView[] }>)[account].keys;

/** The sniper's own terms, as the live bot's receipt recorded them. */
const SNIPER: Record<string, BidTerms> = {
  "nosnipe-11140458": {
    contract: "sealround.itzbeast.testnet",
    saleId: "nosnipe-11140458",
    bidder: "sniper.itzbeast.testnet",
    maxPrice: 4000n,
    maxSpend: 5_000_000n,
    payloadSha256: "c3a49c54ea77f221e1cb54546c4cabd44306363d66c31e07de10834a4eb3036d",
    source: "live bot receipt",
  },
  "nosnipe-11140429": {
    contract: "sealround.itzbeast.testnet",
    saleId: "nosnipe-11140429",
    bidder: "sniper.itzbeast.testnet",
    maxPrice: 4000n,
    maxSpend: 5_000_000n,
    payloadSha256: "50459ed50a818b01c4879a7d7f6df4dc8a45336e61f822beb981f014b5be72e7",
    source: "live bot receipt",
  },
};

const failing = (c: ChainCheck) => c.items.filter((i) => !i.ok).map((i) => (i.kind === "fact" ? i.label : i.values[0].label));

describe("base58 code hashes", () => {
  it("the pinned fairground.wasm sha256 is the code hash NEAR reports", () => {
    const bytes = Uint8Array.from(PINNED_CONTRACT_SHA256.match(/../g)!.map((h) => parseInt(h, 16)));
    expect(base58Encode(bytes)).toBe(PINNED_BASE58);
    expect(codeHashHex(PINNED_BASE58)).toBe(PINNED_CONTRACT_SHA256);
    expect(base58Decode("0OIl")).toBe(null);
    expect(codeHashHex(NO_CODE)).not.toBe(PINNED_CONTRACT_SHA256);
  });
});

describe("the contract account", () => {
  it("passes on the live code hash and fails on one changed character or no code", () => {
    expect(checkContractCode(fx458.contract, fx458.account.code_hash, PINNED_CONTRACT_SHA256).ok).toBe(true);
    const changed = fx458.account.code_hash.replace(/.$/, (c) => (c === "2" ? "3" : "2"));
    expect(checkContractCode(fx458.contract, changed, PINNED_CONTRACT_SHA256).ok).toBe(false);
    expect(checkContractCode(fx458.contract, NO_CODE, PINNED_CONTRACT_SHA256)).toMatchObject({ ok: false });
    expect(checkContractCode(fx458.contract, null, PINNED_CONTRACT_SHA256)).toMatchObject({ ok: null, applies: true });
  });

  it("fails while the contract holds a key, passes with none, and shows the count", () => {
    const held = checkNoKeys("contract_keys", fx458.contract, keysOf(fx458, fx458.contract));
    expect(held.ok).toBe(false);
    expect(held.items[0]).toMatchObject({ kind: "fact", value: expect.stringMatching(/^1: ed25519:QrjwhKpn6BK7FJuQaXU96c9WwnjDUPzUHtFfCgPBDrS \(full access\)/) });
    expect(checkNoKeys("contract_keys", fx458.contract, []).ok).toBe(true);
    const token = fx458.views.get_sale.token;
    expect(checkNoKeys("token_keys", token, keysOf(fx458, token))).toMatchObject({ ok: true, items: [{ value: "0" }] });
    expect(checkNoKeys("token_keys", token, null)).toMatchObject({ ok: null, applies: true });
  });
});

describe("the attested output, applied", () => {
  for (const fx of SALES) {
    it(`${fx.sale}: the contract stored exactly the attested output`, async () => {
      const c = await applied(fx);
      expect(failing(c)).toEqual([]);
      expect(c.ok).toBe(true);
    });
  }

  it("fails on one changed byte of the output", async () => {
    const bytes = outputOf(fx458).bytes.slice();
    const i = new TextDecoder().decode(bytes).indexOf("2500000000000000000000");
    bytes[i + 21] = "1".charCodeAt(0); // ...0001 tokens: still parses, hash and fill both change
    const c = await applied(fx458, factsOf(fx458), bytes);
    expect(c.ok).toBe(false);
    expect(failing(c)).toContain("sha256(" + bytes.length + " returned bytes)");
  });

  it("fails when one fill, the price, a count or the invalid list differs by one", async () => {
    const tokens = factsOf(fx458);
    tokens.fills[1].tokens += 1n;
    expect((await applied(fx458, tokens)).ok).toBe(false);

    const spent = factsOf(fx458);
    spent.fills[0].spent -= 1n;
    expect((await applied(fx458, spent)).ok).toBe(false);

    const price = factsOf(fx458);
    price.price += 1n;
    expect(failing(await applied(fx458, price))).toEqual(["attested price"]);

    const counts = factsOf(fx458);
    counts.nValid -= 1;
    expect(failing(await applied(fx458, counts))).toEqual(["attested"]);

    const penalised = factsOf(fx458);
    penalised.fills[4].penalty = 0n;
    expect(failing(await applied(fx458, penalised))).toEqual(["attested invalid"]);
  });

  it("does not run without the output, and does not apply to a sale still open", async () => {
    expect(await applied(fx458, factsOf(fx458), outputOf(fx458).bytes, null)).toMatchObject({ ok: null, applies: true });
    const open = { ...factsOf(fx458), status: "not_final" as const };
    expect((await applied(fx458, open)).applies).toBe(false);
  });
});

describe("the public rules", () => {
  for (const fx of SALES) {
    it(`${fx.sale}: every rule holds`, () => {
      const c = checkRules(factsOf(fx));
      expect(failing(c)).toEqual([]);
      expect(c.ok).toBe(true);
    });
  }

  it("fails when a winner is charged one unit more", () => {
    const f = factsOf(fx458);
    // ana: deposit 6 USDC, 2,500 tokens for 5 USDC, 1 back.
    f.fills[1].spent += 1n;
    f.fills[1].refund -= 1n; // the refund still adds up: only the price is wrong
    f.totalRaised += 1n;
    expect(failing(checkRules(f))).toContain("one price");
  });

  it("fails when a bid spends more than its deposit", () => {
    const f = factsOf(fx429);
    // ana: deposit 6 USDC, spent 5, refund 1. Charge 7 for 7,000 tokens and take the refund to zero.
    f.fills[0] = { ...f.fills[0], tokens: 7000n * 10n ** 18n, spent: 7_000_000n, refund: 0n };
    expect(failing(checkRules(f))).toContain("spent within the deposit");
  });

  it("fails when more than the supply is sold, or supply is left unsold above the floor", () => {
    const over = factsOf(fx458);
    over.saleSupply -= 1n;
    expect(failing(checkRules(over))).toContain("sold within the supply");
    const under = factsOf(fx458);
    under.saleSupply += 1n;
    expect(failing(checkRules(under))).toContain("unsold only at the floor");
  });

  it("fails when an invalid bid gets a token, or a refund or penalty is one unit off", () => {
    const filled = factsOf(fx458);
    filled.fills[4].tokens = 1n;
    expect(failing(checkRules(filled))).toContain("invalid bids get nothing");
    const refund = factsOf(fx458);
    refund.fills[1].refund += 1n;
    expect(failing(checkRules(refund))).toContain("refunds add up");
    const penalty = factsOf(fx458);
    penalty.fills[4].penalty -= 1n;
    penalty.fills[4].refund += 1n;
    expect(failing(checkRules(penalty))).toContain("refunds add up");
  });
});

describe("sealed bid lengths", () => {
  it("every live bid is 224 + len(sale id) + len(bidder) bytes", () => {
    const f = factsOf(fx458);
    for (const b of f.bids) expect(fromB64(b.payload).length).toBe(sealedBidLen(f.saleId, b.bidder));
    expect(checkLengths(f).ok).toBe(true);
    expect(checkLengths(factsOf(fx429)).ok).toBe(true);
  });

  it("fails on a bid one byte longer or shorter", () => {
    for (const delta of [1, -1]) {
      const f = factsOf(fx458);
      const bytes = fromB64(f.bids[2].payload);
      const changed = delta > 0 ? Uint8Array.from([...bytes, 0]) : bytes.slice(0, -1);
      f.bids[2].payload = toB64(changed);
      const c = checkLengths(f);
      expect(c.ok).toBe(false);
      expect(c.items[1]).toMatchObject({ label: "#3", value: `${bytes.length + delta} bytes, expected ${bytes.length}` });
    }
  });
});

describe("the launch pool", () => {
  for (const fx of SALES) {
    it(`${fx.sale}: opened at the clearing price, LP shares on the contract`, () => {
      const c = checkPool(factsOf(fx), poolOf(fx));
      expect(failing(c)).toEqual([]);
      expect(c.ok).toBe(true);
    });
  }

  it("fails on one LP share less, one more USDC in the opening amounts, or another token pair", () => {
    const shares = poolOf(fx458);
    shares.contractShares -= 1n;
    expect(checkPool(factsOf(fx458), shares).ok).toBe(false);

    const f = factsOf(fx458);
    f.liquidity!.usdc += 1n;
    expect(checkPool(f, poolOf(fx458)).ok).toBe(false);

    const pair = poolOf(fx458);
    pair.tokenIds = [pair.tokenIds[0], "usdt.fakes.testnet"];
    expect(checkPool(factsOf(fx458), pair).ok).toBe(false);
  });

  it("still passes after trades move the live price; does not run without a read; does not apply without a pool", () => {
    const traded = poolOf(fx458);
    traded.amounts = [traded.amounts[0] - 10n ** 18n, traded.amounts[1] + 2_100n];
    const c = checkPool(factsOf(fx458), traded);
    expect(c.ok).toBe(true);
    expect(c.items[1]).toMatchObject({ value: expect.stringContaining("after trading") });
    expect(checkPool(factsOf(fx458), null, "HTTP 429")).toMatchObject({ ok: null, applies: true });
    expect(checkPool({ ...factsOf(fx458), liquidity: null }, null).applies).toBe(false);
  });
});

describe("your bid, from your own terms", () => {
  for (const fx of SALES) {
    it(`${fx.sale}: the sniper's receipt gives exactly its fill`, () => {
      const c = checkYourBid(SNIPER[fx.sale], factsOf(fx));
      expect(failing(c)).toEqual([]);
      expect(c).toMatchObject({ ok: true, subject: "sniper.itzbeast.testnet" });
    });
  }

  it("fails when the fill is below what the rule allows at this price, or the charge is one unit more", () => {
    const terms = SNIPER["nosnipe-11140458"];
    const rule = ruleOutcome(terms, 5_000_000n, factsOf(fx458));
    // Above the price a fill can fall short of full only by a pro-rata hair (the bids above the price
    // alone asking for more than the supply): here less than 2 of the 2,500 tokens.
    expect(rule.max).toBe(2500n * 10n ** 18n);
    expect(rule.max - rule.min).toBeLessThan(2n * 10n ** 18n);
    const short = factsOf(fx458);
    const tokens = rule.min - 1n;
    const spent = costOf(tokens, 2000n, 10n ** 18n);
    short.fills[0] = { ...short.fills[0], tokens, spent, refund: 5_000_000n - spent };
    expect(failing(checkYourBid(terms, short))).toEqual(["the rule gives"]);
    const over = factsOf(fx458);
    over.fills[0].spent += 1n;
    over.fills[0].refund -= 1n;
    expect(failing(checkYourBid(SNIPER["nosnipe-11140458"], over))).toEqual(["charged"]);
  });

  it("fails when the sealed bytes are not the ones the receipt recorded", () => {
    const t = { ...SNIPER["nosnipe-11140458"], payloadSha256: SNIPER["nosnipe-11140458"].payloadSha256!.replace(/^c/, "d") };
    expect(failing(checkYourBid(t, factsOf(fx458)))).toEqual(["sha256 of the sealed bid on chain"]);
  });

  it("a max price below the clearing price must get nothing; invalid terms must pay the penalty", () => {
    const f = factsOf(fx458);
    const below = { ...SNIPER["nosnipe-11140458"], maxPrice: 1999n, payloadSha256: null };
    expect(ruleOutcome(below, 5_000_000n, f)).toMatchObject({ valid: true, min: 0n, max: 0n });
    expect(checkYourBid(below, f).ok).toBe(false);
    // The copycat: its own sealed terms were unreadable, so the rule voids it with a 1 % penalty.
    const copycat: BidTerms = { saleId: f.saleId, bidder: "copy.itzbeast.testnet", maxPrice: 4000n, maxSpend: 0n, source: "test" };
    expect(checkYourBid(copycat, f)).toMatchObject({ ok: true });
    expect(checkYourBid({ ...copycat, maxSpend: 5_000_000n }, f).ok).toBe(false);
  });

  it("reads a live bot receipt, an MCP bid secret and the app's export, and refuses a file with no terms", () => {
    const receipt = { v: 1, kind: "snipe", contract: "sealround.itzbeast.testnet", saleId: "s", bidder: "a.testnet", maxPrice: "4000", maxSpend: "5000000", payloadSha256: "AB".repeat(32) };
    expect(parseBidSecretFile(receipt)).toEqual([
      expect.objectContaining({ source: "live bot receipt", maxPrice: 4000n, maxSpend: 5_000_000n, payloadSha256: "ab".repeat(32) }),
    ]);
    const mcp = { format: "sealround-bid-secret", saleId: "s", bidder: "b.testnet", maxPrice: "1", maxSpend: "2", ciphertextSha256: "cd".repeat(32) };
    expect(parseBidSecretFile(mcp)[0]).toMatchObject({ source: "bid secret file (MCP)", payloadSha256: "cd".repeat(32) });
    const exported = { format: "fairground-bid-secrets", secrets: [{ contract: "x", saleId: "s", bidder: "c.testnet", maxPrice: "1", maxSpend: "2", salt: "00", commitment: "ef".repeat(32), deposit: "3" }] };
    expect(parseBidSecretFile(exported)[0]).toMatchObject({ bidder: "c.testnet", commitment: "ef".repeat(32) });
    expect(() => parseBidSecretFile({ v: 1, kind: "copycat", saleId: "s", bidder: "d.testnet" })).toThrow(/no bid terms/);
  });
});

describe("readChain and chainChecks, over a fake RPC node", () => {
  /** Serves the fixture's views, account, keys and pool, as a NEAR RPC node would. */
  function node(fx: Fixture, o: { keys?: Record<string, AccessKeyView[]>; busy?: number } = {}) {
    const calls: string[] = [];
    let busy = o.busy ?? 0;
    const bytes = (v: unknown) => Array.from(new TextEncoder().encode(JSON.stringify(v)));
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: Record<string, unknown> };
      const p = body.params;
      if (busy > 0) {
        busy--;
        calls.push("429");
        return new Response("", { status: 429 });
      }
      const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
      calls.push(`${String(p.request_type)} ${String(p.account_id)}${p.method_name ? `.${String(p.method_name)}` : ""}`);
      if (p.request_type === "view_account") return reply(fx.account);
      if (p.request_type === "view_access_key_list") {
        const keys = o.keys?.[String(p.account_id)] ?? keysOf(fx, String(p.account_id));
        return reply({ keys, block_height: 1 });
      }
      const args = JSON.parse(new TextDecoder().decode(fromB64(String(p.args_base64)))) as { from_index?: number; limit?: number };
      const m = String(p.method_name);
      const page = <T>(all: T[]) => all.slice(args.from_index ?? 0, (args.from_index ?? 0) + (args.limit ?? all.length));
      const views: Record<string, unknown> = {
        get_sale: fx.views.get_sale,
        get_result: fx.views.get_result,
        get_bids: page(fx.views.get_bids),
        get_fills: page(fx.views.get_fills),
        get_pool: fx.pool.get_pool,
        get_pool_shares: fx.pool.get_pool_shares,
      };
      return m in views ? reply({ result: bytes(views[m]) }) : reply({ error: "MethodNotFound" });
    }) as typeof fetch;
    return { calls, rpc: jsonRpc(["https://rpc.test"], { fetch: fetchImpl, retryDelayMs: 1 }) };
  }

  it("every check passes on the live data except the contract key, which the owner has not deleted yet", async () => {
    const { rpc } = node(fx458);
    const read = await readChain(rpc, fx458.contract, fx458.sale);
    const { answer, bytes } = outputOf(fx458);
    const v = chainChecks(read, {
      contractId: fx458.contract,
      pinnedContract: PINNED_CONTRACT_SHA256,
      clear: { answer, bytes: bytes.length, sha256: await sha256Hex(bytes) },
      terms: [SNIPER["nosnipe-11140458"]],
    });
    const result = Object.fromEntries(v.checks.map((c) => [c.id, c.ok]));
    expect(result).toEqual({
      contract_code: true,
      contract_keys: false,
      token_keys: true,
      applied: true,
      rules: true,
      lengths: true,
      pool: true,
      your_bid: true,
    });
  });

  it("all pass once the contract is locked; the views already read are not read again", async () => {
    const { rpc, calls } = node(fx429, { keys: { [fx429.contract]: [] } });
    const read = await readChain(rpc, fx429.contract, fx429.sale, {
      sale: fx429.views.get_sale as unknown as SaleView,
      result: fx429.views.get_result as unknown as ResultView,
    });
    const { answer, bytes } = outputOf(fx429);
    const v = chainChecks(read, {
      contractId: fx429.contract,
      pinnedContract: PINNED_CONTRACT_SHA256,
      clear: { answer, bytes: bytes.length, sha256: await sha256Hex(bytes) },
    });
    expect(v.checks.every((c) => c.ok === true)).toBe(true);
    expect(calls.filter((c) => c.endsWith(".get_sale") || c.endsWith(".get_result"))).toEqual([]);
  });

  it("asks a rate-limited node again instead of giving up", async () => {
    const { rpc, calls } = node(fx458, { busy: 2 });
    const read = await readChain(rpc, fx458.contract, fx458.sale);
    expect(calls.filter((c) => c === "429")).toHaveLength(2);
    expect(read.facts).not.toBe(null);
    expect(read.codeHash).toBe(PINNED_BASE58);
  });

  it("a pinned build mismatch: the smoke contract's older build is not the pinned one", async () => {
    const { rpc } = node(fx458);
    const read = await readChain(rpc, fx458.contract, fx458.sale);
    const v = chainChecks({ ...read, codeHash: "5vNnZKkPj3Jp7oBxWJ6r2rPCpY2DDqLXVhmrdeYXq1Bw" }, { contractId: fx458.contract, pinnedContract: PINNED_CONTRACT_SHA256 });
    expect(v.checks.find((c) => c.id === "contract_code")?.ok).toBe(false);
    // No clearing output: the applied check says it could not run, the rest still do.
    expect(v.checks.find((c) => c.id === "applied")).toMatchObject({ ok: null, applies: true });
  });
});
