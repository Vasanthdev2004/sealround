import { describe, expect, it, vi } from "vitest";
import { base58Encode } from "../verify/base58";
import { readPayoutReceipt, savePayoutReceipt, verifyPayoutReceipt } from "./payout-receipt";
import type { ChapterSandbox } from "./sandbox";
import type { ChapterPayout } from "./verification";

const contract = "chapters.test.near";
const quote = "usdc.test.near";
const sandbox: ChapterSandbox = {
  contract, token: "lantern.test.near", quote, rpcUrl: "http://localhost:3030", rpc: { view: vi.fn(), headTimeMs: vi.fn() },
};
const recipient = "mira.test.near";
const amount = "25000000";
const paidAt = "6275432000000";
const memo = "Sealround chapter 2 payout 3";
const payout: ChapterPayout = { recipient, token_id: quote, amount, state: "paid", paid_at: paidAt, attempt: 3 };

function hash(byte: number) {
  return base58Encode(new Uint8Array(32).fill(byte));
}

const [txHash, claim, transfer, callback, dependency, tokenBlock, callbackBlock, unrelated] = [1, 2, 3, 4, 5, 6, 7, 8].map(hash);

function call(method_name: string, args: Record<string, unknown>, deposit = "1") {
  return { FunctionCall: { method_name, args: btoa(JSON.stringify(args)), deposit } };
}

function logged(standard: string, event: string, entry: Record<string, unknown>) {
  return `EVENT_JSON:${JSON.stringify({ standard, version: "1.0.0", event, data: [entry] })}`;
}

function fixture() {
  return {
    status: { SuccessValue: btoa("true") }, final_execution_status: "FINAL",
    transaction: {
      hash: txHash, signer_id: recipient, receiver_id: contract, actions: [call("claim_bounty", { round_id: 2 })],
    },
    transaction_outcome: {
      id: txHash, outcome: { executor_id: recipient, receipt_ids: [claim], status: { SuccessReceiptId: claim } },
    },
    receipts: [
      { receipt_id: transfer, predecessor_id: contract, receiver_id: quote, receipt: { Action: {
        actions: [call("ft_transfer", { receiver_id: recipient, amount, memo })], input_data_ids: [],
        output_data_receivers: [{ data_id: dependency, receiver_id: contract }],
      } } },
      { receipt_id: callback, predecessor_id: contract, receiver_id: contract, receipt: { Action: {
        actions: [call("on_claim_bounty", { round_id: 2, attempt: 3 }, "0")], input_data_ids: [dependency], output_data_receivers: [],
      } } },
    ],
    receipts_outcome: [
      { id: claim, block_hash: tokenBlock, outcome: {
        executor_id: contract, receipt_ids: [transfer, callback], status: { SuccessReceiptId: callback }, logs: [],
      } },
      { id: transfer, block_hash: tokenBlock, outcome: {
        executor_id: quote, receipt_ids: [], status: { SuccessValue: "" },
        logs: [logged("nep141", "ft_transfer", { old_owner_id: contract, new_owner_id: recipient, amount, memo })],
      } },
      { id: callback, block_hash: callbackBlock, outcome: {
        executor_id: contract, receipt_ids: [], status: { SuccessValue: btoa("true") },
        logs: [logged("sealround_chapters", "bounty_payment", {
          round_id: 2, attempt: 3, account: recipient, amount, token_id: quote, paid: true, paid_at: paidAt,
        })],
      } },
    ],
  };
}

function check(result: unknown, paid = payout, roundId = 2) {
  return verifyPayoutReceipt(sandbox, roundId, paid, txHash, async () => Response.json({ result }));
}

describe("public payout receipt", () => {
  it("checks both receipt executions in the directly signed claim’s promise chain", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ result: { final_execution_status: "EXECUTED" } }))
      .mockResolvedValueOnce(Response.json({ result: fixture() }));
    await expect(verifyPayoutReceipt(sandbox, 2, payout, txHash, fetchImpl)).resolves.toEqual({
      check: { status: "passed", message: expect.any(String) }, evidence: {
        transactionHash: txHash, claimReceiptId: claim, transferReceiptId: transfer, transferBlockHash: tokenBlock,
        callbackReceiptId: callback, callbackBlockHash: callbackBlock, attempt: 3, memo,
      },
    });
    expect(fetchImpl.mock.calls.map(([url, options]) => [url, JSON.parse(String(options?.body))])).toEqual(
      ["NONE", "FINAL"].map((wait_until, index) => [sandbox.rpcUrl, {
        jsonrpc: "2.0", id: index + 1, method: "EXPERIMENTAL_tx_status",
        params: { tx_hash: txHash, sender_account_id: recipient, wait_until },
      }]),
    );
  });

  it("uses the receipt method supported by each testnet RPC and moves to a provider with receipt records", async () => {
    const rpcUrl = "https://primary.example";
    const archive = "https://archive.example";
    const testnet = { ...sandbox, network: "testnet" as const, rpcUrl, rpcUrls: [rpcUrl, archive] };
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: { code: -32601, message: "Method not found" } }))
      .mockResolvedValueOnce(Response.json({ result: { ...fixture(), receipts: [] } }))
      .mockResolvedValueOnce(Response.json({ result: fixture() }));
    await expect(verifyPayoutReceipt(testnet, 2, payout, txHash, fetchImpl)).resolves.toMatchObject({
      check: { status: "passed" }, evidence: { transactionHash: txHash, transferReceiptId: transfer, callbackReceiptId: callback },
    });
    const calls = fetchImpl.mock.calls.map(([url, request]) => [url, JSON.parse(String(request?.body))]);
    expect(calls).toMatchObject([
      [rpcUrl, { method: "tx_status", params: { wait_until: "NONE" } }],
      [rpcUrl, { method: "EXPERIMENTAL_tx_status", params: { wait_until: "NONE" } }],
      [archive, { method: "tx_status", params: { wait_until: "NONE" } }],
    ]);
  });

  it("checks the next testnet RPC when the primary cannot find a historical transaction", async () => {
    const rpcUrl = "https://primary.example";
    const archive = "https://archive.example";
    const testnet = { ...sandbox, network: "testnet" as const, rpcUrl, rpcUrls: [archive] };
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: { cause: { name: "UNKNOWN_TRANSACTION" } } }))
      .mockResolvedValueOnce(Response.json({ result: { ...fixture(), final_execution_status: "EXECUTED" } }))
      .mockResolvedValueOnce(Response.json({ result: fixture() }));
    await expect(verifyPayoutReceipt(testnet, 2, payout, txHash, fetchImpl)).resolves.toMatchObject({ check: { status: "passed" } });
    expect(fetchImpl.mock.calls.map(([url, request]) => [url, JSON.parse(String(request?.body)).params.wait_until])).toEqual(
      [[rpcUrl, "NONE"], [archive, "NONE"], [archive, "FINAL"]],
    );
  });

  it("scopes a cached testnet hash to its contract and round and keeps it across RPC changes", () => {
    const testnet = { ...sandbox, network: "testnet" as const, rpcUrl: "https://primary.example" };
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      setItem: (key: string, value: string) => { values.set(key, value); },
      getItem: (key: string) => values.get(key) ?? null,
    });
    vi.stubGlobal("window", new EventTarget());
    try {
      savePayoutReceipt(testnet, 2, txHash);
      expect(readPayoutReceipt({ ...testnet, rpcUrl: "https://archive.example" }, 2)).toBe(txHash);
      expect(readPayoutReceipt(testnet, 1)).toBeNull();
      expect(readPayoutReceipt({ ...testnet, contract: "other.testnet" }, 2)).toBeNull();
      expect(readPayoutReceipt(sandbox, 2)).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    ["different signer", (tx: ReturnType<typeof fixture>) => { tx.transaction.signer_id = "another.test.near"; }],
    ["batched claim", (tx: ReturnType<typeof fixture>) => { tx.transaction.actions.push(call("claim_bounty", { round_id: 1 })); }],
    ["unrelated transfer receipt", (tx: ReturnType<typeof fixture>) => { tx.receipts_outcome[0].outcome.receipt_ids = [unrelated, callback]; }],
    ["unlinked callback dependency", (tx: ReturnType<typeof fixture>) => { tx.receipts[1].receipt.Action.input_data_ids = [unrelated]; }],
    ["different token executor", (tx: ReturnType<typeof fixture>) => { tx.receipts_outcome[1].outcome.executor_id = "other.test.near"; }],
    ["failed transfer with a matching log", (tx: ReturnType<typeof fixture>) => {
      Object.assign(tx.receipts_outcome[1].outcome, { status: { Failure: "rolled back" } });
    }],
    ["different transfer memo", (tx: ReturnType<typeof fixture>) => {
      tx.receipts[0].receipt.Action.actions = [call("ft_transfer", { receiver_id: recipient, amount, memo: "unrelated" })];
    }],
    ["different logged transfer amount", (tx: ReturnType<typeof fixture>) => {
      tx.receipts_outcome[1].outcome.logs = [logged("nep141", "ft_transfer", { old_owner_id: contract, new_owner_id: recipient, amount: "24999999", memo })];
    }],
    ["failed callback returning false", (tx: ReturnType<typeof fixture>) => { tx.receipts_outcome[2].outcome.status = { SuccessValue: btoa("false") }; }],
  ] as const)("rejects a %s", async (_scenario, alter) => {
    const tx = fixture();
    alter(tx);
    await expect(check(tx)).resolves.toMatchObject({ check: { status: "failed" }, evidence: null });
  });

  it("rejects an older attempt, a different confirmation timestamp and a different chapter", async () => {
    for (const mismatch of [check(fixture(), { ...payout, attempt: 4 }), check(fixture(), { ...payout, paid_at: "7000000000000" }), check(fixture(), payout, 1)]) {
      await expect(mismatch).resolves.toMatchObject({ check: { status: "failed" }, evidence: null });
    }
  });

  it("distinguishes missing, malformed, unavailable and unfinalized receipts", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { cause: { name: "UNKNOWN_TRANSACTION" } } }));
    await expect(verifyPayoutReceipt(sandbox, 2, payout, "", fetchImpl)).resolves.toMatchObject({ check: { status: "pending" } });
    await expect(verifyPayoutReceipt(sandbox, 2, payout, "0".repeat(44), fetchImpl)).resolves.toMatchObject({ check: { status: "failed" } });
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(verifyPayoutReceipt(sandbox, 2, payout, txHash, fetchImpl)).resolves.toMatchObject({
      check: { status: "unavailable", message: expect.stringContaining("could not find this hash") }, evidence: null,
    });
    await expect(check({ ...fixture(), receipts: undefined })).resolves.toMatchObject({ check: { status: "unavailable" }, evidence: null });
    await expect(check({ ...fixture(), final_execution_status: "EXECUTED" })).resolves.toMatchObject({ check: { status: "pending" }, evidence: null });
  });
});
