/**
 * Reads a transaction's result the way the relayer does (apps/relayer
 * src/outcome.ts), so the app treats a paid fallback exactly like a relayed call.
 *
 * Three traps: a relayed transaction reports SuccessValue("") at the top level
 * even when the inner call fails, so success is decided from every receipt;
 * Fairground refunds a refused bid without failing, so only its events say
 * whether a bid was accepted; and a receipt that fails keeps its logs while its
 * state change is undone, so only events of receipts that succeeded count.
 */
import type { FairgroundEvent, ReceiptFailure, RelayStatus } from "@fairground/relayer/api";

export interface TransactionSummary {
  /** Null only when a wallet returned no recognisable outcome. */
  txHash: string | null;
  /** "pending": not executed yet, or the outcome could not be read; check the chain (e.g. `get_bid`). */
  status: RelayStatus;
  failures: ReceiptFailure[];
  /** NEP-297 events (standard "fairground") logged by the Fairground contract. */
  events: FairgroundEvent[];
}

export type BidOutcome = { kind: "placed" } | { kind: "rejected"; reason: string } | { kind: "unknown" };

const EVENT_PREFIX = "EVENT_JSON:";

interface Outcome {
  id: string;
  executorId: string;
  status: unknown;
  logs: string[];
}

/**
 * Summarizes an RPC final outcome (`FinalExecutionOutcome`: what wallets'
 * `signAndSendTransaction` and near-api-js return). Events count only when a
 * Fairground receipt that succeeded logged them, so no other contract can fake
 * them and a `bid_placed` logged just before running out of gas does not count.
 */
export function summarizeOutcome(value: unknown, fairgroundContract: string): TransactionSummary {
  const tx = asRecord(value);
  const transaction = readOutcome(tx?.["transaction_outcome"]);
  const receipts = readOutcomes(tx?.["receipts_outcome"]);
  const hash = asRecord(tx?.["transaction"])?.["hash"];
  const txHash = transaction?.id ?? (typeof hash === "string" ? hash : null);
  if (!transaction || !receipts) return { txHash, status: "pending", failures: [], events: [] };

  const failures = [transaction, ...receipts].flatMap(({ id, executorId, status }) => {
    const failure = asRecord(status)?.["Failure"];
    return failure === undefined ? [] : [{ receipt_id: id, executor_id: executorId, error: failure }];
  });
  const events = receipts
    .filter((receipt) => receipt.executorId === fairgroundContract && succeeded(receipt.status))
    .flatMap((receipt) => receipt.logs.flatMap(fairgroundEvent));
  return { txHash, status: failures.length === 0 ? "succeeded" : "failed", failures, events };
}

function succeeded(status: unknown): boolean {
  const record = asRecord(status);
  return record !== undefined && ("SuccessValue" in record || "SuccessReceiptId" in record);
}

/** Whether Fairground accepted the bid in a transaction: `bid_placed`, or `bid_rejected` with its reason (the deposit was refunded). */
export function bidOutcome(events: readonly FairgroundEvent[]): BidOutcome {
  for (const { event, data } of events) {
    if (event === "bid_placed") return { kind: "placed" };
    if (event === "bid_rejected") {
      const reason = asRecord(data)?.["reason"];
      return { kind: "rejected", reason: typeof reason === "string" ? reason : "unknown" };
    }
  }
  return { kind: "unknown" };
}

/** Every receipt outcome, or undefined if any of them cannot be read. */
function readOutcomes(value: unknown): Outcome[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const outcomes = value.map(readOutcome);
  return outcomes.every((outcome): outcome is Outcome => outcome !== undefined) ? outcomes : undefined;
}

function readOutcome(value: unknown): Outcome | undefined {
  const record = asRecord(value);
  const outcome = asRecord(record?.["outcome"]);
  const id = record?.["id"];
  const executorId = outcome?.["executor_id"];
  const logs = outcome?.["logs"];
  if (typeof id !== "string" || typeof executorId !== "string" || !Array.isArray(logs)) return undefined;
  return { id, executorId, status: outcome?.["status"], logs: logs.filter((log): log is string => typeof log === "string") };
}

function fairgroundEvent(log: string): FairgroundEvent[] {
  if (!log.startsWith(EVENT_PREFIX)) return [];
  try {
    const event = asRecord(JSON.parse(log.slice(EVENT_PREFIX.length)));
    const name = event?.["event"];
    return event?.["standard"] === "fairground" && typeof name === "string" ? [{ event: name, data: event["data"] }] : [];
  } catch {
    return [];
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
