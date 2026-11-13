import { connection } from "next/server";
import { checkOneClickQuota } from "../quota";
import { ONECLICK_BASE, UPSTREAM_TIMEOUT_MS, passThrough, unreachable, upstreamHeaders } from "../upstream";

/**
 * GET /api/oneclick/tokens -> 1Click GET /v0/tokens.
 * Request-time only (prices move), with a short browser cache.
 */
export async function GET(request: Request) {
  await connection();
  const throttled = await checkOneClickQuota(request);
  if (throttled) return throttled;
  try {
    const res = await fetch(`${ONECLICK_BASE}/v0/tokens`, {
      headers: upstreamHeaders(),
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    return passThrough(res, res.ok ? "private, max-age=60" : "no-store");
  } catch {
    return unreachable();
  }
}
