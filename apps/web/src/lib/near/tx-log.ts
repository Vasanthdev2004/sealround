/**
 * What this browser itself sent to the chain, kept so the timeline can show
 * transaction hashes and bids the contract returned. The contract has no
 * event view, so everything else in a NEAR-mode timeline is derived from
 * views (see views.ts `eventsFromViews`); this log only adds to it and is
 * never the source of truth for state.
 *
 * Stored in localStorage per contract; an in-memory copy is used when there
 * is no storage (private mode, Node).
 */

import type { BidRejectReason, SaleEvent, SaleEventKind } from "../types";

export type TxLogEntry = {
  saleId: string;
  kind: SaleEventKind;
  detail?: SaleEvent["detail"];
  /** This browser's clock when the outcome arrived, ms. */
  at: number;
  account?: string;
  /** USDC base units, decimal string. */
  amount?: string;
  /** "" when the wallet or relayer returned none. */
  txHash: string;
  note?: string;
  reason?: BidRejectReason;
};

const KEY = "fairground:txlog:v1";
/** Entries kept per sale; the oldest go first. */
const MAX_PER_SALE = 200;

export class TxLog {
  private memory: Record<string, TxLogEntry[]> = {};

  /** `scope` separates contracts: the contract id. */
  constructor(private readonly scope: string) {}

  private read(): Record<string, TxLogEntry[]> {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) return JSON.parse(raw) as Record<string, TxLogEntry[]>;
    } catch {
      // no storage: memory only
    }
    return this.memory;
  }

  private write(all: Record<string, TxLogEntry[]>): void {
    this.memory = all;
    try {
      localStorage.setItem(KEY, JSON.stringify(all));
    } catch {
      // memory only
    }
  }

  add(entry: TxLogEntry): void {
    const all = this.read();
    const key = `${this.scope}/${entry.saleId}`;
    all[key] = [...(all[key] ?? []), entry].slice(-MAX_PER_SALE);
    this.write(all);
  }

  list(saleId: string): TxLogEntry[] {
    return this.read()[`${this.scope}/${saleId}`] ?? [];
  }

  /** The latest entry of a kind (and account, and detail when given) for a sale. */
  find(saleId: string, kind: SaleEventKind, account?: string, detail?: SaleEvent["detail"]): TxLogEntry | undefined {
    return this.list(saleId)
      .filter((e) => e.kind === kind && (account === undefined || e.account === account) && e.detail === detail)
      .at(-1);
  }
}
