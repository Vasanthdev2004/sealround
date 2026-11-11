import {
  ONECLICK_BASE,
  UPSTREAM_TIMEOUT_MS,
  badRequest,
  passThrough,
  realSwapsOff,
  realSwapsOn,
  unreachable,
  upstreamHeaders,
} from "../upstream";
import { isDepositAddress, isTxHashFor } from "../shared";

/**
 * POST /api/oneclick/submit -> 1Click POST /v0/deposit/submit.
 *
 * Tells 1Click the hash of the user's deposit so it looks for it sooner.
 * Optional for the swap. Only while real swaps are on (realSwapsOn), and only
 * for a deposit address on an origin chain this app offers with a tx hash of
 * the same chain's shape. Forwards exactly { txHash, depositAddress }.
 */
export async function POST(request: Request) {
  if (!realSwapsOn()) return realSwapsOff();

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return badRequest("Body must be JSON.");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return badRequest("Body must be a JSON object.");
  const b = raw as Record<string, unknown>;

  const depositAddress = typeof b.depositAddress === "string" ? b.depositAddress : "";
  const txHash = typeof b.txHash === "string" ? b.txHash : "";
  if (!isDepositAddress(depositAddress)) return badRequest("depositAddress is not a valid deposit address.");
  if (!isTxHashFor(depositAddress, txHash)) {
    return badRequest("txHash is not a transaction hash on the deposit address's chain.");
  }

  try {
    const res = await fetch(`${ONECLICK_BASE}/v0/deposit/submit`, {
      method: "POST",
      headers: upstreamHeaders(true),
      body: JSON.stringify({ txHash, depositAddress }),
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    return await passThrough(res);
  } catch {
    return unreachable();
  }
}
