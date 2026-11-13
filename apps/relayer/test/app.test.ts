import { KeyPair, teraToGas, type AccessKeyView, type PublicKey } from "near-api-js";
import { describe, expect, it } from "vitest";
import type { ErrorResponse, PolicyResponse, RelayResponse, StorageResponse } from "../src/api.ts";
import { createApp } from "../src/app.ts";
import { TransactionRefused, type Chain, type Submission, type TxOutcome } from "../src/chain.ts";
import { DailyNearBudget, ipHasher, memoryLimiters } from "../src/limits.ts";
import type { LogLine } from "../src/log.ts";
import { ALICE, CIPHERTEXT, FAIRGROUND, HEAD, POLICY, USDC, bid, bidArgs, call, fakeViews, liquidityView, proceedsResult, sale, signDelegate, type DelegateSpec } from "./fixtures.ts";

const IP = "203.0.113.9";
/** What one storage registration reserves with the fake chain: (30 + 5 TGas) x 1e8 + the 0.00125 NEAR minimum. */
const STORAGE_COST = 35n * 10n ** 12n * 100_000_000n + 1_250_000_000_000_000_000_000n;
const outcome = {
  status: { SuccessValue: "" },
  transaction_outcome: { id: "tx1", outcome: { executor_id: "relayer", status: { SuccessReceiptId: "r" }, tokens_burnt: "7", logs: [] } },
  receipts_outcome: [
    {
      id: "r",
      outcome: {
        executor_id: FAIRGROUND,
        status: { SuccessValue: "" },
        tokens_burnt: "3",
        logs: [`EVENT_JSON:${JSON.stringify({ standard: "fairground", event: "bid_placed", data: { sale_id: "fairt" } })}`],
      },
    },
  ],
} as unknown as TxOutcome;
const finalSubmission: Submission = { txHash: "tx1", outcome, done: Promise.resolve(outcome) };

/** Alice's key: the only access key the fake chain knows. */
const aliceKey = KeyPair.fromRandom("ed25519");
const isAliceKey = (publicKey: PublicKey) => publicKey.toString() === aliceKey.getPublicKey().toString();

/** A chain where Alice holds a full-access key at nonce 0, the sale "fairt" is open, and every call is counted. */
function fakeChain(overrides: Partial<Chain> = {}, views = fakeViews()) {
  const calls: string[] = [];
  const counted = <A extends unknown[], R>(name: string, fn: (...args: A) => Promise<R>) =>
    async (...args: A) => (calls.push(name), fn(...args));
  const chain: Chain = {
    head: counted("head", async () => ({ height: HEAD, gasPrice: 100_000_000n, timestampNs: 1_000n })),
    accessKey: counted("accessKey", async (_account: string, publicKey: PublicKey) =>
      isAliceKey(publicKey) ? ({ nonce: 0n, permission: "FullAccess" } as AccessKeyView) : undefined,
    ),
    accountExists: async () => true,
    relayerBalance: counted("relayerBalance", async () => 10n ** 25n),
    view: views,
    isRegistered: async () => false,
    storageMinimum: async () => 1_250_000_000_000_000_000_000n,
    relay: counted("relay", async () => finalSubmission),
    registerStorage: counted("registerStorage", async () => finalSubmission),
    ...overrides,
  };
  return { chain, calls };
}

interface AppOptions {
  chain?: Chain;
  budget?: bigint;
  storageBudget?: bigint;
  ipLimit?: number;
  senderLimit?: number;
  storagePerIp?: number;
  corsOrigins?: string[];
  now?: () => number;
}

function makeApp({
  chain = fakeChain().chain,
  budget = 10n ** 24n,
  storageBudget = 10n ** 24n,
  ipLimit = 100,
  senderLimit = 100,
  storagePerIp = 2,
  corsOrigins = [],
  now = Date.now,
}: AppOptions = {}) {
  const logs: LogLine[] = [];
  const relayBudget = new DailyNearBudget(budget, now);
  const app = createApp({
    config: {
      network: "sandbox",
      policy: POLICY,
      limits: { relaysPerSenderPerHour: senderLimit, requestsPerIpPerHour: ipLimit, storagePerIpPerDay: storagePerIp, dailyBudget: budget, storageBudget },
      relayWaitMs: 1000,
      corsOrigins,
    },
    chain,
    limiters: memoryLimiters(now),
    budget: relayBudget,
    storageBudget: new DailyNearBudget(storageBudget, now),
    // Tests pick the caller's address with this header; the real app reads CLIENT_IP_HEADER or the socket.
    clientIp: (c) => c.req.header("x-test-ip") ?? IP,
    hashIp: ipHasher(),
    log: (line) => logs.push(line),
  });
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown>, headers: res.headers };
  };
  return { app, post, logs, budget: relayBudget };
}

/** A delegate signed by Alice's own key with a fresh nonce: one the chain would accept. */
const aliceDelegate = async (spec: DelegateSpec = {}) => ({ signed_delegate: (await signDelegate({ key: aliceKey, ...spec })).base64 });
/** A delegate naming Alice as sender but signed by some other key. */
const forgedDelegate = async () => ({ signed_delegate: (await signDelegate()).base64 });
const errorOf = (res: { body: Record<string, unknown> }) => (res.body as unknown as ErrorResponse).error;

describe("POST /relay", () => {
  it("relays an allowed bid and summarizes the outcome", async () => {
    const { post, logs } = makeApp();
    const res = await post("/relay", await aliceDelegate());
    expect(res.status).toBe(200);
    expect(res.body as unknown as RelayResponse).toEqual({
      tx_hash: "tx1",
      status: "succeeded",
      outcome: { failures: [], events: [{ event: "bid_placed", data: { sale_id: "fairt" } }], relayer_cost: "11" },
    });
    expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(logs.at(-1)).toMatchObject({ decision: "relayed", account: ALICE, tx_hash: "tx1", status: "succeeded", cost: "11" });
  });

  it("never logs the payload, the ciphertext or the IP", async () => {
    const { post, logs } = makeApp();
    const body = await aliceDelegate();
    await post("/relay", body);
    await post("/relay", { signed_delegate: `${body.signed_delegate}AAAA` });
    const text = JSON.stringify(logs);
    expect(logs).toHaveLength(2);
    expect(text).not.toContain(CIPHERTEXT);
    expect(text).not.toContain(body.signed_delegate.slice(0, 40));
    expect(text).not.toContain(IP);
  });

  it.each([
    ["a missing field", { delegate: "x" }],
    ["a non-string field", { signed_delegate: 5 }],
    ["a JSON array", []],
    ["invalid JSON", "{"],
  ])("refuses %s as bad_request", async (_label, body) => {
    const res = await makeApp().post("/relay", body);
    expect(res.status).toBe(400);
    expect(errorOf(res)).toBe("bad_request");
  });

  it("refuses an oversized body with 413", async () => {
    const res = await makeApp().post("/relay", { signed_delegate: "A".repeat(9000) });
    expect(res.status).toBe(413);
    expect(errorOf(res)).toBe("body_too_large");
  });

  it("returns 202 with the hash when the outcome is late, and holds the sender until it lands", async () => {
    let land = (_: TxOutcome | null) => {};
    const done = new Promise<TxOutcome | null>((resolve) => (land = resolve));
    const { chain } = fakeChain({ relay: async () => ({ txHash: "slow", outcome: null, done }) });
    const { post } = makeApp({ chain });
    const first = await post("/relay", await aliceDelegate({ nonce: 1n }));
    expect(first.status).toBe(202);
    expect(first.body).toEqual({ tx_hash: "slow", status: "pending", outcome: null });
    const second = await post("/relay", await aliceDelegate({ nonce: 2n }));
    expect(second.status).toBe(409);
    expect(errorOf(second)).toBe("sender_busy");
    land(outcome);
    await done;
    await new Promise((resolve) => setImmediate(resolve));
    expect((await post("/relay", await aliceDelegate({ nonce: 3n }))).status).toBe(202);
  });

  it("refuses a no-op creator claim without spending any budget or sender quota", async () => {
    const results = { fairt: proceedsResult() };
    const { chain, calls } = fakeChain({}, fakeViews({ sales: { fairt: sale({ status: "settled" }) }, results }));
    const { post, budget } = makeApp({ chain, senderLimit: 1 });
    const proceeds = () => aliceDelegate({ receiver: FAIRGROUND, actions: [call("claim_proceeds")] });
    const refused = await post("/relay", await proceeds());
    expect(refused).toMatchObject({ status: 400, body: { error: "already_claimed" } });
    expect(calls).not.toContain("relay");
    expect(budget.used).toBe(0n);
    results.fairt = proceedsResult({ total_raised: "100" });
    expect((await post("/relay", await proceeds())).status).toBe(200);
  });

  it("allows one in-flight creator payout per sale, including across senders", async () => {
    let land = (_: TxOutcome | null) => {};
    const done = new Promise<TxOutcome | null>((resolve) => (land = resolve));
    const results = { fairt: proceedsResult({ total_raised: "100" }) };
    let submissions = 0;
    const { chain } = fakeChain({
      accessKey: async () => ({ nonce: 0n, permission: "FullAccess", block_height: Number(HEAD), block_hash: "" }),
      relay: async () => {
        submissions++;
        return { txHash: "slow", outcome: null, done };
      },
    }, fakeViews({ sales: { fairt: sale({ status: "settled" }) }, results }));
    const { post } = makeApp({ chain });
    const pay = (sender: string) => aliceDelegate({ sender, receiver: FAIRGROUND, actions: [call("claim_proceeds")] });
    expect((await post("/relay", await pay(ALICE))).status).toBe(202);
    expect(await post("/relay", await pay("bob.test.near"))).toMatchObject({ status: 400, body: { error: "wrong_phase" } });
    expect(submissions).toBe(1);

    land(outcome);
    await new Promise((resolve) => setImmediate(resolve));
    results.fairt = proceedsResult({ total_raised: "100", proceeds: { ...results.fairt.proceeds, raise_paid: true } });
    expect(await post("/relay", await pay("bob.test.near"))).toMatchObject({ status: 400, body: { error: "already_claimed" } });
    expect(submissions).toBe(1);
  });

  it("holds a pool step across senders, then sponsors the next step once the first lands", async () => {
    let land = (_: TxOutcome | null) => {};
    const done = new Promise<TxOutcome | null>((resolve) => (land = resolve));
    const results = { fairt: proceedsResult({ total_raised: "100", liquidity: liquidityView() }) };
    let submissions = 0;
    const { chain } = fakeChain({
      accessKey: async () => ({ nonce: 0n, permission: "FullAccess", block_height: Number(HEAD), block_hash: "" }),
      relay: async () => {
        submissions++;
        return submissions === 1 ? { txHash: "slow", outcome: null, done } : finalSubmission;
      },
    }, fakeViews({ sales: { fairt: sale({ status: "settled", liquidity: {} }) }, results }));
    const { post } = makeApp({ chain });
    const relay = async (sender: string, method = "seed_liquidity") => post("/relay", await aliceDelegate({
      sender, receiver: FAIRGROUND, actions: [call(method, 0n, teraToGas(150))],
    }));

    expect((await relay(ALICE)).status).toBe(202);
    expect(await relay("bob.test.near")).toMatchObject({ status: 400, body: { error: "wrong_phase" } });
    expect(await relay("bob.test.near", "claim_proceeds")).toMatchObject({ status: 400, body: { error: "wrong_phase" } });
    expect(submissions).toBe(1);

    results.fairt = proceedsResult({ liquidity: liquidityView({ next_step: "create_pool" }) });
    land(outcome);
    await new Promise((resolve) => setImmediate(resolve));
    expect((await relay("bob.test.near")).status).toBe(200);
    expect(submissions).toBe(2);
  });

  it("stops at the daily budget with 503, before sending", async () => {
    const { chain, calls } = fakeChain();
    const res = await makeApp({ budget: 1000n, chain }).post("/relay", await aliceDelegate());
    expect(res.status).toBe(503);
    expect(errorOf(res)).toBe("budget_exhausted");
    expect(calls).not.toContain("relay");
  });

  it("settles the budget at the actual cost", async () => {
    const { post, budget } = makeApp();
    await post("/relay", await aliceDelegate());
    await new Promise((resolve) => setImmediate(resolve));
    expect(budget.used).toBe(11n);
  });

  it("frees the reservation and the sender when the RPC refuses the transaction", async () => {
    const { chain } = fakeChain({
      relay: async () => {
        throw new TransactionRefused("NotEnoughBalance");
      },
    });
    const { post, budget } = makeApp({ chain });
    const res = await post("/relay", await aliceDelegate({ nonce: 1n }));
    expect(res.status).toBe(502);
    expect(errorOf(res)).toBe("relay_failed");
    expect(budget.used).toBe(0n);
    expect(errorOf(await post("/relay", await aliceDelegate({ nonce: 2n })))).toBe("relay_failed"); // not sender_busy
  });

  it("frees the reservation when sending fails before signing", async () => {
    const { chain } = fakeChain({
      relay: async () => {
        throw new Error("could not fetch the relayer nonce");
      },
    });
    const { post, budget } = makeApp({ chain });
    expect((await post("/relay", await aliceDelegate())).status).toBe(500);
    expect(budget.used).toBe(0n);
  });

  it("answers internal_error when the RPC is down, and logs only the error", async () => {
    const { chain } = fakeChain({
      head: async () => {
        throw new Error("fetch failed");
      },
    });
    const { post, logs } = makeApp({ chain });
    const res = await post("/relay", await aliceDelegate());
    expect(res.status).toBe(500);
    expect(errorOf(res)).toBe("internal_error");
    expect(logs.at(-1)).toMatchObject({ decision: "error", error: "Error: fetch failed" });
  });

  it("rate-limits by IP before decoding anything", async () => {
    const { post } = makeApp({ ipLimit: 1 });
    expect((await post("/relay", { signed_delegate: "AAAA" })).status).toBe(400);
    const res = await post("/relay", await aliceDelegate());
    expect(res.status).toBe(429);
    expect(errorOf(res)).toBe("rate_limited");
  });

  it("runs every check that needs no RPC call first", async () => {
    const { chain, calls } = fakeChain();
    const { post } = makeApp({ chain });
    const refused = [
      await post("/relay", { signed_delegate: (await signDelegate({ key: aliceKey, receiver: "evil.test.near", actions: [call("claim")] })).base64 }),
      await post("/relay", { signed_delegate: (await signDelegate({ key: aliceKey, sender: "Alice.TEST" })).base64 }),
    ].map(errorOf);
    expect(refused).toEqual(["receiver_not_allowed", "bad_encoding"]);
    expect(calls).toEqual([]);
  });

  it("asks the chain for the head at most once per half second", async () => {
    const { chain, calls } = fakeChain();
    const { post } = makeApp({ chain });
    for (const nonce of [1n, 2n, 3n]) await post("/relay", await aliceDelegate({ nonce }));
    expect(calls.filter((name) => name === "head")).toEqual(["head"]);
  });

  it("refuses a call the contract would refuse, before paying and without using the sender's quota", async () => {
    const { chain, calls } = fakeChain({}, fakeViews({ sales: { fairt: sale({ status: "open" }) } }));
    const { post } = makeApp({ chain, senderLimit: 1 });
    const claim = await post("/relay", await aliceDelegate({ receiver: FAIRGROUND, actions: [call("claim")], nonce: 1n }));
    expect(claim).toMatchObject({ status: 400, body: { error: "wrong_phase" } });
    expect(calls).not.toContain("relay");
    expect((await post("/relay", await aliceDelegate({ nonce: 2n }))).status).toBe(200);
  });

  it("refuses a sealed bid of the wrong length before any RPC call", async () => {
    const { chain, calls } = fakeChain();
    const { post, logs } = makeApp({ chain });
    const msg = JSON.stringify({ sale_id: "fairt", ciphertext: Buffer.alloc(243, 7).toString("base64") });
    const res = await post("/relay", await aliceDelegate({ actions: [bid(bidArgs({ msg }))] }));
    expect(res).toMatchObject({ status: 400, body: { error: "wrong_ciphertext_length" } });
    expect(calls).toEqual([]);
    expect(logs.at(-1)).toMatchObject({ decision: "rejected", reason: "wrong_ciphertext_length" });
  });

  it("relays clear_onchain once the reveal window has ended, and not a moment before", async () => {
    // The fake head's time is 1000 ns.
    const revealing = (reveal_end: string) => fakeViews({ sales: { fairt: sale({ status: "revealing", reveal_mode: "CommitReveal", reveal_end }) } });
    const clear = { receiver: FAIRGROUND, actions: [call("clear_onchain", 0n, teraToGas(150))] }; // what the client attaches

    const early = fakeChain({}, revealing("1001"));
    const refused = await makeApp({ chain: early.chain }).post("/relay", await aliceDelegate(clear));
    expect(refused).toMatchObject({ status: 400, body: { error: "wrong_phase" } });
    expect(early.calls).not.toContain("relay");

    const due = fakeChain({}, revealing("1000"));
    const relayed = await makeApp({ chain: due.chain }).post("/relay", await aliceDelegate(clear));
    expect(relayed).toMatchObject({ status: 200, body: { tx_hash: "tx1", status: "succeeded" } });
    expect(due.calls).toContain("relay");
  });
});

describe("POST /relay: the per-sender quota belongs to the sender", () => {
  it("is not used up by delegates someone else signed in the sender's name", async () => {
    const { post, logs } = makeApp({ senderLimit: 2 });
    for (let i = 0; i < 5; i++) expect(errorOf(await post("/relay", await forgedDelegate()))).toBe("unknown_access_key");
    // A forgery is not logged as the account it names.
    expect(logs.every((line) => line.account === undefined)).toBe(true);
    expect((await post("/relay", await aliceDelegate({ nonce: 1n }))).status).toBe(200);
  });

  it("is not used up by replays of the sender's own delegates, or by refusals while one is in flight", async () => {
    let land = (_: TxOutcome | null) => {};
    const done = new Promise<TxOutcome | null>((resolve) => (land = resolve));
    let sent = 0;
    const { chain } = fakeChain({
      accessKey: async (_account, publicKey) => (isAliceKey(publicKey) ? ({ nonce: 5n, permission: "FullAccess" } as AccessKeyView) : undefined),
      relay: async () => (sent++ === 0 ? { txHash: "slow", outcome: null, done } : finalSubmission),
    });
    const { post } = makeApp({ chain, senderLimit: 2 });
    const replay = await aliceDelegate({ nonce: 5n }); // already used on chain
    for (let i = 0; i < 5; i++) expect(errorOf(await post("/relay", replay))).toBe("nonce_already_used");
    expect((await post("/relay", await aliceDelegate({ nonce: 6n }))).status).toBe(202);
    for (let i = 0; i < 5; i++) expect(errorOf(await post("/relay", await aliceDelegate({ nonce: 7n + BigInt(i) })))).toBe("sender_busy");
    land(outcome);
    await new Promise((resolve) => setImmediate(resolve));
    expect((await post("/relay", await aliceDelegate({ nonce: 20n }))).status).toBe(200); // the second relay of the hour
    expect(errorOf(await post("/relay", await aliceDelegate({ nonce: 21n })))).toBe("rate_limited");
  });
});

describe("POST /storage", () => {
  it("registers an unregistered account with the bounds minimum", async () => {
    const registered: Array<[string, string, bigint]> = [];
    const { chain } = fakeChain({ registerStorage: async (token, account, deposit) => (registered.push([token, account, deposit]), finalSubmission) });
    const res = await makeApp({ chain }).post("/storage", { account_id: "dave.test.near" });
    expect(res.status).toBe(200);
    expect(res.body as unknown as StorageResponse).toEqual({ status: "registered", token_id: USDC, tx_hash: "tx1" });
    expect(registered).toEqual([[USDC, "dave.test.near", 1_250_000_000_000_000_000_000n]]);
  });

  it("is a no-op for a registered account", async () => {
    const { chain } = fakeChain({ isRegistered: async () => true });
    const res = await makeApp({ chain }).post("/storage", { account_id: "dave.test.near", token_id: "usdc2.test.near" });
    expect(res.body).toEqual({ status: "already_registered", token_id: "usdc2.test.near" });
  });

  it("pays once per account and a few times per IP", async () => {
    const { post } = makeApp();
    expect((await post("/storage", { account_id: "a.test.near" })).status).toBe(200);
    expect(errorOf(await post("/storage", { account_id: "a.test.near" }))).toBe("rate_limited");
    expect((await post("/storage", { account_id: "b.test.near" })).status).toBe(200);
    expect((await post("/storage", { account_id: "c.test.near" })).status).toBe(429); // 2 per IP per day
  });

  it("pays once when two requests for one account race", async () => {
    const { chain, calls } = fakeChain();
    const { post } = makeApp({ chain });
    const results = await Promise.all([post("/storage", { account_id: "a.test.near" }), post("/storage", { account_id: "a.test.near" })]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 429]);
    expect(calls.filter((name) => name === "registerStorage")).toHaveLength(1);
  });

  it("does not use up an account's sponsorship when another IP's quota is spent", async () => {
    const { post } = makeApp({ storagePerIp: 1 });
    const attacker = { "x-test-ip": "198.51.100.66" };
    expect((await post("/storage", { account_id: "own.test.near" }, attacker)).status).toBe(200);
    expect(errorOf(await post("/storage", { account_id: "victim.test.near" }, attacker))).toBe("rate_limited");
    const victim = await post("/storage", { account_id: "victim.test.near" }, { "x-test-ip": "192.0.2.1" });
    expect(victim.body).toMatchObject({ status: "registered" });
  });

  it("does not use up an account's sponsorship when the storage budget is spent for the day", async () => {
    const clock = { now: 0 };
    const { post } = makeApp({ storageBudget: STORAGE_COST, now: () => clock.now });
    expect((await post("/storage", { account_id: "first.test.near" })).status).toBe(200);
    expect(errorOf(await post("/storage", { account_id: "second.test.near" }))).toBe("budget_exhausted");
    clock.now = 86_400_000; // the next UTC day
    expect((await post("/storage", { account_id: "second.test.near" })).body).toMatchObject({ status: "registered" });
  });

  it("does not use up an account's sponsorship when the RPC refuses the registration", async () => {
    let refuse = true;
    const { chain } = fakeChain({
      registerStorage: async () => {
        if (refuse) throw new TransactionRefused("NotEnoughBalance");
        return finalSubmission;
      },
    });
    const { post } = makeApp({ chain });
    expect(errorOf(await post("/storage", { account_id: "a.test.near" }))).toBe("relay_failed");
    refuse = false;
    expect((await post("/storage", { account_id: "a.test.near" })).body).toMatchObject({ status: "registered" });
  });

  it("spends a budget of its own, so registrations cannot starve bids", async () => {
    const { post } = makeApp({ storageBudget: STORAGE_COST - 1n });
    expect(errorOf(await post("/storage", { account_id: "a.test.near" }))).toBe("budget_exhausted");
    expect((await post("/relay", await aliceDelegate())).status).toBe(200);
  });

  it("counts every address of one IPv6 /64 as one client", async () => {
    const { post } = makeApp({ storagePerIp: 3 });
    const statuses = [];
    for (let i = 1; i <= 5; i++) statuses.push((await post("/storage", { account_id: `farm${i}.test.near` }, { "x-test-ip": `2001:db8:1:2::${i}` })).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
  });

  it.each([
    ["an invalid account id", { account_id: "Not Valid" }, "bad_request"],
    ["a token that is not configured", { account_id: "dave.test.near", token_id: "evil.test.near" }, "unknown_token"],
  ])("refuses %s", async (_label, body, reason) => {
    expect(errorOf(await makeApp().post("/storage", body))).toBe(reason);
  });

  it("refuses an account that does not exist", async () => {
    const { chain } = fakeChain({ accountExists: async () => false });
    expect(errorOf(await makeApp({ chain }).post("/storage", { account_id: "ghost.test.near" }))).toBe("unknown_account");
  });
});

describe("GET /policy, GET /health, CORS", () => {
  it("publishes the policy", async () => {
    const res = await makeApp().app.request("/policy");
    const policy = (await res.json()) as PolicyResponse;
    expect(policy).toMatchObject({ fairground_contract: FAIRGROUND, usdc_contracts: [USDC, "usdc2.test.near"], bid_deposit: "1", max_actions: 2 });
    expect(policy.fairground_methods).toEqual([
      "claim", "claim_proceeds", "clear_onchain", "reveal_bid", "trigger_refund_mode", "seed_liquidity", "abandon_liquidity",
    ]);
  });

  it("reports a balance bucket only", async () => {
    const res = await makeApp().app.request("/health");
    expect(await res.json()).toEqual({ ok: true, network: "sandbox", balance: "ok", budget_exhausted: false });
    const { chain } = fakeChain({ relayerBalance: async () => 10n ** 23n });
    const low = await makeApp({ chain }).app.request("/health");
    expect(low.status).toBe(503);
    expect(await low.json()).toMatchObject({ ok: false, balance: "empty" });
  });

  it("reads the balance once however often it is asked", async () => {
    const { chain, calls } = fakeChain();
    const { app } = makeApp({ chain });
    for (let i = 0; i < 5; i++) await app.request("/health");
    expect(calls.filter((name) => name === "relayerBalance")).toHaveLength(1);
  });

  it("answers CORS only for configured origins", async () => {
    const { post } = makeApp({ corsOrigins: ["https://app.example"] });
    const allowed = await post("/storage", { account_id: "dave.test.near" }, { origin: "https://app.example" });
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://app.example");
    const other = await post("/storage", { account_id: "erin.test.near" }, { origin: "https://evil.example" });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });
});
