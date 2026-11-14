import type { FairgroundClient } from "@/lib/client";
import { MAX_BIDS_PER_SALE } from "@/lib/client/rules";
import { readDemoView } from "@/lib/chapters/demo";
import { seriesFor, type ChapterRound } from "@/lib/chapters/model";
import { chapterLink } from "@/lib/chapters/reminders";
import { resolveChapterSandbox } from "@/lib/chapters/sandbox";
import type { ChapterPayout } from "@/lib/chapters/verification";
import { ACCOUNT_ID, type AppConfig } from "@/lib/config";
import { OUTLAYER_NETWORKS, readTx } from "@/lib/near/attestation-sources";
import { createRpc } from "@/lib/near/rpc";
import type { BidView } from "@/lib/near/views";
import { REPO_URL } from "@/lib/site";
import { base58Decode } from "@/lib/verify/base58";
import { checkLengths } from "@/lib/verify/checks";
import type { FactBid } from "@/lib/verify/facts";
import { jsonRpc } from "@/lib/verify/rpc";
import { verifyHref } from "../verify-hub/public-evidence";
import type { ListedSale, VerificationRow } from "../verify-hub/verify-all";
import attacksJson from "../../../../../evidence/attacks.json";
import manifest from "../../../../../evidence/outlayer/manifest.json";

export type CheckId = "sales" | "bids" | "ci" | "outlayer" | "attacks" | "chapters";
type CheckLink = { href: string; label: string; detail?: string };
export type JudgeResult = {
  state: "passed" | "failed" | "unavailable" | "pending" | "listed";
  detail: string;
  links?: CheckLink[];
};

type AttackEvidence = { id: string; title: string; test: string; tx?: { hash: string; network: string; signer?: string } };
type CheckClient = Pick<FairgroundClient, "getBids" | "getSale">;
const attacks: readonly AttackEvidence[] = attacksJson;
const PAGE_SIZE = 50;
const MAX_CHAPTER_ROUNDS = 64;
export const WORKFLOW_URL = `${REPO_URL}/actions/workflows/check.yml?query=branch%3Amain`;
export const MANIFEST_URL = `${REPO_URL}/blob/main/evidence/outlayer/manifest.json`;

function validHash(hash: string) {
  return hash.length >= 32 && hash.length <= 44 && base58Decode(hash)?.length === 32;
}

export function summarizeSales(rows: VerificationRow[]): JudgeResult {
  const final = rows.filter(({ sale }) => sale.status === "settled" || sale.status === "failed");
  if (!final.length) return { state: "pending", detail: "No final sales to check yet." };
  const passed = final.filter(({ result }) => !!result && result.passed === result.total).length;
  const failed = final.some(({ result }) => !!result?.failed.length);
  return {
    state: failed ? "failed" : passed === final.length ? "passed" : "unavailable",
    detail: `${passed} of ${final.length} final sales passed every applicable check. ${rows.length - final.length} still in progress.`,
    links: final.map(({ sale, result }) => ({
      href: verifyHref(sale.id), label: sale.id,
      detail: result ? `${result.passed}/${result.total} passed${result.failed.length ? ` · Failed ${result.failed.join(", ")}` : ""}${result.unavailable.length ? ` · Unavailable ${result.unavailable.join(", ")}` : ""}` : "Verification unavailable",
    })),
  };
}

export async function checkBidSizes(app: AppConfig, client: Pick<CheckClient, "getBids">, sales: ListedSale[], signal: AbortSignal): Promise<JudgeResult> {
  const rpc = app.mode === "near" ? createRpc(app.near.rpcUrls ?? app.near.rpcUrl) : null;
  let checked = 0;
  const failed: string[] = [];
  const missing: string[] = [];
  for (const sale of sales) {
    signal.throwIfAborted();
    if (!Number.isInteger(sale.bidCount) || sale.bidCount < 0 || sale.bidCount > MAX_BIDS_PER_SALE) {
      missing.push(sale.id);
      continue;
    }
    if (!sale.bidCount) continue;
    try {
      const bids: FactBid[] = [];
      if (app.mode === "near" && rpc) {
        for (let from = 0; from < sale.bidCount; from += PAGE_SIZE) {
          signal.throwIfAborted();
          const page = await rpc.view<BidView[]>(app.near.contractId, "get_bids", {
            sale_id: sale.id, from_index: from, limit: Math.min(PAGE_SIZE, sale.bidCount - from),
          });
          bids.push(...page.map(({ index, bidder, payload }) => ({ index, bidder, payload, deposit: 0n })));
        }
      } else {
        bids.push(...(await client.getBids(sale.id)).slice(0, sale.bidCount)
          .map(({ index, bidder, ciphertext }) => ({ index, bidder, payload: ciphertext, deposit: 0n })));
      }
      if (bids.length !== sale.bidCount || bids.some(({ index, bidder }, i) => index !== i || !ACCOUNT_ID.test(bidder))) {
        missing.push(sale.id);
        continue;
      }
      checked += bids.length;
      if (!checkLengths({ saleId: sale.id, mode: sale.mode, bids }).ok) failed.push(sale.id);
    } catch {
      signal.throwIfAborted();
      missing.push(sale.id);
    }
  }
  const summary = `${checked} recorded bids checked. Sealed bids use an exact size for each sale and bidder. Commitments are 32 bytes.`;
  return {
    state: failed.length ? "failed" : missing.length ? "unavailable" : checked ? "passed" : "pending",
    detail: checked || missing.length ? summary : "No bids to check yet.",
    links: [
      ...failed.map((id) => ({ href: verifyHref(id), label: id, detail: "Unexpected bid size" })),
      ...missing.map((id) => ({ href: verifyHref(id), label: id, detail: "Incomplete bid list" })),
    ],
  };
}

type WorkflowRun = { id?: number; head_sha?: string; status?: string; conclusion?: string | null };

export async function checkCI(signal: AbortSignal): Promise<JudgeResult> {
  const repo = new URL(REPO_URL).pathname;
  const response = await fetch(`https://api.github.com/repos${repo}/actions/workflows/check.yml/runs?branch=main&per_page=1`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) {
    return { state: "unavailable", detail: `GitHub did not provide a public workflow result (HTTP ${response.status}).` };
  }
  const { workflow_runs } = await response.json() as { workflow_runs?: WorkflowRun[] };
  const run = workflow_runs?.[0];
  if (!run || !Number.isSafeInteger(run.id) || !run.head_sha || !/^[a-f\d]{40}$/.test(run.head_sha) || !run.status) {
    return { state: "unavailable", detail: "No workflow result was available on main." };
  }
  const state = run.status !== "completed" ? "pending" : run.conclusion === "success" ? "passed"
    : run.conclusion === "failure" || run.conclusion === "timed_out" ? "failed" : "unavailable";
  return {
    state,
    detail: `Latest Check workflow on main · ${(run.conclusion ?? run.status).replaceAll("_", " ")} · ${run.head_sha.slice(0, 8)}.`,
    links: [{ href: `${REPO_URL}/actions/runs/${run.id}`, label: "Open this workflow run" }],
  };
}

export function listOutLayerEvidence(): JudgeResult {
  const runs = manifest.runs;
  const complete = runs.length > 0 && new Set(runs.map(({ transaction }) => transaction)).size === runs.length
    && runs.every(({ contract, transaction, bundle, bundle_sha256 }) => (
      ACCOUNT_ID.test(contract) && validHash(transaction) && /^[\w-]+\/[\w-]+\.json$/.test(bundle)
      && /^[a-f\d]{64}$/.test(bundle_sha256)
    ));
  return {
    state: complete ? "listed" : "failed",
    detail: complete
      ? `${runs.length} testnet proof bundles recorded. The manifest contains offline verifier results. Run all lists them for inspection.`
      : "The manifest contains missing or invalid proof metadata.",
    links: complete ? runs.map(({ sale, run, bundle, verdict }) => ({
      label: `${sale} · ${run}`, href: `${REPO_URL}/blob/main/evidence/outlayer/${bundle}`, detail: verdict.overall,
    })) : [],
  };
}

export async function checkAttackEvidence(app: AppConfig, signal: AbortSignal): Promise<JudgeResult> {
  if (!attacks.length || attacks.some(({ id, test, tx }) => (
    !/^[a-z0-9-]+$/.test(id) || !test.includes("::")
    || (tx && (!validHash(tx.hash) || !["testnet", "mainnet"].includes(tx.network)))
  )) || new Set(attacks.map(({ id }) => id)).size !== attacks.length) {
    return { state: "failed", detail: "The attack evidence index contains invalid entries." };
  }
  const links: CheckLink[] = [];
  let confirmed = 0;
  let mismatched = 0;
  let unavailable = 0;
  for (const { id, title, tx } of attacks) {
    signal.throwIfAborted();
    let detail = "Transaction pending";
    if (tx) {
      detail = "Published transaction link";
      if (app.mode === "near" && app.near.network === tx.network && tx.signer && ACCOUNT_ID.test(tx.signer)) {
        const { hash, signer } = tx;
        const archival = OUTLAYER_NETWORKS[tx.network as "mainnet" | "testnet"].archivalRpc;
        const rpc = jsonRpc([...new Set([...(app.near.rpcUrls ?? [app.near.rpcUrl]), archival])], { timeoutMs: 8_000, retries: 0 });
        try {
          type FinalTx = Awaited<ReturnType<typeof readTx>> & { final_execution_status?: string };
          const seen: FinalTx = await rpc<FinalTx>("tx_status", {
            tx_hash: hash, sender_account_id: signer, wait_until: "FINAL",
          }).catch((error: unknown) => {
            if (!(error instanceof Error) || !/method[\s_-]*not[\s_-]*found/i.test(error.message)) throw error;
            return readTx(rpc, hash, signer);
          });
          if (seen.transaction?.hash === tx.hash && seen.transaction.signer_id === tx.signer
            && seen.receipts_outcome?.length > 0 && seen.final_execution_status === "FINAL") {
            confirmed++;
            detail = "Final transaction and receipt outcomes found";
          } else if (seen.transaction?.hash !== tx.hash || seen.transaction.signer_id !== tx.signer) {
            mismatched++;
            detail = "Transaction identity did not match";
          } else {
            unavailable++;
            detail = "Final receipt outcomes were unavailable";
          }
        } catch {
          unavailable++;
          detail = "Could not read final transaction receipts";
        }
      }
    }
    links.push({ href: `/attack#${id}`, label: title, detail });
  }
  const published = attacks.filter(({ tx }) => tx !== undefined).length;
  return {
    state: mismatched ? "failed" : unavailable ? "unavailable" : confirmed === attacks.length ? "passed" : "listed",
    detail: `${attacks.length} cases cite tests. ${published} published transaction links, ${attacks.length - published} pending. ${confirmed} final transaction records checked this run.`,
    links,
  };
}

export async function checkChapters(app: AppConfig, client: Pick<CheckClient, "getSale">, sales: ListedSale[], signal: AbortSignal): Promise<JudgeResult> {
  const links: CheckLink[] = [];
  let linkedPaid = false;
  let stories = 0;
  let paid = 0;
  let incomplete = false;
  if (app.mode === "near" && (app.near.network === "mainnet" || (!process.env.NEXT_PUBLIC_CHAPTERS_FACTORY
    && !(app.near.network === "sandbox" && process.env.NEXT_PUBLIC_CHAPTERS_CONTRACT)))) {
    return { state: "pending", detail: "Chapters is awaiting configuration on this network." };
  }
  for (const listed of sales) {
    signal.throwIfAborted();
    if (listed.status !== "settled") continue;
    try {
      const sale = await client.getSale(listed.id);
      if (!sale) { incomplete = true; continue; }
      const series = seriesFor(sale);
      const sandbox = app.mode === "near" ? await resolveChapterSandbox(sale, app) : null;
      if (app.mode === "near" && !sandbox) continue;
      let rounds: ChapterRound[];
      if (sandbox) {
        const count = await sandbox.rpc.view<number>(sandbox.contract, "get_round_count");
        if (!Number.isInteger(count) || count < 0 || count > MAX_CHAPTER_ROUNDS) { incomplete = true; continue; }
        rounds = [];
        for (let id = 1; id <= count; id++) {
          signal.throwIfAborted();
          const round = await sandbox.rpc.view<ChapterRound | null>(sandbox.contract, "get_round", { round_id: id });
          if (round?.round_id !== id) { incomplete = true; break; }
          rounds.push(round);
        }
      } else {
        rounds = readDemoView(null, series).rounds;
      }
      if (!rounds.length && !sandbox) continue;
      stories++;
      let previousWinner: { digest: string; paid: boolean } | null = null;
      for (const round of rounds) {
        signal.throwIfAborted();
        const winner = round.winner !== null ? round.candidates[round.winner] : undefined;
        let winnerPaid = round.phase === "finalized" && !!winner && round.bounty_state === "paid";
        if (winnerPaid && winner && sandbox) {
          const record = await sandbox.rpc.view<ChapterPayout | null>(sandbox.contract, "get_payout", { round_id: round.round_id });
          winnerPaid = !!record && record.state === "paid" && record.paid_at != null && record.recipient === winner.artist
            && record.amount === round.bounty && record.token_id === sandbox.quote;
          if (!winnerPaid) incomplete = true;
        }
        if (winnerPaid) paid++;
        if (winnerPaid && previousWinner?.paid && previousWinner.digest === round.parent_sha256) linkedPaid = true;
        if (winner) previousWinner = { digest: winner.content_sha256, paid: winnerPaid };
        links.push({ href: chapterLink(round.round_id, sale.id), label: `${sale.config.tokenName} · Chapter ${round.round_id}`,
          detail: winnerPaid ? "Winning artist payout recorded" : round.phase.replaceAll("_", " ") });
      }
    } catch {
      signal.throwIfAborted();
      incomplete = true;
    }
  }
  return {
    state: incomplete ? "unavailable" : linkedPaid ? "passed" : "pending",
    detail: stories
      ? `${stories} stories and ${paid} winning artist payout records. ${linkedPaid ? "Two linked chapters show both payouts recorded." : "Awaiting two linked chapters with both payouts recorded."}`
      : "No Chapter rounds found for the settled tokens.",
    links,
  };
}
