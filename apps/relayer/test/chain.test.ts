/**
 * nearChain's submission against a scripted provider: what it promises (a hash,
 * an outcome, or a refusal) for each way the RPC can answer.
 */
import { KeyPair, type Provider } from "near-api-js";
import { InvalidNonceError, NotEnoughBalanceError, TransactionTimeoutError } from "near-api-js/rpc-errors";
import { describe, expect, it } from "vitest";
import { TransactionRefused, nearChain, type TxOutcome } from "../src/chain.ts";
import { RELAYER, signDelegate } from "./fixtures.ts";

const outcome = { transaction_outcome: { id: "from-rpc" }, receipts_outcome: [] } as unknown as TxOutcome;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Script {
  /** How send_tx answers (it is asked to wait until INCLUDED). */
  send?: () => Promise<unknown>;
  /** How the tx status query answers. */
  status?: () => Promise<TxOutcome>;
  /** How the nonce lookup answers; it runs before signing. */
  accessKey?: () => Promise<unknown>;
}

function scriptedChain({ send = async () => ({ final_execution_status: "INCLUDED" }), status = async () => outcome, accessKey }: Script) {
  const asked: Array<[string, unknown]> = [];
  const provider = {
    viewAccessKey: accessKey ?? (async () => ({ nonce: 7n, permission: "FullAccess", block_height: 1, block_hash: "" })),
    viewBlock: async () => ({ header: { hash: "11111111111111111111111111111111", height: 1 } }),
    sendTransactionUntil: async (_tx: unknown, waitUntil: string) => (asked.push(["send_tx", waitUntil]), send()),
    viewTransactionStatus: async (query: { txHash: string }) => (asked.push(["tx", query.txHash]), status()),
  } as unknown as Provider;
  return { chain: nearChain(provider, RELAYER, KeyPair.fromRandom("ed25519")), asked };
}

const relay = async (script: Script, waitMs: number) => {
  const { chain, asked } = scriptedChain(script);
  const submission = chain.relay((await signDelegate()).delegate, waitMs);
  return { submission, asked };
};

describe("nearChain submit", () => {
  it("waits for inclusion, then for the outcome, and reports the hash it signed", async () => {
    const { submission, asked } = await relay({}, 1000);
    const { txHash, outcome: got, done } = await submission;
    expect(got).toBe(outcome);
    expect(await done).toBe(outcome);
    expect(txHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    expect(asked).toEqual([
      ["send_tx", "INCLUDED"],
      ["tx", txHash],
    ]);
  });

  it("answers pending with the hash when the outcome is late, and learns it later", async () => {
    const { submission } = await relay({ status: async () => (await sleep(30), outcome) }, 0);
    const { txHash, outcome: got, done } = await submission;
    expect(got).toBeNull();
    expect(txHash).toBeTruthy();
    expect(await done).toBe(outcome);
  });

  it.each([
    ["NotEnoughBalance", () => new NotEnoughBalanceError(1n, 2n, RELAYER, "", "")],
    ["a stale nonce", () => new InvalidNonceError(9, 8, "", "")],
  ])("reports %s as refused even when it should not wait, and however late the RPC says so", async (_label, error) => {
    const { submission } = await relay({ send: async () => (await sleep(30), Promise.reject(error())) }, 0);
    await expect(submission).rejects.toBeInstanceOf(TransactionRefused);
  });

  it("rethrows a failure before signing: nothing was sent", async () => {
    const lookup = new Error("fetch failed");
    const { submission, asked } = await relay({ accessKey: async () => Promise.reject(lookup) }, 1000);
    await expect(submission).rejects.toBe(lookup);
    expect(asked).toEqual([]);
  });

  it.each([
    ["the RPC times out waiting for inclusion", () => new TransactionTimeoutError()],
    ["the answer is lost", () => new TypeError("fetch failed")],
  ])("answers pending with the hash when %s after signing: it may still land", async (_label, error) => {
    const { submission } = await relay({ send: async () => Promise.reject(error()) }, 1000);
    const { txHash, outcome: got, done } = await submission;
    expect(txHash).toBeTruthy();
    expect(got).toBeNull();
    expect(await done).toBe(outcome);
  });

  it("settles done with null when the outcome cannot be learned", async () => {
    const { submission } = await relay({ status: async () => Promise.reject(new Error("unknown transaction")) }, 0);
    expect(await (await submission).done).toBeNull();
  });
});
