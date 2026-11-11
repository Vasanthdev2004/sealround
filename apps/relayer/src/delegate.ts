/**
 * Decoding and local verification of NEP-366 SignedDelegate payloads. Pure: no
 * network, no clock.
 *
 * Wire format: base64(borsh(SignedDelegate)), as NEAR Connect's
 * `signDelegateActions` and near-api-js `encodeSignedDelegate` produce it.
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import { deserialize } from "borsh";
import {
  DelegateAction,
  KeyType,
  PublicKey,
  SCHEMA,
  Signature,
  actions,
  encodeDelegateAction,
  encodeSignedDelegate,
  type SignedDelegate,
} from "near-api-js";
import type { RejectionReason } from "./api.ts";
import { isAccountId } from "./config.ts";

/** One inner FunctionCall, as the policy sees it. */
export interface InnerCall {
  methodName: string;
  args: Uint8Array;
  gas: bigint;
  deposit: bigint;
}

export type DecodeResult =
  | { ok: true; delegate: SignedDelegate }
  | { ok: false; reason: Extract<RejectionReason, "bad_encoding" | "unsupported_key_type" | "action_not_allowed"> };

/** The plain object borsh 2.0.0 returns for SCHEMA.SignedDelegate: u8 arrays as number[], u64/u128 as bigint, enums as `{ variant: value }`. */
interface RawSignedDelegate {
  delegateAction: {
    senderId: string;
    receiverId: string;
    actions: Array<Record<string, unknown>>;
    nonce: bigint;
    maxBlockHeight: bigint;
    publicKey: { ed25519Key?: { data: number[] } };
  };
  signature: { ed25519Signature?: { data: number[] } };
}

interface RawFunctionCall {
  methodName: string;
  args: number[];
  gas: bigint;
  deposit: bigint;
}

/** base64 or base64url, padded or not. Node's decoder skips other characters silently, so they are refused here first. */
const BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/;

/**
 * Decodes a base64 SignedDelegate into near-api-js instances.
 *
 * Only ed25519 keys and FunctionCall actions pass, which is all Fairground needs;
 * transfers, key changes, deploys and anything else are refused here, before any
 * RPC call. So are sender and receiver ids that are not valid account ids, which
 * the RPC would answer with a parse error. The re-encoding must equal the input
 * bytes: borsh-js ignores trailing bytes and replaces bad UTF-8, so this
 * guarantees that what we verify and relay is exactly what the user signed.
 */
export function decodeSignedDelegate(base64: string): DecodeResult {
  if (!BASE64.test(base64)) return { ok: false, reason: "bad_encoding" };
  const bytes = new Uint8Array(Buffer.from(base64, "base64"));
  let raw: RawSignedDelegate;
  try {
    raw = deserialize(SCHEMA.SignedDelegate, bytes) as unknown as RawSignedDelegate;
  } catch {
    return { ok: false, reason: "bad_encoding" };
  }
  const { delegateAction: da, signature } = raw;
  if (!isAccountId(da.senderId) || !isAccountId(da.receiverId)) return { ok: false, reason: "bad_encoding" };
  if (!da.publicKey.ed25519Key || !signature.ed25519Signature) return { ok: false, reason: "unsupported_key_type" };
  const calls = da.actions.map((action) => action["functionCall"] as RawFunctionCall | undefined);
  if (calls.some((call) => call === undefined)) return { ok: false, reason: "action_not_allowed" };

  // near-api-js 7.4.0 declares SignedDelegate as an exported class, but its runtime
  // bundle does not export it, so we build the structurally identical object.
  const delegate: SignedDelegate = {
    delegateAction: new DelegateAction({
      senderId: da.senderId,
      receiverId: da.receiverId,
      actions: (calls as RawFunctionCall[]).map((call) =>
        actions.functionCall(call.methodName, Uint8Array.from(call.args), call.gas, call.deposit),
      ),
      nonce: da.nonce,
      maxBlockHeight: da.maxBlockHeight,
      publicKey: new PublicKey({ keyType: KeyType.ED25519, data: Uint8Array.from(da.publicKey.ed25519Key.data) }),
    }),
    signature: new Signature({ keyType: KeyType.ED25519, data: Uint8Array.from(signature.ed25519Signature.data) }),
  };
  if (!bytesEqual(encodeSignedDelegate(delegate), bytes)) return { ok: false, reason: "bad_encoding" };
  return { ok: true, delegate };
}

/**
 * Checks the signature over what nearcore verifies, sha256(borsh(u32 2^30 + 366)
 * || borsh(DelegateAction)) (`encodeDelegateAction` adds the NEP-461 prefix), with
 * the delegate's own public key. Whether that key belongs to the sender is an
 * on-chain question, checked later.
 *
 * The equation is the cofactorless one of RFC 8032 (OpenSSL through node:crypto),
 * which ed25519-dalek's `verify` in nearcore also checks. near-api-js's
 * `PublicKey.verify` checks the cofactored one, which also accepts signatures
 * with a small-order component that nearcore refuses after the relayer has paid.
 * The two implementations may still disagree on keys with non-canonical
 * encodings; only the key's owner can add such a key, and it costs the relayer at
 * most one failed relay within the limits.
 */
export function hasValidSignature({ delegateAction, signature }: SignedDelegate): boolean {
  const hash = createHash("sha256").update(encodeDelegateAction(delegateAction)).digest();
  try {
    const key = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(delegateAction.publicKey.data).toString("base64url") },
      format: "jwk",
    });
    return verify(null, hash, key, signature.data);
  } catch {
    return false; // not a point OpenSSL can decode
  }
}

/** The inner calls of a decoded delegate; `decodeSignedDelegate` guarantees every action is a FunctionCall. */
export function innerCalls({ delegateAction }: SignedDelegate): InnerCall[] {
  return delegateAction.actions.map(({ functionCall }) => {
    if (!functionCall) throw new Error("decoded delegate holds a non-FunctionCall action");
    const { methodName, args, gas, deposit } = functionCall;
    return { methodName, args, gas, deposit };
  });
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}
