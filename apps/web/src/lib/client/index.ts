/**
 * The one data interface every page uses. Two implementations:
 * - MockClient (mock.ts): an in-browser simulated chain that enforces the
 *   contract's rules and runs the real clearing algorithm and sealed-box
 *   encryption. The default, so the demo needs no wallet and no funds.
 * - NearClient (near.ts): the deployed contract, read over JSON-RPC and
 *   written through the gas relayer or the connected wallet. Used only when
 *   NEXT_PUBLIC_FAIRGROUND_CONTRACT is set; loaded with import() on first use,
 *   so mock-mode pages never download it (see lazy-near.ts).
 *
 * Every write throws a FairgroundError (errors.ts) with a readable message.
 */

import type {
  Attestation,
  Balances,
  BidRecord,
  BidResult,
  BidTerms,
  ClaimResult,
  ClientCapabilities,
  ClientNotice,
  CreateOptions,
  RelayerPolicyInfo,
  RevealTerms,
  Sale,
  SaleConfig,
  SaleEvent,
  SaleMeta,
  SaleResult,
  SaleWithRelay,
  StorageResult,
  WriteOptions,
  WriteResult,
} from "../types";

export type JudgeStep =
  | "create"
  | "key"
  | "bots"
  | "crowd"
  | "copycat"
  | "window"
  | "close"
  | "clearing"
  | "done";

export type JudgeProgress = {
  step: JudgeStep;
  saleId: string | null;
  /** Bids placed so far, for the crowd step. */
  bidsPlaced: number;
  message: string;
};

/** What a bid carries: a sealed bid (TEE sale) or a commitment (commit-reveal sale). */
export type BidPayload = { ciphertext: string } | { commitment: string };

export interface FairgroundClient {
  readonly mode: "mock" | "near";
  /** Contract account the sales live on. */
  readonly contractId: string;
  /** The USDC (NEP-141) contract bids are paid in: a new sale's `quoteToken`. */
  readonly usdcContract: string;
  /**
   * The `contract` argument of the lib/bid-secrets helpers for this client
   * (getBidSecret, exportBidSecrets, ...): the contract id in NEAR mode, a
   * separate scope for the mock, so their commit-reveal salts never mix.
   */
  readonly secretsScope: string;
  /** What this client supports (judge mode, faucet, reset, relayer). */
  readonly capabilities: ClientCapabilities;
  ready(): Promise<void>;

  listSales(): Promise<Sale[]>;
  getSale(id: string): Promise<Sale | null>;
  /** Public bid records: deposits and ciphertexts only, never prices. */
  getBids(id: string): Promise<BidRecord[]>;
  /** One account's bid in a sale, or null. */
  getBid(saleId: string, bidder: string): Promise<BidRecord | null>;
  getEvents(id: string): Promise<SaleEvent[]>;
  /** Null until the sale is final (settled or failed). */
  getResult(id: string): Promise<SaleResult | null>;
  /**
   * USDC balance of an account. `tokens`: the mock lists every sale token the
   * account claimed; the NEAR client reads the balance of each sale token
   * named in `saleIds` (one view call each, none by default).
   */
  getBalances(account: string, saleIds?: string[]): Promise<Balances>;

  /** NEAR create_sale charges for this config (yoctoNEAR); 0n in the mock. Validates like create_sale. */
  getCreateCost(creator: string, config: SaleConfig, meta: SaleMeta, opts?: CreateOptions): Promise<bigint>;
  /** NEAR close_sale needs attached now (yoctoNEAR, get_close_deposit); 0n in the mock and for commit-reveal. */
  getCloseDeposit(saleId: string): Promise<bigint>;

  /**
   * create_sale. NEAR: a wallet transaction (never relayed) attaching
   * get_create_cost; the sale starts in setup (status "upcoming", chainStatus
   * "setup") until its token is deployed and, for a TEE sale, its key arrives.
   */
  createSale(creator: string, config: SaleConfig, meta: SaleMeta, opts?: CreateOptions): Promise<Sale>;
  /**
   * A sealed bid: ft_transfer_call of `deposit` USDC with the ciphertext in
   * `msg` (TEE sales). One bid per account per sale. Throws a FairgroundError
   * ("bid_rejected" with the contract's reason) when the contract returns the
   * deposit. The ciphertext must be sealBid output (padded plaintext).
   */
  placeBid(saleId: string, bidder: string, deposit: bigint, ciphertext: string, opts?: WriteOptions): Promise<BidResult>;
  /** Like placeBid, for either payload: a ciphertext (TEE) or a 64-hex commitment (commit-reveal). */
  placeBidPayload(saleId: string, bidder: string, deposit: bigint, payload: BidPayload, opts?: WriteOptions): Promise<BidResult>;
  /**
   * The whole bid in one call: TEE sales seal the padded plaintext to the
   * sale's key; commit-reveal sales commit (DESIGN v1) and save the salt in
   * this browser first (lib/bid-secrets), so the bid can be revealed later.
   */
  bid(saleId: string, bidder: string, deposit: bigint, terms: BidTerms, opts?: WriteOptions): Promise<BidResult>;
  /** Anyone, after bid_end. Freezes the bid set; TEE: asks the enclave to clear; commit-reveal: opens the reveal window. NEAR: wallet transaction attaching get_close_deposit. */
  closeSale(saleId: string, caller: string): Promise<Sale>;
  /** Commit-reveal, the bidder only, during the reveal window. Without `reveal`, uses the secret saved when bidding. */
  revealBid(saleId: string, bidder: string, reveal?: RevealTerms, opts?: WriteOptions): Promise<WriteResult>;
  /** Commit-reveal, anyone, once the reveal window has ended: the contract clears the sale itself. */
  clearOnchain(saleId: string, caller: string, opts?: WriteOptions): Promise<SaleWithRelay>;
  /** Anyone may push a bidder's claim; the funds only ever go to `bidder`. */
  claim(saleId: string, bidder: string, opts?: WriteOptions): Promise<ClaimResult>;
  /** Anyone may push the creator's payout of a final sale (raise, allocation, NEAR reserve; burns unsold tokens). */
  claimProceeds(saleId: string, caller: string, opts?: WriteOptions): Promise<WriteResult>;
  /** Anyone, after settle_timeout with no result. Moves the sale to Failed. */
  triggerRefundMode(saleId: string, caller: string, opts?: WriteOptions): Promise<SaleWithRelay>;
  /**
   * Anyone, while a sale is in setup and a step failed: redeploys the token
   * and/or re-asks the sealer key. NEAR: wallet transaction; a key retry
   * attaches `deposit` (default OUTLAYER_COMPUTE_DEPOSIT, 0.01401 NEAR).
   */
  retrySetup(saleId: string, caller: string, opts?: { deposit?: bigint }): Promise<Sale>;

  /**
   * What is known about the enclave run. Mock: a simulated attestation that
   * echoes `nonce`. NEAR: what the contract's views hold (`source: "chain"`):
   * the pinned code hash, the stored sale key, and the sha256 of the clearing
   * input and output; no quote is fetched, so `nonce` and `quote` are "".
   */
  getAttestation(saleId: string, nonce: string): Promise<Attestation>;
  /** Hash of our reproducible enclave build from the public repo ("" when not configured). */
  expectedCodeHash(): string;

  /**
   * Test USDC for an account (capabilities.faucet; never on mainnet). Mock:
   * credited at once. NEAR testnet or sandbox: the token's open `mint`, a
   * transaction the connected wallet signs and pays for. With `key`, a second
   * call with the same key mints nothing, so a retried or resumed credit is safe.
   */
  faucet(account: string, amount: bigint, opts?: { key?: string }): Promise<Balances>;
  /**
   * Makes sure `account` is registered (NEP-145) on the USDC contract, so USDC
   * can be delivered to it. NEAR: asks the relayer to sponsor it, falling back
   * to a paid storage_deposit when the relayer's storage budget is used up.
   * The mock has nothing to register.
   */
  ensureUsdcStorage(account: string, opts?: WriteOptions): Promise<StorageResult>;

  /**
   * What the relayer pays for; null when there is no relayer or it cannot be
   * reached. A call is gasless when this is non-null and the wallet can sign
   * delegates (WalletState.canSignDelegates).
   */
  getRelayerPolicy(): Promise<RelayerPolicyInfo | null>;

  /** Judge mode: seeded sale, 50 simulated bidders, 3 snipers, close, clear. Mock only (capabilities.judgeMode). */
  runJudgeMode(opts: {
    onProgress: (p: JudgeProgress) => void;
    /** Seconds the bid window stays open, so a judge can add their own bid. */
    windowSeconds?: number;
  }): Promise<string>;

  /** Called on every state change (any sale). Returns unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Messages for the user that are not errors (paid fallback, storage registration). Returns unsubscribe. */
  subscribeNotices(listener: (n: ClientNotice) => void): () => void;
  /** Wipe local demo state (every sale, bid and balance) and reseed. Mock only (capabilities.reset). */
  reset(): Promise<void>;
}

export {
  FairgroundError,
  isFairgroundError,
  isMaybeSubmitted,
  errorInfo,
  relayerRefusalMessage,
  BID_REJECT_MESSAGES,
  PAID_REASON_MESSAGES,
  RELAYER_REFUSAL_MESSAGES,
} from "./errors";
export type { ErrorCode, ErrorInfo } from "./errors";

import { appConfig } from "../config";
import { createLazyNearClient } from "./lazy-near";
import { MockClient } from "./mock";

let client: FairgroundClient | null = null;

/**
 * The app's client: NEAR when NEXT_PUBLIC_FAIRGROUND_CONTRACT is set, else the
 * mock. Throws a ConfigError when a NEXT_PUBLIC_* value is unusable.
 */
export function getClient(): FairgroundClient {
  if (!client) {
    const config = appConfig();
    client = config.mode === "near" ? createLazyNearClient(config.near) : new MockClient();
  }
  return client;
}

/** "mock" or "near", without creating the client. */
export function clientMode(): "mock" | "near" {
  return appConfig().mode;
}
