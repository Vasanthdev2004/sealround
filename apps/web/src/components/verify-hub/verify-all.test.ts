import { afterEach, describe, expect, it, vi } from "vitest";
import { bidSetHash } from "@fairground/clearing";
import type { FairgroundClient } from "@/lib/client";
import { parseConfig } from "@/lib/config";
import * as attestationSources from "@/lib/near/attestation-sources";
import type { Sale } from "@/lib/types";
import type { FullVerification } from "@/lib/verify/types";
import { verifyAllSales, type VerificationRow } from "./verify-all";

const mock = { mode: "mock" } as const;
const testnet = parseConfig({
  NEXT_PUBLIC_FAIRGROUND_CONTRACT: "sealround.testnet",
  NEXT_PUBLIC_NEAR_NETWORK: "testnet",
  NEXT_PUBLIC_NEAR_RPC_URL: "http://127.0.0.1:1234",
  NEXT_PUBLIC_NEAR_RPC_FALLBACKS: "none",
});

function appSale(id: string, status: Sale["status"], bidSetHash: string | null): Sale {
  return { id, status, bidSetHash, createdAt: 0, bidCount: 0, config: { tokenName: id } } as Sale;
}

function clientFixture(sales: Sale[] = []) {
  return {
    listSales: vi.fn<FairgroundClient["listSales"]>().mockResolvedValue(sales),
    verifySale: vi.fn<FairgroundClient["verifySale"]>(),
    getBids: vi.fn<FairgroundClient["getBids"]>().mockResolvedValue([]),
  };
}

const verification: FullVerification = {
  simulated: true, checkedAt: 0, pinnedWasm: "", key: null, clear: null,
  chain: { simulated: true, checks: [{ id: "rules", applies: true, ok: true, items: [] }] },
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Verify all", () => {
  it("runs final mock sales serially and aggregates only applicable public checks", async () => {
    const client = clientFixture([
      appSale("settled", "settled", bidSetHash("settled", [])),
      appSale("open", "open", null),
      appSale("failed", "failed", null),
    ]);
    let release: ((value: FullVerification) => void) | undefined;
    client.verifySale
      .mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }))
      .mockRejectedValueOnce(new Error("Failed sale check was unavailable"));
    const report = vi.fn<(rows: VerificationRow[]) => void>();
    const run = verifyAllSales(mock, client, report, new AbortController().signal);
    await vi.waitFor(() => expect(client.verifySale).toHaveBeenCalledExactlyOnceWith("settled"));
    release?.({
      ...verification,
      key: { kind: "key", found: false, reason: "not_found", message: "missing" },
      chain: {
        simulated: true,
        checks: [
          { id: "rules", applies: true, ok: true, items: [] },
          { id: "contract_code", applies: true, ok: false, items: [] },
          { id: "pool", applies: false, ok: null, items: [] },
          { id: "your_bid", subject: "private", applies: true, ok: false, items: [] },
        ],
      },
    });
    await run;
    expect(report.mock.calls[0]?.[0].every(({ result }) => result === undefined)).toBe(true);
    expect(client.verifySale.mock.calls).toEqual([["settled"], ["failed"]]);
    expect(client.getBids).toHaveBeenCalledExactlyOnceWith("settled");
    const rows = report.mock.lastCall?.[0];
    expect(rows?.[1].result).toBeUndefined();
    expect(rows).toMatchObject([
      { sale: { id: "settled" }, result: { passed: 2, total: 4, failed: ["contract_code"], unavailable: ["key.found"] } },
      { sale: { id: "open" } },
      { sale: { id: "failed" }, result: { passed: 0, total: 1, failed: [], unavailable: ["verification"] } },
    ]);
  });

  it("pages get_sales and reuses the verification snapshot when checking a frozen bid set", async () => {
    const listing = vi.fn().mockResolvedValueOnce([
      ...Array.from({ length: 49 }, (_, i) => ({ sale_id: `open-${i}`, token_name: `Open ${i}`, status: "open", bid_count: 0 })),
      { sale_id: "settled", token_name: "Settled Token", status: "settled", closed_at: "1", bid_set_hash: "old", bid_count: 0 },
    ]).mockResolvedValueOnce([
      { sale_id: "failed", token_name: "Failed Sale", status: "failed", closed_at: "1", bid_set_hash: "bad", bid_count: 0 },
    ]);
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      expect(request.params).toMatchObject({ account_id: "sealround.testnet", method_name: "get_sales" });
      const page = await listing(JSON.parse(atob(request.params.args_base64)));
      return Response.json({ result: { result: [...new TextEncoder().encode(JSON.stringify(page))] } });
    }));
    const verify = vi.spyOn(attestationSources, "verifySaleRuns").mockResolvedValueOnce({
      verification: { ...verification, simulated: false },
      found: {},
      chain: {
        codeHash: null, contractKeys: null, tokenAccount: "settled.sealround.testnet", tokenKeys: null, pool: null,
        facts: {
          contractId: "sealround.testnet", saleId: "settled", token: "settled.sealround.testnet", quoteToken: "usdc.testnet",
          mode: "tee", status: "settled", failReason: null, saleSupply: 0n, floorPrice: 0n, maxPrice: null,
          minRaise: 0n, decimals: 18, bidSetHash: bidSetHash("settled", []), resultSha256: null, bidCount: 0,
          price: 0n, totalSold: 0n, totalRaised: 0n, nValid: 0, nInvalid: 0, nWinners: 0, bids: [], fills: [], liquidity: null,
        },
      },
    }).mockRejectedValueOnce(new Error("RPC unavailable"));
    const client = clientFixture();
    client.getBids.mockRejectedValueOnce(new Error("Bid view unavailable"));
    const report = vi.fn<(rows: VerificationRow[]) => void>();
    await verifyAllSales(testnet, client, report, new AbortController().signal);
    expect(listing.mock.calls).toEqual([[{ from_index: 0, limit: 50 }], [{ from_index: 50, limit: 50 }]]);
    expect(verify.mock.calls.map(([options]) => options.saleId)).toEqual(["settled", "failed"]);
    expect(client.listSales).not.toHaveBeenCalled();
    expect(client.verifySale).not.toHaveBeenCalled();
    expect(client.getBids).toHaveBeenCalledExactlyOnceWith("failed");
    expect(report.mock.lastCall?.[0].slice(-2)).toMatchObject([
      { sale: { id: "settled" }, result: { passed: 2, total: 2, failed: [], unavailable: [] } },
      { sale: { id: "failed" }, result: { passed: 0, total: 2, failed: [], unavailable: ["verification", "bid_set"] } },
    ]);
  });
});
