import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config";
import { readMockLandingMetrics, readNearLandingMetrics } from "../landing-metrics";
import { restoreBurn } from "../landing-metrics-format";
import type { NearRpc } from "../near/rpc";
import type { ResultView, SaleView } from "../near/views";
import { saleFromView } from "../near/views";
import type { BidRecord, SaleResult } from "../types";

const contract = "sealround.testnet";
const factory = "chapters.testnet";
const escrow = "story.chapters.testnet";
const quote = "usdc.testnet";
const app: Extract<AppConfig, { mode: "near" }> = {
  mode: "near",
  near: {
    network: "testnet", contractId: contract, rpcUrl: "https://rpc.testnet.fastnear.com",
    usdcContract: quote, devAccounts: [], relayerUrl: null, expectedCodeHash: null, explorerUrl: null,
  },
};

function sale(id: string, options: Partial<SaleView> = {}): SaleView {
  return {
    sale_id: id, status: "settled", creator: "creator.testnet", token: `${id}.${contract}`,
    quote_token: quote, token_name: id, token_symbol: id.toUpperCase(), decimals: 24,
    icon: null, description: null, website: null, total_supply: "100000000000000000000000000",
    sale_supply: "100000000000000000000000000", creator_allocation: "0", floor_price: "100",
    max_price: null, min_raise: "0", bid_start: "1000000", bid_end: "2000000",
    min_deposit: "100", max_deposit_per_account: "200", max_bids: 500, reveal_mode: "Tee",
    reveal_window: null, reveal_end: null, settle_timeout: "500000000", refund_mode_at: null,
    unsold_rule: "Burn", sealer_code_hash: "", sealer_pubkey: "", token_setup: "done",
    sealer_key_setup: "done", created_at: "0", closed_at: "3000000", bid_count: 0,
    total_deposits: "0", bid_set_hash: "", ...options,
  };
}

function result({ sale_id, status, sale_supply }: SaleView): ResultView {
  return {
    sale_id, status, fail_reason: status === "failed" ? "refund_mode" : null, clearing_price: "0",
    total_sold: "0", total_raised: "0", unsold: sale_supply, n_valid: 0, n_invalid: 0, n_winners: 0,
    failed_checks: [], failed_checks_total: 0, result_sha256: null, input_sha256: null, clear_requests: 0,
    clear_attempts: 0, total_penalties: "0",
    proceeds: { raise_paid: false, allocation_paid: false, unsold_burned: false, reserve_returned: false },
  };
}

function rpc(lookup: (account: string, method: string, args: Record<string, unknown>) => unknown): NearRpc {
  return {
    view: vi.fn(async (account, method, args = {}) => lookup(account, method, args)) as NearRpc["view"],
    headTimeMs: async () => 0,
  };
}

describe("landing activity metrics", () => {
  it("paginates every sale and the recorded bid prefixes, dedupes accounts, and totals exact units and both rounds", async () => {
    const alpha = sale("alpha", { bid_count: 51, decimals: 6, total_supply: "5000000", sale_supply: "5000000" });
    const beta = sale("beta", { status: "failed", bid_count: 2 });
    const sales = [alpha, ...Array.from({ length: 49 }, (_, i) => sale(`new-${i}`, { status: "setup", token_setup: "pending" })), beta];
    const records: Record<string, string[]> = {
      alpha: Array.from({ length: 52 }, (_, i) => `bidder-${i}.testnet`),
      beta: ["bidder-0.testnet", "bidder-52.testnet"],
    };
    const view = rpc((account, method, args) => {
      const from = Number(args.from_index);
      const limit = Number(args.limit);
      if (method === "get_sales") return sales.slice(from, from + limit);
      if (method === "get_bids") return records[String(args.sale_id)]?.slice(from, from + limit)
        .map((bidder, i) => ({ index: from + i, bidder }));
      if (method === "get_result") return result(args.sale_id === "alpha" ? alpha : beta);
      if (method === "ft_total_supply") return account === alpha.token ? "3749999" : (BigInt(beta.total_supply) - 3n).toString();
      if (method === "get_chapters") return {
        phase: "enabled", title: "Story", brief: "Two chapters", curator: alpha.creator,
        contract_id: escrow, token_id: alpha.token, quote_token_id: quote,
      };
      if (method === "get_round_count") return 2;
      if (method === "get_round") return { round_id: args.round_id, committed_count: Number(args.round_id) * 2 };
      throw new Error(`Unexpected ${method}`);
    });
    const answer = await readNearLandingMetrics(app, view, factory);
    expect(answer).toMatchObject({
      source: "testnet", saleCount: 51, bidCount: 53, bidderCount: 52,
      burned: (1_250_001n * 10n ** 18n + 3n).toString(), chapterVotes: 6, chaptersConfigured: true,
    });
    expect(view.view).toHaveBeenCalledWith(contract, "get_sales", { from_index: 50, limit: 50 });
    expect(view.view).toHaveBeenCalledWith(contract, "get_bids", { sale_id: "alpha", from_index: 50, limit: 1 });
    expect(view.view).toHaveBeenCalledWith(factory, "get_chapters", { sale_id: "alpha" });
    expect(view.view).not.toHaveBeenCalledWith(sales[1].token, "ft_total_supply");
    const decoded = restoreBurn(JSON.parse(JSON.stringify(answer)).burnDetail);
    expect(decoded.rows).toHaveLength(2);
    expect(decoded.rows.find((row) => row.id === "alpha")).toMatchObject({ burn: 5_000_000n, landed: false });
  });

  it("preserves verified sale and bid counts when bid pages or token supply are incomplete", async () => {
    const alpha = sale("alpha", { bid_count: 2 });
    const view = rpc((_account, method) => {
      if (method === "get_sales") return [alpha];
      if (method === "get_bids") return [{ index: 0, bidder: "first.testnet" }];
      throw new Error("Unavailable");
    });
    const answer = await readNearLandingMetrics(app, view, "", "");
    expect(answer).toMatchObject({
      saleCount: 1, bidCount: 2, bidderCount: null, burned: null,
      chaptersConfigured: false, chapterVotes: 0, burnDetail: { unread: 1 },
    });
    expect(view.view).not.toHaveBeenCalledWith(expect.anything(), "get_chapters", expect.anything());
  });

  it("reports an unavailable Chapter count rather than displaying votes from an incomplete round list", async () => {
    const alpha = sale("alpha");
    const view = rpc((_account, method) => {
      if (method === "get_sales") return [alpha];
      if (method === "get_result") return result(alpha);
      if (method === "ft_total_supply") return alpha.total_supply;
      if (method === "get_chapters") return {
        phase: "enabled", title: "Story", brief: "Two chapters", curator: alpha.creator,
        contract_id: escrow, token_id: alpha.token, quote_token_id: quote,
      };
      if (method === "get_round_count") return 2;
      if (method === "get_round") return { round_id: 1, committed_count: 3 };
      throw new Error("Unexpected view");
    });
    expect(await readNearLandingMetrics(app, view, factory)).toMatchObject({
      bidderCount: 0, burned: "0", chapterVotes: null, chaptersConfigured: true,
    });
  });

  it("uses seeded mock results and excludes unsold amounts still owed", async () => {
    const alpha = saleFromView(sale("alpha", { bid_count: 1, decimals: 6 }));
    const beta = saleFromView(sale("beta", { bid_count: 1, decimals: 6 }));
    const paid = { unsold: 12_345_678n, status: "settled", totalSold: 0n, proceeds: { unsoldBurned: true } } as SaleResult;
    const owed = { ...paid, proceeds: { ...paid.proceeds!, unsoldBurned: false } };
    const metrics = await readMockLandingMetrics({
      listSales: async () => [alpha, beta],
      getBids: async () => [{ bidder: "bidder.testnet" } as BidRecord],
      getResult: async (id) => id === alpha.id ? paid : owed,
    });
    expect(metrics).toMatchObject({
      source: "simulated", saleCount: 2, bidCount: 2, bidderCount: 1,
      burned: (12_345_678n * 10n ** 18n).toString(), chapterVotes: 0, chaptersConfigured: true,
    });
  });
});
