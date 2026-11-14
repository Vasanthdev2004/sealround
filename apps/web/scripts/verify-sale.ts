/**
 * Checks a Sealround sale from the command line, without trusting the app or
 * us: the same checks as the result page's Verified panel, read-only.
 *
 *   pnpm --filter web verify-sale --contract <contract> --sale <sale-id> [--network testnet|mainnet] [--rpc <url>] [--json]
 *
 * For each enclave run of the sale (the sale key and the clearing) it finds the
 * transaction, fetches OutLayer's attestation for it and checks the attested
 * build, the measured build, the input and output hashes, the TDX quote's
 * report data, the enclave measurements against OutLayer's register contract,
 * that the request came from the sale contract, and the job's answer
 * (src/lib/near/attestation.ts). Then it lists the frozen bid set from the
 * contract and recomputes its hash chain (src/lib/bid-inclusion.ts).
 *
 * It sends no transaction and needs no key. Exit code 0 when every check that
 * ran passed, 1 when one failed or could not run, 2 on bad options.
 */

import { parseArgs } from "node:util";
import { checkBidSet } from "../src/lib/bid-inclusion";
import { jsonRpc, verifySaleRuns, viewCall, type OutLayerNetwork } from "../src/lib/near/attestation-sources";
import type { AttestationFact, AttestedRun, MissingRun, RunCheckId } from "../src/lib/types";

const RPC: Record<OutLayerNetwork, string> = {
  testnet: "https://rpc.testnet.fastnear.com",
  mainnet: "https://rpc.mainnet.fastnear.com",
};

/** The Verified panel's wording (src/components/result/verified-panel.tsx). */
const LABELS: Record<RunCheckId, string> = {
  build: "Attested build is the sealer the contract pins",
  executed: "The worker measured the same build",
  input: "Input hash matches the request on chain",
  output: "Output hash matches what the contract received",
  task: "The TDX quote commits to this record",
  measurements: "Enclave measurements are approved on chain",
  request: "The request came from the sale contract, for this sale",
  key: "The job's answer names the sale's key",
};

type BidView = { index: number; bidder: string; deposit: string; payload: string };

function usage(message: string): never {
  console.error(message);
  console.error("usage: pnpm --filter web verify-sale --contract <contract> --sale <sale-id> [--network testnet|mainnet] [--rpc <url>] [--json]");
  process.exit(2);
}

function fact(f: AttestationFact): string {
  const mark = f.ok ? "=" : "!=";
  return f.kind === "equal" ? f.values.map((v) => `${v.label} ${v.value}`).join(` ${mark} `) : `${f.label}: ${f.value}`;
}

async function main() {
  const { values } = parseArgs({
    options: {
      network: { type: "string", default: "testnet" },
      contract: { type: "string" },
      sale: { type: "string" },
      rpc: { type: "string" },
      json: { type: "boolean", default: false },
    },
  });
  const network = values.network as OutLayerNetwork;
  if (network !== "testnet" && network !== "mainnet") usage("--network is testnet or mainnet.");
  const contractId = values.contract?.trim();
  const saleId = values.sale?.trim();
  if (!contractId || !saleId) usage("--contract and --sale are required.");
  const rpcUrl = values.rpc?.trim() || RPC[network];

  const { verification } = await verifySaleRuns({ network, rpcUrl, contractId, saleId });

  // The bid set: every bid the contract lists, hashed the way the contract froze it.
  const rpc = jsonRpc([rpcUrl]);
  const sale = await viewCall<{ bid_count: number; bid_set_hash: string; closed_at: string | null }>(rpc, contractId, "get_sale", {
    sale_id: saleId,
  });
  const bids: BidView[] = [];
  for (let from = 0; from < sale.bid_count; from += 50) {
    bids.push(...(await viewCall<BidView[]>(rpc, contractId, "get_bids", { sale_id: saleId, from_index: from, limit: 50 })));
  }
  const bidSet = checkBidSet(
    saleId,
    bids.map((b) => ({ index: b.index, bidder: b.bidder, deposit: BigInt(b.deposit), ciphertext: b.payload })),
    sale.closed_at ? sale.bid_set_hash : null,
    sale.bid_count,
  );

  const runs = [verification.key, verification.clear].filter((r): r is AttestedRun | MissingRun => r !== null);
  const failed =
    runs.some((r) => !r.found || r.checks.some((c) => c.ok !== true)) || (sale.closed_at !== null && !bidSet.matches);

  if (values.json) {
    console.log(JSON.stringify({ network, contractId, saleId, verification, bidSet, ok: !failed }, null, 2));
    process.exit(failed ? 1 : 0);
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
      const mark = check.ok === true ? "PASS" : check.ok === false ? "FAIL" : "NOT RUN";
      console.log(`  [${mark}] ${LABELS[check.id]}`);
      for (const item of check.items) console.log(`         ${fact(item)}`);
    }
    if (run.verifierUrl) console.log(`  Not checked here: the quote's signature chain up to Intel. OutLayer's verifier: ${run.verifierUrl}`);
  }
  console.log("");
  if (sale.closed_at) {
    console.log(
      `Bid set: [${bidSet.matches ? "PASS" : "FAIL"}] ${bidSet.count} of ${bidSet.expectedCount} bids listed; recomputed ${bidSet.recomputed} ${bidSet.matches ? "=" : "!="} frozen ${bidSet.stored}`,
    );
    bidSet.bidders.forEach((bidder, i) => console.log(`  #${i + 1} ${bidder}`));
  } else {
    console.log(`Bid set: not frozen yet (${bidSet.count} bids so far, running hash ${bidSet.recomputed}).`);
  }
  console.log("");
  console.log(failed ? "Some checks failed or could not run." : "Every check passed.");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
