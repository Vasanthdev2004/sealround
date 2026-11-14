import { expect, it, vi } from "vitest";
import { parseConfig } from "../config";
import type { Sale, SaleResult } from "../types";
import type { NearRpc } from "./rpc";
import { buyOnRhea, mockRheaQuote, readRheaReceipt, RHEA_SANDBOX, RHEA_TESTNET, rheaCallbackHash, rheaPool, rheaQuoteFor, rheaSwapAction, type RheaChain } from "./rhea-swap";

const account = "buyer.testnet";
const pool = { exchange: RHEA_TESTNET, poolId: 38, input: "usdc.fakes.testnet", output: "fairt.sealround.testnet" };
const quote = rheaQuoteFor(100n, 200n);
const hash = "11111111111111111111111111111111";
const call = (method_name: string, args: unknown, deposit = "1") => ({ FunctionCall: { method_name, args: btoa(JSON.stringify(args)), deposit } });

it("reads one valid wallet callback hash without treating URL errors as authoritative", () => {
  expect(rheaCallbackHash(`?transactionHashes=${hash}&errorCode=untrusted`)).toBe(hash);
  expect(rheaCallbackHash("?errorCode=UserRejected")).toBeNull();
  expect(rheaCallbackHash(`?transactionHashes=${hash}%2C${hash}`)).toBeNull();
  expect(rheaCallbackHash(`?transactionHashes=${hash}&transactionHashes=${hash}`)).toBeNull();
  expect(rheaCallbackHash("?transactionHashes=bad")).toBeNull();
  expect(rheaCallbackHash(`?transactionHashes=+${hash}`)).toBeNull();
  expect(rheaCallbackHash(`?transactionHashes=${"1".repeat(33)}`)).toBeNull();
});

function txFixture(status: "bought" | "refunded") {
  const inputAction = rheaSwapAction(pool, quote);
  const args = [call(inputAction.methodName, inputAction.args)];
  const transfer = (old_owner_id: string, new_owner_id: string, amount: bigint) =>
    `EVENT_JSON:${JSON.stringify({ standard: "nep141", version: "1.0.0", event: "ft_transfer", data: [{ old_owner_id, new_owner_id, amount: amount.toString() }] })}`;
  function outcome(id: string, executor_id: string, outcomeStatus: { SuccessValue?: string; SuccessReceiptId?: string; Failure?: unknown },
    receipt_ids: string[] = [], logs: string[] = []) {
    return { id, block_hash: hash, outcome: { executor_id, status: outcomeStatus, receipt_ids, logs } };
  }
  const success = status === "bought";
  return {
    final_execution_status: "FINAL",
    transaction: { hash, signer_id: account, receiver_id: pool.input, actions: args },
    transaction_outcome: outcome(hash, account, { SuccessReceiptId: "input" }, ["input"]),
    receipts: [
      { receipt_id: "resolve", predecessor_id: pool.input, receiver_id: pool.input,
        receipt: { Action: { signer_id: account, actions: [call("ft_resolve_transfer", { sender_id: account, receiver_id: pool.exchange, amount: quote.amount.toString() }, "0")] } } },
      { receipt_id: "output", predecessor_id: pool.exchange, receiver_id: pool.output,
        receipt: { Action: { signer_id: account, actions: [call("ft_transfer", { receiver_id: account, amount: quote.estimate.toString() })] } } },
    ],
    receipts_outcome: [
      outcome("input", pool.input, { SuccessReceiptId: "resolve" }, ["exchange", "resolve"]),
      outcome("exchange", pool.exchange, { SuccessValue: "" }, success ? ["output"] : []),
      outcome("resolve", pool.input, { SuccessValue: btoa(JSON.stringify(success ? quote.amount.toString() : "0")) }, [],
        success ? [] : [transfer(pool.exchange, account, quote.amount)]),
      outcome("output", pool.output, { SuccessValue: "" }, [], [transfer(pool.exchange, account, quote.estimate)]),
    ],
  };
}

it("confirms a buy only from a finalized input debit and reachable successful output receipt", () => {
  const tx = txFixture("bought");
  expect(readRheaReceipt(tx, hash, account, pool, quote)).toEqual({ status: "bought", amount: quote.estimate, hash });
  expect(readRheaReceipt({ ...tx, final_execution_status: "EXECUTED" }, hash, account, pool, quote).status).toBe("pending");
  tx.receipts_outcome[1].outcome.receipt_ids = [];
  expect(readRheaReceipt(tx, hash, account, pool, quote).status).toBe("unresolved");
  tx.receipts_outcome[1].outcome.receipt_ids = ["output"];
  tx.receipts_outcome[3].outcome.status = { Failure: "Delivery rejected" };
  expect(readRheaReceipt(tx, hash, account, pool, quote).status).toBe("unresolved");
});

it("checks the original signer and reviewed minimum and distinguishes full refund from missing proof", () => {
  const refunded = txFixture("refunded");
  expect(readRheaReceipt(refunded, hash, account, pool, quote).status).toBe("refunded");
  expect(readRheaReceipt(refunded, hash, "other.testnet", pool, quote).status).toBe("unresolved");
  expect(readRheaReceipt(refunded, hash, account, pool, { ...quote, minimum: quote.minimum + 1n }).status).toBe("unresolved");
  refunded.receipts_outcome[2].outcome.logs = [];
  expect(readRheaReceipt(refunded, hash, account, pool, quote).status).toBe("unresolved");
  refunded.receipts_outcome[0].outcome.status = { Failure: "Insufficient balance" };
  expect(readRheaReceipt(refunded, hash, account, pool, quote).status).toBe("failed");
});

it("accepts only a known seeded pool for the network", () => {
  const sale = { status: "settled", tokenAccount: pool.output, config: { quoteToken: pool.input } } as Sale;
  const result = { status: "settled", liquidity: { stage: "seeded", dex: RHEA_TESTNET, poolId: pool.poolId } } as SaleResult;
  const config = (network: "testnet" | "sandbox", url: string) => parseConfig({
    NEXT_PUBLIC_FAIRGROUND_CONTRACT: "sealround.testnet", NEXT_PUBLIC_NEAR_NETWORK: network,
    NEXT_PUBLIC_USDC_CONTRACT: pool.input, NEXT_PUBLIC_NEAR_RPC_URL: url,
    NEXT_PUBLIC_NEAR_RPC_FALLBACKS: "none",
  });
  expect(rheaPool(sale, result, config("testnet", "https://rpc.testnet.fastnear.com"))).toEqual(pool);
  expect(rheaPool(sale, result, { mode: "mock" })).toBeNull();
  const sandbox = { ...result, liquidity: { ...result.liquidity!, dex: RHEA_SANDBOX } };
  expect(rheaPool(sale, sandbox, config("sandbox", "http://127.0.0.1:3030"))?.exchange).toBe(RHEA_SANDBOX);
  expect(rheaPool(sale, sandbox, config("sandbox", "https://rpc.testnet.fastnear.com"))).toBeNull();
  expect(rheaPool(sale, sandbox, config("testnet", "https://rpc.testnet.fastnear.com"))).toBeNull();
});

it("prices the simulated pool with its reserves and fees and requires a nonzero minimum", () => {
  const result = { liquidity: { simulated: true, usdc: 1_000n, tokens: 100_000n } } as SaleResult;
  expect(mockRheaQuote(result, 30, 100n)).toMatchObject({ estimate: 9_066n, minimum: 8_975n });
  expect(() => rheaQuoteFor(1n, 1n)).toThrow(/usable/);
});

it("refuses to request a signature after price moves and never retries an unconfirmed wallet return", async () => {
  let estimate = (quote.minimum - 1n).toString();
  const rpc: NearRpc = {
    view: async <T,>(_account: string, method: string) => ({
      get_pool: { pool_kind: "SIMPLE_POOL", token_account_ids: [pool.input, pool.output] }, get_return: estimate,
      ft_balance_of: quote.amount.toString(), storage_balance_of: { total: "1250", available: "0" },
    })[method as "get_pool"] as T,
    headTimeMs: async () => 0,
  };
  const chain: RheaChain = { ...pool, network: "testnet", rpc, rpcUrls: [] };
  const sendTransaction = vi.fn().mockRejectedValue(new Error("Wallet disconnected"));
  const activeSigner = vi.fn(() => ({ sendTransaction, signsDelegates: false, signDelegate: vi.fn() }));
  const onSigning = vi.fn();
  await expect(buyOnRhea(chain, account, quote, activeSigner, onSigning)).rejects.toThrow(/moved below/);
  expect(activeSigner).not.toHaveBeenCalled();
  estimate = quote.estimate.toString();
  await expect(buyOnRhea(chain, account, quote, activeSigner, onSigning)).resolves.toEqual({ status: "pending", hash: null });
  expect(onSigning).toHaveBeenCalledExactlyOnceWith({ account, quote, hash: null });
  expect(sendTransaction).toHaveBeenCalledExactlyOnceWith(rheaSwapAction(pool, quote));
  sendTransaction.mockRejectedValueOnce(Object.assign(new Error("User rejected"), { code: 4001 }));
  await expect(buyOnRhea(chain, account, quote, activeSigner, onSigning)).resolves.toEqual({ status: "failed", hash: null });
});
