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
  "usage: pnpm --filter web verify-sale --contract <contract> --sale <sale-id> [--network testnet|mainnet] [--rpc <url>] [--bid-secret <file>]... [--json]";

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

async function main() {
  const { values } = parseArgs({
    options: {
      network: { type: "string", default: "testnet" },
      contract: { type: "string" },
      sale: { type: "string" },
      rpc: { type: "string" },
      "bid-secret": { type: "string", multiple: true },
      json: { type: "boolean", default: false },
    },
  });
  const network = values.network as OutLayerNetwork;
  if (network !== "testnet" && network !== "mainnet") usage("--network is testnet or mainnet.");
  const contractId = values.contract?.trim();
  const saleId = values.sale?.trim();
  if (!contractId || !saleId) usage("--contract and --sale are required.");
  const rpcUrl = values.rpc?.trim() || RPC[network];
  // Notes go to stderr in --json mode, so stdout stays one JSON object.
  const say = (line: string) => (values.json ? console.error(line) : console.log(line));
  const terms = readTerms(values["bid-secret"] ?? [], contractId, saleId, say);

  const { verification, chain: read } = await verifySaleRuns({ network, rpcUrl, contractId, saleId, bidTerms: terms });

  // The bid set: every bid the contract lists, hashed the way the contract froze it. The contract checks
  // already read get_sale and get_bids; read them here only when that failed.
  let facts = read?.facts ?? null;
  if (!facts) {
    const rpc = jsonRpc([rpcUrl]);
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

  if (values.json) {
    console.log(
      JSON.stringify(
        {
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
        },
        null,
        2,
      ),
    );
    process.exit(ok ? 0 : 1);
  }

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
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
