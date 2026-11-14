import { BURN_CAP, burnTotal, finalSales } from "./burn-total";
import { chapterFactoryFor, readChapterRegistration, sandboxFor } from "./chapters/sandbox";
import type { ChapterRound } from "./chapters/model";
import type { AppConfig } from "./config";
import { BURNED_DECIMALS, serializeBurn, type LandingMetrics } from "./landing-metrics-format";
import { createRpc, type NearRpc } from "./near/rpc";
import { resultFromViews, saleFromView, type BidView, type ResultView, type SaleView } from "./near/views";
import type { SaleResult } from "./types";
import type { FairgroundClient } from "./client";

const PAGE_SIZE = 50;
const MAX_CHAPTER_ROUNDS = 64;
function normalizeBurn(amount: bigint, decimals: number) {
  if (amount < 0n || !Number.isSafeInteger(decimals) || decimals < 0 || decimals > BURNED_DECIMALS) {
    throw new Error("Invalid token supply or decimals.");
  }
  return amount * 10n ** BigInt(BURNED_DECIMALS - decimals);
}

export async function readMockLandingMetrics(client: Pick<FairgroundClient, "listSales" | "getBids" | "getResult">): Promise<LandingMetrics> {
  const sales = await client.listSales();
  const bidders = new Set<string>();
  const results = new Map<string, SaleResult | null>();
  let burned = 0n;
  let burnedKnown = true;
  for (const sale of sales) {
    for (const bid of await client.getBids(sale.id)) bidders.add(bid.bidder);
    if (sale.status !== "settled" && sale.status !== "failed") continue;
    const result = await client.getResult(sale.id);
    results.set(sale.id, result);
    if (sale.tokenSetup && sale.tokenSetup !== "done") continue;
    if (!result) burnedKnown = false;
    else if (result.proceeds?.unsoldBurned) burned += normalizeBurn(result.unsold, sale.config.decimals);
  }
  const final = finalSales(sales, BURN_CAP);
  return {
    source: "simulated",
    updatedAt: Date.now(),
    saleCount: sales.length,
    bidCount: sales.reduce((sum, sale) => sum + sale.bidCount, 0),
    bidderCount: bidders.size,
    burned: burnedKnown ? burned.toString() : null,
    // The seed has zero chapter votes. A judge's vote stays in their browser.
    chapterVotes: 0,
    chaptersConfigured: true,
    burnDetail: serializeBurn(burnTotal(final.sales, results, final.beyond)),
  };
}

async function readSales(rpc: NearRpc, contract: string): Promise<SaleView[]> {
  const sales: SaleView[] = [];
  const ids = new Set<string>();
  for (;;) {
    const page = await rpc.view<SaleView[]>(contract, "get_sales", { from_index: sales.length, limit: PAGE_SIZE });
    for (const sale of page) {
      if (ids.has(sale.sale_id) || !Number.isSafeInteger(sale.bid_count) || sale.bid_count < 0) {
        throw new Error("The sale list returned a duplicate or an invalid bid count.");
      }
      ids.add(sale.sale_id);
      sales.push(sale);
    }
    if (page.length < PAGE_SIZE) return sales;
  }
}

async function readBidders(rpc: NearRpc, contract: string, sale: SaleView) {
  const bidders = new Set<string>();
  // The sale view gives us a stable prefix. Bids after it appear on the next refresh.
  for (let from = 0; from < sale.bid_count; from += PAGE_SIZE) {
    const limit = Math.min(PAGE_SIZE, sale.bid_count - from);
    const bids = await rpc.view<BidView[]>(contract, "get_bids", { sale_id: sale.sale_id, from_index: from, limit });
    if (bids.length !== limit) throw new Error("The full bid page is unavailable.");
    for (const [offset, bid] of bids.entries()) {
      if (bid.index !== from + offset || !bid.bidder || bidders.has(bid.bidder)) {
        throw new Error("The bid page does not match the sale's snapshot.");
      }
      bidders.add(bid.bidder);
    }
  }
  return bidders;
}

async function readChapterVotes(rpc: NearRpc, escrow: string) {
  const count = await rpc.view<number>(escrow, "get_round_count");
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_CHAPTER_ROUNDS) {
    throw new Error("Invalid Chapters round count.");
  }
  let votes = 0;
  for (let id = 1; id <= count; id++) {
    const round = await rpc.view<Pick<ChapterRound, "round_id" | "committed_count"> | null>(escrow, "get_round", { round_id: id });
    if (round?.round_id !== id || !Number.isSafeInteger(round.committed_count) || round.committed_count < 0) {
      throw new Error("The chapter did not return a valid vote count.");
    }
    votes += round.committed_count;
  }
  return votes;
}

export async function readNearLandingMetrics(
  app: Extract<AppConfig, { mode: "near" }>,
  rpc = createRpc(app.near.rpcUrls ?? [app.near.rpcUrl]),
  factoryAccount = process.env.NEXT_PUBLIC_CHAPTERS_FACTORY,
  legacyEscrow = process.env.NEXT_PUBLIC_CHAPTERS_CONTRACT,
): Promise<LandingMetrics> {
  const { contractId, network } = app.near;
  const updatedAt = Date.now();
  const views = await readSales(rpc, contractId);
  const sales = views.map((view) => saleFromView(view));
  const final = finalSales(sales, BURN_CAP);
  const detailIds = new Set(final.sales.map((sale) => sale.id));
  const bidders = new Set<string>();
  let biddersKnown = true;
  let burned = 0n;
  let burnedKnown = true;
  let chapterVotes = 0;
  let chaptersKnown = true;
  const chaptersConfigured = (network !== "mainnet" && !!factoryAccount) || (network === "sandbox" && !!legacyEscrow);
  const results = new Map<string, SaleResult | null>();

  for (const [index, view] of views.entries()) {
    const sale = sales[index];
    if (biddersKnown) {
      try {
        for (const account of await readBidders(rpc, contractId, view)) bidders.add(account);
      } catch { biddersKnown = false; }
    }
    if (detailIds.has(sale.id)) {
      try {
        const result = await rpc.view<ResultView | null>(contractId, "get_result", { sale_id: sale.id });
        // A supply-only summary does not need bid fills or browser transactions.
        if (result?.sale_id === sale.id) results.set(sale.id, resultFromViews(view, [], result, []));
      } catch { /* The burn detail reports missing sales. */ }
    }
    const tokenMinted = view.token_setup === "done"
      || (view.token_setup === undefined && (sale.status === "settled" || sale.status === "failed"));
    if (burnedKnown && tokenMinted) {
      try {
        const supply = await rpc.view<string>(view.token, "ft_total_supply");
        if (typeof supply !== "string" || !/^\d+$/.test(supply)) throw new Error("Invalid token supply.");
        burned += normalizeBurn(sale.config.totalSupply - BigInt(supply), sale.config.decimals);
      } catch { burnedKnown = false; }
    }
    if (chaptersConfigured && chaptersKnown && sale.status === "settled") {
      try {
        let escrow = sandboxFor(sale, app, legacyEscrow)?.contract;
        if (!escrow && factoryAccount) {
          const factory = chapterFactoryFor(sale, app, factoryAccount);
          if (!factory) throw new Error("The configured Chapters factory is unavailable.");
          const entry = await readChapterRegistration({ ...factory, rpc }, sale);
          if (entry?.phase === "enabled") escrow = entry.contract_id;
        }
        if (escrow) chapterVotes += await readChapterVotes(rpc, escrow);
      } catch { chaptersKnown = false; }
    }
  }
  return {
    source: network,
    updatedAt,
    saleCount: sales.length,
    bidCount: views.reduce((sum, sale) => sum + sale.bid_count, 0),
    bidderCount: biddersKnown ? bidders.size : null,
    burned: burnedKnown ? burned.toString() : null,
    chapterVotes: chaptersKnown ? chapterVotes : null,
    chaptersConfigured,
    burnDetail: serializeBurn(burnTotal(final.sales, results, final.beyond)),
  };
}
