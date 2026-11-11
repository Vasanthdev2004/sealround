/**
 * Structured request logs. `LogLine` lists every field a line may carry: there
 * is no field for request bodies, delegate args, ciphertexts, keys or IPs, so
 * none of them can be logged by accident.
 */
import type { RejectionReason, RelayStatus } from "./api.ts";

export interface LogLine {
  request_id: string;
  endpoint: string;
  decision: "relayed" | "registered" | "already_registered" | "rejected" | "error";
  reason?: RejectionReason;
  /**
   * The delegate's sender, set only once its own key and a fresh nonce are proven
   * (a forgery naming someone is not logged as them), or the account being
   * registered. Public on chain anyway.
   */
  account?: string;
  tx_hash?: string;
  status?: RelayStatus;
  /** yoctoNEAR the relayer paid, when known. */
  cost?: string;
  /** Error class and message for unexpected failures (never a request body). */
  error?: string;
  ms: number;
}

export type Logger = (line: LogLine) => void;

/** One JSON object per line on stdout. */
export const jsonLogger: Logger = (line) => {
  console.log(JSON.stringify({ time: new Date().toISOString(), ...line }));
};

/** Class and first 200 characters of an error's message. */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return "non-error thrown";
  return `${error.name}: ${error.message}`.slice(0, 200);
}
