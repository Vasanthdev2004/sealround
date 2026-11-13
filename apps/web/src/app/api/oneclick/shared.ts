/**
 * Rules for real 1Click swaps, shared by the proxy routes (server) and
 * lib/oneclick.ts (browser). Pure: no secrets, no process.env, no fetch.
 * Not a route itself.
 *
 * A real swap creates a live deposit address on the origin chain. Whatever the
 * user sends there is swapped to USDC and delivered to `recipient` on NEAR, or
 * refunded to `refundTo` on the origin chain. So every field that decides
 * where money goes is checked here, on both sides.
 */

import { ACCOUNT_ID, type AppConfig } from "@/lib/config";

/** Circle's native USDC on NEAR mainnet: the only asset a real swap may deliver. */
export const NEAR_USDC_CONTRACT = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const NEAR_USDC_ASSET = `nep141:${NEAR_USDC_CONTRACT}`;

export const ONECLICK_STATUSES = [
  "PENDING_DEPOSIT",
  "KNOWN_DEPOSIT_TX",
  "PROCESSING",
  "SUCCESS",
  "INCOMPLETE_DEPOSIT",
  "REFUNDED",
  "FAILED",
] as const;

/** Standard and confidential origin-chain swaps supported by this app. */
export const FUNDING_MODES = ["public", "basic"] as const;
export type FundingMode = (typeof FUNDING_MODES)[number];

export function quoteMatchesFundingMode(mode: FundingMode, echoed: unknown): boolean {
  return echoed === mode || (mode === "public" && echoed === undefined);
}

/** Address format of an origin chain. */
export type AddressKind = "evm" | "sol" | "btc";

/**
 * The origin assets a real swap may start from (1Click asset ids, as listed by
 * GET /v0/tokens), and the address format of their chain. lib/oneclick.ts
 * ORIGINS must use the same ids; a test checks it.
 */
export const REAL_ORIGIN_ASSETS: Readonly<Record<string, AddressKind>> = {
  "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near": "evm",
  "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near": "evm",
  "nep141:eth.omft.near": "evm",
  "nep141:sol.omft.near": "sol",
  "nep141:btc.omft.near": "btc",
};

/** Slippage a real quote may ask for, in basis points. The app asks for 100. */
export const REAL_MAX_SLIPPAGE_BPS = 300;
/** The request deadline of a real quote must be this far ahead, at least and at most. */
export const REAL_DEADLINE_MIN_MS = 5 * 60_000;
export const REAL_DEADLINE_MAX_MS = 3 * 60 * 60_000;

const ADDRESS: Record<AddressKind, RegExp> = {
  evm: /^0x[0-9a-fA-F]{40}$/,
  // Base58, 32 bytes.
  sol: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  // Bech32 (one case only) or legacy base58.
  btc: /^(bc1[02-9ac-hj-np-z]{11,71}|BC1[02-9AC-HJ-NP-Z]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/,
};

const TX_HASH: Record<AddressKind, RegExp> = {
  evm: /^0x[0-9a-fA-F]{64}$/,
  // Base58, 64 bytes.
  sol: /^[1-9A-HJ-NP-Za-km-z]{64,90}$/,
  btc: /^[0-9a-fA-F]{64}$/,
};

const KINDS: AddressKind[] = ["evm", "sol", "btc"];

/** Shape check only (no checksum): is `addr` an address on a chain of this kind? */
export const isAddressOf = (kind: AddressKind, addr: string): boolean => ADDRESS[kind].test(addr);

/** Every chain kind `addr` could be an address on. Short base58 strings fit both Solana and legacy Bitcoin. */
export const addressKinds = (addr: string): AddressKind[] => KINDS.filter((k) => ADDRESS[k].test(addr));

/** A 1Click deposit address on one of the origin chains this app offers. */
export const isDepositAddress = (addr: string): boolean => addressKinds(addr).length > 0;

/** Shape check: a transaction hash on a chain of this kind. */
export const isTxHashOf = (kind: AddressKind, hash: string): boolean => TX_HASH[kind].test(hash);

/** A transaction hash that can belong to a deposit to `depositAddress`. */
export const isTxHashFor = (depositAddress: string, hash: string): boolean =>
  addressKinds(depositAddress).some((k) => isTxHashOf(k, hash));

/**
 * A NEAR account id a real swap may deliver to: a valid account id that is
 * not a testnet name. The app passes the connected wallet's account.
 */
export const isRealRecipient = (id: string): boolean => ACCOUNT_ID.test(id) && !/\.testnet$/.test(id);

/**
 * The switch. Real swaps run only when all of these hold:
 * - the app is in NEAR mode on mainnet;
 * - it pays in Circle's USDC (the asset a real swap delivers);
 * - `flag` is "1". The server passes ONECLICK_REAL_SWAPS.
 */
export function realSwapsAllowed(config: AppConfig, flag: string | undefined): boolean {
  return (
    flag?.trim() === "1" &&
    config.mode === "near" &&
    config.near.network === "mainnet" &&
    config.near.usdcContract === NEAR_USDC_CONTRACT
  );
}

/** The fields of a real quote request that decide where money goes. */
export type RealQuoteTerms = {
  originAsset: string;
  destinationAsset: string;
  amount: string;
  recipient: string;
  refundTo: string;
  confidentiality?: FundingMode;
};

const sameAddress = (kind: AddressKind | undefined, a: unknown, b: string) =>
  typeof a === "string" && (kind === "evm" ? a.toLowerCase() === b.toLowerCase() : a === b);

/**
 * Checks 1Click's answer to a real quote request against what was asked.
 * Returns a plain-words problem, or null when the quote can be shown.
 * Refuses a quote that would deliver elsewhere, refund elsewhere, take a
 * different amount, has no usable deposit address or needs a deposit memo
 * (this app does not pass memos).
 */
export function checkRealQuote(asked: RealQuoteTerms, data: unknown): string | null {
  const bad = "1Click returned a quote that does not match the request, so it is not shown. Nothing was sent.";
  if (!data || typeof data !== "object") return bad;
  const d = data as { quote?: Record<string, unknown>; quoteRequest?: Record<string, unknown> };
  const q = d.quote;
  const r = d.quoteRequest;
  if (!q || typeof q !== "object" || !r || typeof r !== "object") return bad;
  if (!quoteMatchesFundingMode(asked.confidentiality ?? "public", r.confidentiality)) {
    return "1Click did not confirm the requested funding mode. Nothing was sent.";
  }
  const kind = REAL_ORIGIN_ASSETS[asked.originAsset];
  if (!kind) return bad;
  if (r.dry !== false || r.swapType !== "EXACT_INPUT" || r.depositType !== "ORIGIN_CHAIN" || r.amount !== asked.amount) {
    return bad;
  }
  if (q.depositMemo !== undefined && q.depositMemo !== null && q.depositMemo !== "") {
    return "This route needs a deposit memo, which this app does not support. Nothing was sent.";
  }
  if (typeof q.depositAddress !== "string" || !isAddressOf(kind, q.depositAddress)) {
    return "1Click returned no usable deposit address. Nothing was sent.";
  }
  if (q.amountIn !== asked.amount) return bad;
  if (typeof q.amountOut !== "string" || !/^\d{1,40}$/.test(q.amountOut)) return bad;
  if (typeof q.minAmountOut !== "string" || !/^\d{1,40}$/.test(q.minAmountOut)) return bad;
  if (typeof q.deadline !== "string" || !Number.isFinite(Date.parse(q.deadline))) return bad;
  if (r.recipient !== asked.recipient || r.recipientType !== "DESTINATION_CHAIN") return bad;
  if (r.destinationAsset !== asked.destinationAsset || r.originAsset !== asked.originAsset) return bad;
  if (!sameAddress(kind, r.refundTo, asked.refundTo) || r.refundType !== "ORIGIN_CHAIN") return bad;
  return null;
}
