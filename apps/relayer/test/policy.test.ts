import { KeyPair, actions, teraToGas, type AccessKeyView, type Action } from "near-api-js";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import {
  FAIRGROUND_METHODS,
  SEALED_BID_FIXED_BYTES,
  checkAccessKey,
  checkDelegate,
  checkValidity,
  readBidMsg,
  sealedBidLength,
  totalDeposit,
  totalGas,
} from "../src/policy.ts";
import { ALICE, CIPHERTEXT, FAIRGROUND, HEAD, POLICY, RELAYER, REVEAL_ARGS, USDC, bid, bidArgs, bidMsg, call, signDelegate, type DelegateSpec } from "./fixtures.ts";

/** Both policy checks, as the app runs them: the reason code, or null when allowed. */
async function check(spec: DelegateSpec, head = HEAD) {
  const { delegate } = await signDelegate(spec);
  const result = checkDelegate(delegate, POLICY);
  return result.ok ? checkValidity(delegate, POLICY, head) : result.reason;
}

async function allowedCalls(spec: DelegateSpec) {
  const result = checkDelegate((await signDelegate(spec)).delegate, POLICY);
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.calls;
}

const toFairground = (...calls: Action[]): DelegateSpec => ({ receiver: FAIRGROUND, actions: calls });
const toUsdc = (...calls: Action[]): DelegateSpec => ({ receiver: USDC, actions: calls });
const bytes = (text: string) => new TextEncoder().encode(text);
const rawArgs = (text: string) => bid(bytes(text));
const BOM = "﻿";

describe("checkDelegate: accepted", () => {
  it("a bid with a ciphertext, read for the on-chain checks", async () => {
    expect(await check(toUsdc(bid()))).toBeNull();
    expect(await allowedCalls(toUsdc(bid()))).toEqual([{ kind: "bid", token: USDC, saleId: "fairt", amount: 1_000_000n, payload: "ciphertext" }]);
  });

  it("a bid with a commitment, on the second USDC contract", async () => {
    const msg = bidMsg({ sale_id: "fairt", commitment: "AB".repeat(32) });
    const spec = { receiver: "usdc2.test.near", actions: [bid(bidArgs({ msg }))] };
    expect(await check(spec)).toBeNull();
    expect(await allowedCalls(spec)).toMatchObject([{ kind: "bid", token: "usdc2.test.near", payload: "commitment" }]);
  });

  it.each(FAIRGROUND_METHODS)("Fairground %s with no deposit", async (method) => {
    expect(await check(toFairground(call(method)))).toBeNull();
  });

  it("a claim pushed for another bidder names that bidder", async () => {
    const spec = toFairground(call("claim", 0n, teraToGas(50), { sale_id: "fairt", bidder: "bob.test.near" }));
    expect(await allowedCalls(spec)).toEqual([{ kind: "fairground", method: "claim", saleId: "fairt", bidder: "bob.test.near" }]);
    expect(await allowedCalls(toFairground(call("claim")))).toEqual([{ kind: "fairground", method: "claim", saleId: "fairt", bidder: undefined }]);
  });

  it("two actions within the gas cap", async () => {
    expect(await check(toFairground(call("claim", 0n, teraToGas(150)), call("claim", 0n, teraToGas(150))))).toBeNull();
  });

  it("clear_onchain with the 150 TGas the client attaches, exactly the default cap, and not one gas unit more", async () => {
    // The policy a relayer runs with when MAX_GAS_TGAS is not set.
    const defaults = loadConfig({
      NETWORK: "sandbox",
      NEAR_RPC_URL: "http://127.0.0.1:3040",
      RELAYER_ACCOUNT_ID: RELAYER,
      RELAYER_PRIVATE_KEY: KeyPair.fromRandom("ed25519").toString(),
      FAIRGROUND_CONTRACT: FAIRGROUND,
      USDC_CONTRACTS: USDC,
    }).policy;
    expect(defaults.maxGas).toBe(teraToGas(150));
    const clear = async (gas: bigint) => checkDelegate((await signDelegate(toFairground(call("clear_onchain", 0n, gas)))).delegate, defaults);
    expect(await clear(teraToGas(150))).toEqual({ ok: true, calls: [{ kind: "fairground", method: "clear_onchain", saleId: "fairt", bidder: undefined }] });
    expect(await clear(teraToGas(150) + 1n)).toEqual({ ok: false, reason: "gas_too_high" });
  });

  it("a delegate at both ends of the validity window", async () => {
    expect(await check({ maxBlockHeight: HEAD + POLICY.minBlocksLeft })).toBeNull();
    expect(await check({ maxBlockHeight: HEAD + POLICY.maxDelegateBlocks })).toBeNull();
  });
});

describe("checkDelegate: refused", () => {
  it("the relayer as sender", async () => {
    expect(await check({ sender: RELAYER, ...toFairground(call("claim")) })).toBe("sender_is_relayer");
  });

  it("no actions, or more than the maximum", async () => {
    expect(await check(toFairground())).toBe("no_actions");
    expect(await check(toFairground(call("claim"), call("claim"), call("claim")))).toBe("too_many_actions");
  });

  it.each([["another contract", "evil.test.near"], ["a USDC look-alike", "usdc.test.near.evil"], ["the relayer", RELAYER]])(
    "a call to %s",
    async (_label, receiver) => {
      expect(await check({ receiver, actions: [call("claim")] })).toBe("receiver_not_allowed");
    },
  );

  it.each([
    ["create_sale on Fairground", toFairground(call("create_sale"))],
    ["ft_on_transfer on Fairground", toFairground(call("ft_on_transfer"))],
    ["clear_onchain on USDC", toUsdc(call("clear_onchain"))],
    ["close_sale on Fairground (payable: a wallet transaction)", toFairground(call("close_sale"))],
    ["a real close_sale deposit", toFairground(call("close_sale", 14_004_000_000_000_000_000_000n))],
    ["retry_setup on Fairground (payable: a wallet transaction)", toFairground(call("retry_setup"))],
    ["ft_transfer on USDC", toUsdc(actions.functionCall("ft_transfer", { receiver_id: FAIRGROUND, amount: "1" }, teraToGas(30), 1n))],
    ["storage_deposit on USDC", toUsdc(actions.functionCall("storage_deposit", {}, teraToGas(30), 1n))],
    ["claim on USDC", toUsdc(call("claim"))],
    ["a bid sent to Fairground directly", toFairground(bid())],
  ])("%s", async (_label, spec) => {
    expect(await check(spec)).toBe("method_not_allowed");
  });

  it.each([
    ["1 yocto on a Fairground claim", toFairground(call("claim", 1n))],
    ["a deposit on reveal_bid", toFairground(call("reveal_bid", 1n))],
    ["1 yocto on clear_onchain", toFairground(call("clear_onchain", 1n))],
    ["2 yocto on ft_transfer_call", toUsdc(bid(bidArgs(), 2n))],
    ["0 yocto on ft_transfer_call", toUsdc(bid(bidArgs(), 0n))],
    ["1 NEAR on ft_transfer_call", toUsdc(bid(bidArgs(), 10n ** 24n))],
    ["a deposit on the second of two calls", toFairground(call("claim"), call("claim", 1n))],
  ])("%s", async (_label, spec) => {
    expect(await check(spec)).toBe("wrong_deposit");
  });

  it("more gas than the cap, in one action or in total", async () => {
    expect(await check(toUsdc(bid(bidArgs(), 1n, teraToGas(301))))).toBe("gas_too_high");
    expect(await check(toFairground(call("claim", 0n, teraToGas(200)), call("claim", 0n, teraToGas(200))))).toBe("gas_too_high");
  });

  it.each([
    ["args that are not JSON", rawArgs("not json")],
    ["args that are a JSON array", rawArgs("[1,2]")],
    ["invalid UTF-8", bid(new Uint8Array([0x7b, 0xff, 0x7d]))],
    ["an extra field", bid(bidArgs({ memo: "hi" }))],
    ["a missing msg", bid({ receiver_id: FAIRGROUND, amount: "1" })],
    ["a numeric amount", bid(bidArgs({ amount: 1000000 }))],
    ["a zero amount", bid(bidArgs({ amount: "0" }))],
    ["a leading zero", bid(bidArgs({ amount: "01" }))],
    ["an amount above u128", bid(bidArgs({ amount: (1n << 128n).toString() }))],
    ["a non-string receiver", bid(bidArgs({ receiver_id: ["x"] }))],
    // Parsed differently by JSON.parse and by serde in the token contract:
    ["a leading byte-order mark", rawArgs(BOM + JSON.stringify(bidArgs()))],
    ["a duplicate receiver_id", rawArgs(JSON.stringify(bidArgs()).replace("{", `{"receiver_id":"evil.test.near",`))],
    ["whitespace JSON.stringify would not write", rawArgs(JSON.stringify(bidArgs(), null, 1))],
  ])("a bid with %s", async (_label, action) => {
    expect(await check(toUsdc(action))).toBe("bad_transfer_args");
  });

  it.each([
    ["no sale id", { bidder: "bob.test.near" }],
    ["a bad sale id", { sale_id: "Fair" }],
    ["an invalid bidder", { sale_id: "fairt", bidder: "Not Valid" }],
    ["a null bidder", { sale_id: "fairt", bidder: null }],
    ["an extra field", { sale_id: "fairt", memo: "x".repeat(5000) }],
  ])("a claim with %s", async (_label, args) => {
    expect(await check(toFairground(call("claim", 0n, teraToGas(50), args)))).toBe("bad_call_args");
  });

  it.each([
    ["a bidder", "claim_proceeds", { sale_id: "fairt", bidder: "bob.test.near" }],
    ["an extra field", "trigger_refund_mode", { sale_id: "fairt", x: 1 }],
    ["a bidder", "clear_onchain", { sale_id: "fairt", bidder: "bob.test.near" }],
    ["no sale id", "clear_onchain", {}],
    ["a bad sale id", "clear_onchain", { sale_id: "Fair" }],
    ["a missing salt", "reveal_bid", { ...REVEAL_ARGS, salt: undefined }],
    ["a short salt", "reveal_bid", { ...REVEAL_ARGS, salt: "ab" }],
    ["a numeric price", "reveal_bid", { ...REVEAL_ARGS, max_price: 2500 }],
    ["a negative spend", "reveal_bid", { ...REVEAL_ARGS, max_spend: "-1" }],
  ])("%s on %s", async (_label, method, args) => {
    expect(await check(toFairground(call(method, 0n, teraToGas(50), args)))).toBe("bad_call_args");
  });

  it.each([
    ["a byte-order mark", bytes(BOM + '{"sale_id":"fairt"}')],
    ["a duplicate sale_id", bytes('{"sale_id":"nosale","sale_id":"fairt"}')],
    ["a space", bytes('{"sale_id": "fairt"}')],
  ])("Fairground args with %s", async (_label, args) => {
    expect(await check(toFairground(call("claim", 0n, teraToGas(50), args)))).toBe("bad_call_args");
  });

  it.each([
    ["another account", "evil.test.near"],
    ["a look-alike suffix", `${FAIRGROUND}.evil`],
    ["a look-alike prefix", `x${FAIRGROUND}`],
    ["different case", FAIRGROUND.toUpperCase()],
    ["the relayer", RELAYER],
  ])("a transfer to %s", async (_label, receiver_id) => {
    expect(await check(toUsdc(bid(bidArgs({ receiver_id }))))).toBe("transfer_not_to_fairground");
  });

  it("a receiver_id hidden in msg does not count", async () => {
    const msg = JSON.stringify({ sale_id: "fairt", ciphertext: CIPHERTEXT, receiver_id: FAIRGROUND });
    expect(await check(toUsdc(bid(bidArgs({ receiver_id: "evil.test.near", msg }))))).toBe("transfer_not_to_fairground");
  });

  it("a bad bid msg", async () => {
    expect(await check(toUsdc(bid(bidArgs({ msg: "{}" }))))).toBe("bad_bid_msg");
  });

  it("a sealed bid whose length does not fit its sale id and sender", async () => {
    const sealed = (bytes: number, saleId = "fairt") => bid(bidArgs({ msg: bidMsg({ sale_id: saleId, ciphertext: Buffer.alloc(bytes, 7).toString("base64") }) }));
    // 244 = 224 + "fairt" + "alice.test.near"; one byte either way is refused.
    expect(await check(toUsdc(sealed(243)))).toBe("wrong_ciphertext_length");
    expect(await check(toUsdc(sealed(245)))).toBe("wrong_ciphertext_length");
    // The length follows the sender: Alice's box sent by bob.test.near (13 bytes) is 2 bytes too long.
    expect(await check({ sender: "bob.test.near", ...toUsdc(sealed(244)) })).toBe("wrong_ciphertext_length");
    expect(await check({ sender: "bob.test.near", ...toUsdc(sealed(242)) })).toBeNull();
    // And the sale id: "fairt2" is one byte longer.
    expect(await check(toUsdc(sealed(244, "fairt2")))).toBe("wrong_ciphertext_length");
    expect(await check(toUsdc(sealed(245, "fairt2")))).toBeNull();
    // The old cap is gone: anything but the exact length is refused, short or long.
    expect(await check(toUsdc(sealed(96)))).toBe("wrong_ciphertext_length");
    expect(await check(toUsdc(sealed(512)))).toBe("wrong_ciphertext_length");
  });

  it("checks the length of every bid in a delegate", async () => {
    const short = bid(bidArgs({ msg: bidMsg({ sale_id: "fairt", ciphertext: Buffer.alloc(243, 7).toString("base64") }) }));
    expect(await check(toUsdc(bid(), short))).toBe("wrong_ciphertext_length");
  });
});

describe("sealedBidLength", () => {
  it("is fairground_clearing::sealed_bid_len: 224 plus both ids' bytes", () => {
    expect(SEALED_BID_FIXED_BYTES).toBe(224);
    expect(sealedBidLength("fairt", "alice.testnet")).toBe(242);
    expect(sealedBidLength("fairt", ALICE)).toBe(244);
    expect(sealedBidLength("a".repeat(32), "b".repeat(64))).toBe(320); // the longest bid
    expect(sealedBidLength("a", "ab")).toBe(227);
  });
});

describe("checkValidity", () => {
  it("refuses an expired delegate, or one too close to expiring", async () => {
    expect(await check({ maxBlockHeight: HEAD - 1n })).toBe("expired");
    expect(await check({ maxBlockHeight: HEAD + POLICY.minBlocksLeft - 1n })).toBe("expired");
  });

  it("refuses a delegate valid for too long", async () => {
    expect(await check({ maxBlockHeight: HEAD + POLICY.maxDelegateBlocks + 1n })).toBe("validity_too_long");
  });

  it("refuses a nonce nearcore would refuse as too large", async () => {
    expect(await check({ nonce: HEAD * 1_000_000n })).toBe("nonce_too_large");
    expect(await check({ nonce: HEAD * 1_000_000n - 1n })).toBeNull();
  });
});

describe("readBidMsg", () => {
  const read = (fields: Record<string, unknown>, bidder = ALICE) => readBidMsg(JSON.stringify(fields), bidder);
  const box = (bytes: number) => Buffer.alloc(bytes, 1).toString("base64");

  it("reads the two shapes the contract accepts", () => {
    expect(read({ sale_id: "fairt", ciphertext: CIPHERTEXT })).toEqual({ saleId: "fairt", payload: "ciphertext" });
    expect(read({ sale_id: "a", commitment: "0f".repeat(32) })).toEqual({ saleId: "a", payload: "commitment" });
    expect(read({ sale_id: "fairt", ciphertext: CIPHERTEXT, commitment: null })).toEqual({ saleId: "fairt", payload: "ciphertext" });
    // 224 + 8 ("sale_2-x") + 15; and the longest bid, 224 + 32 + 64.
    expect(read({ sale_id: "sale_2-x", ciphertext: box(247) })).toMatchObject({ payload: "ciphertext" });
    expect(read({ sale_id: "s".repeat(32), ciphertext: box(320) }, "b".repeat(64))).toMatchObject({ payload: "ciphertext" });
  });

  it.each([
    ["one byte", box(1)],
    ["one byte short", box(243)],
    ["one byte long", box(245)],
    ["the old 512-byte cap", box(512)],
    ["513 bytes", box(513)],
  ])("tells a sealed bid of the wrong length (%s) from a malformed msg", (_label, ciphertext) => {
    expect(read({ sale_id: "fairt", ciphertext })).toBe("wrong_ciphertext_length");
  });

  it("does not apply the sealed-bid length to a commitment", () => {
    expect(read({ sale_id: "fairt", commitment: "ab".repeat(32) }, "b".repeat(64))).toEqual({ saleId: "fairt", payload: "commitment" });
  });

  it.each([
    ["not JSON", "nope"],
    ["an array", "[]"],
    ["an unknown field", bidMsg({ sale_id: "fairt", ciphertext: CIPHERTEXT, price: "1" })],
    ["both payloads", bidMsg({ sale_id: "fairt", ciphertext: CIPHERTEXT, commitment: "0".repeat(64) })],
    ["no payload", bidMsg({ sale_id: "fairt" })],
    ["no sale id", bidMsg({ ciphertext: CIPHERTEXT })],
    ["an uppercase sale id", bidMsg({ sale_id: "FAIRT", ciphertext: CIPHERTEXT })],
    ["a sale id ending in a dash", bidMsg({ sale_id: "fair-", ciphertext: CIPHERTEXT })],
    ["a 33-character sale id", bidMsg({ sale_id: "a".repeat(33), ciphertext: CIPHERTEXT })],
    ["an empty ciphertext", bidMsg({ sale_id: "fairt", ciphertext: "" })],
    ["unpadded base64", bidMsg({ sale_id: "fairt", ciphertext: "AAA" })],
    ["url-safe base64", bidMsg({ sale_id: "fairt", ciphertext: Buffer.alloc(3, 0xfb).toString("base64url") })],
    ["non-zero trailing bits", bidMsg({ sale_id: "fairt", ciphertext: "AB==" })],
    // Non-canonical spellings of a box of the right length are still malformed.
    ["the right length, unpadded", bidMsg({ sale_id: "fairt", ciphertext: CIPHERTEXT.replace(/=+$/, "") })],
    ["the right length, url-safe", bidMsg({ sale_id: "fairt", ciphertext: Buffer.alloc(244, 0xfb).toString("base64url") })],
    ["the right length, non-zero trailing bits", bidMsg({ sale_id: "fairt", ciphertext: CIPHERTEXT.replace(/w==$/, "x==") })],
    ["the right length with a newline", bidMsg({ sale_id: "fairt", ciphertext: `${CIPHERTEXT}\n` })],
    ["a numeric ciphertext", bidMsg({ sale_id: "fairt", ciphertext: 5 })],
    ["a 63-digit commitment", bidMsg({ sale_id: "fairt", commitment: "0".repeat(63) })],
    ["a non-hex commitment", bidMsg({ sale_id: "fairt", commitment: "g".repeat(64) })],
    ["a byte-order mark", BOM + bidMsg()],
    ["a duplicate sale_id", bidMsg().replace("{", '{"sale_id":"other",')],
  ])("refuses %s", (_label, msg) => {
    expect(readBidMsg(msg, ALICE)).toBe("bad_bid_msg");
  });

  it("the fixture's box ends in w== so the trailing-bits case really changes it", () => {
    expect(CIPHERTEXT.endsWith("Bw==")).toBe(true);
  });
});

describe("checkAccessKey", () => {
  const fullAccess = (nonce: bigint): AccessKeyView =>
    ({ nonce, permission: "FullAccess", block_height: 1, block_hash: "" }) as AccessKeyView;
  const functionCallKey = (receiver_id: string, method_names: string[]): AccessKeyView =>
    ({ nonce: 1n, permission: { FunctionCall: { receiver_id, method_names, allowance: null } }, block_height: 1, block_hash: "" }) as AccessKeyView;

  async function keyCheck(spec: DelegateSpec, key: AccessKeyView | undefined) {
    const { delegate } = await signDelegate({ nonce: 5n, ...spec });
    return checkAccessKey(delegate, key);
  }

  it("refuses a key that does not exist", async () => {
    expect(await keyCheck({}, undefined)).toBe("unknown_access_key");
  });

  it("refuses a used nonce (replay) and accepts a fresh one", async () => {
    expect(await keyCheck({}, fullAccess(5n))).toBe("nonce_already_used");
    expect(await keyCheck({}, fullAccess(9n))).toBe("nonce_already_used");
    expect(await keyCheck({}, fullAccess(4n))).toBeNull();
  });

  it("refuses a bid signed with a function-call key (DepositWithFunctionCall)", async () => {
    expect(await keyCheck(toUsdc(bid()), functionCallKey(USDC, ["ft_transfer_call"]))).toBe("needs_full_access_key");
  });

  it("accepts a function-call key within its permission", async () => {
    expect(await keyCheck(toFairground(call("claim")), functionCallKey(FAIRGROUND, ["claim", "reveal_bid"]))).toBeNull();
    expect(await keyCheck(toFairground(call("reveal_bid")), functionCallKey(FAIRGROUND, []))).toBeNull();
  });

  it.each([
    ["another receiver", toFairground(call("claim")), functionCallKey(USDC, [])],
    ["another method", toFairground(call("claim_proceeds")), functionCallKey(FAIRGROUND, ["claim"])],
    ["two actions", toFairground(call("claim"), call("claim")), functionCallKey(FAIRGROUND, ["claim"])],
  ])("refuses a function-call key used for %s", async (_label, spec, key) => {
    expect(await keyCheck(spec, key)).toBe("key_not_allowed");
  });

  it("refuses a gas key, which cannot sign a V1 delegate", async () => {
    const gasKey = {
      nonce: 1n,
      permission: { GasKeyFunctionCall: { receiver_id: FAIRGROUND, method_names: [], balance: "0", num_nonces: 1 } },
    } as unknown as AccessKeyView;
    expect(await keyCheck(toFairground(call("claim")), gasKey)).toBe("key_not_allowed");
  });
});

describe("totals", () => {
  it("sums gas and deposits over every inner call", async () => {
    const { delegate } = await signDelegate(toUsdc(bid(bidArgs(), 1n, teraToGas(100)), bid(bidArgs(), 1n, teraToGas(50))));
    expect(totalGas(delegate)).toBe(teraToGas(150));
    expect(totalDeposit(delegate)).toBe(2n);
  });
});
