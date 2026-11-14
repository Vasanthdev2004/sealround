/**
 * The two NEAR JSON-RPC calls the app's reads need, over plain fetch: a
 * contract view and the chain head's time. near-api-js is not used here, so
 * reading a sale costs the bundle nothing; it is loaded only to sign with a
 * dev key on a sandbox (dev-signer.ts).
 */

import { FairgroundError, failureText } from "../client/errors";

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
 * Whether a failed request is worth sending again: the node said it is busy,
 * or the request never got an answer. A browser reports a 429 from a public
 * RPC as a network error (TypeError), because the 429 carries no CORS header,
 * so a network error is retried too. A timeout is not: it already waited.
 */
const retryable = (e: unknown): boolean => e instanceof BusyNode || e instanceof TypeError;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * `retries` (default 2) is how many times a busy or unreachable node is asked
 * again, after `retryDelayMs` (default 500), then three times as long, each
 * with up to half as much again at random so a page's parallel reads do not
 * come back at once. The public RPCs allow a short burst and then about
 * three calls a second per visitor; a page that reads a sale makes a few
 * dozen, so without this the later ones fail.
 */
export function createRpc(
  url: string,
  opts: { fetch?: typeof fetch; timeoutMs?: number; retries?: number; retryDelayMs?: number } = {},
): NearRpc {
  const fetchImpl = opts.fetch ?? globalFetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const retries = opts.retries ?? 2;
  const retryDelayMs = opts.retryDelayMs ?? 500;
  let nextId = 1;

  async function call(method: string, params: unknown): Promise<NonNullable<RpcReply["result"]>> {
    let reply: RpcReply;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504) {
          throw new BusyNode(`HTTP ${res.status}`);
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        reply = (await res.json()) as RpcReply;
        break;
      } catch (e) {
        if (attempt < retries && retryable(e)) {
          const wait = retryDelayMs * 3 ** attempt;
          await sleep(wait + Math.random() * wait * 0.5);
          continue;
        }
        throw new FairgroundError("rpc_error", "Could not reach the NEAR RPC node. Check your connection and try again.", {
          cause: e,
        });
      }
    }
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
