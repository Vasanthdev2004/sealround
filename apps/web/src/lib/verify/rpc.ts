/**
 * Read-only NEAR JSON-RPC for the checks: a client that asks a busy node
 * again after a pause and moves to the next node when one refuses, view
 * calls, and the two account queries the contract checks need (its code hash
 * and its access keys). Nothing is signed or sent.
 */

/** Looked up per call on the global object: a detached `window.fetch` throws "Illegal invocation" in some browsers. */
const globalFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

const utf8 = new TextEncoder();
function toBase64(text: string): string {
  let s = "";
  utf8.encode(text).forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s);
}

export type JsonRpc = <T>(method: string, params: unknown) => Promise<T>;

/** A node that said "not now": rate limited (429) or briefly unavailable (502, 503, 504). Worth asking again. */
class BusyNode extends Error {}

/**
 * Worth sending again to the same node: it said it is busy, or the request
 * got no answer. A browser reports a 429 from a public RPC as a network error
 * (TypeError), because the 429 carries no CORS header. A timeout is not
 * retried: it already waited. Same rule as lib/near/rpc.ts.
 */
const retryable = (e: unknown): boolean => e instanceof BusyNode || e instanceof TypeError;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type JsonRpcOptions = {
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Times a busy or unreachable node is asked again before the next URL (default 2). */
  retries?: number;
  /** First wait before asking again, then three times as long, plus up to half again at random (default 500 ms). */
  retryDelayMs?: number;
  /** Requests in flight at once (default 4). The public RPCs allow a short burst, then about three calls a second per visitor. */
  concurrency?: number;
};

/**
 * JSON-RPC over fetch. A busy node (429, 502, 503, 504, or no answer) is asked
 * again after a pause, as lib/near/rpc.ts does; a node that refuses (an RPC
 * error, such as a block or transaction pruned there) passes the call to the
 * next URL. Throws the last error. At most `concurrency` requests are in
 * flight, so a page of checks does not spend the node's burst at once.
 */
export function jsonRpc(urls: string[], opts: JsonRpcOptions = {}): JsonRpc {
  const fetchImpl = opts.fetch ?? globalFetch;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const retries = opts.retries ?? 2;
  const retryDelayMs = opts.retryDelayMs ?? 500;
  const limit = Math.max(1, opts.concurrency ?? 4);
  let id = 1;
  let active = 0;
  const queue: (() => void)[] = [];
  const acquire = () => (active < limit ? (active++, Promise.resolve()) : new Promise<void>((r) => queue.push(r)));
  const release = () => {
    const next = queue.shift();
    if (next) next();
    else active--;
  };

  const once = async <T>(url: string, method: string, params: unknown): Promise<T> => {
    await acquire();
    let res: Response;
    let text: string;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504) throw new BusyNode(`${method}: HTTP ${res.status}`);
      if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
      text = await res.text();
    } finally {
      release();
    }
    const reply = JSON.parse(text) as { result?: T; error?: { cause?: { name?: string }; name?: string; data?: unknown; message?: string } };
    if (reply.error) {
      const e = reply.error;
      const detail = typeof e.data === "string" ? e.data : (e.message ?? "");
      throw new Error(`${method}: ${e.cause?.name ?? e.name ?? "error"} ${detail}`.trim());
    }
    if (reply.result === undefined) throw new Error(`${method}: empty answer`);
    return reply.result;
  };

  // A busy URL hands the call to the next one at once; only when every URL in
  // a round was busy does the call wait and go round again (up to `retries`
  // more rounds). A refusal (an RPC error, such as history a regular node no
  // longer keeps) goes straight to the last URL, the archival node, since the
  // other regular nodes would refuse it too.
  const lastIndex = urls.length - 1;
  return async <T>(method: string, params: unknown): Promise<T> => {
    let last: unknown = new Error("no RPC URL");
    for (let round = 0; round <= retries; round++) {
      let busy = false;
      for (let i = 0; i < urls.length; i++) {
        try {
          return await once<T>(urls[i], method, params);
        } catch (e) {
          last = e;
          if (retryable(e)) {
            busy = true;
            continue;
          }
          if (i >= lastIndex) throw e instanceof Error ? e : new Error(String(e));
          i = lastIndex - 1;
        }
      }
      if (!busy || round === retries) break;
      const wait = retryDelayMs * 3 ** round;
      await sleep(wait + Math.random() * wait * 0.5);
    }
    throw last instanceof Error ? last : new Error(String(last));
  };
}

/** A view call (finality final), its JSON result parsed. */
export async function viewCall<T>(rpc: JsonRpc, account: string, method: string, args: Record<string, unknown>): Promise<T> {
  const r = await rpc<{ result?: number[]; error?: string }>("query", {
    request_type: "call_function",
    finality: "final",
    account_id: account,
    method_name: method,
    args_base64: toBase64(JSON.stringify(args)),
  });
  if (typeof r.error === "string") throw new Error(`${account}.${method}: ${r.error.slice(0, 200)}`);
  const text = new TextDecoder().decode(Uint8Array.from(r.result ?? []));
  return (text === "" ? null : JSON.parse(text)) as T;
}

/** view_account: the account's code hash (base58 sha256 of its wasm; all 1s when it has none). */
export type AccountView = { code_hash: string; amount: string; storage_usage: number; block_height: number };

export function viewAccount(rpc: JsonRpc, account: string): Promise<AccountView> {
  return rpc<AccountView>("query", { request_type: "view_account", finality: "final", account_id: account });
}

/** One access key as view_access_key_list prints it. */
export type AccessKeyView = {
  public_key: string;
  access_key: { nonce: number; permission: "FullAccess" | { FunctionCall: { receiver_id: string; method_names: string[]; allowance: string | null } } };
};

export async function accessKeys(rpc: JsonRpc, account: string): Promise<{ keys: AccessKeyView[]; blockHeight: number }> {
  const r = await rpc<{ keys: AccessKeyView[]; block_height: number }>("query", {
    request_type: "view_access_key_list",
    finality: "final",
    account_id: account,
  });
  return { keys: r.keys ?? [], blockHeight: r.block_height };
}
