/**
 * App-side domain types. These mirror the contract views (get_sale, get_bid,
 * get_result, get_bids_summary) so the mock client can later be swapped for a
 * NEAR RPC client without touching the pages.
 *
 * Units: USDC base units (6 dp), prices in USDC base units per WHOLE token,
 * token amounts in token base units (`decimals`, default 18). All bigint.
 * Times are unix milliseconds.
 */

import type { Fill, ClearingResult } from "@fairground/clearing";

export type SaleStatus =
  /** Created, bid window not started. */
  | "upcoming"
  /** Bid window open. */
  | "open"
  /** Window ended, nobody has called close_sale yet. */
  | "awaiting_close"
  /** close_sale called, waiting on the enclave result. */
  | "clearing"
  /** Commit-reveal fallback only: reveal window open. */
  | "revealing"
  | "settled"
  | "failed";

export type RevealMode = "tee" | "commit_reveal";
export type UnsoldRule = "burn";

export type SaleConfig = {
  tokenName: string;
  tokenSymbol: string;
  decimals: number;
  totalSupply: bigint;
  saleSupply: bigint;
  /** Tokens sent to the creator at settlement. Disclosed up front. */
  creatorAllocation: bigint;
  /** totalSupply - saleSupply - creatorAllocation. Held for an LP. */
  lpReserve: bigint;
  floorPrice: bigint;
  /** Optional ceiling; bounds the total raise to saleSupply * maxPrice. */
  maxPrice: bigint | null;
  minRaise: bigint;
  bidStart: number;
  bidEnd: number;
  minDeposit: bigint;
  maxDepositPerAccount: bigint;
  revealMode: RevealMode;
  unsoldRule: UnsoldRule;
  settleTimeoutMs: number;
  /** NEP-141 account of the only accepted deposit token. */
  quoteToken: string;
};

export type SaleMeta = {
  description: string;
  /** Hex colour used for the token avatar. */
  hue: number;
  website?: string;
};

export type Sale = {
  id: string;
  creator: string;
  /** `<symbol>.fairground.testnet` */
  tokenAccount: string;
  config: SaleConfig;
  meta: SaleMeta;
  status: SaleStatus;
  createdAt: number;
  createTx: string;
  /** X25519 public key of this sale, hex. Set by the attested key call. */
  sealerPubkey: string;
  /** Hash of the enclave build that holds the key. */
  sealerCodeHash: string;
  /** sha256 over the frozen bid set, hex. Set at close. */
  bidSetHash: string | null;
  closedAt: number | null;
  settledAt: number | null;
  /** Set when anyone triggered refund mode after settle_timeout. */
  refundModeAt: number | null;
  /** Public aggregates, always visible. */
  bidCount: number;
  totalDeposits: bigint;
  /** True for sales created by judge mode. */
  isJudgeSale: boolean;
};

/** A bid as anyone can see it on-chain. The price is not here. */
export type BidRecord = {
  saleId: string;
  index: number;
  bidder: string;
  deposit: bigint;
  /** Sealed box ciphertext, base64. */
  ciphertext: string;
  placedAt: number;
  txHash: string;
  claimed: boolean;
  claimTx: string | null;
  /** Demo-only label so the UI can mark the sniper bots. Not on-chain. */
  tag?: "bot" | "sim" | "you";
};

export type ContractCheck = {
  id: string;
  label: string;
  passed: boolean;
};

export type Attestation = {
  /** Random nonce the app sent, hex. */
  nonce: string;
  codeHash: string;
  /** Public key the attestation reports for this sale, hex. */
  reportedPubkey: string;
  inputHash: string;
  outputHash: string;
  /** TDX quote, truncated for display. */
  quote: string;
  fetchedAt: number;
  /** Where a judge can see the raw attestation. */
  url: string;
  simulated: boolean;
};

export type SaleResult = Omit<ClearingResult, "fills" | "failReason"> & {
  /** settle_timeout: the enclave never answered and anyone switched the sale to refunds. */
  failReason?: ClearingResult["failReason"] | "settle_timeout";
  fills: (Fill & { claimed: boolean; claimTx: string | null; tag?: BidRecord["tag"] })[];
  /** Hash the enclave reports for the bid set it cleared, hex. */
  bidSetHash: string;
  checks: ContractCheck[];
  settleTx: string;
  clearingMs: number;
};

export type SaleEventKind =
  | "created"
  | "bid"
  | "bid_rejected"
  | "closed"
  | "clearing_requested"
  | "settled"
  | "failed"
  | "claimed"
  | "refund_mode";

export type SaleEvent = {
  saleId: string;
  kind: SaleEventKind;
  at: number;
  account?: string;
  /** USDC base units, for bids/claims. */
  amount?: bigint;
  txHash: string;
  note: string;
};

export type Balances = {
  account: string;
  /** Test USDC on NEAR, base units. */
  usdc: bigint;
  /** saleId -> token base units claimed. */
  tokens: Record<string, bigint>;
};

export type ClaimReceipt = {
  saleId: string;
  bidder: string;
  tokens: bigint;
  refund: bigint;
  txHash: string;
};

/** Plaintext inside the sealed box. Canonical JSON, keys in this order. */
export type BidPlaintext = {
  sale_id: string;
  bidder: string;
  /** Decimal string, USDC base units per whole token. */
  max_price: string;
  /** Decimal string, USDC base units. */
  max_spend: string;
  /** 16 random bytes, hex. */
  salt: string;
};
