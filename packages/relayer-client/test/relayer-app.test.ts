/**
 * The client against the real relayer app (apps/relayer, in process), with only
 * the chain faked. The relayer's own decoder, signature check and policy judge
 * every delegate the builders and signers produce, and its real answers drive
 * the client's error mapping.
 */
import { DailyNearBudget, createApp, ipHasher, loadConfig, memoryLimiters, type Chain, type RelayerConfig } from "@fairground/relayer";
import { KeyPair, base64Decode, base64Encode, type SignedDelegate } from "near-api-js";
import { describe, expect, it } from "vitest";
import {
  bidAction,
  claimAction,
  claimProceedsAction,
  clearOnchainAction,
  revealAction,
  triggerRefundModeAction,
  type BidPayload,
  type FairgroundAction,
} from "../src/actions";
import { RelayerError, createRelayerClient } from "../src/relayer";
import { keyPairSigner, walletSigner, type ActionSigner } from "../src/signers";
import { submitAction } from "../src/submit";
import { ALICE, CIPHERTEXT, COMMITMENT, FAIRGROUND, HEAD, USDC, ciphertextFor, memoryProvider, stubWallet } from "./helpers";

type Submission = Awaited<ReturnType<Chain["relay"]>>;

const RELAYER = "relayer.test.near";
const TGAS = 1_000_000_000_000n;
const POLICY: RelayerConfig["policy"] = {
  relayerAccountId: RELAYER,
  fairgroundContract: FAIRGROUND,
  usdcContracts: [USDC],
  maxGas: 300n * TGAS,
  maxActions: 2,
  minBlocksLeft: 5n,
  maxDelegateBlocks: 1200n,
};
/** The gas cap a relayer runs with when MAX_GAS_TGAS is not set (apps/relayer src/config.ts). */
const DEFAULT_MAX_GAS = loadConfig({
  NETWORK: "sandbox",
  NEAR_RPC_URL: "http://127.0.0.1:3040",
  RELAYER_ACCOUNT_ID: RELAYER,
  RELAYER_PRIVATE_KEY: KeyPair.fromRandom("ed25519").toString(),
  FAIRGROUND_CONTRACT: FAIRGROUND,
  USDC_CONTRACTS: USDC,
}).policy.maxGas;

const placedLog = `EVENT_JSON:${JSON.stringify({ standard: "fairground", version: "1.0.0", event: "bid_placed", data: { sale_id: "fairt" } })}`;
const outcome = {
  status: { SuccessValue: "" },
  transaction_outcome: { id: "RelayTx", outcome: { executor_id: RELAYER, status: { SuccessReceiptId: "r" }, tokens_burnt: "7", logs: [] } },
  receipts_outcome: [{ id: "r", outcome: { executor_id: FAIRGROUND, status: { SuccessValue: "" }, tokens_burnt: "3", logs: [placedLog] } }],
} as unknown as NonNullable<Submission["outcome"]>;

/** A `get_sale` answer the relayer's on-chain checks read: an open sale quoted in USDC unless overridden. */
const sale = (overrides: Record<string, unknown> = {}) => ({
  status: "open",
  quote_token: USDC,
  reveal_mode: "Tee",
  reveal_end: null,
  refund_mode_at: "9000000000000000000",
  ...overrides,
});
/** Sales in the state each relayable call needs. Any other sale id is an open sale in `revealMode`. */
const SALES: Record<string, ReturnType<typeof sale>> = {
  sealed: sale(),
  committed: sale({ reveal_mode: "CommitReveal" }),
  final: sale({ status: "settled", refund_mode_at: null, token_setup: "done", creator_allocation: "0" }),
  seed: sale({ status: "settled", liquidity: {} }),
  abandon: sale({ status: "settled", liquidity: {} }),
  revealing: sale({ status: "revealing", reveal_mode: "CommitReveal", reveal_end: "9000000000000000000" }),
  /** Its reveal window ended at the fake head time (1000 ns): ready for clear_onchain. */
  revealed: sale({ status: "revealing", reveal_mode: "CommitReveal", reveal_end: "1000" }),
  stale: sale({ status: "clearing", refund_mode_at: "0" }),
};

/**
 * The relayer app with a chain where every key is a fresh full-access key, every
 * account holds all the USDC there is and has an unclaimed, unrevealed bid, and
 * the sales are as in SALES. `relayed` holds each delegate the relayer decoded and sent.
 */
function inProcessRelayer({ budget = 10n ** 24n, revealMode = "Tee", maxGas = POLICY.maxGas } = {}) {
  const relayed: SignedDelegate[] = [];
  const views: Record<string, (args: Record<string, unknown>) => unknown> = {
    get_sale: (args) => SALES[String(args["sale_id"])] ?? sale({ reveal_mode: revealMode }),
    get_result: ({ sale_id }) => {
      if (sale_id === "seed" || sale_id === "abandon") {
        const seed = sale_id === "seed";
        return {
          sale_id, status: "settled",
          liquidity: { status: "seeding", next_step: seed ? "deposit" : null, in_flight: null, deadline: seed ? "1001" : "1000" },
        };
      }
      return sale_id === "final" ? {
        sale_id,
        status: "settled",
        total_raised: "1000000",
        unsold: "0",
        proceeds: { raise_paid: false, allocation_paid: false, unsold_burned: false, reserve_returned: false },
      } : null;
    },
    get_reserve_refund: () => "0",
    get_bid: () => ({ revealed: false, claimed: false }),
    ft_balance_of: () => ((1n << 128n) - 1n).toString(),
  };
  const chain: Chain = {
    head: async () => ({ height: HEAD, gasPrice: 100_000_000n, timestampNs: 1_000n }),
    accessKey: async () => ({ nonce: 0n, permission: "FullAccess", block_height: Number(HEAD), block_hash: "" }),
    accountExists: async () => true,
    relayerBalance: async () => 10n ** 25n,
    view: async <T,>(_contractId: string, method: string, args: Record<string, unknown>) => views[method]!(args) as T,
    isRegistered: async () => false,
    storageMinimum: async () => 1_250_000_000_000_000_000_000n,
    relay: async (delegate) => (relayed.push(delegate), { txHash: "RelayTx", outcome, done: Promise.resolve(outcome) }),
    registerStorage: async () => ({ txHash: "StorageTx", outcome, done: Promise.resolve(outcome) }),
  };
  const app = createApp({
    config: {
      network: "sandbox",
      policy: { ...POLICY, maxGas },
      limits: { relaysPerSenderPerHour: 100, requestsPerIpPerHour: 100, storagePerIpPerDay: 3, dailyBudget: budget, storageBudget: 10n ** 24n },
      relayWaitMs: 1000,
      corsOrigins: [],
    },
    chain,
    limiters: memoryLimiters(),
    budget: new DailyNearBudget(budget),
    storageBudget: new DailyNearBudget(10n ** 24n),
    clientIp: () => "203.0.113.1",
    hashIp: ipHasher(),
    log: () => {},
  });
  const client = createRelayerClient({ url: "http://relayer.test", fetch: async (input, init) => app.fetch(new Request(input, init)) });
  return { client, relayed };
}

const aliceKey = KeyPair.fromRandom("ed25519");
const alice = (validityBlocks?: number) =>
  keyPairSigner({ accountId: ALICE, keyPair: aliceKey, provider: memoryProvider({ nonce: 0n, height: HEAD }), validityBlocks });

const relayable: Array<[string, FairgroundAction]> = [
  ["a sealed bid", bidAction(USDC, FAIRGROUND, "sealed", 2_000_000n, { ciphertext: ciphertextFor("sealed"), bidder: ALICE })],
  ["the largest sealed bid Alice can send", bidAction(USDC, FAIRGROUND, "s".repeat(32), (1n << 128n) - 1n, { ciphertext: ciphertextFor("s".repeat(32)), bidder: ALICE })],
  ["a commitment", bidAction(USDC, FAIRGROUND, "committed", 1n, { commitment: COMMITMENT })],
  ["a claim", claimAction(FAIRGROUND, "final")],
  ["a pushed claim", claimAction(FAIRGROUND, "final", "bob.test.near")],
  ["claim_proceeds", claimProceedsAction(FAIRGROUND, "final")],
  ["a reveal", revealAction(FAIRGROUND, "revealing", { maxPrice: 2_500n, maxSpend: 10n ** 8n, salt: "c".repeat(32) })],
  ["clear_onchain", clearOnchainAction(FAIRGROUND, "revealed")],
  ["trigger_refund_mode", triggerRefundModeAction(FAIRGROUND, "stale")],
  // The web client builds pool calls directly from the relayer policy.
  ["seed_liquidity", { receiverId: FAIRGROUND, methodName: "seed_liquidity", args: { sale_id: "seed" }, gas: 150n * TGAS, deposit: 0n }],
  ["abandon_liquidity", { receiverId: FAIRGROUND, methodName: "abandon_liquidity", args: { sale_id: "abandon" }, gas: 150n * TGAS, deposit: 0n }],
];

describe("the client against the real relayer app", () => {
  it.each(relayable)("the relayer accepts %s and decodes exactly the call that was built", async (_label, action) => {
    const { client, relayed } = inProcessRelayer();
    const response = await client.relay(await alice().signDelegate(action));
    expect(response).toMatchObject({ tx_hash: "RelayTx", status: "succeeded" });

    const [delegate] = relayed;
    expect(delegate?.delegateAction).toMatchObject({ senderId: ALICE, receiverId: action.receiverId, nonce: 1n, maxBlockHeight: HEAD + 200n });
    const calls = delegate!.delegateAction.actions.map(({ functionCall }) => functionCall);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ methodName: action.methodName, gas: action.gas, deposit: action.deposit });
    expect(new TextDecoder().decode(calls[0]!.args)).toBe(JSON.stringify(action.args));
  });

  it.each(relayable)("a relayer with its default gas cap accepts %s as built", async (_label, action) => {
    const { client, relayed } = inProcessRelayer({ maxGas: DEFAULT_MAX_GAS });
    expect(await client.relay(await alice().signDelegate(action))).toMatchObject({ tx_hash: "RelayTx", status: "succeeded" });
    expect(relayed).toHaveLength(1);
  });

  it("clear_onchain attaches exactly the relayer's default gas cap: one gas unit more is refused", async () => {
    const clear = clearOnchainAction(FAIRGROUND, "revealed");
    expect(clear.gas).toBe(DEFAULT_MAX_GAS);
    expect(DEFAULT_MAX_GAS).toBe(150n * TGAS);
    const { client, relayed } = inProcessRelayer({ maxGas: DEFAULT_MAX_GAS });
    const error = await client.relay(await alice().signDelegate({ ...clear, gas: clear.gas + 1n })).catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ name: "RelayerError", reason: "gas_too_high", status: 400, maybeSubmitted: false });
    expect(relayed).toEqual([]);
  });

  const box = (bytes: number) => Buffer.alloc(bytes, 3).toString("base64");
  const fromAlice = (ciphertext: string): BidPayload => ({ ciphertext, bidder: ALICE });

  it.each<[string, string, BidPayload]>([
    ["a sealed bid", "fairt", fromAlice(CIPHERTEXT)],
    ["a sealed bid on a 32-character sale id", "a".repeat(32), fromAlice(ciphertextFor("a".repeat(32)))],
    ["a sealed bid on a one-character sale id", "a", fromAlice(ciphertextFor("a"))],
    ["one byte short", "fairt", fromAlice(box(243))],
    ["one byte long", "fairt", fromAlice(box(245))],
    ["the length for another sale id", "fairt", fromAlice(ciphertextFor("fairt2"))],
    ["one byte", "fairt", fromAlice("AA==")],
    ["512 bytes", "fairt", fromAlice(box(512))],
    ["513 bytes", "fairt", fromAlice(box(513))],
    ["no bytes", "fairt", fromAlice("")],
    ["no padding", "fairt", fromAlice("AAE")],
    ["the right length, no padding", "fairt", fromAlice(CIPHERTEXT.replace(/=+$/, ""))],
    ["the right length, non-zero trailing bits", "fairt", fromAlice(CIPHERTEXT.replace(/w==$/, "x=="))],
    ["non-zero trailing bits", "fairt", fromAlice("AAF=")],
    ["the url alphabet", "fairt", fromAlice("-_8=")],
    ["a stray character", "fairt", fromAlice("AAE*")],
    ["a space", "fairt", fromAlice("AA E=")],
    ["a trailing newline", "fairt", fromAlice(`${CIPHERTEXT}\n`)],
    ["padding in the middle", "fairt", fromAlice("AA==AA==")],
    ["an uppercase commitment", "fairt", { commitment: COMMITMENT.toUpperCase() }],
    ["a short commitment", "fairt", { commitment: COMMITMENT.slice(2) }],
    ["a 32-character sale id", "a".repeat(32), { commitment: COMMITMENT }],
    ["a 33-character sale id", "a".repeat(33), { commitment: COMMITMENT }],
    ["a one-character sale id", "a", { commitment: COMMITMENT }],
    ["a sale id ending in _", "fair_", { commitment: COMMITMENT }],
    ["an uppercase sale id", "Fair", { commitment: COMMITMENT }],
  ])("refuses a bid message exactly when the relayer does, and for the same reason: %s", async (_label, saleId, payload) => {
    expect(CIPHERTEXT.endsWith("Bw==")).toBe(true); // so the trailing-bits case really changes the text
    // What the builder says, as the relayer code it matches: a wrong length, or a malformed msg.
    const clientRefusal = (() => {
      try {
        bidAction(USDC, FAIRGROUND, saleId, 1n, payload);
        return null;
      } catch (error) {
        expect(error).toBeInstanceOf(RangeError);
        return / bytes for this sale id and bidder/.test((error as Error).message) ? "wrong_ciphertext_length" : "bad_bid_msg";
      }
    })();
    // The same call built by hand, past the builder's checks. Alice signs it, so she is the bidder.
    const msg = "ciphertext" in payload ? { sale_id: saleId, ciphertext: payload.ciphertext } : { sale_id: saleId, commitment: payload.commitment };
    const handBuilt: FairgroundAction = {
      ...bidAction(USDC, FAIRGROUND, "fairt", 1n, { commitment: COMMITMENT }),
      args: { receiver_id: FAIRGROUND, amount: "1", msg: JSON.stringify(msg) },
    };
    const { client } = inProcessRelayer({ revealMode: "ciphertext" in payload ? "Tee" : "CommitReveal" });
    const relayerRefusal = await client.relay(await alice().signDelegate(handBuilt)).then(
      () => null,
      (error: unknown) => (error instanceof RelayerError ? error.reason : "unexpected"),
    );
    expect(clientRefusal).toBe(relayerRefusal);
  });

  it.each(relayable)("accepts %s as a NEAR Connect wallet encodes and signs it", async (_label, action) => {
    const { client, relayed } = inProcessRelayer();
    const { wallet } = stubWallet({ accountId: ALICE, keyPair: aliceKey, provider: memoryProvider({ nonce: 0n, height: HEAD }) });
    const signer = walletSigner(wallet, { signerId: ALICE });
    const result = await submitAction(action, { signer, relayer: client, fairgroundContract: FAIRGROUND });
    expect(result).toMatchObject({ paidBy: "relayer", txHash: "RelayTx", events: [{ event: "bid_placed", data: { sale_id: "fairt" } }] });
    expect(relayed).toHaveLength(1);
  });

  it("maps a refusal read from the chain, and does not pay for the call instead", async () => {
    const { client, relayed } = inProcessRelayer();
    const paid: FairgroundAction[] = [];
    const signer: ActionSigner = { ...alice(), sendTransaction: async (action) => (paid.push(action), outcome) };
    const claimOnOpenSale = claimAction(FAIRGROUND, "sealed");
    const error = await submitAction(claimOnOpenSale, { signer, relayer: client, fairgroundContract: FAIRGROUND }).catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ name: "RelayerError", reason: "wrong_phase", status: 400, maybeSubmitted: false });
    expect(relayed).toEqual([]);
    expect(paid).toEqual([]);
  });

  it.each([
    ["wrong_deposit", () => alice().signDelegate({ ...claimAction(FAIRGROUND, "fairt"), deposit: 1n })],
    ["method_not_allowed", () => alice().signDelegate({ ...claimAction(FAIRGROUND, "fairt"), methodName: "create_sale" })],
    ["gas_too_high", () => alice().signDelegate({ ...claimAction(FAIRGROUND, "fairt"), gas: 301n * TGAS })],
    ["expired", () => alice(3).signDelegate(claimAction(FAIRGROUND, "fairt"))],
    ["bad_signature", async () => flipLastByte(await alice().signDelegate(claimAction(FAIRGROUND, "fairt")))],
  ])("maps the relayer's %s refusal, which sent nothing", async (reason, signed) => {
    const { client, relayed } = inProcessRelayer();
    const error = await client.relay(await signed()).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(RelayerError);
    expect(error).toMatchObject({ reason, status: 400, maybeSubmitted: false, requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(relayed).toEqual([]);
  });

  it("falls back to a paid transaction when the relayer's budget is spent", async () => {
    const { client, relayed } = inProcessRelayer({ budget: 0n });
    const paid: FairgroundAction[] = [];
    const signer: ActionSigner = { ...alice(), sendTransaction: async (action) => (paid.push(action), outcome) };
    const bid = relayable[0]![1];
    const result = await submitAction(bid, { signer, relayer: client, fairgroundContract: FAIRGROUND });
    expect(result).toMatchObject({ paidBy: "user", fallbackReason: "budget_exhausted", txHash: "RelayTx", status: "succeeded" });
    expect(paid).toEqual([bid]);
    expect(relayed).toEqual([]);
  });

  it("reads the policy and sponsors storage", async () => {
    const { client } = inProcessRelayer();
    expect(await client.getPolicy()).toMatchObject({
      relayer_account_id: RELAYER,
      fairground_contract: FAIRGROUND,
      usdc_contracts: [USDC],
      bid_deposit: "1",
      fairground_methods: ["claim", "claim_proceeds", "clear_onchain", "reveal_bid", "trigger_refund_mode", "seed_liquidity", "abandon_liquidity"],
    });
    expect(await client.sponsorStorage("dave.test.near")).toEqual({ status: "registered", token_id: USDC, tx_hash: "StorageTx" });
  });
});

/** Corrupts the signature's last byte, keeping the encoding valid. */
function flipLastByte(base64: string): string {
  const bytes = base64Decode(base64);
  bytes[bytes.length - 1]! ^= 1;
  return base64Encode(bytes);
}
