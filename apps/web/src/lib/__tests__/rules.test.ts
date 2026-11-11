/** The contract's rules as both clients apply them (client/rules.ts), and the error helpers. */
import { describe, expect, it } from "vitest";
import {
  BID_REJECT_MESSAGES,
  FairgroundError,
  RELAYER_REFUSAL_MESSAGES,
  bidRejected,
  contractMessage,
  errorInfo,
  failureText,
  isMaybeSubmitted,
  relayerRefusalMessage,
} from "../client/errors";
import {
  MAX_CIPHERTEXT_BYTES,
  MIN_DEPOSIT_FLOOR,
  appFailReason,
  bidTermsProblem,
  checkClearOutput,
  checkRows,
  ciphertextProblem,
  commitmentProblem,
  invalidBidPenalty,
  outcomeReason,
  saleIdError,
  tokenAccountOf,
  unsoldOf,
  validSaleId,
  type CheckedSale,
  type SealerClearOutput,
} from "../client/rules";
import { sealedBidLen, toB64 } from "../crypto";

describe("sale ids", () => {
  it("follow the contract's pattern (the cases of sale.rs)", () => {
    for (const ok of ["a", "7", "fairt", "my-sale_1", "a-b", "a".repeat(32)]) expect(validSaleId(ok), ok).toBe(true);
    for (const bad of ["", "-a", "a-", "_", "A", "a.b", "a b", "a".repeat(33), "ä"]) expect(validSaleId(bad), bad).toBe(false);
  });

  it("must also make a valid token account", () => {
    expect(tokenAccountOf("fairt", "fairground.testnet")).toBe("fairt.fairground.testnet");
    expect(saleIdError("fairt", "fairground.testnet")).toBeNull();
    expect(saleIdError("Fairt", "fairground.testnet")).toMatch(/^invalid sale_id: must match/);
    // Fine as a sale id, not as part of an account id.
    expect(saleIdError("a--b", "fairground.testnet")).toMatch(/valid account id/);
    expect(saleIdError("a_-b", "fairground.testnet")).toMatch(/valid account id/);
    // 32 + 1 + 32 = 65 characters: one too many for an account id.
    expect(saleIdError("a".repeat(32), "b".repeat(32))).toMatch(/at most 64 characters/);
    expect(saleIdError("a".repeat(32), "b".repeat(31))).toBeNull();
  });
});

describe("the invalid-bid penalty", () => {
  it("is 1 % of the deposit, rounded up", () => {
    expect(invalidBidPenalty(0n)).toBe(0n);
    expect(invalidBidPenalty(1n)).toBe(1n);
    expect(invalidBidPenalty(100n)).toBe(1n);
    expect(invalidBidPenalty(101n)).toBe(2n);
    expect(invalidBidPenalty(MIN_DEPOSIT_FLOOR)).toBe(10_000n);
    expect(invalidBidPenalty(5_000_001n)).toBe(50_001n);
    expect(invalidBidPenalty(10_000_000n)).toBe(100_000n);
  });
});

describe("bid payloads", () => {
  const saleId = "fairt";
  const bidder = "alice.testnet";
  const box = (bytes: number) => toB64(new Uint8Array(bytes).fill(7));

  it("accepts only a sealed bid of the exact length", () => {
    const exact = sealedBidLen(saleId, bidder);
    expect(exact).toBe(224 + 5 + 13);
    expect(ciphertextProblem(box(exact), saleId, bidder)).toBeNull();
    expect(ciphertextProblem(box(exact - 1), saleId, bidder)).toBe("wrong_ciphertext_length");
    expect(ciphertextProblem(box(exact + 1), saleId, bidder)).toBe("wrong_ciphertext_length");
    // The same box under an account id of another length is refused.
    expect(ciphertextProblem(box(exact), saleId, "bob.testnet")).toBe("wrong_ciphertext_length");
    expect(ciphertextProblem(box(exact), saleId, "carol.testnet")).toBeNull();
  });

  it("names the other refusals in the contract's order", () => {
    expect(MAX_CIPHERTEXT_BYTES).toBe(320);
    expect(ciphertextProblem("", saleId, bidder)).toBe("bad_base64");
    expect(ciphertextProblem("not base64!", saleId, bidder)).toBe("bad_base64");
    // Canonical padded base64 only.
    expect(ciphertextProblem(box(242).replace(/=+$/, ""), "s", "ab")).toBe("bad_base64");
    expect(ciphertextProblem(box(MAX_CIPHERTEXT_BYTES + 1), saleId, bidder)).toBe("ciphertext_too_long");
    expect(ciphertextProblem("A".repeat(1000), saleId, bidder)).toBe("ciphertext_too_long");
  });

  it("checks a commitment's shape", () => {
    expect(commitmentProblem("ab".repeat(32))).toBeNull();
    expect(commitmentProblem("AB".repeat(32))).toBeNull();
    expect(commitmentProblem("ab".repeat(31))).toBe("bad_hex");
    expect(commitmentProblem("zz".repeat(32))).toBe("bad_hex");
  });

  it("spots terms that would be void at clearing", () => {
    expect(bidTermsProblem({ maxPrice: 1000n, maxSpend: 5n }, 5n, 1000n)).toBeNull();
    expect(bidTermsProblem({ maxPrice: 1000n, maxSpend: 0n }, 5n, 1000n)).toMatch(/above zero/);
    expect(bidTermsProblem({ maxPrice: 1000n, maxSpend: 6n }, 5n, 1000n)).toMatch(/more than the deposit/);
    expect(bidTermsProblem({ maxPrice: 999n, maxSpend: 5n }, 5n, 1000n)).toMatch(/floor/);
  });
});

describe("the clearing result checks", () => {
  const ONE = 10n ** 18n;
  const sale: CheckedSale = {
    saleId: "fairt",
    bidSetHash: "aa".repeat(32),
    sealerPubkey: "bb".repeat(32),
    deposits: [5_000_000n, 5_000_000n, 2_000_000n],
    floorPrice: 1000n,
    maxPrice: null,
    saleSupply: 10_000n * ONE,
    minRaise: 1_000_000n,
    decimals: 18,
  };
  // 2000 tokens at 1000 per whole token cost 2,000,000; bid 2 is void.
  const good: SealerClearOutput = {
    saleId: "fairt",
    bidSetHash: "aa".repeat(32),
    pubkey: "bb".repeat(32),
    clearingPrice: 1000n,
    nValid: 2,
    nInvalid: 1,
    invalid: [2],
    fills: [
      [2000n * ONE, 2_000_000n],
      [1000n * ONE, 1_000_000n],
      [0n, 0n],
    ],
  };

  it("pass a correct result", () => {
    expect(checkClearOutput(sale, good)).toEqual({
      failed: [],
      integrityFailed: false,
      sold: 3000n * ONE,
      raised: 3_000_000n,
    });
    expect(outcomeReason(3000n * ONE, 3_000_000n, 2, sale.minRaise)).toBeNull();
  });

  it("name each integrity failure", () => {
    const failing: [Partial<SealerClearOutput>, string][] = [
      [{ saleId: "other" }, "sale_id_matches"],
      [{ bidSetHash: "cc".repeat(32) }, "bid_set_hash_matches"],
      [{ pubkey: "cc".repeat(32) }, "pubkey_matches"],
      [{ fills: good.fills.slice(0, 2) }, "one_fill_per_bid"],
      [{ invalid: [3] }, "invalid_list_matches"],
      [{ invalid: [] }, "invalid_list_matches"],
      [{ nValid: 3 }, "invalid_list_matches"],
      [{ clearingPrice: 999n }, "price_at_least_floor"],
      [{ fills: [[2000n * ONE, 2_000_001n], good.fills[1], good.fills[2]] }, "spent_equals_tokens_times_price_0"],
      [{ fills: [good.fills[0], good.fills[1], [3000n * ONE, 3_000_000n]] }, "spent_within_deposit_2"],
      [{ fills: [good.fills[0], good.fills[1], [1000n * ONE, 1_000_000n]] }, "invalid_bid_unfilled_2"],
      [{ fills: [[20_000n * ONE, 20_000_000n], good.fills[1], good.fills[2]] }, "sold_at_most_supply"],
    ];
    for (const [patch, name] of failing) {
      const report = checkClearOutput(sale, { ...good, ...patch });
      expect(report.failed, name).toContain(name);
      expect(report.integrityFailed, name).toBe(true);
    }
    expect(checkClearOutput({ ...sale, maxPrice: 900n }, good).failed).toContain("price_at_most_ceiling");
    expect(checkClearOutput({ ...sale, sealerPubkey: null }, good).failed).toContain("pubkey_matches");
  });

  it("treat a low raise and nothing sold as outcomes, not integrity failures", () => {
    const low = checkClearOutput({ ...sale, minRaise: 4_000_000n }, good);
    expect(low).toMatchObject({ failed: ["raise_at_least_min"], integrityFailed: false });
    const none = checkClearOutput(sale, { ...good, nValid: 0, nInvalid: 3, invalid: [0, 1, 2], fills: [[0n, 0n], [0n, 0n], [0n, 0n]] });
    expect(none).toMatchObject({ failed: ["raise_at_least_min", "something_sold"], integrityFailed: false });
    expect(outcomeReason(0n, 0n, 0, 1n)).toBe("no_valid_bids");
    expect(outcomeReason(0n, 0n, 2, 1n)).toBe("below_min_raise");
    expect(outcomeReason(0n, 0n, 2, 0n)).toBe("nothing_sold");
    expect(outcomeReason(5n, 5n, 2, 6n)).toBe("below_min_raise");
  });

  it("turn failed names into the rows the UI lists", () => {
    const rows = checkRows([], { clearedBy: "enclave", hasCeiling: false });
    expect(rows.every((r) => r.passed)).toBe(true);
    expect(rows.map((r) => r.id)).not.toContain("price_at_most_ceiling");
    expect(checkRows([], { clearedBy: "enclave", hasCeiling: true }).map((r) => r.id)).toContain("price_at_most_ceiling");
    // Below the minimum raise shows exactly one failing row, even when nothing sold.
    const low = checkRows(["raise_at_least_min", "something_sold"], { clearedBy: "enclave", hasCeiling: false });
    expect(low.filter((r) => !r.passed).map((r) => r.id)).toEqual(["raise_at_least_min"]);
    // Per-bid names share a row.
    const perBid = checkRows(["spent_within_deposit_3", "spent_within_deposit_17"], { clearedBy: "enclave", hasCeiling: false });
    expect(perBid.filter((r) => !r.passed).map((r) => r.id)).toEqual(["spent_within_deposit"]);
    expect(checkRows(["something_sold"], { clearedBy: "onchain", hasCeiling: false })).toEqual([
      expect.objectContaining({ id: "onchain", passed: true }),
      expect.objectContaining({ id: "raise_at_least_min", passed: false }),
    ]);
  });

  it("map the contract's fail reasons to the app's", () => {
    expect(appFailReason("refund_mode")).toBe("settle_timeout");
    expect(appFailReason("below_min_raise")).toBe("below_min_raise");
    expect(appFailReason("nothing_sold")).toBe("below_min_raise");
    expect(appFailReason("no_bids")).toBe("no_valid_bids");
    expect(appFailReason("no_valid_bids")).toBe("no_valid_bids");
    expect(appFailReason("checks_failed")).toBeUndefined();
    expect(appFailReason(null)).toBeUndefined();
  });

  it("count unsold tokens like get_result", () => {
    const base = { saleSupply: 100n, totalSold: 60n };
    expect(unsoldOf({ ...base, final: false, settled: false, tokenDeployed: true })).toBe(0n);
    expect(unsoldOf({ ...base, final: true, settled: true, tokenDeployed: true })).toBe(40n);
    expect(unsoldOf({ ...base, final: true, settled: false, tokenDeployed: true })).toBe(100n);
    // Nothing exists to burn while the token is not deployed.
    expect(unsoldOf({ ...base, final: true, settled: false, tokenDeployed: false })).toBe(0n);
    expect(unsoldOf({ ...base, final: true, settled: true, tokenDeployed: false })).toBe(0n);
  });
});

describe("errors", () => {
  it("say a rejected bid's deposit came back", () => {
    const e = bidRejected("wrong_ciphertext_length");
    expect(e).toBeInstanceOf(FairgroundError);
    expect(e.code).toBe("bid_rejected");
    expect(e.reason).toBe("wrong_ciphertext_length");
    expect(e.message).toBe(`${BID_REJECT_MESSAGES.wrong_ciphertext_length} Your deposit was returned.`);
    expect(e.maybeSubmitted).toBe(false);
    expect(bidRejected("below_min_deposit", "Minimum deposit is 1 USDC.").message).toBe(
      "Minimum deposit is 1 USDC. Your deposit was returned.",
    );
    expect(bidRejected("brand_new_reason").message).toMatch(/brand_new_reason/);
  });

  it("have text for every bid rejection and every relayer code", () => {
    for (const text of [...Object.values(BID_REJECT_MESSAGES), ...Object.values(RELAYER_REFUSAL_MESSAGES)]) {
      expect(text.length).toBeGreaterThan(10);
    }
    for (const code of ["wrong_ciphertext_length", "needs_full_access_key", "expired", "sender_busy", "nonce_already_used"]) {
      expect(relayerRefusalMessage(code)).toBe(RELAYER_REFUSAL_MESSAGES[code as keyof typeof RELAYER_REFUSAL_MESSAGES]);
    }
    expect(relayerRefusalMessage("some_future_code")).toMatch(/some_future_code/);
    // Every answer that leaves the call possibly on chain says so.
    for (const code of ["internal_error", "timeout", "network_error", "bad_response"] as const) {
      expect(RELAYER_REFUSAL_MESSAGES[code]).toMatch(/may still land/);
    }
  });

  it("read the contract's words out of an RPC failure", () => {
    const failure = {
      ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: unknown sale" } } },
    };
    expect(failureText(failure)).toBe("unknown sale");
    expect(contractMessage(failureText(failure))).toBe("There is no sale with this id.");
    expect(contractMessage("cannot claim: sale is awaiting_close")).toBe("Cannot claim: the sale is awaiting close.");
    expect(contractMessage("cannot close the sale before 1700000000000000000 ns")).toBe("The bid window has not ended yet.");
    expect(contractMessage("the reveal does not match the commitment")).toMatch(/salt saved when you bid/);
    expect(contractMessage("something else")).toBe("something else");
    expect(failureText({ odd: 1 })).toBe('{"odd":1}');
  });

  it("give the UI one shape for any thrown value", () => {
    const relay = { paidBy: "relayer", fallbackReason: null, txHash: null, status: "pending", requestId: "req-1", simulated: false } as const;
    const lost = new FairgroundError("maybe_submitted", "The relayer did not answer in time. The call may still land.", {
      reason: "timeout",
      maybeSubmitted: true,
      requestId: "req-1",
      relay,
    });
    expect(isMaybeSubmitted(lost)).toBe(true);
    expect(errorInfo(lost)).toEqual({
      code: "maybe_submitted",
      message: "The relayer did not answer in time. The call may still land.",
      reason: "timeout",
      maybeSubmitted: true,
      requestId: "req-1",
      txHash: null,
      relay,
    });
    expect(errorInfo(new Error("boom"))).toMatchObject({ code: "unknown", message: "boom", maybeSubmitted: false, requestId: null });
    expect(errorInfo("text")).toMatchObject({ code: "unknown", message: "text" });
    expect(isMaybeSubmitted(new Error("boom"))).toBe(false);
  });
});
