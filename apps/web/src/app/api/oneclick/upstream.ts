/**
 * Server-only helpers for the 1Click proxy routes. Not a route itself.
 * ONECLICK_JWT (optional) is read here and sent as a Bearer token. It never
 * reaches the browser: only these route handlers import this file.
 */

export const ONECLICK_BASE = "https://1click.chaindefuser.com";

/** Upstream timeout. 1Click quotes usually return in under 3 seconds. */
export const UPSTREAM_TIMEOUT_MS = 15_000;

export function upstreamHeaders(json = false): Record<string, string> {
  const h: Record<string, string> = { accept: "application/json" };
  if (json) h["content-type"] = "application/json";
  const jwt = process.env.ONECLICK_JWT;
  if (jwt) h.authorization = `Bearer ${jwt}`;
  return h;
}

/** Pass an upstream response through with its status, never cached. */
export async function passThrough(res: Response, cacheControl = "no-store"): Promise<Response> {
  const body = await res.text();
  return new Response(body, {
    status: res.status,
    headers: {
      "content-type": res.headers.get("content-type") ?? "application/json",
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
