import { checkBidSet } from "@/lib/bid-inclusion";
import type { FairgroundClient } from "@/lib/client";
import type { AppConfig } from "@/lib/config";
import { createRpc } from "@/lib/near/rpc";
import { foldStatus, type SaleView } from "@/lib/near/views";
import type { Sale } from "@/lib/types";
import type { FullVerification } from "@/lib/verify/types";
import { evidenceState } from "./public-evidence";

type ListedSale = Pick<Sale, "id" | "status" | "bidSetHash" | "bidCount"> & { name: string };
type VerificationClient = Pick<FairgroundClient, "listSales" | "verifySale" | "getBids">;

export type VerificationRow = {
  sale: ListedSale;
  result?: {
    passed: number;
    total: number;
    failed: string[];
    unavailable: string[];
  };
};

const PAGE_SIZE = 50;

async function listSales(config: AppConfig, client: VerificationClient, signal: AbortSignal): Promise<ListedSale[]> {
  if (config.mode === "mock") {
    return (await client.listSales()).toSorted((a, b) => a.createdAt - b.createdAt).map((sale) => ({
      id: sale.id, status: sale.status, name: sale.config.tokenName, bidSetHash: sale.bidSetHash, bidCount: sale.bidCount,
    }));
  }
  const { contractId, rpcUrl, rpcUrls } = config.near;
  const rpc = createRpc(rpcUrls ?? rpcUrl);
  const sales: ListedSale[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    signal.throwIfAborted();
    const page = await rpc.view<Pick<SaleView, "sale_id" | "status" | "token_name" | "closed_at" | "bid_set_hash" | "bid_count">[]>(
      contractId, "get_sales", { from_index: from, limit: PAGE_SIZE },
    );
    sales.push(...page.map((sale): ListedSale => ({
      id: sale.sale_id,
      status: foldStatus(sale.status),
      name: sale.token_name,
      bidSetHash: sale.closed_at ? sale.bid_set_hash : null,
      bidCount: sale.bid_count,
    })));
    if (page.length < PAGE_SIZE) return sales;
  }
}

function checkRow(sale: ListedSale, verification: FullVerification | null, bidSet: boolean | null): VerificationRow {
  const checks: { id: string; ok: boolean | null }[] = [];
  if (verification) {
    for (const run of [verification.key, verification.clear]) {
      if (!run) continue;
      if (!run.found) checks.push({ id: `${run.kind}.found`, ok: null });
      else checks.push(...run.checks.map((check) => ({ id: `${run.kind}.${check.id}`, ok: check.ok })));
    }
    checks.push(...(verification.chain?.checks ?? [])
      .filter((check) => check.applies && check.id !== "your_bid")
      .map(({ id, ok, subject }) => ({ id: subject ? `${id}:${subject}` : id, ok })));
    if (!verification.chain) checks.push({ id: "chain", ok: null });
  } else {
    checks.push({ id: "verification", ok: null });
  }
  if (sale.bidSetHash !== null) checks.push({ id: "bid_set", ok: bidSet });
  if (checks.length === 0) checks.push({ id: "verification", ok: null });
  const failed: string[] = [];
  const unavailable: string[] = [];
  for (const { id, ok } of checks) {
    const state = evidenceState(ok);
    if (state === "failed") failed.push(id);
    if (state === "unavailable") unavailable.push(id);
  }
  return { sale, result: { passed: checks.length - failed.length - unavailable.length, total: checks.length, failed, unavailable } };
}

export async function verifyAllSales(
  config: AppConfig,
  client: VerificationClient,
  report: (rows: VerificationRow[]) => void,
  signal: AbortSignal,
) {
  const sales = await listSales(config, client, signal);
  signal.throwIfAborted();
  const rows = sales.map((sale): VerificationRow => ({ sale }));
  report([...rows]);

  for (const [index, sale] of sales.entries()) {
    if (sale.status !== "settled" && sale.status !== "failed") continue;
    signal.throwIfAborted();
    let verification: FullVerification | null = null;
    let bidSet: boolean | null = null;
    let current = sale;
    let checkedBidSet = false;
    try {
      if (config.mode === "near" && config.near.network !== "sandbox") {
        const { network, contractId, rpcUrl, expectedCodeHash } = config.near;
        const { verifySaleRuns } = await import("@/lib/near/attestation-sources");
        const result = await verifySaleRuns({ network, contractId, rpcUrl, referenceWasm: expectedCodeHash, saleId: sale.id });
        const facts = result.chain?.facts;
        // The listing is optimistic while verification uses finalized views.
        // Keep a recently ended sale unresolved until those views agree.
        verification = facts?.status === "not_final" ? null : result.verification;
        if (facts && facts.status !== "not_final") {
          current = { ...sale, bidSetHash: facts.bidSetHash, bidCount: facts.bidCount };
          checkedBidSet = true;
          if (facts.bidSetHash !== null) {
            bidSet = checkBidSet(sale.id, facts.bids.map(({ payload, ...bid }) => ({ ...bid, ciphertext: payload })),
              facts.bidSetHash, facts.bidCount).matches;
          }
        }
      } else {
        verification = await client.verifySale(sale.id);
      }
    } catch {
      // A sale with unreadable evidence still gets a row, and the batch moves on.
    }
    signal.throwIfAborted();
    if (current.bidSetHash !== null && !checkedBidSet) {
      try {
        bidSet = checkBidSet(sale.id, await client.getBids(sale.id), current.bidSetHash, current.bidCount).matches;
      } catch {
        // The row marks the hash check unavailable.
      }
    }
    signal.throwIfAborted();
    rows[index] = checkRow(current, verification, bidSet);
    report([...rows]);
  }
}
