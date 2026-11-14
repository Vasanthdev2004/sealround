import { afterEach, describe, expect, it, vi } from "vitest";
import { readDemoView } from "@/lib/chapters/demo";
import type { ChapterRound } from "@/lib/chapters/model";
import { parseConfig } from "@/lib/config";
import { sealedBidLen } from "@/lib/crypto";
import type { BidRecord, Sale } from "@/lib/types";
import { checkAttackEvidence, checkBidSizes, checkChapters, checkCI, listOutLayerEvidence, summarizeSales } from "./checks";
import type { ListedSale } from "../verify-hub/verify-all";

const signal = new AbortController().signal;
const mock = { mode: "mock" } as const;
const sale: ListedSale = { id: "fairt", status: "open", bidSetHash: null, bidCount: 1, name: "Fair Test", mode: "tee" };

vi.mock("@/lib/chapters/demo", () => ({ readDemoView: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("judge checklist checks", () => {
  it("verifies bid sizes on open sales and marks incomplete bid lists unavailable", async () => {
    const bidder = "alice.testnet";
    const payload = btoa("a".repeat(sealedBidLen(sale.id, bidder)));
    const getBids = vi.fn()
      .mockResolvedValueOnce([{ index: 0, bidder, ciphertext: payload }] as BidRecord[])
      .mockResolvedValueOnce([{ index: 0, bidder, ciphertext: btoa("x") }] as BidRecord[])
      .mockResolvedValueOnce([]);
    await expect(checkBidSizes(mock, { getBids }, [sale], signal)).resolves.toMatchObject({ state: "passed", detail: expect.stringContaining("1 recorded bid") });
    await expect(checkBidSizes(mock, { getBids }, [sale], signal)).resolves.toMatchObject({ state: "failed", links: [{ detail: "Unexpected bid size" }] });
    await expect(checkBidSizes(mock, { getBids }, [sale], signal)).resolves.toMatchObject({ state: "unavailable", links: [{ detail: "Incomplete bid list" }] });
  });

  it("keeps final sale failures separate from RPC gaps and open sales", () => {
    const settled = { ...sale, status: "settled" } as const;
    const pass = { passed: 2, total: 2, failed: [], unavailable: [] };
    expect(summarizeSales([{ sale }]).state).toBe("pending");
    expect(summarizeSales([{ sale }, { sale: settled, result: pass }]).state).toBe("passed");
    expect(summarizeSales([{ sale: settled, result: { ...pass, passed: 1, unavailable: ["pool"] } }]).state).toBe("unavailable");
    expect(summarizeSales([{ sale: settled, result: { ...pass, passed: 1, failed: ["contract_keys"] } }]).state).toBe("failed");
  });

  it("shows public CI pass, failure and access gaps from workflow results", async () => {
    const workflow = { id: 1, head_sha: "a".repeat(40), status: "completed" };
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ workflow_runs: [{ ...workflow, conclusion: "success" }] }))
      .mockResolvedValueOnce(Response.json({ workflow_runs: [{ ...workflow, conclusion: "failure" }] }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetch);
    await expect(checkCI(signal)).resolves.toMatchObject({ state: "passed", detail: expect.stringContaining("aaaaaaaa") });
    await expect(checkCI(signal)).resolves.toMatchObject({ state: "failed" });
    await expect(checkCI(signal)).resolves.toMatchObject({ state: "unavailable", detail: expect.stringContaining("needs a public repository") });
    expect(fetch.mock.calls[0][0]).toContain("check.yml/runs?branch=main");
  });

  it("lists provenance and pending transaction links without claiming a fresh proof", async () => {
    const manifest = listOutLayerEvidence();
    expect(manifest.state).toBe("listed");
    expect(manifest.links?.length).toBeGreaterThan(0);
    const result = await checkAttackEvidence(mock, signal);
    expect(result.state).toBe("listed");
    expect(result.links).toContainEqual({ href: "/attack#withdraw-early", detail: "Transaction pending", label: "Chapters withdrawal before the round ends" });
    expect(result.detail).toContain("0 final transaction records checked this run");
  });

  it("checks final attack receipts through both supported NEAR RPC methods", async () => {
    const app = parseConfig({ NEXT_PUBLIC_FAIRGROUND_CONTRACT: "sealround.itzbeast.testnet", NEXT_PUBLIC_NEAR_NETWORK: "testnet",
      NEXT_PUBLIC_NEAR_RPC_URL: "https://rpc.example.test", NEXT_PUBLIC_NEAR_RPC_FALLBACKS: "none" });
    const fetch = vi.fn(async (_: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      if (request.method === "tx_status" && request.params.sender_account_id.startsWith("copy.")) {
        return Response.json({ error: { message: "Method not found" } });
      }
      return Response.json({ result: {
        final_execution_status: "FINAL",
        transaction: { hash: request.params.tx_hash, signer_id: request.params.sender_account_id },
        receipts_outcome: [{}],
      } });
    });
    vi.stubGlobal("fetch", fetch);
    await expect(checkAttackEvidence(app, signal)).resolves.toMatchObject({
      state: "listed", detail: expect.stringContaining("2 final transaction records checked this run"),
    });
    expect(fetch.mock.calls.some(([, init]) => JSON.parse(String(init.body)).method === "EXPERIMENTAL_tx_status")).toBe(true);
  });

  it("passes on the two bundled Lantern chapters in a fresh demo without crediting payouts", async () => {
    const lantern = { ...sale, id: "lantern", status: "settled", name: "Lantern" } as const;
    const getSale = vi.fn().mockResolvedValue({ id: lantern.id, config: { tokenName: lantern.name, tokenSymbol: "LNTN" } } as Sale);
    vi.mocked(readDemoView).mockReturnValueOnce({ rounds: [], votes: {}, balance: null });
    await expect(checkChapters(mock, { getSale }, [lantern], signal)).resolves.toMatchObject({
      state: "passed", detail: "Lantern has 2 bundled Chapters ready to play. This browser has 0 simulated winning artist payout records.",
      links: [{ href: "/token/lantern#meme-chapters", label: "Play Lantern’s Chapters" }],
    });
  });

  it("keeps a paid winner as the parent after a no-winner round but requires the next parent to be paid", async () => {
    const settled = { ...sale, status: "settled" } as const;
    const getSale = vi.fn().mockResolvedValue({ id: settled.id, config: { tokenName: settled.name } } as Sale);
    const round = (id: number, winner: number | null, paid: boolean, parent: string | null) => ({
      round_id: id, phase: "finalized", winner, parent_sha256: parent, bounty_state: paid ? "paid" : "unclaimed",
      candidates: [{ artist: "mira.testnet", content_sha256: `round-${id}` }],
    }) as unknown as ChapterRound;
    const first = round(1, 0, true, null);
    const tied = round(2, null, true, "round-1");
    const linked = round(3, 0, true, "round-1");
    vi.mocked(readDemoView).mockReturnValueOnce({ rounds: [first, tied, linked], votes: {}, balance: null });
    await expect(checkChapters(mock, { getSale }, [settled], signal)).resolves.toMatchObject({ state: "passed" });
    const unpaid = round(3, 0, false, "round-1");
    const unlinked = round(4, 0, true, "round-3");
    vi.mocked(readDemoView).mockReturnValueOnce({ rounds: [first, tied, unpaid, unlinked], votes: {}, balance: null });
    await expect(checkChapters(mock, { getSale }, [settled], signal)).resolves.toMatchObject({ state: "pending" });
  });
});
