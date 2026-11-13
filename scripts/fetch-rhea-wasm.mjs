#!/usr/bin/env node
// Fetches the Rhea (Ref Finance) exchange wasm that the sandbox integration
// tests deploy (contracts/tests, launch liquidity) and saves it to
// contracts/tests/res/ref_exchange.wasm.
//
// The file is not in git: its licence is not confirmed, so the repository
// does not redistribute it. This script reads the code that is deployed on
// ref-finance-101.testnet with the read-only RPC `view_code` query and keeps
// it only if its sha256 matches the pinned v1.9.19 build the tests were
// written against. If the exchange has been upgraded since, it reads the
// pinned block from an archival node instead.
//
// Usage: node scripts/fetch-rhea-wasm.mjs
// scripts/test-contracts.ps1 runs it before the integration tests.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ACCOUNT = "ref-finance-101.testnet";
const PINNED_SHA256 = "8918c505017ceb57646bdd863c34e4fe56e2edc7756963d6f4a1f38d6f9c34d2";
// The block the pinned copy was first read at (12 Nov 2026), for the archival fallback.
const PINNED_BLOCK = 277_345_406;
const SOURCES = [
  { rpc: "https://rpc.testnet.near.org", at: { finality: "final" } },
  { rpc: "https://archival-rpc.testnet.fastnear.com", at: { block_id: PINNED_BLOCK } },
];

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(repoRoot, "contracts", "tests", "res", "ref_exchange.wasm");
const shown = relative(process.cwd(), target) || target;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function viewCode({ rpc, at }) {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "query",
      params: { request_type: "view_code", account_id: ACCOUNT, ...at },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(body.error.data ?? body.error.message ?? JSON.stringify(body.error));
  return Buffer.from(body.result.code_base64, "base64");
}

if (existsSync(target) && sha256(readFileSync(target)) === PINNED_SHA256) {
  console.log(`${shown}: already present, sha256 matches.`);
  process.exit(0);
}

for (const source of SOURCES) {
  const where = "block_id" in source.at ? `block ${source.at.block_id}` : "the latest final block";
  try {
    const code = await viewCode(source);
    const got = sha256(code);
    if (got !== PINNED_SHA256) {
      console.log(`${source.rpc} (${where}): code sha256 ${got} is not the pinned build, trying the next source.`);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, code);
    console.log(`${shown}: fetched from ${ACCOUNT} at ${where} (${code.length} bytes), sha256 matches.`);
    process.exit(0);
  } catch (error) {
    console.log(`${source.rpc} (${where}): ${error instanceof Error ? error.message : error}`);
  }
}

console.error(
  `Could not fetch the pinned Rhea exchange wasm (sha256 ${PINNED_SHA256}). ` +
    `The integration tests that deploy a launch pool need it. See contracts/tests/res/NOTICE.md.`,
);
process.exit(1);
