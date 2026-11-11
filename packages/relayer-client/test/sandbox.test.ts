/**
 * End to end on a local nearcore sandbox: the real fairground.wasm and
 * mock_ft.wasm (as USDC), the real relayer (in process, real RPC), and this
 * client's builders, signers and fallback. One commit-reveal sale is taken
 * through every relayed call (bid, reveal, clear_onchain, claim, claim_proceeds),
 * and a second one through trigger_refund_mode, so each builder's gas is proven
 * on chain.
 *
 * Run with `pnpm test:sandbox` (scripts/test-sandbox.ps1 starts and removes the
 * near-sandbox-relayer container). Skipped unless RELAYER_CLIENT_SANDBOX_RPC and
 * RELAYER_CLIENT_SANDBOX_KEY are set.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRelayer, loadConfig } from "@fairground/relayer";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, nearToYocto, teraToGas, type KeyPairString } from "near-api-js";
import { beforeAll, describe, expect, it } from "vitest";
import {
  RelayerError,
  bidAction,
  bidOutcome,
  claimAction,
  claimProceedsAction,
  clearOnchainAction,
  createRelayerClient,
  keyPairSigner,
  revealAction,
  submitAction,
  triggerRefundModeAction,
  walletSigner,
  type ActionSigner,
  type FairgroundAction,
  type FallbackReason,
  type RelayerClient,
} from "../src/index";
import { stubWallet } from "./helpers";

const RPC = process.env["RELAYER_CLIENT_SANDBOX_RPC"];
const KEY_FILE = process.env["RELAYER_CLIENT_SANDBOX_KEY"];
const RES = new URL("../../../contracts/res/", import.meta.url);
const SECOND_NS = 1_000_000_000n;
const USDC_UNIT = 1_000_000n;
/** Block time sandbox_fast_forward adds per block (contracts/tests: about 0.29 s). */
const NS_PER_FORWARDED_BLOCK = 290_000_000n;

describe.skipIf(!RPC || !KEY_FILE)("relayer client on a local sandbox", { timeout: 120_000 }, () => {
  const uid = Date.now().toString(36);
  const saleId = `c${uid}`;
  const idleSaleId = `i${uid}`;
  const salt = randomBytes(16).toString("hex");
  const aliceBid = { maxPrice: 2_000n, maxSpend: 2n * USDC_UNIT };

  let provider: JsonRpcProvider;
  let usdc: Named;
  let fairground: Named;
  let creator: Named;
  let alice: Named;
  let bob: Named;
  let carol: Named;
  let dave: Named;
  /** The relayer as configured for the tests, and one whose daily budget is 0. */
  let relayer: RelayerClient;
  let brokeRelayer: RelayerClient;

  interface Named {
    id: string;
    account: Account;
    signer: ActionSigner;
    key: KeyPair;
  }

  // ---- chain helpers -------------------------------------------------------

  const view = async <T,>(contractId: string, method: string, args: Record<string, unknown> = {}) =>
    (await provider.callFunction({ contractId, method, args })) as T;
  const nearOf = async (accountId: string) => (await provider.viewAccount({ accountId })).amount;
  const usdcOf = async (accountId: string) => BigInt(await view<string>(usdc.id, "ft_balance_of", { account_id: accountId }));
  const sale = (id: string) => view<{ status: string; bid_end: string; reveal_end: string | null; refund_mode_at: string | null }>(fairground.id, "get_sale", { sale_id: id });
  const chainTime = async () => BigInt((await provider.viewBlock({ finality: "optimistic" })).header.timestamp_nanosec);

  /** Moves the chain clock to at least `at` (ns) with the sandbox's fast_forward. */
  async function advanceTo(at: bigint): Promise<void> {
    for (let now = await chainTime(); now < at; now = await chainTime()) {
      const blocks = Number((at - now) / NS_PER_FORWARDED_BLOCK + 2n);
      const res = await fetch(RPC!, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "ff", method: "sandbox_fast_forward", params: { delta_height: Math.min(blocks, 3_000) } }),
      });
      const body = (await res.json()) as { error?: unknown };
      if (body.error) throw new Error(`sandbox_fast_forward: ${JSON.stringify(body.error)}`);
    }
  }

  /** sha256 commitment of contracts/DESIGN.md "Commitment (commit-reveal mode)". */
  function commitment(bidder: string, maxPrice: bigint, maxSpend: bigint): string {
    const u128 = (value: bigint) => Buffer.from(value.toString(16).padStart(32, "0"), "hex");
    const zero = Buffer.from([0]);
    return createHash("sha256")
      .update("fairground/commit/v1").update(zero).update(saleId).update(zero).update(bidder).update(zero)
      .update(u128(maxPrice)).update(u128(maxSpend)).update(Buffer.from(salt, "hex"))
      .digest("hex");
  }

  const submit = (action: FairgroundAction, signer: ActionSigner, via = relayer, onPaidFallback?: (reason: FallbackReason) => void) =>
    submitAction(action, { signer, relayer: via, fairgroundContract: fairground.id, ...(onPaidFallback && { onPaidFallback }) });

  // ---- setup ---------------------------------------------------------------

  beforeAll(async () => {
    const fairgroundWasm = new URL("fairground.wasm", RES);
    if (!existsSync(fairgroundWasm)) throw new Error("contracts/res/fairground.wasm is missing: build the contracts first");
    provider = new JsonRpcProvider({ url: RPC! });
    const validator = JSON.parse(readFileSync(KEY_FILE!, "utf8")) as { account_id: string; secret_key?: string; private_key?: string };
    const root = new Account(validator.account_id, provider, (validator.secret_key ?? validator.private_key) as KeyPairString);

    const create = async (name: string, near: number): Promise<Named> => {
      const key = KeyPair.fromRandom("ed25519");
      const id = `${name}-${uid}.${root.accountId}`;
      await root.createAccount({ newAccountId: id, publicKey: key.getPublicKey(), nearToTransfer: nearToYocto(near) });
      return { id, key, account: new Account(id, provider, new KeyPairSigner(key)), signer: keyPairSigner({ accountId: id, keyPair: key, provider }) };
    };
    let relayerAccount: Named;
    [relayerAccount, usdc, fairground, creator, alice, bob, carol, dave] = await Promise.all([
      create("relayer", 30),
      create("usdc", 10),
      create("fg", 30),
      create("creator", 20),
      create("alice", 5),
      create("bob", 5),
      create("carol", 5),
      create("dave", 5),
    ]);

    await usdc.account.deployContract(readFileSync(new URL("mock_ft.wasm", RES)));
    await usdc.account.callFunction({ contractId: usdc.id, methodName: "new", args: { name: "USD Coin", symbol: "USDC", decimals: 6 } });
    const sealerHash = "ab".repeat(32);
    await fairground.account.deployContract(readFileSync(fairgroundWasm));
    await fairground.account.callFunction({
      contractId: fairground.id,
      methodName: "new",
      args: {
        outlayer: root.accountId,
        sealer_source: { WasmUrl: { url: "https://example.com/sealer.wasm", hash: sealerHash, build_target: "wasm32-wasip1" } },
        sealer_code_hash: sealerHash,
        sealer_secrets: null,
        allowed_quote_tokens: [usdc.id],
      },
      gas: teraToGas(50),
    });

    // Two commit-reveal sales (no OutLayer needed) whose bid windows open in 4 s and last a minute.
    const bidStart = (await chainTime()) + 4n * SECOND_NS;
    for (const id of [saleId, idleSaleId]) {
      const params = {
        sale_id: id,
        token_name: "Client Test",
        token_symbol: "CLT",
        decimals: 18,
        total_supply: (10n ** 24n).toString(),
        sale_supply: (6n * 10n ** 23n).toString(),
        floor_price: "1000",
        min_raise: "0",
        bid_start: bidStart.toString(),
        bid_end: (bidStart + 60n * SECOND_NS).toString(),
        min_deposit: USDC_UNIT.toString(),
        max_deposit_per_account: (10n * USDC_UNIT).toString(),
        max_bids: 10,
        reveal_mode: "CommitReveal",
        reveal_window: (60n * SECOND_NS).toString(),
        settle_timeout: (600n * SECOND_NS).toString(),
        quote_token: usdc.id,
      };
      const cost = await view<string>(fairground.id, "get_create_cost", { params });
      await creator.account.callFunction({ contractId: fairground.id, methodName: "create_sale", args: { params }, deposit: BigInt(cost), gas: teraToGas(300) });
    }
    for (const who of [alice, bob, carol]) {
      await root.callFunction({ contractId: usdc.id, methodName: "mint", args: { account_id: who.id, amount: (100n * USDC_UNIT).toString() }, gas: teraToGas(30) });
    }
    await advanceTo(bidStart);
    expect((await sale(saleId)).status).toBe("open");

    const env = (overrides: Record<string, string> = {}) => ({
      NETWORK: "sandbox",
      NEAR_RPC_URL: RPC!,
      RELAYER_ACCOUNT_ID: relayerAccount.id,
      RELAYER_PRIVATE_KEY: relayerAccount.key.toString(),
      FAIRGROUND_CONTRACT: fairground.id,
      USDC_CONTRACTS: usdc.id,
      ...overrides,
    });
    const inProcess = (overrides?: Record<string, string>) => {
      const app = createRelayer(loadConfig(env(overrides)), { clientIp: () => "198.51.100.9", log: () => {} });
      return createRelayerClient({ url: "http://relayer.test", fetch: async (input, init) => app.fetch(new Request(input, init)) });
    };
    relayer = inProcess();
    brokeRelayer = inProcess({ DAILY_BUDGET_NEAR: "0" });
  }, 240_000);

  // ---- tests ---------------------------------------------------------------

  it("reads the relayer's policy", async () => {
    expect(await relayer.getPolicy()).toMatchObject({ network: "sandbox", fairground_contract: fairground.id, usdc_contracts: [usdc.id] });
  });

  it("sponsors a new bidder's USDC storage once", async () => {
    expect(await view(usdc.id, "storage_balance_of", { account_id: dave.id })).toBeNull();
    expect(await relayer.sponsorStorage(dave.id)).toMatchObject({ status: "registered", token_id: usdc.id, tx_hash: expect.any(String) });
    expect(await view(usdc.id, "storage_balance_of", { account_id: dave.id })).not.toBeNull();
    expect(await relayer.sponsorStorage(dave.id)).toEqual({ status: "already_registered", token_id: usdc.id });
  });

  it("relays a bid: the relayer pays, the contract places it, the bidder spends no NEAR", async () => {
    const [nearBefore, usdcBefore] = [await nearOf(alice.id), await usdcOf(alice.id)];
    const bid = bidAction(usdc.id, fairground.id, saleId, 2n * USDC_UNIT, { commitment: commitment(alice.id, aliceBid.maxPrice, aliceBid.maxSpend) });
    const result = await submit(bid, alice.signer);
    expect(result).toMatchObject({ paidBy: "relayer", fallbackReason: null, status: "succeeded", failures: [] });
    expect(bidOutcome(result.events)).toEqual({ kind: "placed" });
    expect(await nearOf(alice.id)).toBe(nearBefore);
    expect(usdcBefore - (await usdcOf(alice.id))).toBe(2n * USDC_UNIT);
    expect(await view(fairground.id, "get_bid", { sale_id: saleId, bidder: alice.id })).toMatchObject({ bidder: alice.id });
    const tx = await provider.viewTransactionStatus({ txHash: result.txHash!, accountId: (await relayer.getPolicy()).relayer_account_id });
    expect(tx.transaction_outcome.id).toBe(result.txHash);
  });

  it("falls back to a paid transaction through a NEAR Connect wallet when the relayer's budget is spent", async () => {
    // The wallet signs the delegate with its own encoder; the relayer checks it all the way to the budget.
    const { wallet } = stubWallet({ accountId: bob.id, keyPair: bob.key, provider });
    const told: FallbackReason[] = [];
    const nearBefore = await nearOf(bob.id);
    const bid = bidAction(usdc.id, fairground.id, saleId, 3n * USDC_UNIT, { commitment: commitment(bob.id, 1_500n, USDC_UNIT) });
    const result = await submit(bid, walletSigner(wallet, { signerId: bob.id }), brokeRelayer, (reason) => void told.push(reason));
    expect(told).toEqual(["budget_exhausted"]);
    expect(result).toMatchObject({ paidBy: "user", fallbackReason: "budget_exhausted", status: "succeeded", txHash: expect.any(String) });
    expect(bidOutcome(result.events)).toEqual({ kind: "placed" });
    expect(await nearOf(bob.id)).toBeLessThan(nearBefore); // bob paid the gas
  });

  it("tells a refunded bid from a placed one although both transactions succeed", async () => {
    const usdcBefore = await usdcOf(carol.id);
    const result = await submit(bidAction(usdc.id, fairground.id, saleId, USDC_UNIT / 2n, { commitment: commitment(carol.id, 1n, 1n) }), carol.signer);
    expect(result).toMatchObject({ paidBy: "relayer", status: "succeeded" });
    expect(bidOutcome(result.events)).toEqual({ kind: "rejected", reason: "below_min_deposit" });
    expect(await usdcOf(carol.id)).toBe(usdcBefore);
  });

  it("reveals, claims and pays out the creator through the relayer", async () => {
    await advanceTo(BigInt((await sale(saleId)).bid_end));
    await creator.account.callFunction({ contractId: fairground.id, methodName: "close_sale", args: { sale_id: saleId }, gas: teraToGas(100) });
    expect((await sale(saleId)).status).toBe("revealing");

    const reveal = await submit(revealAction(fairground.id, saleId, { ...aliceBid, salt }), alice.signer);
    expect(reveal).toMatchObject({ paidBy: "relayer", status: "succeeded", events: [{ event: "bid_revealed", data: { bidder: alice.id } }] });

    // Clearing is refused while the reveal window is open, without spending a nonce.
    const daveNonce = async () => (await provider.viewAccessKey({ accountId: dave.id, publicKey: dave.key.getPublicKey() })).nonce;
    const nonceBefore = await daveNonce();
    const early = await submit(clearOnchainAction(fairground.id, saleId), dave.signer).catch((thrown: unknown) => thrown);
    expect(early).toMatchObject({ name: "RelayerError", reason: "wrong_phase", status: 400, maybeSubmitted: false });
    expect(await daveNonce()).toBe(nonceBefore);

    // Once it has ended, anyone clears the sale through the relayer: dave never bid.
    await advanceTo(BigInt((await sale(saleId)).reveal_end!));
    const daveNear = await nearOf(dave.id);
    const clear = await submit(clearOnchainAction(fairground.id, saleId), dave.signer);
    expect(clear).toMatchObject({ paidBy: "relayer", status: "succeeded", failures: [] });
    expect(clear.events).toContainEqual(expect.objectContaining({ event: "sale_settled", data: expect.objectContaining({ sale_id: saleId, n_valid: 1, n_invalid: 1 }) }));
    expect(await nearOf(dave.id)).toBe(daveNear);
    expect((await sale(saleId)).status).toBe("settled");
    // Bob never revealed: his bid is invalid and pays the 1 % penalty (rounded up) of his 3 USDC deposit.
    const result = await view<{ total_penalties: string; n_invalid: number }>(fairground.id, "get_result", { sale_id: saleId });
    expect(result).toMatchObject({ total_penalties: (3n * USDC_UNIT / 100n).toString(), n_invalid: 1 });

    // A second clear finds the sale settled and is refused before anything is paid.
    const again = await submit(clearOnchainAction(fairground.id, saleId), carol.signer).catch((thrown: unknown) => thrown);
    expect(again).toMatchObject({ name: "RelayerError", reason: "wrong_phase", maybeSubmitted: false });

    // Carol pushes Alice's claim; the tokens go to Alice.
    const claim = await submit(claimAction(fairground.id, saleId, alice.id), carol.signer);
    expect(claim).toMatchObject({ paidBy: "relayer", status: "succeeded", failures: [] });
    expect(claim.events).toContainEqual(expect.objectContaining({ event: "claimed", data: expect.objectContaining({ bidder: alice.id, failed: [] }) }));
    expect(BigInt(await view<string>(`${saleId}.${fairground.id}`, "ft_balance_of", { account_id: alice.id }))).toBeGreaterThan(0n);

    const proceeds = await submit(claimProceedsAction(fairground.id, saleId), creator.signer);
    expect(proceeds).toMatchObject({ paidBy: "relayer", status: "succeeded", failures: [] });
    expect(proceeds.events).toContainEqual(expect.objectContaining({ event: "proceeds_claimed", data: expect.objectContaining({ failed: [] }) }));
    expect(await usdcOf(creator.id)).toBe(2n * USDC_UNIT);

    // Bob's unrevealed bid gets its deposit back less the penalty, also through the relayer.
    const bobUsdc = await usdcOf(bob.id);
    const refund = await submit(claimAction(fairground.id, saleId), bob.signer);
    expect(refund).toMatchObject({ paidBy: "relayer", status: "succeeded", failures: [] });
    expect((await usdcOf(bob.id)) - bobUsdc).toBe(3n * USDC_UNIT - 3n * USDC_UNIT / 100n);
    expect(await view(fairground.id, "get_bid", { sale_id: saleId, bidder: bob.id })).toMatchObject({ claimed: true });
  });

  it("is refused, not paid for, when the contract would refuse the call", async () => {
    const carolNonce = (await provider.viewAccessKey({ accountId: carol.id, publicKey: carol.key.getPublicKey() })).nonce;
    const error = await submit(triggerRefundModeAction(fairground.id, saleId), carol.signer).catch((thrown: unknown) => thrown); // the sale is final
    expect(error).toBeInstanceOf(RelayerError);
    expect(error).toMatchObject({ reason: "wrong_phase", status: 400, maybeSubmitted: false });
    expect((await provider.viewAccessKey({ accountId: carol.id, publicKey: carol.key.getPublicKey() })).nonce).toBe(carolNonce);
  });

  it("triggers refund mode on a sale nobody closed", async () => {
    await advanceTo(BigInt((await sale(idleSaleId)).refund_mode_at!));
    const result = await submit(triggerRefundModeAction(fairground.id, idleSaleId), dave.signer);
    expect(result).toMatchObject({ paidBy: "relayer", status: "succeeded", failures: [] });
    expect(result.events).toContainEqual(expect.objectContaining({ event: "refund_mode" }));
    expect((await sale(idleSaleId)).status).toBe("failed");
  });
});
