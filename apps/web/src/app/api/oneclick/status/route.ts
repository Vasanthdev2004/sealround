import { isDepositAddress } from "../shared";
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

/** Poll a deposit created by a simple origin-chain quote. */
export async function GET(request: Request) {
  if (!realSwapsOn()) return realSwapsOff();

  const depositAddress = new URL(request.url).searchParams.get("depositAddress");
  if (!depositAddress || !isDepositAddress(depositAddress)) return badRequest("depositAddress is not valid.");

  const url = new URL("/v0/status", ONECLICK_BASE);
  url.searchParams.set("depositAddress", depositAddress);
  try {
    const res = await fetch(url, {
      headers: upstreamHeaders(),
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    return await passThrough(res);
  } catch {
    return unreachable();
  }
}
