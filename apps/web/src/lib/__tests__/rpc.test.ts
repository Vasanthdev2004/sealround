/** The JSON-RPC reader (near/rpc.ts) against canned node answers, in the shapes real nodes send. */
import { describe, expect, it } from "vitest";
import { FairgroundError } from "../client/errors";
import { createRpc, panicText } from "../near/rpc";

type Call = { method: string; params: Record<string, unknown> };

/** A fetch that answers every JSON-RPC call with `reply(call)`. */
function node(reply: (call: Call) => unknown, status = 200) {
  const calls: Call[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Call & { id: number };
    calls.push({ method: body.method, params: body.params });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...(reply(body) as object) }), { status });
  }) as typeof fetch;
  return { calls, rpc: createRpc("http://127.0.0.1:3030", { fetch: fetchImpl }) };
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
