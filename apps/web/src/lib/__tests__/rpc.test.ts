/** The JSON-RPC reader (near/rpc.ts) against canned node answers, in the shapes real nodes send. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FairgroundError } from "../client/errors";
import { createRpc, panicText, resetRpcHealth, rpcEndpoints } from "../near/rpc";

type Call = { method: string; params: Record<string, unknown> };

/** A fetch that answers every JSON-RPC call with `reply(call)`. */
function node(reply: (call: Call) => unknown, status = 200) {
  const calls: Call[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Call & { id: number };
    calls.push({ method: body.method, params: body.params });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...(reply(body) as object) }), { status });
  }) as typeof fetch;
  return { calls, rpc: createRpc("http://127.0.0.1:3030", { fetch: fetchImpl, retryDelayMs: 0 }) };
}

const bytes = (value: unknown) => Array.from(new TextEncoder().encode(JSON.stringify(value)));

async function failure(p: Promise<unknown>): Promise<FairgroundError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof FairgroundError) return e;
    throw e;
  }
  throw new Error("expected the call to fail");
}

describe("view calls", () => {
  it("send a call_function query and decode the JSON result", async () => {
    const { rpc, calls } = node(() => ({ result: { result: bytes({ sale_id: "fairt", bid_count: 3 }), logs: [] } }));
    expect(await rpc.view("fairground.testnet", "get_sale", { sale_id: "fairt" })).toEqual({ sale_id: "fairt", bid_count: 3 });
    expect(calls).toEqual([
      {
        method: "query",
        params: {
          request_type: "call_function",
          finality: "optimistic",
          account_id: "fairground.testnet",
          method_name: "get_sale",
          args_base64: btoa('{"sale_id":"fairt"}'),
        },
      },
    ]);
  });

  it("decode null, strings and non-ASCII text", async () => {
    expect(await node(() => ({ result: { result: bytes(null) } })).rpc.view("c.near", "get_sale")).toBeNull();
    expect(await node(() => ({ result: { result: bytes("72000000") } })).rpc.view("c.near", "ft_balance_of")).toBe("72000000");
    expect(await node(() => ({ result: { result: bytes({ name: "Café ☕" }) } })).rpc.view("c.near", "m")).toEqual({ name: "Café ☕" });
    // Arguments are UTF-8 before base64.
    const { rpc, calls } = node(() => ({ result: { result: bytes(1) } }));
    await rpc.view("c.near", "m", { text: "é" });
    expect(atob(String(calls[0].params.args_base64))).toBe('{"text":"Ã©"}');
  });

  it("keep the contract's words when a view panics, in either shape nodes use", async () => {
    // Public RPCs today: the failure is inside `result`.
    const inResult = node(() => ({
      result: {
        error:
          'wasm execution failed with error: HostError(GuestPanic { panic_msg: "invalid min_deposit: must satisfy 1 USDC (1000000) <= min_deposit <= max_deposit_per_account" })',
        logs: [],
      },
    }));
    const a = await failure(inResult.rpc.view("fairground.testnet", "get_create_cost", { params: {} }));
    expect(a).toMatchObject({ code: "rpc_error", reason: "view_failed" });
    expect(a.message).toBe("invalid min_deposit: must satisfy 1 USDC (1000000) <= min_deposit <= max_deposit_per_account");

    // Newer nodes: a top-level error.
    const topLevel = node(() => ({
      error: {
        name: "HANDLER_ERROR",
        cause: { name: "CONTRACT_EXECUTION_ERROR", info: { vm_error: { HostError: { GuestPanic: { panic_msg: "unknown sale" } } } } },
        data: 'wasm execution failed with error: HostError(GuestPanic { panic_msg: "unknown sale" })',
      },
    }));
    expect(await failure(topLevel.rpc.view("fairground.testnet", "get_close_deposit", { sale_id: "x" }))).toMatchObject({
      code: "rpc_error",
      reason: "view_failed",
      message: "unknown sale",
    });
  });

  it("report node errors and unreachable nodes as rpc_error", async () => {
    const unknown = node(() => ({
      error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" }, data: "account nope.testnet does not exist while viewing" },
    }));
    const a = await failure(unknown.rpc.view("nope.testnet", "x"));
    expect(a).toMatchObject({ code: "rpc_error", reason: "UNKNOWN_ACCOUNT" });
    expect(a.message).toMatch(/nope\.testnet does not exist/);

    expect(await failure(node(() => ({}), 502).rpc.view("c.near", "m"))).toMatchObject({ code: "rpc_error" });
    expect(await failure(node(() => ({})).rpc.view("c.near", "m"))).toMatchObject({ message: "The NEAR RPC node sent an empty answer." });
    const down = createRpc("http://127.0.0.1:1", {
      retryDelayMs: 0,
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    expect((await failure(down.view("c.near", "m"))).message).toMatch(/Could not reach the NEAR RPC node/);
    expect(await failure(node(() => ({ result: { result: Array.from(new TextEncoder().encode("not json")) } })).rpc.view("c.near", "m"))).toMatchObject({
      code: "rpc_error",
    });
  });
});

describe("a busy or unreachable node", () => {
  const ok = (id: number) =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { result: bytes("20000"), logs: [] } }), { status: 200 });
  // What FastNear's public RPC sends past its rate limit.
  const limited = (id: number) =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -429, message: "Rate limits exceeded." } }), { status: 429 });

  /** A fetch that plays `steps` in order, one per call. */
  function script(steps: ((id: number, init?: RequestInit) => Response | Promise<Response>)[]) {
    let n = 0;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const id = (JSON.parse(String(init?.body)) as { id: number }).id;
      const step = steps[Math.min(n++, steps.length - 1)];
      return step(id, init);
    }) as typeof fetch;
    return { fetchImpl, count: () => n };
  }
  const networkError = () => {
    // How a browser reports a 429 without a CORS header, and how Node reports a refused connection.
    throw new TypeError("Failed to fetch");
  };

  it("asks again after a 429, 502, 503 or 504 and returns the answer", async () => {
    for (const status of [429, 502, 503, 504]) {
      const busy = (id: number) => (status === 429 ? limited(id) : new Response("busy", { status }));
      const s = script([busy, ok]);
      const rpc = createRpc("http://rpc", { fetch: s.fetchImpl, retryDelayMs: 0 });
      expect(await rpc.view("token.testnet", "ft_total_supply")).toBe("20000");
      expect(s.count()).toBe(2);
    }
  });

  it("asks again after a network error, which is how a browser sees a rate-limited public RPC", async () => {
    const s = script([networkError, networkError, ok]);
    const rpc = createRpc("http://rpc", { fetch: s.fetchImpl, retryDelayMs: 0 });
    expect(await rpc.view("token.testnet", "ft_total_supply")).toBe("20000");
    expect(s.count()).toBe(3);
  });

  it("gives up after `retries` more tries, as an rpc_error", async () => {
    const s = script([limited]);
    const rpc = createRpc("http://rpc", { fetch: s.fetchImpl, retryDelayMs: 0, retries: 2 });
    expect((await failure(rpc.view("c.near", "m"))).message).toMatch(/Could not reach the NEAR RPC node/);
    expect(s.count()).toBe(3);

    const once = script([limited]);
    await failure(createRpc("http://rpc", { fetch: once.fetchImpl, retries: 0 }).view("c.near", "m"));
    expect(once.count()).toBe(1);
  });

  it("does not ask again after a timeout, a 500, a refused view or a bad answer", async () => {
    const timeout = script([
      () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      },
    ]);
    await failure(createRpc("http://rpc", { fetch: timeout.fetchImpl, retryDelayMs: 0 }).view("c.near", "m"));
    expect(timeout.count()).toBe(1);

    const internal = script([() => new Response("oops", { status: 500 })]);
    await failure(createRpc("http://rpc", { fetch: internal.fetchImpl, retryDelayMs: 0 }).view("c.near", "m"));
    expect(internal.count()).toBe(1);

    const panic = script([
      (id) =>
        new Response(
          JSON.stringify({ jsonrpc: "2.0", id, result: { error: 'HostError(GuestPanic { panic_msg: "unknown sale" })' } }),
        ),
    ]);
    const e = await failure(createRpc("http://rpc", { fetch: panic.fetchImpl, retryDelayMs: 0 }).view("c.near", "m"));
    expect(e.message).toBe("unknown sale");
    expect(panic.count()).toBe(1);
  });

  it("waits longer before each try", async () => {
    const s = script([networkError, networkError, ok]);
    const rpc = createRpc("http://rpc", { fetch: s.fetchImpl, retryDelayMs: 20 });
    const t0 = Date.now();
    await rpc.view("c.near", "m");
    // 20 ms, then 60 ms, each with up to half again: at least 80 ms in all.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(75);
  });
});

describe("several endpoints", () => {
  beforeEach(() => resetRpcHealth());

  type Step = (id: number) => Response;
  const ok: Step = (id) => new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { result: bytes("7"), logs: [] } }));
  const limited: Step = () => new Response("Too Many Requests", { status: 429 });
  const gone: Step = () => new Response("This endpoint has been discontinued.", { status: 410 });

  /** A fetch per endpoint: each plays its steps in order (the last one repeats) and logs which endpoint was called. */
  function endpoints(plan: Record<string, Step[] | "network" | "timeout">) {
    const log: string[] = [];
    const n: Record<string, number> = {};
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      log.push(u);
      const steps = plan[u];
      if (steps === "network") throw new TypeError("Failed to fetch");
      if (steps === "timeout") throw new DOMException("The operation timed out.", "TimeoutError");
      const i = (n[u] = (n[u] ?? -1) + 1);
      return steps[Math.min(i, steps.length - 1)]((JSON.parse(String(init?.body)) as { id: number }).id);
    }) as typeof fetch;
    return { fetchImpl, log, hits: (u: string) => log.filter((x) => x === u).length };
  }

  it("moves to the next endpoint at once when one is busy or unreachable, before any wait", async () => {
    for (const first of [[limited], "network"] as (Step[] | "network")[]) {
      resetRpcHealth();
      const e = endpoints({ "https://a": first, "https://b": [ok] });
      const rpc = createRpc(["https://a", "https://b"], { fetch: e.fetchImpl, retryDelayMs: 60_000 });
      const t0 = Date.now();
      expect(await rpc.view("c.near", "m")).toBe("7");
      expect(Date.now() - t0).toBeLessThan(1_000);
      expect(e.log).toEqual(["https://a", "https://b"]);
    }
  });

  it("lets a busy endpoint rest, so the next read starts on another one", async () => {
    const e = endpoints({ "https://a": [limited, ok], "https://b": [ok] });
    const rpc = createRpc(["https://a", "https://b"], { fetch: e.fetchImpl, retryDelayMs: 0 });
    await rpc.view("c.near", "m");
    await rpc.view("c.near", "m");
    expect(e.log).toEqual(["https://a", "https://b", "https://b"]);
  });

  it("spreads a page's burst of reads over the endpoints instead of sending them all to the first", async () => {
    const urls = ["https://a", "https://b", "https://c"];
    const e = endpoints({ "https://a": [ok], "https://b": [ok], "https://c": [ok] });
    const rpc = createRpc(urls, { fetch: e.fetchImpl });
    await Promise.all(Array.from({ length: 60 }, () => rpc.view("c.near", "m")));
    expect(e.log).toHaveLength(60);
    for (const u of urls) {
      expect(e.hits(u), u).toBeGreaterThanOrEqual(15);
      expect(e.hits(u), u).toBeLessThanOrEqual(25);
    }
    // A quiet page stays on the first endpoint.
    resetRpcHealth();
    const quiet = endpoints({ "https://a": [ok], "https://b": [ok] });
    const q = createRpc(["https://a", "https://b"], { fetch: quiet.fetchImpl });
    for (let i = 0; i < 5; i++) await q.view("c.near", "m");
    expect(quiet.hits("https://a")).toBe(5);
  });

  it("goes round again, after a wait, only once every endpoint was busy", async () => {
    const e = endpoints({ "https://a": [limited, ok], "https://b": [limited] });
    const rpc = createRpc(["https://a", "https://b"], { fetch: e.fetchImpl, retryDelayMs: 20 });
    const t0 = Date.now();
    expect(await rpc.view("c.near", "m")).toBe("7");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(18);
    expect(e.log).toEqual(["https://a", "https://b", "https://a"]);

    resetRpcHealth();
    const down = endpoints({ "https://a": "network", "https://b": [limited] });
    const r = createRpc(["https://a", "https://b"], { fetch: down.fetchImpl, retryDelayMs: 0, retries: 2 });
    expect((await failure(r.view("c.near", "m"))).message).toMatch(/Could not reach the NEAR RPC node/);
    expect(down.log).toHaveLength(6); // two endpoints, three rounds
  });

  it("skips an endpoint that answers with another error, without going round again", async () => {
    const e = endpoints({ "https://gone": [gone], "https://b": [ok] });
    expect(await createRpc(["https://gone", "https://b"], { fetch: e.fetchImpl }).view("c.near", "m")).toBe("7");

    resetRpcHealth();
    const both = endpoints({ "https://gone": [gone], "https://b": [() => new Response("not json")] });
    await failure(createRpc(["https://gone", "https://b"], { fetch: both.fetchImpl, retryDelayMs: 0 }).view("c.near", "m"));
    expect(both.log).toEqual(["https://gone", "https://b"]);
  });

  it("does not move on after a timeout or the contract's own refusal", async () => {
    const slow = endpoints({ "https://a": "timeout", "https://b": [ok] });
    await failure(createRpc(["https://a", "https://b"], { fetch: slow.fetchImpl }).view("c.near", "m"));
    expect(slow.log).toEqual(["https://a"]);

    resetRpcHealth();
    const refused = endpoints({
      "https://a": [(id) => new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { error: 'GuestPanic { panic_msg: "unknown sale" }' } }))],
      "https://b": [ok],
    });
    expect((await failure(createRpc(["https://a", "https://b"], { fetch: refused.fetchImpl }).view("c.near", "m"))).message).toBe(
      "unknown sale",
    );
    expect(refused.log).toEqual(["https://a"]);
  });

  it("treats a rate limit sent as a JSON-RPC error with status 200 as busy", async () => {
    const e = endpoints({
      "https://a": [(id) => new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32005, message: "Rate limit exceeded" } }))],
      "https://b": [ok],
    });
    expect(await createRpc(["https://a", "https://b"], { fetch: e.fetchImpl }).view("c.near", "m")).toBe("7");
    expect(e.log).toEqual(["https://a", "https://b"]);
  });
});

describe("which endpoints a reader uses", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("uses a list as given and a stray URL alone", () => {
    expect(rpcEndpoints(["https://a", "https://b", "https://a"])).toEqual(["https://a", "https://b"]);
    expect(rpcEndpoints("http://127.0.0.1:3030")).toEqual(["http://127.0.0.1:3030"]);
  });

  it("reads the configured URL as the configured list, in NEAR mode", async () => {
    vi.stubEnv("NEXT_PUBLIC_FAIRGROUND_CONTRACT", "sealround.itzbeast.testnet");
    vi.stubEnv("NEXT_PUBLIC_NEAR_NETWORK", "testnet");
    vi.stubEnv("NEXT_PUBLIC_NEAR_RPC_URL", "https://rpc.testnet.fastnear.com");
    vi.stubEnv("NEXT_PUBLIC_NEAR_RPC_FALLBACKS", "https://my-node.example");
    vi.resetModules();
    const fresh = await import("../near/rpc");
    expect(fresh.rpcEndpoints("https://rpc.testnet.fastnear.com")).toEqual([
      "https://rpc.testnet.fastnear.com",
      "https://my-node.example",
      "https://near-testnet.drpc.org",
      "https://test.rpc.fastnear.com",
    ]);
    expect(fresh.rpcEndpoints("https://other.example")).toEqual(["https://other.example"]);
  });
});

describe("the chain clock", () => {
  it("reads the head block's timestamp in ms", async () => {
    // `timestamp` (a number) is too large for a double; the node also sends it as a string.
    const { rpc, calls } = node(() => ({ result: { header: { timestamp_nanosec: "1800000000123456789" } } }));
    expect(await rpc.headTimeMs()).toBe(1_800_000_000_123);
    expect(calls).toEqual([{ method: "block", params: { finality: "optimistic" } }]);
  });
});

describe("panicText", () => {
  it("finds the panic in each shape and nothing in other text", () => {
    expect(panicText('wasm execution failed with error: HostError(GuestPanic { panic_msg: "unknown sale" })')).toBe("unknown sale");
    expect(panicText(JSON.stringify({ data: 'HostError(GuestPanic { panic_msg: "cannot claim: sale is open" })' }))).toBe("cannot claim: sale is open");
    expect(panicText("Smart contract panicked: unknown sale")).toBe("unknown sale");
    expect(panicText(JSON.stringify({ ExecutionError: "Smart contract panicked: this bid is already revealed" }))).toBe("this bid is already revealed");
    expect(panicText("wasm execution failed with error: MethodResolveError(MethodNotFound)")).toBeNull();
    expect(panicText("timeout")).toBeNull();
  });
});
