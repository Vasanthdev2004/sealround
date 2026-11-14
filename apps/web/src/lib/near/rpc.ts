/**
 * The two NEAR JSON-RPC calls the app's reads need, over plain fetch: a
 * contract view and the chain head's time. near-api-js is not used here, so
 * reading a sale costs the bundle nothing; it is loaded only to sign with a
 * dev key on a sandbox (dev-signer.ts).
 *
 * Reads can go to several endpoints (NearConfig.rpcUrls). The free public
 * ones allow a short burst and then about three calls a second per visitor,
 * and a result page makes well over a hundred reads in its first seconds, so
 * one endpoint alone would refuse most of them. Each endpoint gets a small
 * allowance (BURST calls, refilled at PER_SECOND); reads go to the first
 * endpoint in the list that has allowance left and spill to the next when it
 * runs out. An endpoint that says it is busy, or does not answer, rests for a
 * while and the read moves straight on to the next one; only when every
 * endpoint has failed does the read wait and go round again. The allowance
 * and the rests are shared by every reader in this tab (or server process).
 */

import { FairgroundError, failureText } from "../client/errors";
import { appConfig, isNearMode } from "../config";

export type NearRpc = {
  /** Calls a view method and parses its JSON result. Throws a FairgroundError ("rpc_error") when the node or the contract refuses. */
  view<T>(contractId: string, method: string, args?: Record<string, unknown>): Promise<T>;
  /** The head block's timestamp in ms: the clock the contract's time rules use. */
  headTimeMs(): Promise<number>;
};

type RpcReply = {
  result?: { result?: number[]; error?: string; header?: { timestamp_nanosec?: string; timestamp?: number } };
  error?: { name?: string; message?: string; data?: unknown; cause?: { name?: string; info?: unknown } };
};

const utf8 = new TextEncoder();

function toBase64(text: string): string {
  let s = "";
  utf8.encode(text).forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s);
}

/** Looked up per call on the global object: a detached `window.fetch` throws "Illegal invocation" in some browsers. */
const globalFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

/** A node that said "not now": rate limited (429) or briefly unavailable (502, 503, 504). Worth asking again. */
class BusyNode extends Error {}

/**
 * Whether a failed request is worth sending again later: the node said it is
 * busy, or the request never got an answer. A browser reports a 429 from a
 * public RPC as a network error (TypeError), because the 429 carries no CORS
 * header, so a network error counts as busy too.
 */
const busy = (e: unknown): boolean => e instanceof BusyNode || e instanceof TypeError;

/** A request that ran out of time. It already waited, so it is not sent again. */
const timedOut = (e: unknown): boolean =>
  typeof e === "object" && e !== null && "name" in e && (e.name === "TimeoutError" || e.name === "AbortError");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Calls an endpoint takes at once before reads spill to the next one, and how
 * fast that allowance comes back, in calls a second. Below the public limits
 * (a burst of about 16, then 3 a second), because other readers in the page
 * (the attestation checks) spend the same visitor's budget on the first endpoint.
 */
const BURST = 8;
const PER_SECOND = 2;
/** First rest for an endpoint that failed; doubles with each failure in a row, up to MAX_REST_MS. */
const REST_MS = 1_000;
const MAX_REST_MS = 15_000;

type Health = { allowance: number; at: number; restUntil: number; strikes: number };

const health = new Map<string, Health>();

function healthOf(url: string, now: number): Health {
  let h = health.get(url);
  if (!h) {
    h = { allowance: BURST, at: now, restUntil: 0, strikes: 0 };
    health.set(url, h);
  }
  h.allowance = Math.min(BURST, h.allowance + ((now - h.at) / 1000) * PER_SECOND);
  h.at = now;
  return h;
}

/** Forgets every endpoint's allowance and rest. For tests. */
export function resetRpcHealth(): void {
  health.clear();
}

/**
 * The endpoints in the order to try them now: those with allowance left, in
 * list order; then those without, the one closest to having some first; then
 * those resting, the one that rests least long first.
 */
function ranked(urls: readonly string[], now: number): string[] {
  if (urls.length < 2) return [...urls];
  const rows = urls.map((url, i) => {
    const h = healthOf(url, now);
    const tier = h.restUntil > now ? 2 : h.allowance >= 1 ? 0 : 1;
    const within = tier === 0 ? i : tier === 1 ? -h.allowance : h.restUntil;
    return { url, i, tier, within };
  });
  rows.sort((a, b) => a.tier - b.tier || a.within - b.within || a.i - b.i);
  return rows.map((r) => r.url);
}

/**
 * The endpoints a reader built for `url` uses. A list is used as given. A
 * single URL that is the app's configured NEXT_PUBLIC_NEAR_RPC_URL stands for
 * the whole configured list, so every caller that passes `config.rpcUrl`
 * (the NEAR client, the share-card readers) gets the fallbacks too. Any other
 * single URL is used alone.
 */
export function rpcEndpoints(url: string | readonly string[]): string[] {
  if (typeof url !== "string") return [...new Set(url)];
  if (isNearMode()) {
    try {
      const c = appConfig();
      if (c.mode === "near" && c.near.rpcUrl === url && c.near.rpcUrls?.length) return [...c.near.rpcUrls];
    } catch {
      // An unusable config is reported where the app reads it.
    }
  }
  return [url];
}

/** A JSON-RPC error that is a rate limit in disguise (some providers answer 200 with one). */
function rateLimited(error: NonNullable<RpcReply["error"]>): boolean {
  const text = JSON.stringify(error);
  return !panicText(text) && /rate.?limit|too many requests/i.test(text);
}

/**
 * `url` is one endpoint or a list (see rpcEndpoints). `retries` (default 2)
 * is how many more times a read goes round the endpoints after every one of
 * them said busy or did not answer, after `retryDelayMs` (default 500), then
 * three times as long, each with up to half as much again at random so a
 * page's parallel reads do not come back at once. An endpoint that answers
 * with another HTTP error or an unreadable body is skipped for the next one
 * but does not earn another round. A timeout ends the read: it already waited.
 */
export function createRpc(
  url: string | readonly string[],
  opts: { fetch?: typeof fetch; timeoutMs?: number; retries?: number; retryDelayMs?: number } = {},
): NearRpc {
  const urls = rpcEndpoints(url);
  if (urls.length === 0) throw new Error("createRpc: no RPC URL");
  const fetchImpl = opts.fetch ?? globalFetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const retries = opts.retries ?? 2;
  const retryDelayMs = opts.retryDelayMs ?? 500;
  let nextId = 1;

  async function send(endpoint: string, method: string, params: unknown): Promise<RpcReply> {
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504) {
      throw new BusyNode(`HTTP ${res.status}`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const reply = (await res.json()) as RpcReply;
    if (reply.error && rateLimited(reply.error)) throw new BusyNode("rate limited");
    return reply;
  }

  const unreachable = (cause: unknown) =>
    new FairgroundError("rpc_error", "Could not reach the NEAR RPC node. Check your connection and try again.", { cause });

  async function reach(method: string, params: unknown): Promise<RpcReply> {
    let last: unknown = null;
    for (let round = 0; ; round++) {
      let anyBusy = false;
      for (const endpoint of ranked(urls, Date.now())) {
        const h = healthOf(endpoint, Date.now());
        h.allowance -= 1;
        try {
          const reply = await send(endpoint, method, params);
          h.strikes = 0;
          return reply;
        } catch (e) {
          last = e;
          h.strikes += 1;
          h.restUntil = Date.now() + Math.min(REST_MS * 2 ** (h.strikes - 1), MAX_REST_MS);
          h.allowance = Math.min(h.allowance, 0);
          if (timedOut(e)) throw unreachable(e);
          if (busy(e)) anyBusy = true;
        }
      }
      if (!anyBusy || round >= retries) throw unreachable(last);
      const wait = retryDelayMs * 3 ** round;
      await sleep(wait + Math.random() * wait * 0.5);
    }
  }

  async function call(method: string, params: unknown): Promise<NonNullable<RpcReply["result"]>> {
    const reply = await reach(method, params);
    if (reply.error) {
      // A view the contract refused (newer nodes report it here): keep the contract's own words.
      const panic = panicText(JSON.stringify(reply.error));
      if (panic) throw new FairgroundError("rpc_error", panic, { reason: "view_failed" });
      const cause = reply.error.cause?.name ?? reply.error.name ?? "error";
      const detail =
        typeof reply.error.data === "string" ? reply.error.data : (reply.error.message ?? failureText(reply.error));
      throw new FairgroundError("rpc_error", `The NEAR RPC node answered with an error (${cause}): ${detail}`, {
        reason: cause,
      });
    }
    if (!reply.result) throw new FairgroundError("rpc_error", "The NEAR RPC node sent an empty answer.");
    return reply.result;
  }

  return {
    async view<T>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
      const result = await call("query", {
        request_type: "call_function",
        finality: "optimistic",
        account_id: contractId,
        method_name: method,
        args_base64: toBase64(JSON.stringify(args)),
      });
      // Older nodes report a failed view inside `result`.
      if (typeof result.error === "string") {
        throw new FairgroundError("rpc_error", panicText(result.error) ?? result.error.slice(0, 300), {
          reason: "view_failed",
        });
      }
      const bytes = Uint8Array.from(result.result ?? []);
      const text = new TextDecoder().decode(bytes);
      try {
        return (text === "" ? null : JSON.parse(text)) as T;
      } catch (e) {
        throw new FairgroundError("rpc_error", `${contractId}.${method} did not return JSON.`, { cause: e });
      }
    },

    async headTimeMs(): Promise<number> {
      const block = await call("block", { finality: "optimistic" });
      const ns = block.header?.timestamp_nanosec ?? String(block.header?.timestamp ?? "0");
      return Number(BigInt(ns) / 1_000_000n);
    },
  };
}

/**
 * The contract's own words out of a failed view, or null when the text holds
 * no contract panic. Nodes report a panic in one of two shapes:
 * - `wasm execution failed with error: HostError(GuestPanic { panic_msg: "unknown sale" })`
 *   (what the public RPCs answer for a view today), and
 * - `... Smart contract panicked: unknown sale` (the shape of transaction failures).
 * The text may arrive JSON-escaped (`\"`), so quotes are matched either way.
 */
export function panicText(raw: string): string | null {
  const guest = /panic_msg: \\*"(.*?)\\*" ?\}/.exec(raw);
  if (guest) return guest[1].replace(/\\+"/g, '"').trim();
  const panic = /Smart contract panicked: ([^"\\]*)/.exec(raw);
  return panic ? panic[1].replace(/\)+$/, "").trim() : null;
}
