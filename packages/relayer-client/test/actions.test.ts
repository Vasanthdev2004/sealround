import { describe, expect, it } from "vitest";
import {
  bidAction,
  claimAction,
  claimProceedsAction,
  clearOnchainAction,
  revealAction,
  sealedBidLength,
  triggerRefundModeAction,
  type BidPayload,
} from "../src/actions";
import { ALICE, CIPHERTEXT, COMMITMENT, FAIRGROUND, USDC } from "./helpers";

const TGAS = 1_000_000_000_000n;
const json = (action: { args: unknown }) => JSON.stringify(action.args);

describe("bidAction", () => {
  const sealed = { ciphertext: CIPHERTEXT, bidder: ALICE };

  it("is ft_transfer_call into Fairground with 1 yocto, 100 TGas and the sealed bid in msg", () => {
    const action = bidAction(USDC, FAIRGROUND, "fairt", 2_000_000n, sealed);
    expect(action).toEqual({
      receiverId: USDC,
      methodName: "ft_transfer_call",
      args: { receiver_id: FAIRGROUND, amount: "2000000", msg: `{"sale_id":"fairt","ciphertext":"${CIPHERTEXT}"}` },
      gas: 100n * TGAS,
      deposit: 1n,
    });
    // The exact bytes a wallet and a key both sign. The bidder is checked, not sent.
    expect(json(action)).toBe(
      `{"receiver_id":"${FAIRGROUND}","amount":"2000000","msg":"{\\"sale_id\\":\\"fairt\\",\\"ciphertext\\":\\"${CIPHERTEXT}\\"}"}`,
    );
  });

  it("carries a commit-reveal commitment instead", () => {
    const action = bidAction(USDC, FAIRGROUND, "fair-t_1", 1n, { commitment: COMMITMENT.toUpperCase() });
    expect(action.args["msg"]).toBe(`{"sale_id":"fair-t_1","commitment":"${COMMITMENT.toUpperCase()}"}`);
    expect(action.args["amount"]).toBe("1");
  });

  it("accepts the largest u128 amount and the longest sealed bid (32-byte sale id, 64-byte bidder: 320 bytes)", () => {
    const max = (1n << 128n) - 1n;
    const [saleId, bidder] = ["s".repeat(32), "b".repeat(64)];
    const big = Buffer.alloc(320, 1).toString("base64");
    expect(bidAction(USDC, FAIRGROUND, saleId, max, { ciphertext: big, bidder }).args["amount"]).toBe(max.toString());
  });

  it("takes exactly sealedBidLength(saleId, bidder) bytes: the length follows both ids", () => {
    expect(sealedBidLength("fairt", ALICE)).toBe(244);
    expect(sealedBidLength("fairt", "alice.testnet")).toBe(242);
    expect(sealedBidLength("a", "ab")).toBe(227);
    expect(sealedBidLength("s".repeat(32), "b".repeat(64))).toBe(320);
    const box = (bytes: number) => Buffer.alloc(bytes, 3).toString("base64");
    expect(() => bidAction(USDC, FAIRGROUND, "fairt", 1n, { ciphertext: box(242), bidder: "alice.testnet" })).not.toThrow();
    // Alice's box sent as another account, or for another sale, is the wrong length.
    expect(() => bidAction(USDC, FAIRGROUND, "fairt", 1n, { ciphertext: box(244), bidder: "alice.testnet" })).toThrow(/242 bytes .* not 244/);
    expect(() => bidAction(USDC, FAIRGROUND, "fairt2", 1n, sealed)).toThrow(/245 bytes .* not 244/);
  });

  it.each([
    ["an uppercase sale id", "Fairt", 1n, sealed, /saleId/],
    ["a sale id ending in -", "fairt-", 1n, sealed, /saleId/],
    ["a 33-character sale id", "a".repeat(33), 1n, sealed, /saleId/],
    ["a zero amount", "fairt", 0n, sealed, /amount/],
    ["an amount above u128", "fairt", 1n << 128n, sealed, /amount/],
    ["no bidder", "fairt", 1n, { ciphertext: CIPHERTEXT } as unknown as BidPayload, /bidder/],
    ["an invalid bidder", "fairt", 1n, { ciphertext: CIPHERTEXT, bidder: "Alice.near" }, /bidder/],
    ["an empty ciphertext", "fairt", 1n, { ciphertext: "", bidder: ALICE }, /canonical/],
    ["unpadded base64", "fairt", 1n, { ciphertext: "AAE", bidder: ALICE }, /canonical/],
    ["base64url", "fairt", 1n, { ciphertext: "-_8=", bidder: ALICE }, /canonical/],
    ["non-zero trailing bits", "fairt", 1n, { ciphertext: "AAF=", bidder: ALICE }, /canonical/],
    ["base64 with whitespace", "fairt", 1n, { ciphertext: `${CIPHERTEXT.slice(0, 8)} ${CIPHERTEXT.slice(8)}`, bidder: ALICE }, /canonical/],
    ["a trailing newline", "fairt", 1n, { ciphertext: `${CIPHERTEXT}\n`, bidder: ALICE }, /canonical/],
    ["a stray character", "fairt", 1n, { ciphertext: "AAE*", bidder: ALICE }, /canonical/],
    ["padding in the middle", "fairt", 1n, { ciphertext: "AA==AA==", bidder: ALICE }, /canonical/],
    ["the right length, unpadded", "fairt", 1n, { ciphertext: CIPHERTEXT.replace(/=+$/, ""), bidder: ALICE }, /canonical/],
    ["one byte short", "fairt", 1n, { ciphertext: Buffer.alloc(243).toString("base64"), bidder: ALICE }, /244 bytes/],
    ["one byte long", "fairt", 1n, { ciphertext: Buffer.alloc(245).toString("base64"), bidder: ALICE }, /244 bytes/],
    ["an unpadded-amount box (old format, 96 bytes)", "fairt", 1n, { ciphertext: Buffer.alloc(96).toString("base64"), bidder: ALICE }, /244 bytes/],
    ["a 512-byte ciphertext (the old cap)", "fairt", 1n, { ciphertext: Buffer.alloc(512).toString("base64"), bidder: ALICE }, /244 bytes/],
    ["a 63-character commitment", "fairt", 1n, { commitment: COMMITMENT.slice(1) }, /commitment/],
    ["a non-hex commitment", "fairt", 1n, { commitment: "zz".repeat(32) }, /commitment/],
  ])("refuses %s before anything is signed", (_label, saleId, amount, payload, message) => {
    expect(() => bidAction(USDC, FAIRGROUND, saleId, amount, payload)).toThrow(RangeError);
    expect(() => bidAction(USDC, FAIRGROUND, saleId, amount, payload)).toThrow(message);
  });
});

describe("Fairground calls", () => {
  it("claim: 100 TGas, no deposit, bidder only when given", () => {
    expect(claimAction(FAIRGROUND, "fairt")).toEqual({
      receiverId: FAIRGROUND,
      methodName: "claim",
      args: { sale_id: "fairt" },
      gas: 100n * TGAS,
      deposit: 0n,
    });
    expect(json(claimAction(FAIRGROUND, "fairt", ALICE))).toBe(`{"sale_id":"fairt","bidder":"${ALICE}"}`);
    expect(() => claimAction(FAIRGROUND, "fairt", "Alice.near")).toThrow(/bidder/);
  });

  it("claim_proceeds: 150 TGas, no deposit", () => {
    expect(claimProceedsAction(FAIRGROUND, "fairt")).toEqual({
      receiverId: FAIRGROUND,
      methodName: "claim_proceeds",
      args: { sale_id: "fairt" },
      gas: 150n * TGAS,
      deposit: 0n,
    });
  });

  it("reveal_bid: prices as decimal strings and the 32-hex salt, 30 TGas", () => {
    const salt = "0123456789abcdefABCDEF0123456789";
    const action = revealAction(FAIRGROUND, "fairt", { maxPrice: 2_500n, maxSpend: 101_000_000n, salt });
    expect(action).toMatchObject({ receiverId: FAIRGROUND, methodName: "reveal_bid", gas: 30n * TGAS, deposit: 0n });
    expect(json(action)).toBe(`{"sale_id":"fairt","max_price":"2500","max_spend":"101000000","salt":"${salt}"}`);
    expect(() => revealAction(FAIRGROUND, "fairt", { maxPrice: 1n, maxSpend: 1n, salt: salt.slice(1) })).toThrow(/salt/);
    expect(() => revealAction(FAIRGROUND, "fairt", { maxPrice: -1n, maxSpend: 1n, salt })).toThrow(/maxPrice/);
  });

  it("clear_onchain: 150 TGas (the relayer's cap; the longest 500-bid search measured burns 102.8), no deposit", () => {
    expect(clearOnchainAction(FAIRGROUND, "fairt")).toEqual({
      receiverId: FAIRGROUND,
      methodName: "clear_onchain",
      args: { sale_id: "fairt" },
      gas: 150n * TGAS,
      deposit: 0n,
    });
    expect(json(clearOnchainAction(FAIRGROUND, "fair-t_1"))).toBe(`{"sale_id":"fair-t_1"}`);
    expect(() => clearOnchainAction(FAIRGROUND, "Fairt")).toThrow(/saleId/);
    expect(() => clearOnchainAction(FAIRGROUND, "a".repeat(33))).toThrow(/saleId/);
  });

  it("trigger_refund_mode: 30 TGas, no deposit", () => {
    expect(triggerRefundModeAction(FAIRGROUND, "fairt")).toEqual({
      receiverId: FAIRGROUND,
      methodName: "trigger_refund_mode",
      args: { sale_id: "fairt" },
      gas: 30n * TGAS,
      deposit: 0n,
    });
    expect(() => triggerRefundModeAction(FAIRGROUND, "")).toThrow(/saleId/);
  });
});
