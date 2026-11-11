/**
 * End to end against a local nearcore sandbox: real accounts, the real
 * fairground.wasm and mock_ft.wasm (as USDC), the real RPC client.
 *
 * Run with `pnpm test:sandbox` (scripts/test-sandbox.ps1 starts and removes the
 * near-sandbox-relayer container). Skipped unless RELAYER_SANDBOX_RPC and
 * RELAYER_SANDBOX_KEY are set.
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  Account,
  JsonRpcProvider,
  KeyPair,
  KeyPairSigner,
  actions,
  base64Encode,
  buildDelegateAction,
  encodeSignedDelegate,
  nearToYocto,
  teraToGas,
  type Action,
  type KeyPairString,
  type SignedDelegate,
} from "near-api-js";
import { beforeAll, describe, expect, it } from "vitest";
import type { RelayResponse, StorageResponse } from "../src/api.ts";
import { decodeSignedDelegate } from "../src/delegate.ts";
import { assertRelayerKey, createRelayer, loadConfig, nearChain } from "../src/lib.ts";
import type { LogLine } from "../src/log.ts";
import { relayerCost, summarizeOutcome } from "../src/outcome.ts";

const RPC = process.env["RELAYER_SANDBOX_RPC"];
const KEY_FILE = process.env["RELAYER_SANDBOX_KEY"];
const RES = new URL("../../../contracts/res/", import.meta.url);
const CLIENT_IP = "198.51.100.7";
const SECOND_NS = 1_000_000_000n;
const USDC_UNIT = 1_000_000n;

describe.skipIf(!RPC || !KEY_FILE)("relayer on a local sandbox", { timeout: 90_000 }, () => {
  const uid = Date.now().toString(36);
  const saleId = `r${uid}`;
  const commitment = randomBytes(32).toString("hex");
  const logs: LogLine[] = [];
  const payloads: string[] = [];
  let aliceBid = "";

  let provider: JsonRpcProvider;
  let relayer: Named;
  let usdc: Named;
  let fairground: Named;
  let alice: Named;
  let carol: Named;
  let dave: Named;
  let erin: Named;
  let creator: Named;
  /** OutLayer's real contract, and the test acting as its worker (the operator). */
  let outlayer: Named;
  let operator: Named;
  /** A relayer account with too little NEAR to buy 100 TGas at protocol 88's floor price. */
  let poor: Named;
  let env: (overrides?: Record<string, string>) => Record<string, string>;

  interface Named {
    id: string;
    account: Account;
    key: KeyPair;
  }

  // ---- chain helpers -------------------------------------------------------

  const view = async <T,>(contractId: string, method: string, args: Record<string, unknown> = {}) =>
    (await provider.callFunction({ contractId, method, args })) as T;
  const nearOf = async (accountId: string) => (await provider.viewAccount({ accountId })).amount;
  const keyNonce = async ({ id, key }: Named) => (await provider.viewAccessKey({ accountId: id, publicKey: key.getPublicKey() })).nonce;
  const usdcOf = async (accountId: string) => BigInt(await view<string>(usdc.id, "ft_balance_of", { account_id: accountId }));
  const head = async () => (await provider.viewBlock({ finality: "optimistic" })).header;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * The relayer buys prepaid gas at protocol 88's 1e9 yocto/gas floor and gets the
   * unused part back in refund receipts that land a few blocks after the RPC reports
   * the transaction executed. Waits until the balance has not moved for 5 blocks.
   */
  async function steadyBalance(accountId: string): Promise<bigint> {
    let balance = await nearOf(accountId);
    let since = (await head()).height;
    for (const deadline = Date.now() + 30_000; Date.now() < deadline; ) {
      await sleep(200);
      const [now, height] = [await nearOf(accountId), (await head()).height];
      if (now !== balance) [balance, since] = [now, height];
      else if (height - since >= 5) return balance;
    }
    throw new Error(`${accountId}'s balance did not settle`);
  }

  const encode = (delegate: SignedDelegate) => {
    const payload = base64Encode(encodeSignedDelegate(delegate));
    payloads.push(payload);
    return payload;
  };

  /** A delegate signed by `who`'s full-access key (or `signer`), as a wallet would produce it. */
  async function sign(who: Named, receiverId: string, calls: Action[], { ttl = 120, signer }: { ttl?: number; signer?: KeyPair } = {}) {
    const { signedDelegate } = await who.account.createSignedMetaTransaction({
      receiverId,
      actions: calls,
      blockHeightTtl: ttl,
      ...(signer ? { signer: new KeyPairSigner(signer) } : {}),
    });
    return encode(signedDelegate);
  }

  const bidArgs = ({ amount = 2n * USDC_UNIT, receiver = fairground.id, sale = saleId, payload = { commitment } as Record<string, string> } = {}) => ({
    receiver_id: receiver,
    amount: amount.toString(),
    msg: JSON.stringify({ sale_id: sale, ...payload }),
  });
  const bidCall = ({ amount = 2n * USDC_UNIT, deposit = 1n, receiver = fairground.id, gas = teraToGas(100), sale = saleId, payload = { commitment } as Record<string, string> } = {}) =>
    actions.functionCall("ft_transfer_call", bidArgs({ amount, receiver, sale, payload }), gas, deposit);
  /**
   * Random bytes of the one length the contract accepts as a sealed bid by
   * `bidder` on `sale`: crates/clearing sealed_bid_len, 224 + both ids' bytes.
   * The contract cannot open a box, so random bytes stand in for one.
   */
  const sealedBox = (sale: string, bidder: string) => randomBytes(224 + Buffer.byteLength(sale) + Buffer.byteLength(bidder)).toString("base64");
  /** A bid whose args are exactly `text`, as a client that does not use JSON.stringify might send them. */
  const rawBid = (text: string) => actions.functionCall("ft_transfer_call", new TextEncoder().encode(text), teraToGas(100), 1n);
  const claimCall = (args: Record<string, unknown> = { sale_id: saleId }) => actions.functionCall("claim", args, teraToGas(50), 0n);

  /** A delegate in `senderId`'s name signed by `key`, which need not be a key of that account. */
  async function signAs(senderId: string, key: KeyPair, receiverId: string, calls: Action[], nonce = 1n) {
    const delegateAction = buildDelegateAction({
      senderId,
      receiverId,
      actions: calls,
      nonce,
      maxBlockHeight: BigInt((await head()).height) + 100n,
      publicKey: key.getPublicKey(),
    });
    return encode((await new KeyPairSigner(key).signDelegateAction(delegateAction)).signedDelegate);
  }

  /** Sale parameters: a bid window of 30 minutes from `bidStart`, deposits of 1 to 10 USDC. */
  const saleParams = (id: string, bidStart: bigint, revealMode: "CommitReveal" | "Tee") => ({
    sale_id: id,
    token_name: "Relay Test",
    token_symbol: "RLY",
    decimals: 18,
    total_supply: (10n ** 24n).toString(),
    sale_supply: (6n * 10n ** 23n).toString(),
    floor_price: "1000",
    min_raise: "0",
    bid_start: bidStart.toString(),
    bid_end: (bidStart + 1800n * SECOND_NS).toString(),
    min_deposit: USDC_UNIT.toString(),
    max_deposit_per_account: (10n * USDC_UNIT).toString(),
    max_bids: 10,
    reveal_mode: revealMode,
    settle_timeout: (600n * SECOND_NS).toString(),
    quote_token: usdc.id,
  });

  async function untilOpen(id: string): Promise<void> {
    for (let i = 0; ; i++) {
      const sale = await view<{ status: string }>(fairground.id, "get_sale", { sale_id: id });
      if (sale.status === "open") return;
      if (i > 60) throw new Error(`sale did not open: ${JSON.stringify(sale)}`);
      await sleep(500);
    }
  }

  /**
   * Answers OutLayer's next pending request as its worker would, for a
   * `pubkey` job: the sealer's reply with a fresh X25519 public key. The
   * contract cannot tell it from the enclave's, and no test here opens a bid.
   */
  async function servePubkey(): Promise<void> {
    for (let i = 0; i < 150; i++) {
      const [requestId] = await view<number[]>(outlayer.id, "get_pending_request_ids");
      if (requestId !== undefined) {
        const request = await view<{ input_data: string }>(outlayer.id, "get_request", { request_id: requestId });
        const input = JSON.parse(request.input_data) as { op: string; sale_id: string };
        expect(input.op).toBe("pubkey");
        const pubkey = generateKeyPairSync("x25519").publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
        const output = JSON.stringify({ v: 1, ok: true, op: "pubkey", sale_id: input.sale_id, pubkey });
        const response = {
          success: true,
          output: { Text: output },
          error: null,
          resources_used: { instructions: 1_000_000, time_ms: 100, compile_time_ms: null },
          compilation_note: null,
          refund_usd: null,
        };
        await operator.account.callFunction({
          contractId: outlayer.id,
          methodName: "resolve_execution",
          args: { request_id: requestId, response },
          gas: teraToGas(300),
        });
        return;
      }
      await sleep(100);
    }
    throw new Error("no OutLayer request within 15 s");
  }

  function relayerApp(overrides: Record<string, string> = {}) {
    const app = createRelayer(loadConfig(env(overrides)), { log: (line) => logs.push(line), clientIp: () => CLIENT_IP });
    return async (path: string, body: unknown) => {
      const res = await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
  }

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
      return { id, key, account: new Account(id, provider, new KeyPairSigner(key)) };
    };
    [relayer, usdc, fairground, creator, alice, carol, dave, erin, poor, outlayer, operator] = await Promise.all([
      create("relayer", 30),
      create("usdc", 10),
      create("fg", 30),
      create("creator", 20),
      create("alice", 5),
      create("carol", 5),
      create("dave", 5),
      create("erin", 5),
      create("poor", 0.05),
      create("outlayer", 20),
      create("operator", 10),
    ]);

    await outlayer.account.deployContract(readFileSync(new URL("outlayer_contract.wasm", RES)));
    await outlayer.account.callFunction({ contractId: outlayer.id, methodName: "new", args: { owner_id: operator.id, operator_id: operator.id } });

    await usdc.account.deployContract(readFileSync(new URL("mock_ft.wasm", RES)));
    await usdc.account.callFunction({ contractId: usdc.id, methodName: "new", args: { name: "USD Coin", symbol: "USDC", decimals: 6 } });
    const sealerHash = "ab".repeat(32);
    await fairground.account.deployContract(readFileSync(fairgroundWasm));
    await fairground.account.callFunction({
      contractId: fairground.id,
      methodName: "new",
      args: {
        outlayer: outlayer.id,
        sealer_source: { WasmUrl: { url: "https://example.com/sealer.wasm", hash: sealerHash, build_target: "wasm32-wasip1" } },
        sealer_code_hash: sealerHash,
        sealer_secrets: null,
        allowed_quote_tokens: [usdc.id],
      },
      gas: teraToGas(50),
    });

    // A commit-reveal sale (no OutLayer needed) whose bid window opens in 4 s.
    const params = saleParams(saleId, BigInt((await head()).timestamp) + 4n * SECOND_NS, "CommitReveal");
    const cost = await view<string>(fairground.id, "get_create_cost", { params });
    await creator.account.callFunction({
      contractId: fairground.id,
      methodName: "create_sale",
      args: { params },
      deposit: BigInt(cost),
      gas: teraToGas(300),
    });
    for (const who of [alice, carol, erin]) {
      await root.callFunction({ contractId: usdc.id, methodName: "mint", args: { account_id: who.id, amount: (100n * USDC_UNIT).toString() }, gas: teraToGas(30) });
    }
    await untilOpen(saleId);

    env = (overrides = {}) => ({
      NETWORK: "sandbox",
      NEAR_RPC_URL: RPC!,
      RELAYER_ACCOUNT_ID: relayer.id,
      RELAYER_PRIVATE_KEY: relayer.key.toString(),
      FAIRGROUND_CONTRACT: fairground.id,
      USDC_CONTRACTS: usdc.id,
      ...overrides,
    });
  }, 180_000);

  // ---- tests ---------------------------------------------------------------

  it("starts only with a full-access relayer key", async () => {
    const config = loadConfig(env());
    await expect(assertRelayerKey(nearChain(provider, relayer.id, config.relayerKey), config)).resolves.toBeUndefined();

    const callKey = KeyPair.fromRandom("ed25519");
    await relayer.account.addFunctionCallAccessKey({ publicKey: callKey.getPublicKey(), contractId: fairground.id, methodNames: [] });
    const limited = loadConfig(env({ RELAYER_PRIVATE_KEY: callKey.toString() }));
    await expect(assertRelayerKey(nearChain(provider, relayer.id, callKey), limited)).rejects.toThrow("not a full-access key");
  });

  it("registers a new bidder's USDC storage once, paying the bounds minimum", async () => {
    const post = relayerApp();
    const min = BigInt((await view<{ min: string }>(usdc.id, "storage_balance_bounds")).min);
    const before = await steadyBalance(relayer.id);

    const first = await post("/storage", { account_id: dave.id });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: "registered", token_id: usdc.id } satisfies Partial<StorageResponse>);
    expect(await view(usdc.id, "storage_balance_of", { account_id: dave.id })).not.toBeNull();
    const tx = await provider.viewTransactionStatus({ txHash: String(first.body["tx_hash"]), accountId: relayer.id });
    const spent = before - (await steadyBalance(relayer.id));
    expect(spent).toBe(relayerCost(tx, min));
    expect(spent).toBeGreaterThan(min);
    expect(spent).toBeLessThan(min + nearToYocto(0.001));

    const again = await post("/storage", { account_id: dave.id });
    expect(again.body).toEqual({ status: "already_registered", token_id: usdc.id });
    expect(await post("/storage", { account_id: `ghost-${uid}.test.near` })).toMatchObject({ status: 400, body: { error: "unknown_account" } });
    expect(before - (await nearOf(relayer.id))).toBe(spent);
  });

  it("relays a bid: the relayer pays the gas and the 1 yocto, the bidder pays no NEAR", async () => {
    const post = relayerApp();
    const payload = (aliceBid = await sign(alice, usdc.id, [bidCall()]));
    const [aliceNear, relayerNear, aliceUsdc] = await Promise.all([steadyBalance(alice.id), steadyBalance(relayer.id), usdcOf(alice.id)]);

    const res = await post("/relay", { signed_delegate: payload });
    expect(res.status).toBe(200);
    const body = res.body as unknown as RelayResponse;
    expect(body.status).toBe("succeeded");
    expect(body.outcome?.failures).toEqual([]);
    expect(body.outcome?.events).toContainEqual(expect.objectContaining({ event: "bid_placed", data: expect.objectContaining({ sale_id: saleId, bidder: alice.id }) }));

    expect((await steadyBalance(alice.id)) - aliceNear).toBe(0n);
    expect(relayerNear - (await steadyBalance(relayer.id))).toBe(BigInt(body.outcome!.relayer_cost));
    expect(aliceUsdc - (await usdcOf(alice.id))).toBe(2n * USDC_UNIT);
    expect(await view(fairground.id, "get_bid", { sale_id: saleId, bidder: alice.id })).toMatchObject({ bidder: alice.id });

    // The hash the relayer reports is the one the chain knows.
    const tx = await provider.viewTransactionStatus({ txHash: body.tx_hash, accountId: relayer.id });
    expect(tx.transaction_outcome.id).toBe(body.tx_hash);
  });

  it("reports an inner failure that the top-level status hides", async () => {
    // With 1 TGas, ft_transfer_call runs out of gas in USDC, after the relayer has paid.
    const post = relayerApp();
    const payload = await sign(alice, usdc.id, [bidCall({ gas: teraToGas(1) })]);
    const res = await post("/relay", { signed_delegate: payload });
    const body = res.body as unknown as RelayResponse;
    expect(body.status).toBe("failed");
    expect(body.outcome?.failures).toEqual([expect.objectContaining({ executor_id: usdc.id })]);
    expect(body.outcome?.events).toEqual([]);
    const tx = await provider.viewTransactionStatus({ txHash: body.tx_hash, accountId: relayer.id });
    expect(tx.status).toEqual({ SuccessValue: "" });
  });

  it("refuses bad delegates and calls that would fail, without sending anything", async () => {
    const post = relayerApp();
    const fcKey = KeyPair.fromRandom("ed25519");
    await alice.account.addFunctionCallAccessKey({ publicKey: fcKey.getPublicKey(), contractId: usdc.id, methodNames: ["ft_transfer_call"] });
    const tampered = decodeSignedDelegate(await sign(alice, usdc.id, [bidCall()]));
    if (!tampered.ok) throw new Error("fixture did not decode");
    const fc = tampered.delegate.delegateAction.actions[0]!.functionCall!;
    fc.args = new TextEncoder().encode(new TextDecoder().decode(fc.args).replace(fairground.id, relayer.id));
    const canonical = JSON.stringify(bidArgs());
    const reveal = { sale_id: saleId, max_price: "2000", max_spend: "2000000", salt: "ab".repeat(16) };

    const cases: Array<[string, string]> = [
      ["nonce_already_used", aliceBid], // already relayed above
      ["transfer_not_to_fairground", await sign(alice, usdc.id, [bidCall({ receiver: relayer.id })])],
      ["wrong_deposit", await sign(alice, usdc.id, [bidCall({ deposit: 2n })])],
      ["wrong_deposit", await sign(alice, fairground.id, [actions.functionCall("claim", { sale_id: saleId }, teraToGas(30), 1n)])],
      ["method_not_allowed", await sign(alice, fairground.id, [actions.functionCall("create_sale", {}, teraToGas(30), 0n)])],
      ["method_not_allowed", await sign(alice, fairground.id, [actions.functionCall("close_sale", { sale_id: saleId }, teraToGas(30), 0n)])],
      ["action_not_allowed", await sign(alice, relayer.id, [actions.transfer(nearToYocto(1))])],
      ["expired", await sign(alice, usdc.id, [bidCall()], { ttl: 2 })],
      ["validity_too_long", await sign(alice, usdc.id, [bidCall()], { ttl: 5000 })],
      ["needs_full_access_key", await sign(alice, usdc.id, [bidCall()], { signer: fcKey })],
      ["unknown_access_key", await signAs(`ghost-${uid}.test.near`, KeyPair.fromRandom("ed25519"), fairground.id, [claimCall()])],
      ["bad_signature", encode(tampered.delegate)],
      ["bad_encoding", "AAAA"],
      ["bad_encoding", await signAs("Alice.TEST", alice.key, fairground.id, [claimCall()])],
      // Args the token's serde would read differently from JSON.parse:
      ["bad_transfer_args", await sign(alice, usdc.id, [rawBid(canonical.replace("{", `{"receiver_id":"${relayer.id}",`))])],
      ["bad_transfer_args", await sign(alice, usdc.id, [rawBid(`﻿${canonical}`)])],
      ["bad_call_args", await sign(alice, fairground.id, [claimCall({ sale_id: saleId, memo: "x".repeat(4000) })])],
      // Calls the contract would refuse at this point of the sale:
      ["unknown_sale", await sign(alice, fairground.id, [claimCall({ sale_id: "nosuchsale" })])],
      ["wrong_phase", await sign(alice, fairground.id, [claimCall()])],
      ["wrong_phase", await sign(alice, fairground.id, [actions.functionCall("reveal_bid", reveal, teraToGas(30), 0n)])],
      ["wrong_phase", await sign(alice, fairground.id, [actions.functionCall("trigger_refund_mode", { sale_id: saleId }, teraToGas(30), 0n)])],
      ["wrong_phase", await sign(alice, fairground.id, [actions.functionCall("clear_onchain", { sale_id: saleId }, teraToGas(150), 0n)])],
      // A sealed bid of the length the contract takes from carol, on a commit-reveal sale.
      ["wrong_payload", await sign(carol, usdc.id, [bidCall({ payload: { ciphertext: sealedBox(saleId, carol.id) } })])],
      // One of any other length is refused before the sale is even read.
      ["wrong_ciphertext_length", await sign(carol, usdc.id, [bidCall({ payload: { ciphertext: Buffer.alloc(96, 7).toString("base64") } })])],
      // Dave's box ("dave-" is one byte shorter than "carol-") sent by carol.
      ["wrong_ciphertext_length", await sign(carol, usdc.id, [bidCall({ payload: { ciphertext: sealedBox(saleId, dave.id) } })])],
      ["insufficient_balance", await sign(carol, usdc.id, [bidCall({ amount: 1000n * USDC_UNIT })])],
    ];
    const [relayerNear, relayerNonce, aliceNonce] = await Promise.all([steadyBalance(relayer.id), keyNonce(relayer), keyNonce(alice)]);
    const results = [];
    for (const [, payload] of cases) {
      const res = await post("/relay", { signed_delegate: payload });
      results.push({ reason: res.body["error"], status: res.status });
    }
    expect(results).toEqual(cases.map(([reason]) => ({ reason, status: 400 })));
    expect(await nearOf(relayer.id)).toBe(relayerNear);
    expect(await keyNonce(relayer)).toBe(relayerNonce);
    expect(await keyNonce(alice)).toBe(aliceNonce);
  });

  it("counts toward a sender's quota only relays its own key asked for, and limits per IP", async () => {
    const perSender = relayerApp({ RELAYS_PER_SENDER_PER_HOUR: "1" });
    const results = [];
    // Delegates in carol's name signed by keys that are not hers, and a replay of alice's: refused, not counted.
    for (let i = 0; i < 3; i++) {
      const forged = await signAs(carol.id, KeyPair.fromRandom("ed25519"), usdc.id, [bidCall()], 1_000n);
      results.push((await perSender("/relay", { signed_delegate: forged })).body["error"]);
    }
    results.push((await perSender("/relay", { signed_delegate: aliceBid })).body["error"]);
    expect(results).toEqual(["unknown_access_key", "unknown_access_key", "unknown_access_key", "nonce_already_used"]);
    // Carol's own bid still goes through, and only her second one is over the limit.
    const first = await perSender("/relay", { signed_delegate: await sign(carol, usdc.id, [bidCall()]) });
    expect(first).toMatchObject({ status: 200, body: { status: "succeeded" } });
    expect((first.body as unknown as RelayResponse).outcome?.events).toContainEqual(expect.objectContaining({ event: "bid_placed" }));
    const second = await perSender("/relay", { signed_delegate: await sign(carol, usdc.id, [bidCall()]) });
    expect(second).toMatchObject({ status: 429, body: { error: "rate_limited" } });

    const perIp = relayerApp({ REQUESTS_PER_IP_PER_HOUR: "1" });
    expect((await perIp("/relay", { signed_delegate: "AAAA" })).body["error"]).toBe("bad_encoding");
    expect(await perIp("/storage", { account_id: carol.id })).toMatchObject({ status: 429, body: { error: "rate_limited" } });
  });

  it("reports a transaction the RPC refuses as relay_failed even when it does not wait", async () => {
    // poor holds 0.05 NEAR: less than the 0.1 NEAR that 100 TGas costs up front at 1e9 yocto/gas.
    const post = relayerApp({ RELAY_WAIT_MS: "0", RELAYER_ACCOUNT_ID: poor.id, RELAYER_PRIVATE_KEY: poor.key.toString() });
    const erinNonce = await keyNonce(erin);
    const res = await post("/relay", { signed_delegate: await sign(erin, usdc.id, [bidCall()]) });
    expect(res).toMatchObject({ status: 502, body: { error: "relay_failed" } });
    expect(await keyNonce(erin)).toBe(erinNonce);
  });

  it("answers with the real hash at once when it does not wait", async () => {
    const post = relayerApp({ RELAY_WAIT_MS: "0" });
    const res = await post("/relay", { signed_delegate: await sign(erin, usdc.id, [bidCall()]) });
    expect(res).toMatchObject({ status: 202, body: { status: "pending", outcome: null } });
    const txHash = String(res.body["tx_hash"]);
    const tx = await provider.viewTransactionStatus({ txHash, accountId: relayer.id, waitUntil: "EXECUTED_OPTIMISTIC" });
    expect(tx.receipts_outcome.every(({ outcome }) => !(typeof outcome.status === "object" && "Failure" in outcome.status))).toBe(true);
    expect(await view(fairground.id, "get_bid", { sale_id: saleId, bidder: erin.id })).toMatchObject({ bidder: erin.id });
  });

  it("relays a sealed bid of exactly the length the contract takes on a TEE sale; the contract refunds any other", async () => {
    const teeSale = `t${uid}`;
    const params = saleParams(teeSale, BigInt((await head()).timestamp) + 6n * SECOND_NS, "Tee");
    const cost = await view<string>(fairground.id, "get_create_cost", { params });
    // create_sale waits on OutLayer for the sale's key, so only wait for inclusion and then answer as the worker.
    await creator.account.signAndSendTransaction({
      receiverId: fairground.id,
      actions: [actions.functionCall("create_sale", { params }, teraToGas(300), BigInt(cost))],
      waitUntil: "INCLUDED_FINAL",
    });
    await servePubkey();
    await untilOpen(teeSale);

    // Erin's box is 224 + len(sale id) + len(erin's account id) bytes: the relayer takes it and the contract places it.
    const post = relayerApp();
    const box = sealedBox(teeSale, erin.id);
    const res = await post("/relay", { signed_delegate: await sign(erin, usdc.id, [bidCall({ sale: teeSale, payload: { ciphertext: box } })]) });
    expect(res.status).toBe(200);
    const body = res.body as unknown as RelayResponse;
    expect(body.outcome?.events).toContainEqual(expect.objectContaining({ event: "bid_placed", data: expect.objectContaining({ sale_id: teeSale, bidder: erin.id }) }));
    expect(await view(fairground.id, "get_bid", { sale_id: teeSale, bidder: erin.id })).toMatchObject({ bidder: erin.id, payload: box });

    // The relayer refuses a box one byte short (static check, nothing sent)...
    const short = randomBytes(Buffer.from(box, "base64").length - 1).toString("base64");
    const refused = await post("/relay", { signed_delegate: await sign(carol, usdc.id, [bidCall({ sale: teeSale, payload: { ciphertext: short } })]) });
    expect(refused).toMatchObject({ status: 400, body: { error: "wrong_ciphertext_length" } });
    // ...and the contract refunds one sent past the relayer, with a reason of the same name.
    const carolUsdc = await usdcOf(carol.id);
    const tx = await carol.account.signAndSendTransaction({
      receiverId: usdc.id,
      actions: [bidCall({ sale: teeSale, payload: { ciphertext: randomBytes(224 + teeSale.length + carol.id.length - 1).toString("base64") } })],
      waitUntil: "EXECUTED_OPTIMISTIC",
    });
    const { events } = summarizeOutcome(tx, fairground.id, 1n);
    expect(events).toContainEqual({ event: "bid_rejected", data: expect.objectContaining({ sale_id: teeSale, sender_id: carol.id, reason: "wrong_ciphertext_length" }) });
    expect(await usdcOf(carol.id)).toBe(carolUsdc);
  }, 120_000);

  it("never logs payloads, bid contents or IPs", () => {
    const text = JSON.stringify(logs);
    expect(logs.length).toBeGreaterThan(20);
    expect(text).not.toContain(commitment);
    expect(text).not.toContain(CLIENT_IP);
    for (const payload of payloads) expect(text).not.toContain(payload.slice(0, 40));
    for (const line of logs) expect(Object.keys(line).every((key) => /^(request_id|endpoint|decision|reason|account|tx_hash|status|cost|error|ms)$/.test(key))).toBe(true);
  });
});
