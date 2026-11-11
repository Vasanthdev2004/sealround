/** Offline test helpers: accounts, an in-memory RPC, a stand-in wallet, and NEP-366 bytes built from the spec. */
import { createHash, createPrivateKey, sign } from "node:crypto";
import {
  actions,
  base64Decode,
  baseDecode,
  buildDelegateAction,
  encodeDelegateAction,
  type KeyPair,
  type Provider,
} from "near-api-js";
import { expect } from "vitest";
import type { FairgroundAction } from "../src/actions";
import { keyPairSigner, type ConnectWallet, type ConnectorFunctionCall } from "../src/signers";

export const FAIRGROUND = "fairground.test.near";
export const USDC = "usdc.test.near";
export const ALICE = "alice.test.near";
export const HEAD = 1_000n;
/**
 * A stand-in sealed bid on sale "fairt" from ALICE, of the one length the
 * contract accepts for them: 224 + 5 ("fairt") + 15 ("alice.test.near") = 244
 * bytes (crates/clearing sealed_bid_len). Real libsodium boxes are tested in
 * sealed-bid.test.ts.
 */
export const CIPHERTEXT = Buffer.alloc(244, 7).toString("base64");
/** A stand-in sealed bid from ALICE on a sale id of `saleId.length` bytes. */
export const ciphertextFor = (saleId: string) => Buffer.alloc(224 + saleId.length + ALICE.length, 7).toString("base64");
export const COMMITMENT = "ab".repeat(32);

/** The two reads keyPairSigner makes (access key nonce, final head), answered from `chain`. */
export function memoryProvider(chain: { nonce: bigint; height: bigint }): Provider {
  const provider: Pick<Provider, "viewAccessKey" | "viewBlock"> = {
    viewAccessKey: async () => ({ nonce: chain.nonce, permission: "FullAccess", block_height: Number(chain.height), block_hash: "" }),
    viewBlock: async () => ({ header: { height: Number(chain.height) } }) as Awaited<ReturnType<Provider["viewBlock"]>>,
  };
  return provider as Provider;
}

export interface SpecDelegate {
  senderId: string;
  action: FairgroundAction;
  nonce: bigint;
  maxBlockHeight: bigint;
}

/**
 * base64(borsh(SignedDelegate)) built from NEP-366 and NEP-461 alone: borsh written
 * by hand, args as JSON.stringify writes them, ed25519 from node:crypto. No
 * near-api-js encoding is involved, so what the relayer decodes here is not
 * bytes its own library produced.
 */
export function specSignedDelegate(keyPair: KeyPair, { senderId, action, nonce, maxBlockHeight }: SpecDelegate): string {
  const { receiverId, methodName, args, gas, deposit } = action;
  const delegateAction = Buffer.concat([
    string(senderId),
    string(receiverId),
    u32(1), // one action
    Buffer.from([2]), // Action::FunctionCall
    string(methodName),
    sized(Buffer.from(JSON.stringify(args))),
    u64(gas),
    u128(deposit),
    u64(nonce),
    u64(maxBlockHeight),
    Buffer.from([0]), // KeyType::ED25519
    Buffer.from(keyPair.getPublicKey().data),
  ]);
  const prefixed = Buffer.concat([u32(2 ** 30 + 366), delegateAction]); // NEP-461 prefix for NEP-366
  const signature = sign(null, createHash("sha256").update(prefixed).digest(), ed25519PrivateKey(keyPair));
  return Buffer.concat([delegateAction, Buffer.from([0]), signature]).toString("base64");
}

/**
 * A NEAR Connect wallet stand-in that signs delegates with its own code
 * (specSignedDelegate), as a real wallet would, choosing the nonce and expiry
 * from `provider` itself. Its paid path is the key's own transaction. Records
 * every request it gets.
 */
export function stubWallet(
  { accountId, keyPair, provider, validityBlocks = 200 }: { accountId: string; keyPair: KeyPair; provider: Provider; validityBlocks?: number },
  { delegates = true } = {},
) {
  const requests: unknown[] = [];
  const paid = keyPairSigner({ accountId, keyPair, provider });
  const fromConnector = (receiverId: string, { params }: ConnectorFunctionCall): FairgroundAction => ({
    receiverId,
    methodName: params.methodName,
    args: params.args as Record<string, unknown>,
    gas: BigInt(params.gas),
    deposit: BigInt(params.deposit),
  });
  const wallet: ConnectWallet = {
    manifest: { features: { signDelegateActions: delegates } },
    async signDelegateActions(params) {
      requests.push(params);
      const [key, block] = await Promise.all([
        provider.viewAccessKey({ accountId, publicKey: keyPair.getPublicKey(), finalityQuery: { finality: "optimistic" } }),
        provider.viewBlock({ finality: "final" }),
      ]);
      const signedDelegateActions = params.delegateActions.map(({ receiverId, actions: calls }, i) => {
        const [call] = calls;
        if (!call || calls.length > 1) throw new Error("the stand-in wallet signs one action per delegate");
        return specSignedDelegate(keyPair, {
          senderId: accountId,
          action: fromConnector(receiverId, call),
          nonce: key.nonce + 1n + BigInt(i),
          maxBlockHeight: BigInt(block.header.height) + BigInt(validityBlocks),
        });
      });
      return { signedDelegateActions };
    },
    async signAndSendTransaction(params) {
      requests.push(params);
      const [call] = params.actions;
      return paid.sendTransaction(fromConnector(params.receiverId, call!));
    },
  };
  return { wallet, requests };
}

/**
 * Checks a base64 SignedDelegate against what it should hold, independently of
 * how it was produced: its DelegateAction bytes must equal the expected ones, and
 * its ed25519 signature must verify over sha256(NEP-461 prefix || those bytes),
 * which is what nearcore checks.
 */
export function expectSignedDelegate(
  base64: string,
  key: KeyPair,
  expected: { senderId: string; action: FairgroundAction; nonce: bigint; maxBlockHeight: bigint },
): void {
  const bytes = base64Decode(base64);
  const delegateAction = encodeDelegateAction(
    buildDelegateAction({
      senderId: expected.senderId,
      receiverId: expected.action.receiverId,
      actions: [actions.functionCall(expected.action.methodName, expected.action.args, expected.action.gas, expected.action.deposit)],
      nonce: expected.nonce,
      maxBlockHeight: expected.maxBlockHeight,
      publicKey: key.getPublicKey(),
    }),
  );
  const prefix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint32(0, 2 ** 30 + 366, true);
  expect(delegateAction.subarray(0, 4)).toEqual(prefix);
  // SignedDelegate = DelegateAction || Signature; an ed25519 Signature is a 0 key-type byte and 64 bytes.
  expect(bytes.subarray(0, -65)).toEqual(delegateAction.subarray(4));
  expect(bytes[bytes.length - 65]).toBe(0);
  const hash = new Uint8Array(createHash("sha256").update(delegateAction).digest());
  expect(key.getPublicKey().verify(hash, bytes.subarray(-64))).toBe(true);
}

/** PKCS#8 wrapping of a raw 32-byte Ed25519 seed (RFC 8410). */
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

/** The node:crypto private key behind a near-api-js ed25519 KeyPair ("ed25519:" + base58(seed || public key)). */
function ed25519PrivateKey(keyPair: KeyPair) {
  const seed = baseDecode(keyPair.toString().slice("ed25519:".length)).subarray(0, 32);
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: "der", type: "pkcs8" });
}

const u32 = (value: number) => {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value);
  return out;
};
const u64 = (value: bigint) => {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value);
  return out;
};
const u128 = (value: bigint) => Buffer.concat([u64(value & 0xffff_ffff_ffff_ffffn), u64(value >> 64n)]);
const sized = (bytes: Buffer) => Buffer.concat([u32(bytes.length), bytes]);
const string = (text: string) => sized(Buffer.from(text, "utf8"));
