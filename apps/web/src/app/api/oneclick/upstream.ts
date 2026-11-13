/**
 * Server-only helpers for the 1Click proxy routes. Not a route itself.
 * ONECLICK_JWT (optional) is read here and sent as a Bearer token. It never
 * reaches the browser: only these route handlers import this file.
 *
 * ONECLICK_REAL_SWAPS is the server switch for deposit quotes and status.
 */

import { parseConfig, type AppConfig } from "@/lib/config";
import { oneClickSharedQuotaConfigured } from "./quota";
import { receiptSigningConfigured } from "./receipt";
import { realSwapsAllowed } from "./shared";

export const ONECLICK_BASE = "https://1click.chaindefuser.com";

/** Upstream timeout. 1Click quotes usually return in under 3 seconds. */
export const UPSTREAM_TIMEOUT_MS = 15_000;

export function upstreamHeaders(json = false): Record<string, string> {
  const h: Record<string, string> = { accept: "application/json" };
  if (json) h["content-type"] = "application/json";
  const jwt = process.env.ONECLICK_JWT;
  if (jwt && oneClickSharedQuotaConfigured()) h.authorization = `Bearer ${jwt}`;
  return h;
}

/** Pass an upstream response through with its status, never cached. */
export async function passThrough(res: Response, cacheControl = "no-store"): Promise<Response> {
  const body = await res.text();
  return new Response(body || null, {
    status: res.status,
    headers: {
      "content-type": "application/json",
      "x-content-type-options": "nosniff",
      "cache-control": cacheControl,
    },
  });
}

export function unreachable(): Response {
  return Response.json(
    { message: "1Click is unreachable from the server right now." },
    { status: 502, headers: { "cache-control": "no-store" } },
  );
}

/** A request this proxy refuses to forward. */
export function badRequest(message: string): Response {
  return Response.json({ message }, { status: 400, headers: { "cache-control": "no-store" } });
}

// ---------- the real-swap switch ----------

/**
 * True only when this server may start and track real swaps: NEAR mode on
 * mainnet, paying in Circle's USDC, with the live switch, receipt signing and
 * shared quotas configured. The config route reports the decision to the browser.
 */
export function realSwapsOn(): boolean {
  if (!receiptSigningConfigured() || !oneClickSharedQuotaConfigured()) return false;
  let config: AppConfig;
  try {
    config = parseConfig({
      NEXT_PUBLIC_FAIRGROUND_CONTRACT: process.env.NEXT_PUBLIC_FAIRGROUND_CONTRACT,
      NEXT_PUBLIC_NEAR_NETWORK: process.env.NEXT_PUBLIC_NEAR_NETWORK,
      NEXT_PUBLIC_NEAR_RPC_URL: process.env.NEXT_PUBLIC_NEAR_RPC_URL,
      NEXT_PUBLIC_USDC_CONTRACT: process.env.NEXT_PUBLIC_USDC_CONTRACT,
      NEXT_PUBLIC_RELAYER_URL: process.env.NEXT_PUBLIC_RELAYER_URL,
      NEXT_PUBLIC_SEALER_CODE_HASH: process.env.NEXT_PUBLIC_SEALER_CODE_HASH,
    });
  } catch {
    return false;
  }
  return realSwapsAllowed(config, process.env.ONECLICK_REAL_SWAPS);
}

export const REAL_SWAPS_OFF_MESSAGE =
  "Real 1Click swaps are off on this server. It only gives dry quotes, which never create a deposit address.";

/** 403 for a real-swap request while the switch is off. */
export function realSwapsOff(): Response {
  return Response.json(
    { message: REAL_SWAPS_OFF_MESSAGE, code: "real_swaps_off" },
    { status: 403, headers: { "cache-control": "no-store" } },
  );
}
