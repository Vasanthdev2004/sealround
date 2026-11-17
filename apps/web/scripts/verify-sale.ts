/**
 * Checks a Sealround sale from the command line, without trusting the app or
 * us: the same checks as the result page's Verified panel, read-only.
 *
 *   pnpm --filter web verify-sale --contract <contract> --sale <sale-id>
 *     [--network testnet|mainnet] [--rpc <url>] [--bid-secret <file>]... [--json]
 *
 * For each enclave run of the sale (the sale key and the clearing) it finds the
 * transaction, fetches OutLayer's attestation for it and checks the attested
 * build, the measured build, the input and output hashes, the TDX quote's
 * report data, the enclave measurements against OutLayer's register contract,
 * that the request came from the sale contract, and the job's answer
 * (src/lib/near/attestation.ts). It lists the frozen bid set from the
 * contract and recomputes its hash chain (src/lib/bid-inclusion.ts).
 *
 * Then the contract and the rules (src/lib/verify/checks.ts): the contract
 * account runs the pinned fairground.wasm and nobody holds a key to it or to
 * the sale's token; the contract stored exactly the attested output; the
 * public clearing rules hold over get_fills; every sealed bid has the fixed
 * length; a launch pool opened at the clearing price with its LP shares on the
 * contract. With --bid-secret (a live bot receipt, an MCP bid secret file, or
 * the app's exported bid secrets) it checks that bid's fill against the rule
 * at the clearing price (src/lib/verify/your-bid.ts).
 *
 * --json prints one object: `ok`, and `checks`, each with `id`, `ok` (true,
 * false, or null when it could not run) and `detail`; checks that do not
 * apply to the sale are listed under `notApplicable`.
 *
 * --all (in place of --sale) checks every sale the contract lists (get_sales),
 * oldest first: each settled or failed sale gets the same checks and one summary
 * line; sales still running are listed as not final yet. With --json it prints
 * one object with a `sales` array.
 *
 * It sends no transaction and needs no key. Exit code 0 when every check that
 * applies ran and passed, 1 when one failed or could not run, 2 on bad options.
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { checkBidSet } from "../src/lib/bid-inclusion";
import { jsonRpc, verifySaleRuns, viewCall, type OutLayerNetwork } from "../src/lib/near/attestation-sources";
import type { AttestationFact, AttestedRun, MissingRun } from "../src/lib/types";
import { CHAIN_LABELS, RUN_LABELS } from "../src/lib/verify/labels";
import type { SaleFacts } from "../src/lib/verify/facts";
import type { ChainCheck } from "../src/lib/verify/types";
import { parseBidSecretFile, type BidTerms } from "../src/lib/verify/your-bid";

const RPC: Record<OutLayerNetwork, string> = {
  testnet: "https://rpc.testnet.fastnear.com",
  mainnet: "https://rpc.mainnet.fastnear.com",
};

type BidView = { index: number; bidder: string; deposit: string; payload: string };
/** One line of the --json output. */
type CheckLine = { id: string; label: string; ok: boolean | null; detail: string };

const USAGE =
  "usage: pnpm --filter web verify-sale --contract <contract> (--sale <sale-id> | --all) [--network testnet|mainnet] [--rpc <url>] [--bid-secret <file>]... [--json]";

/** Statuses whose result is final, so every check applies. */
const FINAL = new Set(["settled", "failed"]);

/**
 * A busy RPC is asked again after 2, 6 and 18 s (plus jitter) instead of the
 * page's half-second steps. Blocks and transactions older than about two days
 * come only from the archival node, and a run of checks (CI checks every sale
 * twice in a row) can use up its rate limit; the run search would then find
 * nothing.
 */
const PATIENCE = { retries: 3, retryDelayMs: 2_000 };

/** --all checks a sale again after this pause when a check could not run (a read failed). */
const RECHECK_AFTER_MS = 30_000;

function usage(message: string): never {
  console.error(message);
  console.error(USAGE);
  process.exit(2);
}

function fact(f: AttestationFact): string {
  const mark = f.ok ? "=" : "!=";
  return f.kind === "equal" ? f.values.map((v) => `${v.label} ${v.value}`).join(` ${mark} `) : `${f.label}: ${f.value}`;
}

const detail = (items: AttestationFact[], note?: string) => [...items.map(fact), ...(note ? [note] : [])].join("; ");
const mark = (ok: boolean | null) => (ok === true ? "PASS" : ok === false ? "FAIL" : "NOT RUN");

/** Reads every --bid-secret file; keeps the terms for this sale and contract, says what it skipped. */
function readTerms(files: string[], contractId: string, saleId: string, say: (line: string) => void): BidTerms[] {
  const out: BidTerms[] = [];
  for (const file of files) {
    let terms: BidTerms[];
    try {
      terms = parseBidSecretFile(JSON.parse(readFileSync(file, "utf8")));
    } catch (e) {
      usage(`--bid-secret ${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
    for (const t of terms) {
      if (t.saleId !== saleId || (t.contract && t.contract !== contractId && !t.contract.endsWith(`:${contractId}`))) {
        say(`--bid-secret ${file}: skipped the terms of ${t.bidder} for sale ${t.saleId}${t.contract ? ` on ${t.contract}` : ""}.`);
        continue;
      }
      out.push(t);
    }
  }
  if (files.length && out.length === 0) usage(`No bid terms for sale ${saleId} on ${contractId} in the --bid-secret files.`);
  return out;
}

type Options = { network: OutLayerNetwork; contractId: string; rpcUrl: string; json: boolean; secretFiles: string[] };

/** The outcome of one sale's checks, as --json prints it. */
type SaleOutcome = {
  ok: boolean;
  network: OutLayerNetwork;
  contract: string;
  sale: string;
  checkedAt: string;
  pinnedSealer: string;
  checks: CheckLine[];
  failed: string[];
  notApplicable: { id: string; label: string; detail: string }[];
  bidders: string[];
};

type SaleRow = { sale_id: string; status: string };

async function main() {
  const { values } = parseArgs({
    options: {
      network: { type: "string", default: "testnet" },
      contract: { type: "string" },
      sale: { type: "string" },
      all: { type: "boolean", default: false },
      rpc: { type: "string" },
      "bid-secret": { type: "string", multiple: true },
      json: { type: "boolean", default: false },
    },
  });
  const network = values.network as OutLayerNetwork;
  if (network !== "testnet" && network !== "mainnet") usage("--network is testnet or mainnet.");
  const contractId = values.contract?.trim();
  const saleId = values.sale?.trim();
  if (!contractId) usage("--contract is required.");
  if (!saleId === !values.all) usage("Pass either --sale <sale-id> or --all.");
  const o: Options = {
    network,
    contractId,
    rpcUrl: values.rpc?.trim() || RPC[network],
    json: values.json ?? false,
    secretFiles: values["bid-secret"] ?? [],
  };
  if (saleId) {
    const outcome = await verifyOne(o, saleId, false);
    if (o.json) console.log(JSON.stringify(outcome, null, 2));
    process.exit(outcome.ok ? 0 : 1);
  }
  await verifyAll(o);
}

/** Every sale the contract lists, oldest first. */
async function listSales(o: Options): Promise<SaleRow[]> {
  const rpc = jsonRpc([o.rpcUrl], PATIENCE);
  const out: SaleRow[] = [];
  for (let from = 0; ; from += 50) {
    const page = await viewCall<SaleRow[]>(rpc, o.contractId, "get_sales", { from_index: from, limit: 50 });
    out.push(...page);
    if (page.length < 50) return out;
  }
}

async function verifyAll(o: Options) {
  const say = (line: string) => (o.json ? console.error(line) : console.log(line));
  const status = (s: SaleRow) => String(s.status).toLowerCase();
  const sales = await listSales(o);
  const final = sales.filter((s) => FINAL.has(status(s)));
  const running = sales.filter((s) => !FINAL.has(status(s)));
  say(`${o.contractId} (${o.network}) lists ${sales.length} sale(s): ${final.length} final, ${running.length} not final yet.`);
  const outcomes: (SaleOutcome & { status: string })[] = [];
  for (const s of final) {
    let outcome = await verifyOne(o, s.sale_id, true);
    // A check that could not run (ok null) is usually a read the RPC refused for the moment:
    // check the sale once more after a pause and keep the answer with fewer failures.
    // A check that ran and failed (ok false) is an answer from the chain; it is not retried.
    if (!outcome.ok && outcome.checks.some((c) => c.ok === null)) {
      sayFailed(say, outcome);
      say(`  ${s.sale_id}: a check could not run; checking the sale again in ${RECHECK_AFTER_MS / 1000} s`);
      await new Promise((r) => setTimeout(r, RECHECK_AFTER_MS));
      const again = await verifyOne(o, s.sale_id, true);
      if (again.failed.length < outcome.failed.length) outcome = again;
    }
    outcomes.push({ ...outcome, status: status(s) });
    const passed = outcome.checks.filter((c) => c.ok === true).length;
    const head = `${s.sale_id} (${status(s)}): ${passed} of ${outcome.checks.length} checks`;
    say(outcome.ok ? `[PASS] ${head}` : `[FAIL] ${head}; failed or not run: ${outcome.failed.join(", ")}`);
    if (!outcome.ok) sayFailed(say, outcome);
  }
  for (const s of running) say(`[OPEN] ${s.sale_id} (${status(s)}): not final yet, checked once it settles`);
  const ok = outcomes.every((x) => x.ok);
  if (o.json) {
    const notFinal = running.map((s) => ({ sale: s.sale_id, status: status(s) }));
    console.log(JSON.stringify({ ok, network: o.network, contract: o.contractId, checkedAt: new Date().toISOString(), sales: outcomes, notFinal }, null, 2));
  } else {
    const bad = outcomes.filter((x) => !x.ok).map((x) => x.sale);
    say("");
    say(ok ? `Every final sale passed every check (${outcomes.length}).` : `Some sales failed or could not be checked: ${bad.join(", ")}.`);
  }
  process.exit(ok ? 0 : 1);
}

/** One line per check that failed or could not run, with its detail (cut to 400 characters). */
function sayFailed(say: (line: string) => void, outcome: SaleOutcome) {
  for (const c of outcome.checks.filter((c) => c.ok !== true)) say(`  ${c.ok === null ? "not run" : "failed"} ${c.id}: ${c.detail}`.slice(0, 400));
}

/** Runs every check for one sale. Prints the full report unless `quiet` or --json; returns the outcome. */
async function verifyOne(o: Options, saleId: string, quiet: boolean): Promise<SaleOutcome> {
  const { network, contractId, rpcUrl } = o;
  // Notes go to stderr in --json mode, so stdout stays one JSON object.
  const say = (line: string) => (o.json ? console.error(line) : console.log(line));
  const terms = quiet ? [] : readTerms(o.secretFiles, contractId, saleId, say);

  const { verification, chain: read } = await verifySaleRuns({
    network,
    rpcUrl,
    contractId,
    saleId,
    bidTerms: terms,
    rpcPatience: PATIENCE,
  });

  // The bid set: every bid the contract lists, hashed the way the contract froze it. The contract checks
  // already read get_sale and get_bids; read them here only when that failed.
  let facts = read?.facts ?? null;
  if (!facts) {
    const rpc = jsonRpc([rpcUrl], PATIENCE);
    const sale = await viewCall<{ bid_count: number; bid_set_hash: string; closed_at: string | null }>(rpc, contractId, "get_sale", {
      sale_id: saleId,
    });
    const bids: BidView[] = [];
    for (let from = 0; from < sale.bid_count; from += 50) {
      bids.push(...(await viewCall<BidView[]>(rpc, contractId, "get_bids", { sale_id: saleId, from_index: from, limit: 50 })));
    }
    facts = {
      bidCount: sale.bid_count,
      bidSetHash: sale.closed_at ? sale.bid_set_hash : null,
      bids: bids.map((b) => ({ index: b.index, bidder: b.bidder, deposit: BigInt(b.deposit), payload: b.payload })),
    } as SaleFacts;
  }
  const closed = facts.bidSetHash !== null;
  const bidSet = checkBidSet(
    saleId,
    facts.bids.map((b) => ({ index: b.index, bidder: b.bidder, deposit: b.deposit, ciphertext: b.payload })),
    facts.bidSetHash,
    facts.bidCount,
  );

  const runs = [verification.key, verification.clear].filter((r): r is AttestedRun | MissingRun => r !== null);
  const chain: ChainCheck[] = verification.chain?.checks ?? [];
  const applying = chain.filter((c) => c.applies);
  const skipped = chain.filter((c) => !c.applies);

  // Every check as one flat list, the shape CI reads.
  const lines: CheckLine[] = [];
  for (const run of runs) {
    const name = run.kind === "clear" ? "Clearing run" : "Sale key run";
    if (!run.found) {
      lines.push({ id: `${run.kind}.found`, label: `${name} found and attested`, ok: null, detail: `${run.reason}: ${run.message}` });
      continue;
    }
    for (const c of run.checks) lines.push({ id: `${run.kind}.${c.id}`, label: `${name}: ${RUN_LABELS[c.id]}`, ok: c.ok, detail: detail(c.items) });
  }
  if (closed) {
    lines.push({
      id: "bid_set",
      label: "Recomputed bid set matches the frozen hash",
      ok: bidSet.matches,
      detail: `${bidSet.count} of ${bidSet.expectedCount} bids listed; recomputed ${bidSet.recomputed} ${bidSet.matches ? "=" : "!="} frozen ${bidSet.stored}`,
    });
  }
  for (const c of applying) {
    lines.push({ id: c.subject ? `${c.id}:${c.subject}` : c.id, label: CHAIN_LABELS[c.id], ok: c.ok, detail: detail(c.items, c.note) });
  }
  const failed = lines.filter((l) => l.ok !== true);
  const ok = failed.length === 0;

  const outcome: SaleOutcome = {
    ok,
    network,
    contract: contractId,
    sale: saleId,
    checkedAt: new Date(verification.checkedAt).toISOString(),
    pinnedSealer: verification.pinnedWasm,
    checks: lines,
    failed: failed.map((l) => l.id),
    notApplicable: skipped.map((c) => ({ id: c.subject ? `${c.id}:${c.subject}` : c.id, label: CHAIN_LABELS[c.id], detail: c.note ?? "" })),
    bidders: bidSet.bidders,
  };
  if (o.json || quiet) return outcome;

  console.log(`Sale ${saleId} on ${contractId} (${network}); the contract pins sealer ${verification.pinnedWasm}`);
  for (const run of runs) {
    const name = run.kind === "clear" ? "Clearing run" : "Sale key run";
    console.log("");
    if (!run.found) {
      console.log(`${name}: NOT CHECKED (${run.reason}) ${run.message}`);
      continue;
    }
    console.log(`${name}: ${run.method ?? "tx"} ${run.txHash} signed by ${run.signer}, found via ${run.txSource}`);
    console.log(
      `  attestation #${run.attestationId}, request ${run.requestId ?? "?"}, block ${run.blockHeight ?? "?"} at ${new Date(run.at).toISOString()}`,
    );
    for (const check of run.checks) {
      console.log(`  [${mark(check.ok)}] ${RUN_LABELS[check.id]}`);
      for (const item of check.items) console.log(`         ${fact(item)}`);
    }
    if (run.verifierUrl) console.log(`  Not checked here: the quote's signature chain up to Intel. OutLayer's verifier: ${run.verifierUrl}`);
  }
  console.log("");
  if (closed) {
    console.log(
      `Bid set: [${bidSet.matches ? "PASS" : "FAIL"}] ${bidSet.count} of ${bidSet.expectedCount} bids listed; recomputed ${bidSet.recomputed} ${bidSet.matches ? "=" : "!="} frozen ${bidSet.stored}`,
    );
    bidSet.bidders.forEach((bidder, i) => console.log(`  #${i + 1} ${bidder}`));
  } else {
    console.log(`Bid set: not frozen yet (${bidSet.count} bids so far, running hash ${bidSet.recomputed}).`);
  }
  console.log("");
  console.log("Contract and rules:");
  for (const c of chain) {
    console.log(`  [${c.applies ? mark(c.ok) : "N/A"}] ${CHAIN_LABELS[c.id]}`);
    for (const item of c.items) console.log(`         ${fact(item)}`);
    if (c.note) console.log(`         ${c.note}`);
  }
  if (!terms.length) console.log("  Your bid: pass --bid-secret <file> to check a bid's fill against the rule from its own terms.");
  console.log("");
  console.log(ok ? "Every check passed." : `Some checks failed or could not run: ${failed.map((l) => l.id).join(", ")}.`);
  return outcome;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
