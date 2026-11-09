/**
 * The one data interface every page uses. Today it is backed by an in-browser
 * mock that runs the real clearing algorithm and real sealed-box encryption.
 * When the contract is on testnet, a NEAR RPC implementation replaces it
 * behind this same interface.
 */

import type {
  Attestation,
  Balances,
  BidRecord,
  ClaimReceipt,
  Sale,
  SaleConfig,
  SaleEvent,
  SaleMeta,
  SaleResult,
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

export interface FairgroundClient {
  readonly mode: "mock" | "near";
  /** Contract account the sales live on. */
  readonly contractId: string;
  ready(): Promise<void>;

  listSales(): Promise<Sale[]>;
  getSale(id: string): Promise<Sale | null>;
  /** Public bid records: deposits and ciphertexts only, never prices. */
  getBids(id: string): Promise<BidRecord[]>;
  getEvents(id: string): Promise<SaleEvent[]>;
  getResult(id: string): Promise<SaleResult | null>;
  getBalances(account: string): Promise<Balances>;

  createSale(creator: string, config: SaleConfig, meta: SaleMeta): Promise<Sale>;
  /**
   * ft_transfer_call to the contract with the sealed bid in `msg`.
   * One bid per account per sale. Throws with a readable message when the
   * contract would reject it (and in that case funds never leave).
   */
  placeBid(saleId: string, bidder: string, deposit: bigint, ciphertext: string): Promise<BidRecord>;
  /** Anyone, after bid_end. Freezes the bid set and asks the enclave to clear. */
  closeSale(saleId: string, caller: string): Promise<Sale>;
  claim(saleId: string, bidder: string): Promise<ClaimReceipt>;
  /** Anyone, after settle_timeout with no result. Moves the sale to Failed. */
  triggerRefundMode(saleId: string, caller: string): Promise<Sale>;

  /** Fetch the enclave attestation with a fresh nonce. */
  getAttestation(saleId: string, nonce: string): Promise<Attestation>;
  /** Hash of our reproducible enclave build from the public repo. */
  expectedCodeHash(): string;

  /**
   * Testnet only: mint test USDC to an account. With `key`, a second call with
   * the same key mints nothing, so a retried or resumed credit is safe.
   */
  faucet(account: string, amount: bigint, opts?: { key?: string }): Promise<Balances>;

  /** Judge mode: seeded sale, 50 simulated bidders, 3 snipers, close, clear. */
  runJudgeMode(opts: {
    onProgress: (p: JudgeProgress) => void;
    /** Seconds the bid window stays open, so a judge can add their own bid. */
    windowSeconds?: number;
  }): Promise<string>;

  /** Called on every state change (any sale). Returns unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Wipe local demo state (every sale, bid and balance) and reseed. */
  reset(): Promise<void>;
}

import { MockClient } from "./mock";

let client: FairgroundClient | null = null;
export function getClient(): FairgroundClient {
  if (!client) client = new MockClient();
  return client;
}
