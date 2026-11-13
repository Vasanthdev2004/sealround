/**
 * The simulated chain must behave like the contract: bid-set hash v1, exact
 * ciphertext lengths, the contract's rejection reasons, the 1 % invalid-bid
 * penalty in both modes, the 1 USDC minimum deposit, sale id rules.
 * Runs in Node, where the mock keeps its state in memory.
 */
import { bidSetHash, poolPriceMatches } from "@fairground/clearing";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { checkBidSet, placeOf } from "../bid-inclusion";
import { planFor } from "../liquidity";
import { getBidSecret } from "../bid-secrets";
import { FairgroundError } from "../client/errors";
import { CONTRACT_ID, MOCK_SECRETS_SCOPE, MockClient, SEALER_CODE_HASH, USDC_TOKEN, validateConfig } from "../client/mock";
import { MIN_DEPOSIT_MESSAGE, invalidBidPenalty } from "../client/rules";
import { bidCommitment, fromB64, randomHex, sealBid, sealedBidLen } from "../crypto";
import type { BidRecord, SaleConfig, SaleMeta } from "../types";

const USDC = 1_000_000n;
const TOKEN = 10n ** 18n;
const META: SaleMeta = { description: "A test sale.", hue: 10 };

function config(over: Partial<SaleConfig> = {}): SaleConfig {
  const now = Date.now();
  return {
    tokenName: "Test",
    tokenSymbol: "TST",
    decimals: 18,
    totalSupply: 1_000_000n * TOKEN,
    saleSupply: 100_000n * TOKEN,
    creatorAllocation: 100_000n * TOKEN,
    lpReserve: 800_000n * TOKEN,
    floorPrice: 1000n,
    maxPrice: null,
    minRaise: USDC,
    bidStart: now,
    bidEnd: now + 60_000,
    minDeposit: USDC,
    maxDepositPerAccount: 10n * USDC,
    revealMode: "tee",
    unsoldRule: "burn",
    settleTimeoutMs: 2 * 3_600_000,
    quoteToken: USDC_TOKEN,
    ...over,
  };
}

const hashOf = (saleId: string, bids: BidRecord[]) =>
  bidSetHash(
    saleId,
    bids.map((b) => ({ bidder: b.bidder, deposit: b.deposit, payload: fromB64(b.ciphertext) })),
  );

/** The rejection a promise ends in, as a FairgroundError. */
async function failure(p: Promise<unknown>): Promise<FairgroundError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof FairgroundError) return e;
    throw e;
  }
  throw new Error("expected the call to be refused");
}

async function until(check: () => Promise<boolean>, ms = 8000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!(await check())) {
    if (performance.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("seeded demo sales", () => {
  let client: MockClient;
  beforeAll(async () => {
    client = new MockClient();
    await client.ready();
  });

  it("describes itself as a simulated chain with a simulated relayer", async () => {
    expect(client.mode).toBe("mock");
    expect(client.contractId).toBe(CONTRACT_ID);
    expect(client.usdcContract).toBe(USDC_TOKEN);
    expect(client.secretsScope).toBe(MOCK_SECRETS_SCOPE);
    expect(client.capabilities).toEqual({ judgeMode: true, faucet: true, reset: true, relayer: true, simulated: true });
    expect(await client.getRelayerPolicy()).toMatchObject({ simulated: true, usdcContracts: [USDC_TOKEN] });
    expect(await client.ensureUsdcStorage("anyone.testnet")).toEqual({ status: "already_registered", txHash: null });
    expect(await client.getCloseDeposit("kiln")).toBe(0n);
  });

  it("keeps the six demo sales in their states", async () => {
    const byId = Object.fromEntries((await client.listSales()).map((s) => [s.id, s]));
    expect(byId.lantern.status).toBe("settled");
    expect(byId.driftwood.status).toBe("failed");
    expect(byId.ashfall.status).toBe("clearing");
    expect(byId.kiln.status).toBe("awaiting_close");
    expect(byId.fairt.status).toBe("open");
    expect(byId.moth.status).toBe("upcoming");
    for (const s of Object.values(byId)) {
      // Token accounts are <sale_id>.<contract>.
      expect(s.tokenAccount).toBe(`${s.id}.${CONTRACT_ID}`);
      expect(s.chainStatus).toBe(s.status);
      expect(s.tokenSetup).toBe("done");
      expect(s.config.minDeposit).toBeGreaterThanOrEqual(USDC);
    }
  });

  it("hashes the bid set with the DESIGN v1 running hash", async () => {
    for (const id of ["lantern", "driftwood", "ashfall", "kiln", "fairt"]) {
      const sale = (await client.getSale(id))!;
      const bids = await client.getBids(id);
      expect(bids.length).toBe(sale.bidCount);
      expect(sale.runningBidSetHash, id).toBe(hashOf(id, bids));
      // Frozen at close, absent before.
      expect(sale.bidSetHash, id).toBe(sale.closedAt === null ? null : hashOf(id, bids));
      // The bid-inclusion check on the result page agrees, and places every bidder.
      if (sale.bidSetHash !== null) {
        const check = checkBidSet(id, bids, sale.bidSetHash, sale.bidCount);
        expect(check.matches, id).toBe(true);
        for (const b of bids) expect(placeOf(check, b.bidder), b.bidder).not.toBeNull();
        if (check.count > 0) expect(placeOf(check, check.bidders[0])).toBe(1);
      }
    }
  });

  it("only holds sealed bids of the exact length", async () => {
    for (const id of ["lantern", "fairt"]) {
      for (const b of await client.getBids(id)) {
        expect(fromB64(b.ciphertext).length).toBe(sealedBidLen(id, b.bidder));
        expect(b.payloadKind).toBe("ciphertext");
      }
    }
  });

  it("charges the copycat the 1 % penalty and nobody else", async () => {
    const sale = (await client.getSale("lantern"))!;
    const result = (await client.getResult("lantern"))!;
    const bids = await client.getBids("lantern");
    expect(result.status).toBe("settled");
    expect(result.bidSetHash).toBe(sale.bidSetHash);
    expect(result.clearedBy).toBe("enclave");
    expect(result.checks.length).toBeGreaterThan(10);
    expect(result.checks.every((c) => c.passed)).toBe(true);
    expect(result.checks.map((c) => c.id)).toEqual(expect.arrayContaining(["pubkey_matches", "invalid_list_matches", "invalid_bid_unfilled", "raise_at_least_min"]));
    expect(result.failedChecks).toEqual([]);

    const voided = result.fills.filter((f) => !f.valid);
    expect(voided).toHaveLength(1);
    const copy = voided[0];
    expect(copy.invalidReason).toBe("bidder_mismatch");
    expect(copy.tokens).toBe(0n);
    expect(copy.penalty).toBe(invalidBidPenalty(copy.deposit));
    expect(copy.penalty).toBe((copy.deposit + 99n) / 100n);
    expect(copy.refund).toBe(copy.deposit - copy.penalty!);
    // The copy is someone else's ciphertext, from an account id of the same length.
    const original = bids.find((b) => b.ciphertext === bids[copy.index].ciphertext && b.index !== copy.index)!;
    expect(original.bidder.length).toBe(copy.bidder.length);
    expect(original.placedAt).toBeLessThan(bids[copy.index].placedAt);

    for (const f of result.fills.filter((x) => x.valid)) {
      expect(f.penalty).toBe(0n);
      expect(f.refund).toBe(f.deposit - f.spent);
    }
    expect(result.totalPenalties).toBe(copy.penalty);
    expect(result.nInvalid).toBe(1);
    expect(result.unsold).toBe(sale.config.saleSupply - result.totalSold);
    expect(result.resultSha256).toMatch(/^[0-9a-f]{64}$/);
    // The creator collected at claim_proceeds.
    expect(result.proceeds).toEqual({ raisePaid: true, allocationPaid: true, unsoldBurned: true, reserveReturned: true });
    expect((await client.getBalances(sale.creator)).usdc).toBe(result.totalRaised);
  });

  it("refunds a sale below its minimum raise with one failing check", async () => {
    const sale = (await client.getSale("driftwood"))!;
    const result = (await client.getResult("driftwood"))!;
    expect(result.status).toBe("failed");
    expect(result.failReason).toBe("below_min_raise");
    expect(result.chainFailReason).toBe("below_min_raise");
    expect(sale.chainFailReason).toBe("below_min_raise");
    expect(result.checks.filter((c) => !c.passed).map((c) => c.id)).toEqual(["raise_at_least_min"]);
    expect(result.totalSold).toBe(0n);
    expect(result.unsold).toBe(sale.config.saleSupply);
    expect(result.totalPenalties).toBe(0n);
    for (const f of result.fills) expect(f.refund).toBe(f.deposit);
  });

  it("moves a silent sale to refunds after the settle timeout, without penalties", async () => {
    const before = (await client.getSale("ashfall"))!;
    expect(before.refundModeFrom).toBeLessThan(Date.now());
    expect((await failure(client.triggerRefundMode("kiln", "anyone.testnet"))).message).toBe("Settle timeout has not passed yet.");
    const after = await client.triggerRefundMode("ashfall", "anyone.testnet");
    expect(after.status).toBe("failed");
    expect(after.chainFailReason).toBe("refund_mode");
    expect(after.refundModeFrom).toBeNull();
    expect(after.relay).toMatchObject({ paidBy: "relayer", simulated: true });
    const result = (await client.getResult("ashfall"))!;
    expect(result.failReason).toBe("settle_timeout");
    expect(result.checks).toEqual([]);
    expect(result.clearedBy).toBe("none");
    expect(result.totalPenalties).toBe(0n);
    for (const f of result.fills) expect(f).toMatchObject({ refund: f.deposit, penalty: 0n, valid: true });
    expect((await failure(client.triggerRefundMode("ashfall", "anyone.testnet"))).reason).toBe("wrong_phase");
  });
});

describe("create_sale rules", () => {
  let client: MockClient;
  beforeAll(async () => {
    client = new MockClient();
    await client.ready();
  });

  it("requires a minimum deposit of at least 1 USDC, in the contract's words", async () => {
    expect(MIN_DEPOSIT_MESSAGE).toBe(
      "invalid min_deposit: must satisfy 1 USDC (1000000) <= min_deposit <= max_deposit_per_account",
    );
    expect(() => validateConfig(config({ minDeposit: 999_999n }))).toThrow(MIN_DEPOSIT_MESSAGE);
    expect(() => validateConfig(config({ minDeposit: 0n }))).toThrow(MIN_DEPOSIT_MESSAGE);
    expect(() => validateConfig(config({ minDeposit: 11n * USDC }))).toThrow(MIN_DEPOSIT_MESSAGE);
    expect(() => validateConfig(config({ minDeposit: USDC }))).not.toThrow();
    const e = await failure(client.createSale("me.testnet", config({ minDeposit: 999_999n }), META));
    expect(e.code).toBe("invalid");
    expect(e.message).toBe(MIN_DEPOSIT_MESSAGE);
    expect((await failure(client.getCreateCost("me.testnet", config({ minDeposit: 1n }), META))).message).toBe(MIN_DEPOSIT_MESSAGE);
  });

  it("applies the contract's other limits", () => {
    expect(() => validateConfig(config({ settleTimeoutMs: 60_000 }))).toThrow(/settle_timeout/);
    expect(() => validateConfig(config({ bidEnd: Date.now() + 31 * 24 * 3_600_000 }))).toThrow(/30 days/);
    expect(() => validateConfig(config({ maxBids: 501 }))).toThrow(/max_bids/);
    expect(() => validateConfig(config({ maxBids: 0 }))).toThrow(/max_bids/);
    expect(() => validateConfig(config({ revealWindowMs: 60_000 }))).toThrow(/CommitReveal sales only/);
    expect(() => validateConfig(config({ revealMode: "commit_reveal", revealWindowMs: 59_999 }))).toThrow(/reveal_window/);
    expect(() => validateConfig(config({ revealMode: "commit_reveal" }))).not.toThrow();
    expect(() => validateConfig(config({ decimals: 25 }))).toThrow(/decimals/);
  });

  it("validates sale ids with the contract's pattern", async () => {
    for (const saleId of ["Bad", "-a", "a.b", "a".repeat(33)]) {
      const e = await failure(client.createSale("me.testnet", config({ tokenSymbol: "IDS" }), META, { saleId }));
      expect(e.message, saleId).toBe("invalid sale_id: must match ^[a-z0-9]([a-z0-9_-]{0,30}[a-z0-9])?$");
    }
    const e = await failure(client.createSale("me.testnet", config({ tokenSymbol: "IDS" }), META, { saleId: "a--b" }));
    expect(e.message).toMatch(/<sale_id>\.<contract> must be a valid account id/);
  });

  it("creates a sale whose token account is <sale_id>.<contract>", async () => {
    expect(await client.getCreateCost("me.testnet", config({ tokenSymbol: "NEW1" }), META)).toBe(0n);
    const sale = await client.createSale("me.testnet", config({ tokenSymbol: "NEW1" }), META);
    expect(sale.id).toBe("new1");
    expect(sale.tokenAccount).toBe("new1.fairground.testnet");
    expect(sale.status).toBe("open");
    expect(sale.sealerCodeHash).toBe(SEALER_CODE_HASH);
    expect(sale.maxBids).toBe(500);
    const named = await client.createSale("me.testnet", config({ tokenSymbol: "NEW2" }), META, { saleId: "my-sale_2" });
    expect(named.tokenAccount).toBe("my-sale_2.fairground.testnet");
    const taken = await failure(client.createSale("me.testnet", config({ tokenSymbol: "NEW1" }), META));
    expect(taken.message).toMatch(/NEW1 is taken/);
    const dup = await failure(client.createSale("me.testnet", config({ tokenSymbol: "NEW3" }), META, { saleId: "my-sale_2" }));
    expect(dup.message).toBe("a sale with this id already exists");
  });
});

describe("a TEE sale, bid to claim", () => {
  it("rejects like the contract, penalises the void bid and pays everyone", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    const client = new MockClient();
    await client.ready();
    const [alice, bob, carol, dave] = ["alice.testnet", "bob.testnet", "carol.testnet", "dave.testnet"];
    const sale = await client.createSale("maker.testnet", config({ tokenSymbol: "TEE1", maxBids: 3 }), META);
    const id = sale.id;
    for (const who of [alice, bob, carol, dave]) await client.faucet(who, 100n * USDC);

    // A good bid, sealed by the client itself.
    const placed = await client.bid(id, alice, 5n * USDC, { maxPrice: 2000n, maxSpend: 5n * USDC });
    expect(placed).toMatchObject({ index: 0, bidder: alice, deposit: 5n * USDC, payloadKind: "ciphertext" });
    expect(placed.relay).toEqual({ paidBy: "relayer", fallbackReason: null, txHash: placed.txHash, status: "succeeded", requestId: null, simulated: true });
    expect(fromB64(placed.ciphertext).length).toBe(sealedBidLen(id, alice));
    expect((await client.getBid(id, alice))?.index).toBe(0);
    expect(await client.getBid(id, bob)).toBeNull();

    // A bid sealed for an account id of another length has the wrong length.
    const forAlice = await sealBid(sale.sealerPubkey, { sale_id: id, bidder: alice, max_price: "2000", max_spend: "5000000", salt: randomHex(16) });
    const wrong = await failure(client.placeBid(id, bob, 5n * USDC, forAlice));
    expect(wrong.code).toBe("bid_rejected");
    expect(wrong.reason).toBe("wrong_ciphertext_length");
    expect(wrong.message).toMatch(/Your deposit was returned\.$/);
    expect((await client.getBalances(bob)).usdc).toBe(100n * USDC);
    const rejected = (await client.getEvents(id)).find((e) => e.kind === "bid_rejected")!;
    expect(rejected).toMatchObject({ account: bob, reason: "wrong_ciphertext_length", source: "simulated" });

    // The other contract reasons, in the contract's words.
    expect((await failure(client.placeBid(id, bob, 5n * USDC, "!!!"))).reason).toBe("bad_base64");
    expect((await failure(client.placeBidPayload(id, bob, 5n * USDC, { commitment: "ab".repeat(32) }))).reason).toBe("wrong_payload");
    expect((await failure(client.placeBid(id, alice, 5n * USDC, forAlice))).reason).toBe("already_bid");
    const forDave = (spend: bigint) =>
      sealBid(sale.sealerPubkey, { sale_id: id, bidder: dave, max_price: "2000", max_spend: spend.toString(), salt: randomHex(16) });
    expect((await failure(client.placeBid(id, dave, USDC - 1n, await forDave(1n)))).reason).toBe("below_min_deposit");
    expect((await failure(client.placeBid(id, dave, 10n * USDC + 1n, await forDave(1n)))).reason).toBe("above_max_deposit");
    expect((await failure(client.placeBid("nope", dave, USDC, await forDave(1n)))).reason).toBe("unknown_sale");
    const poor = await failure(client.placeBid(id, "poor.testnet", USDC, forAlice));
    expect(poor).toMatchObject({ code: "invalid", reason: "insufficient_balance" });

    // bid() refuses terms that would be void, so an honest user never pays the penalty.
    const tooMuch = await failure(client.bid(id, bob, 5n * USDC, { maxPrice: 2000n, maxSpend: 6n * USDC }));
    expect(tooMuch.code).toBe("invalid");
    expect(tooMuch.message).toMatch(/lose 1 % of its deposit/);
    expect((await failure(client.bid(id, bob, 5n * USDC, { maxPrice: 999n, maxSpend: USDC }))).message).toMatch(/floor/);

    // The contract cannot see inside a sealed bid: one that spends more than its deposit gets in.
    const voidBid = await sealBid(sale.sealerPubkey, { sale_id: id, bidder: bob, max_price: "2000", max_spend: "5000001", salt: randomHex(16) });
    await client.placeBid(id, bob, 5n * USDC, voidBid);
    await client.bid(id, carol, 3n * USDC + 33n, { maxPrice: 1500n, maxSpend: 3n * USDC });
    // Three slots, three bids.
    expect((await failure(client.placeBid(id, dave, USDC, await forDave(1n)))).reason).toBe("sale_full");

    const bids = await client.getBids(id);
    expect((await client.getSale(id))!.runningBidSetHash).toBe(hashOf(id, bids));
    expect((await failure(client.closeSale(id, dave))).message).toBe("The bid window has not ended yet.");

    vi.setSystemTime(t0 + 61_000);
    expect((await client.getSale(id))!.status).toBe("awaiting_close");
    expect((await failure(client.placeBid(id, dave, USDC, await forDave(1n)))).reason).toBe("not_open");
    const closed = await client.closeSale(id, dave);
    expect(closed.status).toBe("clearing");
    expect(closed.bidSetHash).toBe(hashOf(id, bids));
    await until(async () => (await client.getSale(id))!.status === "settled");

    const result = (await client.getResult(id))!;
    expect(result.status).toBe("settled");
    expect(result.bidSetHash).toBe(closed.bidSetHash);
    expect(result.checks.every((c) => c.passed)).toBe(true);
    expect(result.clearingPrice).toBe(1000n); // undersubscribed: the floor
    const [fa, fb, fc] = result.fills;
    expect(fa).toMatchObject({ bidder: alice, valid: true, tokens: 5000n * TOKEN, spent: 5n * USDC, refund: 0n, penalty: 0n });
    expect(fb).toMatchObject({ bidder: bob, valid: false, invalidReason: "spend_above_deposit", tokens: 0n, spent: 0n });
    expect(fb.penalty).toBe(50_000n); // 1 % of 5 USDC
    expect(fb.refund).toBe(5n * USDC - 50_000n);
    expect(fc).toMatchObject({ bidder: carol, valid: true, tokens: 3000n * TOKEN, spent: 3n * USDC, refund: 33n, penalty: 0n });
    expect(result.totalPenalties).toBe(50_000n);
    expect(result.nValid).toBe(2);
    expect(result.nInvalid).toBe(1);
    expect(result.totalRaised).toBe(8n * USDC);
    expect(result.unsold).toBe(sale.config.saleSupply - 8000n * TOKEN);

    // Claims pay what the fill says; the penalty stays behind.
    const bobClaim = await client.claim(id, bob);
    expect(bobClaim).toMatchObject({ tokens: 0n, refund: 4_950_000n });
    expect(bobClaim.relay?.paidBy).toBe("relayer");
    expect((await client.getBalances(bob)).usdc).toBe(100n * USDC - 50_000n);
    await client.claim(id, alice);
    const aliceBalances = await client.getBalances(alice);
    expect(aliceBalances.usdc).toBe(95n * USDC);
    expect(aliceBalances.tokens[id]).toBe(5000n * TOKEN);
    expect((await failure(client.claim(id, alice))).reason).toBe("already_claimed");
    expect((await failure(client.claim(id, dave))).reason).toBe("no_bid");
    expect((await client.getBid(id, alice))?.claimed).toBe(true);

    // The creator is paid by claim_proceeds, once.
    expect((await client.getBalances("maker.testnet")).usdc).toBe(0n);
    const proceeds = await client.claimProceeds(id, dave);
    expect(proceeds.txHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{44}$/);
    expect((await client.getBalances("maker.testnet")).usdc).toBe(8n * USDC);
    expect((await client.getResult(id))!.proceeds?.raisePaid).toBe(true);
    expect((await failure(client.claimProceeds(id, dave))).reason).toBe("already_claimed");
    const paid = (await client.getEvents(id)).find((e) => e.detail === "proceeds_claimed")!;
    expect(paid).toMatchObject({ kind: "claimed", account: "maker.testnet", amount: 8n * USDC });

    const verification = await client.verifySale(id);
    expect(verification).toMatchObject({ simulated: true, pinnedWasm: SEALER_CODE_HASH });
    const runs = [verification.key, verification.clear];
    for (const run of runs) {
      expect(run).toMatchObject({ found: true, simulated: true, txSource: "simulated" });
      if (!run?.found) throw new Error("no run");
      // The same eight rows NEAR mode shows, every one passing on the simulated run.
      expect(run.checks.map((c) => c.id)).toEqual(["build", "executed", "input", "output", "task", "measurements", "request", "key"]);
      expect(run.checks.every((c) => c.ok === true)).toBe(true);
    }
    const output = verification.clear?.found ? verification.clear.checks.find((c) => c.id === "output")! : null;
    expect(output?.items[0]).toMatchObject({ kind: "equal", values: expect.arrayContaining([{ label: "contract stored", value: result.resultSha256 }]) });
  }, 60_000);

  it("fails a sale closed without bids", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    const client = new MockClient();
    await client.ready();
    const sale = await client.createSale("maker.testnet", config({ tokenSymbol: "NOBID" }), META);
    vi.setSystemTime(t0 + 61_000);
    const closed = await client.closeSale(sale.id, "anyone.testnet");
    expect(closed.status).toBe("failed");
    expect(closed.chainFailReason).toBe("no_bids");
    const result = (await client.getResult(sale.id))!;
    expect(result).toMatchObject({ status: "failed", failReason: "no_valid_bids", chainFailReason: "no_bids", checks: [], fills: [], clearedBy: "none" });
  }, 30_000);
});

describe("a commit-reveal sale", () => {
  it("clears on chain and penalises unrevealed and void bids", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    const client = new MockClient();
    await client.ready();
    const [alice, bob, carol, dave] = ["alice.testnet", "bob.testnet", "carol.testnet", "dave.testnet"];
    const sale = await client.createSale(
      "maker.testnet",
      config({ tokenSymbol: "CR1", revealMode: "commit_reveal", revealWindowMs: 60_000 }),
      META,
    );
    const id = sale.id;
    for (const who of [alice, bob, carol]) await client.faucet(who, 100n * USDC);

    // bid() commits and keeps the salt in this browser's scope for the mock.
    const a = await client.bid(id, alice, 5n * USDC, { maxPrice: 3000n, maxSpend: 4n * USDC });
    expect(a.payloadKind).toBe("commitment");
    expect(a.revealed).toBe(false);
    expect(a.secret?.commitment).toMatch(/^[0-9a-f]{64}$/);
    expect(a.secret?.commitment).toBe(bidCommitment({ saleId: id, bidder: alice, maxPrice: 3000n, maxSpend: 4n * USDC, salt: a.secret!.salt }));
    expect(fromB64(a.ciphertext).length).toBe(32);
    const stored = getBidSecret(MOCK_SECRETS_SCOPE, id, alice)!;
    expect(stored).toMatchObject({ salt: a.secret!.salt, maxPrice: "3000", maxSpend: "4000000", deposit: "5000000" });
    expect(getBidSecret(CONTRACT_ID, id, alice)).toBeNull();
    // A second bid never replaces the secret of the bid that is in the sale.
    expect((await failure(client.bid(id, alice, 5n * USDC, { maxPrice: 3000n, maxSpend: USDC }))).reason).toBe("already_bid");
    expect(getBidSecret(MOCK_SECRETS_SCOPE, id, alice)!.salt).toBe(a.secret!.salt);

    await client.bid(id, bob, 7n * USDC + 1n, { maxPrice: 2000n, maxSpend: 7n * USDC }); // will not reveal
    // Committed terms the rules refuse (spend above the deposit): revealed, still void.
    const carolSalt = randomHex(16);
    const carolTerms = { maxPrice: 2000n, maxSpend: 6n * USDC, salt: carolSalt };
    await client.placeBidPayload(id, carol, 5n * USDC, { commitment: bidCommitment({ saleId: id, bidder: carol, ...carolTerms }) });

    expect((await failure(client.placeBidPayload(id, dave, USDC, { commitment: "zz" }))).reason).toBe("insufficient_balance");
    await client.faucet(dave, USDC);
    expect((await failure(client.placeBidPayload(id, dave, USDC, { commitment: "zz" }))).reason).toBe("bad_hex");
    expect((await failure(client.placeBidPayload(id, dave, USDC, { ciphertext: "AAAA" }))).reason).toBe("wrong_payload");
    expect((await failure(client.revealBid(id, alice))).reason).toBe("wrong_phase");

    const bids = await client.getBids(id);
    vi.setSystemTime(t0 + 61_000);
    const closed = await client.closeSale(id, dave);
    expect(closed.status).toBe("revealing");
    expect(closed.revealEnd).toBe(closed.closedAt! + 60_000);
    expect(closed.refundModeFrom).toBe(closed.revealEnd! + sale.config.settleTimeoutMs);
    expect(closed.bidSetHash).toBe(hashOf(id, bids));
    expect((await failure(client.clearOnchain(id, dave))).message).toBe("The reveal window has not ended yet.");

    // Reveals: the stored secret, explicit terms, and the refusals.
    const revealed = await client.revealBid(id, alice);
    expect(revealed.relay?.paidBy).toBe("relayer");
    expect((await client.getBid(id, alice))?.revealed).toBe(true);
    expect((await failure(client.revealBid(id, alice))).reason).toBe("already_revealed");
    expect((await failure(client.revealBid(id, carol))).reason).toBe("missing_secret");
    expect((await failure(client.revealBid(id, carol, { ...carolTerms, maxSpend: 5n * USDC }))).reason).toBe("commitment_mismatch");
    await client.revealBid(id, carol, carolTerms);
    expect((await failure(client.revealBid(id, dave))).reason).toBe("no_bid");
    expect((await client.getEvents(id)).filter((e) => e.detail === "bid_revealed")).toHaveLength(2);

    vi.setSystemTime(closed.revealEnd! + 1);
    expect((await failure(client.revealBid(id, bob))).message).toBe("The reveal window has ended.");
    const cleared = await client.clearOnchain(id, dave);
    expect(cleared.status).toBe("settled");
    expect(cleared.relay?.paidBy).toBe("relayer");
    expect((await failure(client.clearOnchain(id, dave))).reason).toBe("wrong_phase");

    const result = (await client.getResult(id))!;
    expect(result.clearedBy).toBe("onchain");
    expect(result.checks).toEqual([
      expect.objectContaining({ id: "onchain", passed: true }),
      expect.objectContaining({ id: "raise_at_least_min", passed: true }),
    ]);
    const [fa, fb, fc] = result.fills;
    expect(fa).toMatchObject({ bidder: alice, valid: true, revealed: true, tokens: 4000n * TOKEN, spent: 4n * USDC, refund: USDC, penalty: 0n });
    // Not revealed: void, 1 % of 7.000001 USDC rounded up.
    expect(fb).toMatchObject({ bidder: bob, valid: false, revealed: false, tokens: 0n, penalty: 70_001n, refund: 7n * USDC + 1n - 70_001n });
    // Revealed but against the rules: void too, same penalty rule.
    expect(fc).toMatchObject({ bidder: carol, valid: false, revealed: true, invalidReason: "spend_above_deposit", penalty: 50_000n, refund: 4_950_000n });
    expect(result.totalPenalties).toBe(120_001n);
    expect(result.nValid).toBe(1);
    expect(result.nInvalid).toBe(2);

    expect((await client.claim(id, bob)).refund).toBe(7n * USDC + 1n - 70_001n);
    expect((await client.getBalances(bob)).usdc).toBe(100n * USDC - 70_001n);
  }, 60_000);

  it("keeps the penalty when the sale then fails", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    const client = new MockClient();
    await client.ready();
    const sale = await client.createSale(
      "maker.testnet",
      config({ tokenSymbol: "CR2", revealMode: "commit_reveal", revealWindowMs: 60_000, minRaise: 50n * USDC }),
      META,
    );
    for (const who of ["alice.testnet", "bob.testnet"]) await client.faucet(who, 100n * USDC);
    await client.bid(sale.id, "alice.testnet", 5n * USDC, { maxPrice: 3000n, maxSpend: 5n * USDC });
    await client.bid(sale.id, "bob.testnet", 2n * USDC, { maxPrice: 3000n, maxSpend: 2n * USDC });
    vi.setSystemTime(t0 + 61_000);
    const closed = await client.closeSale(sale.id, "anyone.testnet");
    await client.revealBid(sale.id, "alice.testnet");
    vi.setSystemTime(closed.revealEnd!);
    const cleared = await client.clearOnchain(sale.id, "anyone.testnet");
    expect(cleared.status).toBe("failed");
    expect(cleared.chainFailReason).toBe("below_min_raise");
    const result = (await client.getResult(sale.id))!;
    expect(result.failReason).toBe("below_min_raise");
    expect(result.checks.filter((c) => !c.passed).map((c) => c.id)).toEqual(["raise_at_least_min"]);
    expect(result.fills[0]).toMatchObject({ valid: true, tokens: 0n, refund: 5n * USDC, penalty: 0n });
    expect(result.fills[1]).toMatchObject({ valid: false, tokens: 0n, refund: 2n * USDC - 20_000n, penalty: 20_000n });
    expect(result.totalPenalties).toBe(20_000n);
    expect(result.unsold).toBe(sale.config.saleSupply);
  }, 30_000);
});

describe("judge mode", () => {
  it("runs start to finish and voids the copycat", async () => {
    const client = new MockClient();
    await client.ready();
    const steps: string[] = [];
    const started = performance.now();
    const saleId = await client.runJudgeMode({
      windowSeconds: 1,
      onProgress: (p) => {
        if (steps.at(-1) !== p.step) steps.push(p.step);
      },
    });
    expect(performance.now() - started).toBeLessThan(25_000);
    expect(steps).toEqual(["create", "key", "bots", "crowd", "copycat", "window", "close", "clearing", "done"]);
    const sale = (await client.getSale(saleId))!;
    const result = (await client.getResult(saleId))!;
    const bids = await client.getBids(saleId);
    expect(sale.isJudgeSale).toBe(true);
    expect(sale.status).toBe("settled");
    expect(bids).toHaveLength(54); // 3 bots, 50 people, 1 copycat
    expect(sale.bidSetHash).toBe(hashOf(saleId, bids));
    expect(result.checks.every((c) => c.passed)).toBe(true);
    const voided = result.fills.filter((f) => !f.valid);
    expect(voided).toHaveLength(1);
    expect(voided[0]).toMatchObject({ invalidReason: "bidder_mismatch", tokens: 0n, tag: "bot" });
    expect(voided[0].penalty).toBe(invalidBidPenalty(voided[0].deposit));
    expect(voided[0].refund).toBe(voided[0].deposit - voided[0].penalty!);
    expect(result.totalPenalties).toBe(voided[0].penalty);
    // Bots and people pay the same price.
    const prices = new Set(result.fills.filter((f) => f.tokens > 0n).map((f) => (f.spent * TOKEN) / f.tokens));
    expect(prices.size).toBeLessThanOrEqual(2); // equal up to the rounding of one base unit
    // The launch pool: 20 % of the raise at the clearing price, seeded right after settlement (simulated).
    expect(sale.config.liquidity).toMatchObject({ raiseShareBps: 2000, feeBps: 30 });
    expect(result.liquidity).toMatchObject({ stage: "seeded", simulated: true, inFlight: null, failures: 0 });
    const pool = result.liquidity!;
    expect(pool).toMatchObject(planFor(sale.config, result.totalRaised, result.clearingPrice));
    expect(pool.tokens).toBeGreaterThan(0n);
    expect(poolPriceMatches(pool.usdc, pool.tokens, result.clearingPrice, sale.config.decimals)).toBe(true);
    expect(result.proceeds?.allocationLocked).toBeUndefined();
  }, 40_000);
});
