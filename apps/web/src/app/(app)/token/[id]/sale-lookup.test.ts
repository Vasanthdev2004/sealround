import { describe, expect, it, vi } from "vitest";
import { decodeSaleId, lookupSale, saleLookup } from "./sale-lookup";

const target = { rpcUrl: "https://rpc.example", contractId: "sealround.testnet" };

/** A node that answers a view with `value` as the contract's JSON. */
function answering(value: unknown) {
  const bytes = Array.from(new TextEncoder().encode(value === undefined ? "" : JSON.stringify(value)));
  return vi.fn(async () => Response.json({ jsonrpc: "2.0", id: 1, result: { result: bytes, logs: [] } }));
}

describe("does the contract have this sale", () => {
  it("is missing when get_sale returns null", async () => {
    const fetch = answering(null);
    expect(await lookupSale("nosnipe-1", target, { fetch })).toBe("missing");
    const body = JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.params.method_name).toBe("get_sale");
    expect(body.params.account_id).toBe("sealround.testnet");
    expect(JSON.parse(atob(body.params.args_base64))).toEqual({ sale_id: "nosnipe-1" });
  });

  it("is found when get_sale returns a sale", async () => {
    expect(await lookupSale("nosnipe-1", target, { fetch: answering({ status: "settled" }) })).toBe("found");
  });

  it("is missing, without a read, for an id no sale can have", async () => {
    const fetch = answering({ status: "settled" });
    for (const id of ["", "Nosnipe", "a b", "x".repeat(33), "a..b", "-a", "a%20b"]) {
      expect(await lookupSale(id, target, { fetch }), id).toBe("missing");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("is unknown when the node cannot be read, so the page renders and says so", async () => {
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await lookupSale("nosnipe-1", target, { fetch: down })).toBe("unknown");
    const http = vi.fn(async () => new Response("bad gateway", { status: 502 }));
    expect(await lookupSale("nosnipe-1", target, { fetch: http })).toBe("unknown");
    const rpcError = vi.fn(async () =>
      Response.json({ jsonrpc: "2.0", id: 1, error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" } } }),
    );
    expect(await lookupSale("nosnipe-1", target, { fetch: rpcError })).toBe("unknown");
  });

  it("decodes the route's id", () => {
    expect(decodeSaleId("nosnipe-1")).toBe("nosnipe-1");
    expect(decodeSaleId("a%2Eb")).toBe("a.b");
    expect(decodeSaleId("%E0%A4%A")).toBe("%E0%A4%A");
  });

  it("in mock mode says missing only for an id no sale can have: the sales live in the browser", async () => {
    vi.stubEnv("NEXT_PUBLIC_FAIRGROUND_CONTRACT", "");
    try {
      for (const id of ["nonexistent", "thistle", "judge-12", "fairt-2"]) expect(await saleLookup(id), id).toBe("unknown");
      expect(await saleLookup("Not%20A%20Sale!")).toBe("missing");
      expect(await saleLookup("THISTLE")).toBe("missing");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
