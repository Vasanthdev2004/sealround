import {
  ONECLICK_BASE,
  UPSTREAM_TIMEOUT_MS,
  realSwapsOff,
  realSwapsOn,
  unreachable,
  upstreamHeaders,
} from "../upstream";
import { checkOneClickQuota } from "../quota";
import { receiptRequired, verifyReceipt } from "../receipt";
import { trackStatus, trackingError } from "../tracking";

/** Poll a deposit created by a simple origin-chain quote. */
export async function GET(request: Request) {
  if (!realSwapsOn()) return realSwapsOff();

  const depositAddress = new URL(request.url).searchParams.get("depositAddress");
  const receipt = verifyReceipt(request, depositAddress);
  if (!receipt) return receiptRequired();
  const throttled = await checkOneClickQuota(request, { live: true });
  if (throttled) return throttled;

  const url = new URL("/v0/status", ONECLICK_BASE);
  url.searchParams.set("depositAddress", receipt.address);
  try {
    const res = await fetch(url, {
      headers: upstreamHeaders(),
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!res.ok) return trackingError(res.status);
    const tracked = trackStatus(await res.json(), receipt);
    return tracked ? Response.json(tracked, { headers: { "cache-control": "no-store" } }) : trackingError(502);
  } catch {
    return unreachable();
  }
}
