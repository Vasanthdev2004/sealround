/** Offline fixtures: real ed25519-signed delegates, no network. */
import {
  KeyPair,
  KeyPairSigner,
  actions,
  base64Encode,
  buildDelegateAction,
  encodeSignedDelegate,
  teraToGas,
  type Action,
  type SignedDelegate,
} from "near-api-js";
import type { RelayPolicy } from "../src/policy.ts";
import type { ViewCall } from "../src/preflight.ts";

export const RELAYER = "relayer.test.near";
export const FAIRGROUND = "fairground.test.near";
export const USDC = "usdc.test.near";
export const ALICE = "alice.test.near";
export const HEAD = 1_000n;

export const POLICY: RelayPolicy = {
  relayerAccountId: RELAYER,
  fairgroundContract: FAIRGROUND,
  usdcContracts: [USDC, "usdc2.test.near"],
  maxGas: teraToGas(300),
  maxActions: 2,
  minBlocksLeft: 5n,
  maxDelegateBlocks: 1200n,
};

/**
 * A stand-in sealed bid on sale "fairt" from ALICE, of the one length the
 * contract accepts for them: 224 + 5 ("fairt") + 15 ("alice.test.near") = 244
 * bytes (crates/clearing sealed_bid_len). Real libsodium boxes are tested in
 * sealed-bid.test.ts.
 */
export const CIPHERTEXT = Buffer.alloc(244, 7).toString("base64");

export const bidMsg = (fields: Record<string, unknown> = { sale_id: "fairt", ciphertext: CIPHERTEXT }) =>
  JSON.stringify(fields);

export const bidArgs = (overrides: Record<string, unknown> = {}) => ({
  receiver_id: FAIRGROUND,
  amount: "1000000",
  msg: bidMsg(),
  ...overrides,
});

export const bid = (args: Record<string, unknown> | Uint8Array = bidArgs(), deposit = 1n, gas = teraToGas(100)) =>
  actions.functionCall("ft_transfer_call", args, gas, deposit);

export const REVEAL_ARGS = { sale_id: "fairt", max_price: "2500", max_spend: "100000000", salt: "c".repeat(32) };

/** A Fairground call with the arguments the contract takes for `method`. */
export const call = (method: string, deposit = 0n, gas = teraToGas(50), args: Record<string, unknown> | Uint8Array = method === "reveal_bid" ? REVEAL_ARGS : { sale_id: "fairt" }) =>
  actions.functionCall(method, args, gas, deposit);

/** A `get_sale` answer: an open TEE sale quoted in USDC unless overridden. */
export const sale = (overrides: Record<string, unknown> = {}) => ({
  status: "open",
  quote_token: USDC,
  reveal_mode: "Tee",
  reveal_end: null,
  refund_mode_at: "9000000000000000000",
  token_setup: "done",
  creator_allocation: "0",
  ...overrides,
});

/** A final sale with no creator payout due unless the test specifies one. */
export const proceedsResult = (overrides: Record<string, unknown> = {}) => ({
  sale_id: "fairt",
  status: "settled",
  total_raised: "0",
  unsold: "0",
  proceeds: { raise_paid: false, allocation_paid: false, unsold_burned: false, reserve_returned: false },
  ...overrides,
});

/** A pool ready to register before its seeding deadline. */
export const liquidityView = (overrides: Record<string, unknown> = {}) => ({
  status: "seeding",
  next_step: "register",
  in_flight: null,
  deadline: "1001",
  usdc: "50",
  usdc_on_dex: "0",
  ...overrides,
});

interface ChainState {
  sales?: Record<string, unknown>;
  results?: Record<string, unknown>;
  reserves?: Record<string, unknown>;
  /** `get_bid` answers by bidder (any sale). */
  bids?: Record<string, { revealed: boolean; claimed: boolean }>;
  /** Everyone's USDC balance. */
  balance?: bigint;
}

/** Fairground and USDC views answered from `state`; each call is recorded in `asked` as [method, args]. */
export function fakeViews(
  { sales = { fairt: sale() }, results = {}, reserves = {}, bids = {}, balance = 10n ** 12n }: ChainState = {},
  asked: unknown[] = [],
): ViewCall {
  return async <T,>(contractId: string, method: string, args: Record<string, unknown>): Promise<T> => {
    asked.push([method, args]);
    if (method === "get_sale") return (sales[String(args["sale_id"])] ?? null) as T;
    if (method === "get_result") return (results[String(args["sale_id"])] ?? null) as T;
    if (method === "get_reserve_refund") return (reserves[String(args["sale_id"])] ?? "0") as T;
    if (method === "get_bid") return (bids[String(args["bidder"])] ?? null) as T;
    if (method === "ft_balance_of") return balance.toString() as T;
    throw new Error(`unexpected view ${contractId}.${method}`);
  };
}

export interface DelegateSpec {
  sender?: string;
  receiver?: string;
  actions?: Action[];
  nonce?: bigint;
  maxBlockHeight?: bigint;
  key?: KeyPair;
}

export async function signDelegate(spec: DelegateSpec = {}): Promise<{ delegate: SignedDelegate; base64: string }> {
  const key = spec.key ?? KeyPair.fromRandom("ed25519");
  const delegateAction = buildDelegateAction({
    senderId: spec.sender ?? ALICE,
    receiverId: spec.receiver ?? USDC,
    actions: spec.actions ?? [bid()],
    nonce: spec.nonce ?? 5n,
    maxBlockHeight: spec.maxBlockHeight ?? HEAD + 100n,
    publicKey: key.getPublicKey(),
  });
  const { signedDelegate } = await new KeyPairSigner(key).signDelegateAction(delegateAction);
  return { delegate: signedDelegate, base64: base64Encode(encodeSignedDelegate(signedDelegate)) };
}
