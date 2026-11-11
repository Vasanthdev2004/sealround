import type { RejectionReason, RelayResponse } from "@fairground/relayer/api";
import { describe, expect, it } from "vitest";
import { bidAction, type FairgroundAction } from "../src/actions";
import { RelayerError, type RelayerClient, type TransportFailure } from "../src/relayer";
import type { ActionSigner } from "../src/signers";
import { submitAction, type FallbackReason } from "../src/submit";
import { ALICE, CIPHERTEXT, FAIRGROUND, USDC } from "./helpers";

const bid = bidAction(USDC, FAIRGROUND, "fairt", 2_000_000n, { ciphertext: CIPHERTEXT, bidder: ALICE });
const placed = `EVENT_JSON:${JSON.stringify({ standard: "fairground", event: "bid_placed", data: { sale_id: "fairt" } })}`;
const paidOutcome = {
  transaction_outcome: { id: "PaidTx", outcome: { executor_id: "alice.test.near", status: { SuccessReceiptId: "r" }, logs: [] } },
  receipts_outcome: [{ id: "r", outcome: { executor_id: FAIRGROUND, status: { SuccessValue: "" }, logs: [placed] } }],
};

/** A signer that records what it was asked to do. */
function recordingSigner({ delegates = true } = {}) {
  const log: string[] = [];
  const signer: ActionSigner = {
    signsDelegates: delegates,
    signDelegate: async (action: FairgroundAction) => (log.push(`sign ${action.methodName}`), "SIGNED"),
    sendTransaction: async (action: FairgroundAction) => (log.push(`send ${action.methodName}`), paidOutcome),
  };
  return { signer, log };
}

function relayerAnswering(answer: RelayResponse | RelayerError) {
  const relayed: string[] = [];
  const relayer: RelayerClient = {
    relay: async (signedDelegate) => {
      relayed.push(signedDelegate);
      if (answer instanceof RelayerError) throw answer;
      return answer;
    },
    sponsorStorage: async () => {
      throw new Error("not used");
    },
    getPolicy: async () => {
      throw new Error("not used");
    },
  };
  return { relayer, relayed };
}

const refusal = (reason: RejectionReason | TransportFailure, maybeSubmitted = false) =>
  new RelayerError(reason, { status: maybeSubmitted ? null : 400, requestId: null, maybeSubmitted });

describe("submitAction", () => {
  it("relays a delegate: the relayer pays", async () => {
    const { signer, log } = recordingSigner();
    const { relayer, relayed } = relayerAnswering({
      tx_hash: "RelayTx",
      status: "succeeded",
      outcome: { failures: [], events: [{ event: "bid_placed", data: { sale_id: "fairt" } }], relayer_cost: "1" },
    });
    const result = await submitAction(bid, { signer, relayer, fairgroundContract: FAIRGROUND });
    expect(result).toEqual({
      paidBy: "relayer",
      fallbackReason: null,
      txHash: "RelayTx",
      status: "succeeded",
      failures: [],
      events: [{ event: "bid_placed", data: { sale_id: "fairt" } }],
    });
    expect(log).toEqual(["sign ft_transfer_call"]);
    expect(relayed).toEqual(["SIGNED"]);
  });

  it("passes a pending relay through with no events yet", async () => {
    const { signer } = recordingSigner();
    const { relayer } = relayerAnswering({ tx_hash: "RelayTx", status: "pending", outcome: null });
    expect(await submitAction(bid, { signer, relayer, fairgroundContract: FAIRGROUND })).toMatchObject({
      paidBy: "relayer",
      status: "pending",
      txHash: "RelayTx",
      events: [],
    });
  });

  it("pays with the wallet at once when it cannot sign delegates", async () => {
    const { signer, log } = recordingSigner({ delegates: false });
    const { relayer, relayed } = relayerAnswering(refusal("internal_error", true));
    const told: FallbackReason[] = [];
    const result = await submitAction(bid, { signer, relayer, fairgroundContract: FAIRGROUND, onPaidFallback: (reason) => void told.push(reason) });
    expect(result).toEqual({
      paidBy: "user",
      fallbackReason: "delegates_unsupported",
      txHash: "PaidTx",
      status: "succeeded",
      failures: [],
      events: [{ event: "bid_placed", data: { sale_id: "fairt" } }],
    });
    expect(told).toEqual(["delegates_unsupported"]);
    expect(log).toEqual(["send ft_transfer_call"]);
    expect(relayed).toEqual([]);
  });

  it.each(["rate_limited", "budget_exhausted", "relay_failed"] as const)(
    "falls back to a paid transaction when the relayer refuses with %s",
    async (reason) => {
      const { signer, log } = recordingSigner();
      const { relayer } = relayerAnswering(refusal(reason));
      const told: FallbackReason[] = [];
      const result = await submitAction(bid, { signer, relayer, fairgroundContract: FAIRGROUND, onPaidFallback: (r) => void told.push(r) });
      expect(result).toMatchObject({ paidBy: "user", fallbackReason: reason, txHash: "PaidTx", status: "succeeded" });
      expect(told).toEqual([reason]);
      expect(log).toEqual(["sign ft_transfer_call", "send ft_transfer_call"]);
    },
  );

  it.each([
    ["a timeout, which may still land", refusal("timeout", true)],
    ["internal_error, which may still land", refusal("internal_error", true)],
    ["a refusal of the call itself", refusal("wrong_deposit")],
    ["a busy sender, whose last call is landing", refusal("sender_busy")],
  ])("never pays twice: rethrows %s", async (_label, error) => {
    const { signer, log } = recordingSigner();
    const { relayer } = relayerAnswering(error);
    await expect(submitAction(bid, { signer, relayer, fairgroundContract: FAIRGROUND })).rejects.toBe(error);
    expect(log).toEqual(["sign ft_transfer_call"]);
  });

  it("stops when onPaidFallback throws", async () => {
    const { signer, log } = recordingSigner();
    const { relayer } = relayerAnswering(refusal("budget_exhausted"));
    const declined = new Error("user declined to pay gas");
    const onPaidFallback = () => {
      throw declined;
    };
    await expect(submitAction(bid, { signer, relayer, fairgroundContract: FAIRGROUND, onPaidFallback })).rejects.toBe(declined);
    expect(log).toEqual(["sign ft_transfer_call"]);
  });
});
