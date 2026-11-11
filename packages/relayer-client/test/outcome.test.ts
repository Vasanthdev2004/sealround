import { describe, expect, it } from "vitest";
import { bidOutcome, summarizeOutcome } from "../src/outcome";
import { ALICE, FAIRGROUND, USDC } from "./helpers";

const event = (name: string, data: unknown, standard = "fairground") =>
  `EVENT_JSON:${JSON.stringify({ standard, version: "1.0.0", event: name, data })}`;

/** A paid bid as the RPC reports it: USDC ft_transfer_call, Fairground ft_on_transfer, USDC resolve. */
const paidBid = {
  status: { SuccessValue: "IjAi" },
  transaction: { hash: "TxHash", signer_id: ALICE },
  transaction_outcome: { id: "TxHash", outcome: { executor_id: ALICE, status: { SuccessReceiptId: "r1" }, logs: [] } },
  receipts_outcome: [
    { id: "r1", outcome: { executor_id: USDC, status: { SuccessReceiptId: "r3" }, logs: [event("ft_transfer", {}, "nep141")] } },
    {
      id: "r2",
      outcome: {
        executor_id: FAIRGROUND,
        status: { SuccessValue: "IjAi" },
        logs: ["a plain log line", event("bid_placed", { sale_id: "fairt", bidder: ALICE, index: 0 })],
      },
    },
    // Another contract cannot fake a Fairground event.
    { id: "r3", outcome: { executor_id: USDC, status: { SuccessValue: "IjIwMDAwMDAi" }, logs: [event("bid_placed", { forged: true })] } },
  ],
};

describe("summarizeOutcome", () => {
  it("reads the hash, the status from every receipt, and Fairground's own events", () => {
    expect(summarizeOutcome(paidBid, FAIRGROUND)).toEqual({
      txHash: "TxHash",
      status: "succeeded",
      failures: [],
      events: [{ event: "bid_placed", data: { sale_id: "fairt", bidder: ALICE, index: 0 } }],
    });
  });

  it("reports an inner failure even when the top-level status is a success", () => {
    const failure = { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: no sale" } } } };
    const failed = structuredClone(paidBid);
    failed.receipts_outcome[1]!.outcome.status = { Failure: failure } as never;
    expect(summarizeOutcome(failed, FAIRGROUND)).toMatchObject({
      status: "failed",
      failures: [{ receipt_id: "r2", executor_id: FAIRGROUND, error: failure }],
    });
  });

  it("ignores events of a Fairground receipt that failed: its logs stay, its state change does not", () => {
    const outOfGas = { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "Exceeded the prepaid gas." } } } };
    const failed = structuredClone(paidBid);
    failed.receipts_outcome[1]!.outcome.status = { Failure: outOfGas } as never;
    const summary = summarizeOutcome(failed, FAIRGROUND);
    expect(summary.events).toEqual([]);
    expect(bidOutcome(summary.events)).toEqual({ kind: "unknown" });
  });

  it.each([
    ["nothing", undefined, null],
    ["a bare transaction", { transaction: { hash: "OnlyHash" } }, "OnlyHash"],
    ["unreadable receipts", { ...paidBid, receipts_outcome: [{ id: 5 }] }, "TxHash"],
  ])("answers pending for %s", (_label, value, txHash) => {
    expect(summarizeOutcome(value, FAIRGROUND)).toEqual({ txHash, status: "pending", failures: [], events: [] });
  });
});

describe("bidOutcome", () => {
  it("tells a placed bid from a refunded one", () => {
    expect(bidOutcome([{ event: "bid_placed", data: {} }])).toEqual({ kind: "placed" });
    expect(bidOutcome([{ event: "bid_rejected", data: { reason: "below_min_deposit" } }])).toEqual({
      kind: "rejected",
      reason: "below_min_deposit",
    });
    expect(bidOutcome([{ event: "claimed", data: {} }])).toEqual({ kind: "unknown" });
    expect(bidOutcome([])).toEqual({ kind: "unknown" });
  });

  it("passes on a reason it has no list of, as the contract's wrong_ciphertext_length", () => {
    // What Fairground logs when it refunds a sealed bid of the wrong length sent past the relayer.
    const refunded = structuredClone(paidBid);
    const rejected = { sale_id: "fairt", sender_id: ALICE, token: USDC, amount: "2000000", reason: "wrong_ciphertext_length" };
    refunded.receipts_outcome[1]!.outcome.logs = [event("bid_rejected", rejected)];
    const summary = summarizeOutcome(refunded, FAIRGROUND);
    expect(summary).toMatchObject({ status: "succeeded", events: [{ event: "bid_rejected", data: rejected }] });
    expect(bidOutcome(summary.events)).toEqual({ kind: "rejected", reason: "wrong_ciphertext_length" });
  });

  it("keeps event data as logged, so new fields such as penalties reach the app", () => {
    const settled = structuredClone(paidBid);
    const data = { sale_id: "fairt", n_valid: 1, n_invalid: 1, total_penalties: "30000" };
    settled.receipts_outcome[1]!.outcome.logs = [event("sale_settled", data)];
    expect(summarizeOutcome(settled, FAIRGROUND).events).toEqual([{ event: "sale_settled", data }]);
  });
});
