import { summarizeOutcome } from "@fairground/relayer-client";
import { failureText } from "../client/errors";
import { base58Decode } from "../verify/base58";
import type { ChapterNetwork } from "./wallet";

export function chapterTransactionHash(result: unknown, outcome = summarizeOutcome(result, "")): string | null {
  const hash = outcome.txHash ?? (typeof result === "string" ? result
    : result && typeof result === "object" && "transactionHash" in result ? result.transactionHash : null);
  return typeof hash === "string" && hash.length >= 32 && hash.length <= 44 && base58Decode(hash)?.length === 32 ? hash : null;
}

export function chapterFailure(problem: unknown): Error {
  return problem instanceof Error ? problem : new Error(failureText(problem));
}

/** A wallet result may arrive before an async callback or the configured RPC's view has caught up. */
export async function confirmChapterChange<T>(
  network: ChapterNetwork, read: () => Promise<T | null>, problem?: unknown,
): Promise<T | null> {
  const delays = network === "testnet" && !problem ? [0, 500, 1000, 1500, 2000, 3000] : [0];
  for (const delay of delays) {
    if (delay) await new Promise<void>((resolve) => setTimeout(resolve, delay));
    const result = await read().catch(() => null);
    if (result !== null) return result;
  }
  if (problem) throw chapterFailure(problem);
  return null;
}
