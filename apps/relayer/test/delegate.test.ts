import { createHash } from "node:crypto";
import { KeyPair, actions, base64Encode, encodeDelegateAction, encodeSignedDelegate } from "near-api-js";
import { describe, expect, it } from "vitest";
import { decodeSignedDelegate, hasValidSignature, innerCalls } from "../src/delegate.ts";
import { ALICE, USDC, bid, signDelegate } from "./fixtures.ts";

function decodeOk(base64: string) {
  const decoded = decodeSignedDelegate(base64);
  if (!decoded.ok) throw new Error(`expected a delegate, got ${decoded.reason}`);
  return decoded.delegate;
}

const reasonOf = (base64: string) => {
  const decoded = decodeSignedDelegate(base64);
  return decoded.ok ? "ok" : decoded.reason;
};

const bytesOf = (base64: string) => Buffer.from(base64, "base64");

/** borsh string: u32 little-endian length, then UTF-8. */
function borshString(text: string): Buffer {
  const utf8 = Buffer.from(text);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(utf8.length);
  return Buffer.concat([length, utf8]);
}

describe("decodeSignedDelegate", () => {
  it("round-trips a signed bid exactly", async () => {
    const { base64, delegate } = await signDelegate();
    const decoded = decodeOk(base64);
    expect(decoded.delegateAction.senderId).toBe(ALICE);
    expect(decoded.delegateAction.receiverId).toBe(USDC);
    expect(decoded.delegateAction.nonce).toBe(delegate.delegateAction.nonce);
    expect(innerCalls(decoded)).toEqual(innerCalls(delegate));
    expect(base64Encode(encodeSignedDelegate(decoded))).toBe(base64);
  });

  it("accepts base64url without padding (same bytes)", async () => {
    const { base64 } = await signDelegate();
    const url = base64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    expect(reasonOf(url)).toBe("ok");
  });

  it.each([
    ["an empty string", ""],
    ["whitespace inside", "AAAA AAAA"],
    ["non-base64 characters", "!!!!"],
    ["random bytes", Buffer.from("not a delegate at all, just text").toString("base64")],
  ])("refuses %s", (_label, input) => {
    expect(reasonOf(input)).toBe("bad_encoding");
  });

  it("refuses a truncated payload", async () => {
    const { base64 } = await signDelegate();
    expect(reasonOf(bytesOf(base64).subarray(0, -10).toString("base64"))).toBe("bad_encoding");
  });

  it("refuses trailing bytes (borsh-js would ignore them)", async () => {
    const { base64 } = await signDelegate();
    expect(reasonOf(Buffer.concat([bytesOf(base64), Buffer.from([0])]).toString("base64"))).toBe("bad_encoding");
  });

  it("refuses a secp256k1 key", async () => {
    const { base64 } = await signDelegate({ key: KeyPair.fromRandom("secp256k1") });
    expect(reasonOf(base64)).toBe("unsupported_key_type");
  });

  it.each([
    ["a NEAR transfer", actions.transfer(1n)],
    ["an add-key", actions.addFullAccessKey(KeyPair.fromRandom("ed25519").getPublicKey())],
    ["a deploy", actions.deployContract(new Uint8Array([0, 97, 115, 109]))],
    ["a delete-account", actions.deleteAccount("thief.test.near")],
  ])("refuses %s", async (_label, action) => {
    const { base64 } = await signDelegate({ actions: [action] });
    expect(reasonOf(base64)).toBe("action_not_allowed");
  });

  it("refuses a FunctionCall mixed with another action", async () => {
    const { base64 } = await signDelegate({ actions: [bid(), actions.transfer(1n)] });
    expect(reasonOf(base64)).toBe("action_not_allowed");
  });

  describe("refuses a nested delegate (action discriminant 8), which near-api-js will not even encode", () => {
    /** A SignedDelegate from alice whose one action is discriminant 8 followed by `payload`. */
    async function withDelegateAction(payload: Buffer) {
      const { delegate } = await signDelegate();
      return Buffer.concat([
        borshString(ALICE),
        borshString(USDC),
        Buffer.from([1, 0, 0, 0, 8]),
        payload,
        Buffer.alloc(16), // nonce, max_block_height
        Buffer.from([0]), // ed25519
        Buffer.from(delegate.delegateAction.publicKey.data),
        Buffer.from([0]),
        Buffer.from(delegate.signature.data),
      ]).toString("base64");
    }

    it("as nearcore encodes it: a whole SignedDelegate", async () => {
      // near-api-js's schema has only a string placeholder for this variant, so these bytes do not decode.
      const { delegate: inner } = await signDelegate();
      expect(reasonOf(await withDelegateAction(Buffer.from(encodeSignedDelegate(inner))))).toBe("bad_encoding");
    });

    it("shaped to fit the schema's placeholder", async () => {
      expect(reasonOf(await withDelegateAction(borshString("x")))).toBe("action_not_allowed");
    });
  });

  it.each([
    ["an uppercase sender", { sender: "Alice.TEST" }],
    ["a sender with a space", { sender: "not valid.near" }],
    ["a one-character receiver", { receiver: "u" }],
    ["a 65-character sender", { sender: `${"a".repeat(60)}.near` }],
  ])("refuses %s, which the RPC could not even look up", async (_label, spec) => {
    const { base64 } = await signDelegate(spec);
    expect(reasonOf(base64)).toBe("bad_encoding");
  });
});

describe("hasValidSignature", () => {
  it("accepts the sender's own signature", async () => {
    const { delegate } = await signDelegate();
    expect(hasValidSignature(delegate)).toBe(true);
  });

  it("refuses tampered args", async () => {
    const { base64 } = await signDelegate();
    const delegate = decodeOk(base64);
    const fc = delegate.delegateAction.actions[0]?.functionCall;
    if (!fc) throw new Error("no call");
    fc.args = new TextEncoder().encode(new TextDecoder().decode(fc.args).replace("1000000", "9000000"));
    expect(hasValidSignature(delegate)).toBe(false);
  });

  it("refuses a signature by a key other than the one named", async () => {
    const { base64 } = await signDelegate();
    const delegate = decodeOk(base64);
    delegate.delegateAction.publicKey = KeyPair.fromRandom("ed25519").getPublicKey();
    expect(hasValidSignature(delegate)).toBe(false);
  });

  it("refuses a flipped signature bit", async () => {
    const { base64 } = await signDelegate();
    const bytes = bytesOf(base64);
    bytes[bytes.length - 1]! ^= 1;
    expect(hasValidSignature(decodeOk(bytes.toString("base64")))).toBe(false);
  });

  it("refuses a signature that only the cofactored equation accepts, as nearcore does", () => {
    // Built with @noble/curves: R = rB + T for T = (0, -1) of order 2, S = r + k·a.
    // [8]SB = [8]R + [8]kA holds (noble, near-api-js); SB = R + kA does not (ed25519-dalek, OpenSSL).
    const delegate = decodeOk(MIXED_ORDER_DELEGATE);
    const hash = new Uint8Array(createHash("sha256").update(encodeDelegateAction(delegate.delegateAction)).digest());
    expect(delegate.delegateAction.publicKey.verify(hash, delegate.signature.data)).toBe(true);
    expect(hasValidSignature(delegate)).toBe(false);
  });
});

/** A claim by alice.test.near whose signature has a small-order component in R (generated once; see the test). */
const MIXED_ORDER_DELEGATE =
  "DwAAAGFsaWNlLnRlc3QubmVhchQAAABmYWlyZ3JvdW5kLnRlc3QubmVhcgEAAAACBQAAAGNsYWltEwAAAHsic2FsZV9pZCI6ImZhaXJ0In0AID2IeS0AAAAAAAAAAAAAAAAAAAAAAAAFAAAAAAAAAEwEAAAAAAAAAOpKbGPinFIKvvVQexMuxfmVR3auvr57kkIe6mkURtIsANYAUn+XI/IWbKLJnJDFLkohkhy+xO3HcbrE+g1bPiwkV9dhKx1v7bn6xN1p/6pr7tV5TQBR7oh9j0Ui2r/3rAw=";
