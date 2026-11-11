/**
 * Reads a final transaction outcome into the summary the relayer returns. Pure.
 *
 * A relayed transaction's top-level status is SuccessValue("") even when the
 * inner call fails (the Delegate action returns no value and the status follows
 * only its own receipt), so success is decided from every receipt. And a bid
 * that Fairground refuses is refunded without any failure, which is why the
 * contract's events are returned too: only those of Fairground receipts that
 * succeeded, since a failed receipt keeps its logs while its state change is
 * undone (a `bid_placed` logged just before running out of gas placed nothing).
 */
import type { FairgroundEvent, OutcomeSummary, ReceiptFailure } from "./api.ts";
import type { TxOutcome } from "./chain.ts";

const EVENT_PREFIX = "EVENT_JSON:";

type ExecutionStatus = TxOutcome["receipts_outcome"][number]["outcome"]["status"];

export function summarizeOutcome(outcome: TxOutcome, fairground: string, deposits: bigint): OutcomeSummary {
  const all = [outcome.transaction_outcome, ...outcome.receipts_outcome];
  const failures: ReceiptFailure[] = all.flatMap(({ id, outcome: o }) =>
    isFailure(o.status) ? [{ receipt_id: id, executor_id: o.executor_id, error: o.status.Failure }] : [],
  );
  const events = outcome.receipts_outcome
    .filter(({ outcome: o }) => o.executor_id === fairground && isSuccess(o.status))
    .flatMap(({ outcome: o }) => o.logs.flatMap(fairgroundEvent));
  return { failures, events, relayer_cost: relayerCost(outcome, deposits).toString() };
}

function isFailure(status: ExecutionStatus): status is Extract<ExecutionStatus, { Failure: unknown }> {
  return typeof status === "object" && "Failure" in status;
}

function isSuccess(status: ExecutionStatus): boolean {
  return typeof status === "object" && ("SuccessValue" in status || "SuccessReceiptId" in status);
}

/**
 * What the transaction cost the relayer: tokens burnt by the transaction and
 * every receipt, plus the deposits it attached (paid even if a failed call
 * refunds them to the user).
 */
export function relayerCost(outcome: TxOutcome, deposits: bigint): bigint {
  const all = [outcome.transaction_outcome, ...outcome.receipts_outcome];
  return all.reduce((sum, { outcome: o }) => sum + BigInt(o.tokens_burnt), deposits);
}

/** A NEP-297 log line of the `fairground` standard, or nothing. */
function fairgroundEvent(log: string): FairgroundEvent[] {
  if (!log.startsWith(EVENT_PREFIX)) return [];
  try {
    const parsed: unknown = JSON.parse(log.slice(EVENT_PREFIX.length));
    if (typeof parsed !== "object" || parsed === null) return [];
    const { standard, event, data } = parsed as Record<string, unknown>;
    return standard === "fairground" && typeof event === "string" ? [{ event, data }] : [];
  } catch {
    return [];
  }
}
