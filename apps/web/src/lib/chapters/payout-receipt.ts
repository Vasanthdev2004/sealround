import { fromB64 } from "../crypto";
import type { RpcAction, RpcOutcome, RpcReceipt, RpcTransaction } from "../near/attestation";
import { base58Decode } from "../verify/base58";
import { jsonRpc } from "../verify/rpc";
import type { ChapterSandbox } from "./sandbox";
import type { ChapterCheck, ChapterPayout } from "./verification";

const RECEIPT_CHANGED = "sealround:chapter-payout-receipt";

function hash32(value: string) {
  return typeof value === "string" && value.length >= 32 && value.length <= 44 && base58Decode(value)?.length === 32;
}

function receiptKey(sandbox: ChapterSandbox, roundId: number) {
  const scope = sandbox.network === "testnet" ? "testnet" : sandbox.rpcUrl;
  return `${RECEIPT_CHANGED}:${scope}:${sandbox.contract}:${roundId}`;
}

/** This caches the public transaction locator. The receipt check still queries the chain. */
export function savePayoutReceipt(sandbox: ChapterSandbox, roundId: number, hash: string | null) {
  if (!sandbox.rpcUrl || !hash || !hash32(hash)) return;
  try {
    localStorage.setItem(receiptKey(sandbox, roundId), hash);
    window.dispatchEvent(new Event(RECEIPT_CHANGED));
  } catch {
    // Anyone can enter the public transaction hash when storage is blocked.
  }
}

export function readPayoutReceipt(sandbox: ChapterSandbox, roundId: number) {
  try {
    const hash = localStorage.getItem(receiptKey(sandbox, roundId));
    return hash && hash32(hash) ? hash : null;
  } catch {
    return null;
  }
}

export function subscribePayoutReceipt(listener: () => void) {
  window.addEventListener(RECEIPT_CHANGED, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(RECEIPT_CHANGED, listener);
    window.removeEventListener("storage", listener);
  };
}

type Outcome = RpcOutcome & { outcome: { receipt_ids: string[] } };
type Receipt = RpcReceipt & {
  receipt: { Action?: { input_data_ids: string[]; output_data_receivers: { data_id: string; receiver_id: string }[] } };
};

type PayoutTx = {
  final_execution_status?: string;
  status?: { SuccessValue?: string };
  transaction?: RpcTransaction;
  transaction_outcome?: Outcome;
  receipts?: Receipt[];
  receipts_outcome?: Outcome[];
};

type TransferEvidence = {
  transactionHash: string;
  claimReceiptId: string;
  transferReceiptId: string;
  transferBlockHash: string;
  callbackReceiptId: string;
  callbackBlockHash: string;
  attempt: number;
  memo: string;
};

export function payoutReceiptResult(status: ChapterCheck["status"], message: string, evidence: TransferEvidence | null = null) {
  return { check: { status, message }, evidence };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function callArgs(actions: RpcAction[] | undefined, method: string, deposit: string) {
  if (!Array.isArray(actions) || actions.length !== 1) return;
  const call = record(record(actions[0])?.FunctionCall);
  if (call?.method_name !== method || call.deposit !== deposit || typeof call.args !== "string" || call.args.length > 1024) return;
  try {
    return record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fromB64(call.args))));
  } catch {
    return undefined;
  }
}

function eventRows(outcome: Outcome["outcome"], standard: string, event: string) {
  return (Array.isArray(outcome.logs) ? outcome.logs : []).flatMap((log) => {
    if (typeof log !== "string" || !log.startsWith("EVENT_JSON:")) return [];
    try {
      const parsed = record(JSON.parse(log.slice("EVENT_JSON:".length)));
      return parsed?.standard === standard && parsed.version === "1.0.0" && parsed.event === event && Array.isArray(parsed.data)
        ? parsed.data.flatMap((row) => {
          const value = record(row);
          return value ? [value] : [];
        }) : [];
    } catch {
      return [];
    }
  });
}

/** Verify the actual FT receipt and its promise callback in the finalized claim transaction. */
function checkReceipts(tx: PayoutTx, hash: string, contract: string, roundId: number, payout: ChapterPayout) {
  if (tx.final_execution_status !== "FINAL") {
    return payoutReceiptResult("pending", "The transaction or its receipts are awaiting finality.");
  }
  const { transaction, transaction_outcome: root } = tx;
  if (!transaction || !root || !Array.isArray(tx.receipts) || tx.receipts.length === 0
    || !Array.isArray(tx.receipts_outcome) || tx.receipts_outcome.length === 0) {
    return payoutReceiptResult("unavailable", "The RPC did not return the transaction’s receipt records.");
  }
  if (transaction.hash !== hash || transaction.signer_id !== payout.recipient || transaction.receiver_id !== contract
    || callArgs(transaction.actions, "claim_bounty", "1")?.round_id !== roundId || tx.status?.SuccessValue !== btoa("true")) {
    return payoutReceiptResult("failed", "This transaction is not the successful payout claim for this chapter and recipient.");
  }

  const claimId = record(root.outcome?.status)?.SuccessReceiptId;
  const claim = tx.receipts_outcome.find((row) => row?.id === claimId);
  const callbackId = record(claim?.outcome?.status)?.SuccessReceiptId;
  const callback = tx.receipts_outcome.find((row) => row?.id === callbackId);
  if (root.id !== hash || root.outcome?.executor_id !== payout.recipient || typeof claimId !== "string" || !hash32(claimId)
    || !root.outcome.receipt_ids?.includes(claimId) || !claim?.outcome || claim.outcome.executor_id !== contract
    || typeof callbackId !== "string" || !hash32(callbackId) || !claim.outcome.receipt_ids?.includes(callbackId)
    || !callback?.outcome || callback.outcome.executor_id !== contract || record(callback.outcome.status)?.SuccessValue !== btoa("true")) {
    return payoutReceiptResult("failed", "The claim and successful Chapters callback are missing their expected receipt links.");
  }

  const callbackReceipt = tx.receipts.find((row) => row?.receipt_id === callbackId);
  const callbackAction = callbackReceipt?.receipt?.Action;
  const callbackArgs = callArgs(callbackAction?.actions, "on_claim_bounty", "0");
  const payment = eventRows(callback.outcome, "sealround_chapters", "bounty_payment");
  if (callbackReceipt?.predecessor_id !== contract || callbackReceipt.receiver_id !== contract
    || callbackArgs?.round_id !== roundId || callbackArgs.attempt !== payout.attempt
    || payment.length !== 1 || !payment.some((row) => row.round_id === roundId && row.attempt === payout.attempt
      && row.account === payout.recipient && row.token_id === payout.token_id && row.amount === payout.amount
      && row.paid === true && row.paid_at === payout.paid_at)) {
    return payoutReceiptResult("failed", "The callback differs from this chapter’s recorded payout attempt.");
  }

  const memo = `Sealround chapter ${roundId} payout ${payout.attempt}`;
  const transfers = tx.receipts.filter((row) => row?.receiver_id === payout.token_id
    && claim.outcome.receipt_ids.includes(row.receipt_id));
  const [transfer] = transfers;
  const tokenAction = transfer?.receipt?.Action;
  const tokenArgs = callArgs(tokenAction?.actions, "ft_transfer", "1");
  const tokenOutcome = tx.receipts_outcome.find((row) => row?.id === transfer?.receipt_id);
  const [dependency] = callbackAction?.input_data_ids ?? [];
  const [output] = tokenAction?.output_data_receivers ?? [];
  if (transfers.length !== 1 || !transfer || !hash32(transfer.receipt_id) || transfer.predecessor_id !== contract
    || tokenArgs?.receiver_id !== payout.recipient || tokenArgs.amount !== payout.amount || tokenArgs.memo !== memo
    || !dependency || callbackAction?.input_data_ids.length !== 1 || tokenAction?.output_data_receivers.length !== 1
    || output?.data_id !== dependency || output.receiver_id !== contract
    || !tokenOutcome?.outcome || tokenOutcome.outcome.executor_id !== payout.token_id
    || typeof record(tokenOutcome.outcome.status)?.SuccessValue !== "string") {
    return payoutReceiptResult("failed", "The claim is missing its linked, successful token transfer to the recorded recipient.");
  }

  const events = eventRows(tokenOutcome.outcome, "nep141", "ft_transfer");
  if (events.length !== 1 || !events.some((row) => row.old_owner_id === contract && row.new_owner_id === payout.recipient
    && row.amount === payout.amount && row.memo === memo)) {
    return payoutReceiptResult("failed", "The token transfer event differs from this chapter’s sender, recipient, amount or payout memo.");
  }
  if (!hash32(tokenOutcome.block_hash) || !hash32(callback.block_hash)) {
    return payoutReceiptResult("unavailable", "The RPC did not return the receipt block hashes.");
  }
  return payoutReceiptResult("passed", "The finalized token receipt matches the payout and is linked to the chapter’s successful callback.", {
    transactionHash: hash,
    claimReceiptId: claimId,
    transferReceiptId: transfer.receipt_id,
    transferBlockHash: tokenOutcome.block_hash,
    callbackReceiptId: callbackId,
    callbackBlockHash: callback.block_hash,
    attempt: payout.attempt,
    memo,
  });
}

export async function verifyPayoutReceipt(sandbox: ChapterSandbox, roundId: number, payout: ChapterPayout, hash: string, fetchImpl?: typeof fetch) {
  if (!hash) return payoutReceiptResult("pending", "Enter the payout transaction hash to check the token receipt.");
  if (!hash32(hash)) return payoutReceiptResult("failed", "Enter a valid NEAR transaction hash.");
  const endpoints = [...new Set([...(sandbox.rpcUrl ? [sandbox.rpcUrl] : []), ...(sandbox.rpcUrls ?? [])])];
  if (endpoints.length === 0) return payoutReceiptResult("unavailable", "No RPC endpoint is configured for receipt lookup.");
  const params = { tx_hash: hash, sender_account_id: payout.recipient };
  let pending: ReturnType<typeof payoutReceiptResult> | undefined;
  let incomplete: ReturnType<typeof payoutReceiptResult> | undefined;
  let unknown = 0;
  for (const endpoint of endpoints) {
    const rpc = jsonRpc([endpoint], { fetch: fetchImpl, timeoutMs: 12_000, retries: 0 });
    let method = sandbox.network === "testnet" ? "tx_status" : "EXPERIMENTAL_tx_status";
    try {
      // A non-blocking lookup gives receipt-capable nodes a chance to report an unknown hash.
      const lookup = () => rpc<PayoutTx>(method, { ...params, wait_until: "NONE" });
      const tx = await lookup().catch((problem: unknown) => {
        if (method !== "tx_status" || !(problem instanceof Error) || !/method[\s_-]*not[\s_-]*found/i.test(problem.message)) throw problem;
        method = "EXPERIMENTAL_tx_status";
        return lookup();
      });
      const final = tx?.final_execution_status === "FINAL" ? tx
        : await rpc<PayoutTx>(method, { ...params, wait_until: "FINAL" });
      if (!final || typeof final.final_execution_status !== "string") continue;
      const result = checkReceipts(final, hash, sandbox.contract, roundId, payout);
      if (result.check.status === "pending") pending = result;
      else if (result.check.status === "unavailable") incomplete = result;
      else return result;
    } catch (problem) {
      if (problem instanceof Error && problem.message.includes("UNKNOWN_TRANSACTION")) unknown += 1;
    }
  }
  if (pending) return pending;
  if (incomplete) return incomplete;
  if (unknown === endpoints.length) return payoutReceiptResult("unavailable", "The RPC could not find this hash for the payout recipient. Check the hash or ask the claimant for their verification link.");
  return payoutReceiptResult("unavailable", "The configured RPC endpoints could not read the finalized transaction receipts. Try again shortly.");
}
