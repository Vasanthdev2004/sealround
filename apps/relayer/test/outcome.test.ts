import { describe, expect, it } from "vitest";
import type { TxOutcome } from "../src/chain.ts";
import { relayerCost, summarizeOutcome } from "../src/outcome.ts";
import { ALICE, FAIRGROUND, RELAYER, USDC } from "./fixtures.ts";

type Status = TxOutcome["receipts_outcome"][number]["outcome"]["status"];

const receipt = (id: string, executor: string, status: Status, tokensBurnt: string, logs: string[] = []) => ({
  id,
  block_hash: "",
  proof: [],
  outcome: { executor_id: executor, status, tokens_burnt: tokensBurnt, gas_burnt: 0, logs, receipt_ids: [] },
});

const event = (standard: string, name: string, data: unknown) =>
  `EVENT_JSON:${JSON.stringify({ standard, version: "1.0.0", event: name, data })}`;

/** Shaped like sandbox experiment E3: the top level says success while Fairground's receipt failed. */
const outcome = {
  final_execution_status: "EXECUTED_OPTIMISTIC",
  status: { SuccessValue: "" },
  transaction: {},
  transaction_outcome: receipt("tx", RELAYER, { SuccessReceiptId: "r1" }, "100"),
  receipts_outcome: [
    receipt("r1", ALICE, { SuccessValue: "" }, "10"),
    receipt("r2", USDC, { SuccessReceiptId: "r3" }, "20", [event("nep141", "ft_transfer", [])]),
    // Logged, then out of gas: the logs stay, the bid does not.
    receipt("r3", FAIRGROUND, { Failure: { ActionError: { index: 0, kind: "DelegateActionExpired" } } }, "30", [
      event("fairground", "bid_placed", { sale_id: "fairt" }),
    ]),
    receipt("r4", USDC, { SuccessValue: "" }, "5", [event("fairground", "forged_by_another_contract", {})]),
    receipt("r5", RELAYER, { SuccessValue: "" }, "0"),
    receipt("r6", FAIRGROUND, { SuccessValue: "IjAi" }, "0", [
      event("fairground", "bid_rejected", { reason: "not_open" }),
      "plain log",
      "EVENT_JSON:{broken",
    ]),
  ],
} as unknown as TxOutcome;

describe("summarizeOutcome", () => {
  const summary = summarizeOutcome(outcome, FAIRGROUND, 1n);

  it("finds an inner failure the top-level status hides", () => {
    expect(summary.failures).toEqual([{ receipt_id: "r3", executor_id: FAIRGROUND, error: { ActionError: { index: 0, kind: "DelegateActionExpired" } } }]);
  });

  it("keeps only fairground events of Fairground receipts that succeeded", () => {
    expect(summary.events).toEqual([{ event: "bid_rejected", data: { reason: "not_open" } }]);
  });

  it("counts tokens burnt by every outcome plus the deposits", () => {
    expect(summary.relayer_cost).toBe("166");
    expect(relayerCost(outcome, 0n)).toBe(165n);
  });
});
