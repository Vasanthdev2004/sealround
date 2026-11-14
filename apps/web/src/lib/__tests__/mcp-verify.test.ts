import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../../scripts/mcp/config";
import { verifySale } from "../../../scripts/mcp/tools";
import { checkBidSet } from "../bid-inclusion";
import type { AttestedRun } from "../types";
import type { ChainCheck, FullVerification } from "../verify/types";

const verifyOnClient = vi.hoisted(() => vi.fn<() => Promise<FullVerification>>());

vi.mock("../../../scripts/mcp/session", () => ({
  openSale: async () => ({
    opts: { saleId: "round" },
    client: { verifySale: verifyOnClient },
    repoSealerHash: "sealer-hash",
  }),
}));

vi.mock("../near/attestation-sources", () => ({
  jsonRpc: () => ({}),
  viewCall: async () => ({
    bid_count: 0,
    bid_set_hash: checkBidSet("round", [], null, 0).recomputed,
    closed_at: "1",
  }),
}));

const run: AttestedRun = {
  kind: "clear",
  found: true,
  simulated: false,
  attestationId: 1,
  taskId: 1,
  requestId: 1,
  txHash: "tx-hash",
  signer: "bidder.testnet",
  method: "close_sale",
  txSource: "block_scan",
  blockHeight: 1,
  at: 0,
  quote: "test-quote",
  verifierUrl: null,
  checks: [{ id: "output", ok: true, items: [] }],
};

async function verify(checks?: ChainCheck[]) {
  verifyOnClient.mockResolvedValue({
    simulated: false,
    checkedAt: 0,
    pinnedWasm: "sealer-hash",
    key: null,
    clear: run,
    ...(checks ? { chain: { simulated: false, checks } } : {}),
  });
  const { config } = loadConfig({
    NODE_ENV: "test",
    SEALROUND_NETWORK: "testnet",
    SEALROUND_CONTRACT: "sealround.testnet",
    SEALROUND_RPC_URL: "http://127.0.0.1:9",
  });
  if (!config) throw new Error("Invalid test configuration");
  return verifySale(config, { sale_id: "round" });
}

describe("MCP sale verification", () => {
  it("fails on a contract key check even when the enclave and bid set pass", async () => {
    const evidence = [{ kind: "fact" as const, label: "Access keys", value: "1", ok: false }];
    const result = await verify([
      { id: "contract_keys", ok: false, applies: true, items: evidence },
      { id: "pool", ok: null, applies: true, items: [], note: "RPC unavailable" },
    ]);
    expect(result.bidSet.result).toBe("pass");
    expect(result.runs[0]).toMatchObject({ found: true, checks: [{ id: "output", result: "pass" }] });
    expect(result).toMatchObject({ ok: false, verdict: "fail", chain: { checks: [{ id: "contract_keys", result: "fail", evidence }, { id: "pool", result: "not_run" }] } });
  });

  it("keeps unavailable applicable checks incomplete", async () => {
    const result = await verify([{ id: "rules", ok: null, applies: true, items: [], note: "RPC unavailable" }]);
    expect(result).toMatchObject({ ok: false, verdict: "incomplete", chain: { available: true, checks: [{ id: "rules", result: "not_run", note: "RPC unavailable" }] } });
  });

  it("passes when the only skipped check does not apply", async () => {
    const result = await verify([
      { id: "rules", ok: true, applies: true, items: [] },
      { id: "pool", ok: null, applies: false, items: [], note: "No pool planned" },
    ]);
    expect(result).toMatchObject({ ok: true, verdict: "pass", chain: { available: true, checks: [{ id: "rules", result: "pass" }, { id: "pool", result: "not_applicable", note: "No pool planned" }] } });
  });

  it("reports an absent contract report as incomplete", async () => {
    expect(await verify()).toMatchObject({ ok: false, verdict: "incomplete", chain: { available: false, checks: [] } });
  });
});
