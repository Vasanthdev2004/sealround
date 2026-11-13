import {
  ONECLICK_BASE,
  UPSTREAM_TIMEOUT_MS,
  badRequest,
  realSwapsOff,
  realSwapsOn,
  unreachable,
  upstreamHeaders,
} from "../upstream";
import { isTxHashOf } from "../shared";
import { checkOneClickQuota } from "../quota";
import { receiptRequired, verifyReceipt } from "../receipt";
import { trackStatus, trackingError, trackingMismatch } from "../tracking";

/**
 * POST /api/oneclick/submit -> 1Click POST /v0/deposit/submit.
 *
 * Tells 1Click the hash of the user's deposit so it looks for it sooner.
 * Optional for the swap. Only while real swaps are on (realSwapsOn), and only
 * for a receipt the server signed with a tx hash of the same chain's shape.
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

  const receipt = verifyReceipt(request, b.depositAddress);
  if (!receipt) return receiptRequired();
  const txHash = typeof b.txHash === "string" ? b.txHash : "";
  if (!isTxHashOf(receipt.kind, txHash)) {
    return badRequest("txHash is not a transaction hash on the deposit address's chain.");
  }
  const throttled = await checkOneClickQuota(request, { live: true });
  if (throttled) return throttled;

  try {
    const res = await fetch(`${ONECLICK_BASE}/v0/deposit/submit`, {
      method: "POST",
      headers: upstreamHeaders(true),
      body: JSON.stringify({ txHash, depositAddress: receipt.address }),
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!res.ok) return trackingError(res.status);
    const data: unknown = await res.json().catch(() => null);
    if (trackingMismatch(data, receipt)) return trackingError(502);
    const tracked = trackStatus(data, receipt);
    const headers = { "cache-control": "no-store" };
    return tracked ? Response.json(tracked, { headers }) : new Response(null, { status: 204, headers });
  } catch {
    return unreachable();
  }
}
