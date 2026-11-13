/**
 * The in-browser attestation checks (near/attestation.ts, a port of
 * enclave/deploy/Verify-Attestation.ps1) against real testnet evidence:
 * contract fairground.itzbeast.testnet, sale smoke-11120830, its create_sale
 * transaction (key run, attestation 65871, request 29835) and its close_sale
 * transaction (clearing run, attestation 66245, request 29915), saved under
 * fixtures/outlayer on 12 Nov 2026. Everything runs offline: the RPC node and
 * OutLayer's API are fakes that serve the saved answers.
 */
import { describe, expect, it } from "vitest";
import { bidSetHash } from "@fairground/clearing";
import { checkBidSet, placeOf } from "../bid-inclusion";
import { fromB64, toB64 } from "../crypto";
import {
  findSealerRun,
  parseTdxQuote,
  QUOTE_LAYOUT,
  taskHash,
  txCallsSale,
  verifyRun,
  type OutLayerAttestation,
  type RpcTransaction,
  type TxStatus,
  type VerifyRunInput,
} from "../near/attestation";
import { OUTLAYER_NETWORKS, SCAN_OFFSETS, verifySaleRuns, type VerifySaleOptions } from "../near/attestation-sources";
import type { BidRecord, RunCheckId, RunKind, TeeMeasurements } from "../types";
import attestationClear from "./fixtures/outlayer/attestation-clear.json";
import attestationKey from "./fixtures/outlayer/attestation-key.json";
import blockClear from "./fixtures/outlayer/block-clear.json";
import blockKey from "./fixtures/outlayer/block-key.json";
import jobs from "./fixtures/outlayer/jobs.json";
import txClear from "./fixtures/outlayer/tx-status-clear.json";
import txKey from "./fixtures/outlayer/tx-status-key.json";
import views from "./fixtures/outlayer/views.json";

const CONTRACT = "fairground.itzbeast.testnet";
const SALE = "smoke-11120830";
const OUTLAYER = "outlayer.testnet";
const PINNED = "f8408a875ec685394d00937cfc320c8b5e8c2a1e8398cfdf34987aa91001d8cb";
const REGISTER = OUTLAYER_NETWORKS.testnet.register;
const RPC_URL = "https://rpc.example.test";
const TX = {
  key: "9VTgvUt8FhEPq2U22wFJDWv8hVf7g6q2wD8rY8qhZdem",
  clear: "E7CEppqPTqGuT5E7eXEMTWaJGzjFrTDw4wDFmVinDVDS",
} as const;
/** The blocks the two requests ran in on the contract (what newer contracts record). */
const REQUEST_BLOCK = { key: 277_338_464, clear: 277_340_196 } as const;

const clone = <T>(v: T): T => structuredClone(v);
const fixtures = {
  attestation: { key: attestationKey as OutLayerAttestation, clear: attestationClear as OutLayerAttestation },
  tx: { key: txKey as unknown as TxStatus, clear: txClear as unknown as TxStatus },
  block: { key: blockKey, clear: blockClear },
};
const approvedFor = (kind: RunKind) => views.is_measurements_approved[kind].measurements as TeeMeasurements;

/** The register contract, as far as these runs go: it approves exactly the measurements their quotes carry. */
const register = (m: TeeMeasurements) =>
  (["key", "clear"] as const).some((k) => JSON.stringify(approvedFor(k)) === JSON.stringify(m));

function input(kind: RunKind, change: (i: { att: OutLayerAttestation; tx: TxStatus; saleKey: string; stored: { inputSha256: string; resultSha256: string } }) => void = () => {}): VerifyRunInput {
  const i = {
    att: clone(fixtures.attestation[kind]),
    tx: clone(fixtures.tx[kind]),
    saleKey: views.get_sale.sealer_pubkey,
    stored: { inputSha256: views.get_result.input_sha256, resultSha256: views.get_result.result_sha256 },
  };
  change(i);
  const quote = parseTdxQuote(i.att.tdx_quote);
  return {
    kind,
    attestation: i.att,
    tx: i.tx,
    outlayerContract: OUTLAYER,
    contractId: CONTRACT,
    saleId: SALE,
    pinnedWasm: PINNED,
    referenceWasm: PINNED,
    saleKey: i.saleKey,
    stored: kind === "clear" ? i.stored : null,
    register: REGISTER,
    measurementsApproved: "quote" in quote ? register(quote.quote.measurements) : null,
    requestBlockHeight: fixtures.attestation[kind].block_height,
  };
}

const outcome = (r: ReturnType<typeof verifyRun>) => Object.fromEntries(r.checks.map((c) => [c.id, c.ok]));
const ALL_PASS = { build: true, executed: true, input: true, output: true, task: true, measurements: true, request: true, key: true };

/** Flips the low bit of one byte of a base64 string. */
function flipB64(b64: string, at: number): string {
  const bytes = fromB64(b64);
  bytes[at] ^= 1;
  return toB64(bytes);
}

/** The request_execution call inside a transaction (to edit its arguments). */
function requestCall(tx: TxStatus) {
  for (const r of tx.receipts) {
    for (const a of r.receipt.Action?.actions ?? []) {
      if (typeof a === "object" && a.FunctionCall?.method_name === "request_execution") return { receipt: r, call: a.FunctionCall };
    }
  }
  throw new Error("no request in the fixture");
}

function editRequestArgs(tx: TxStatus, edit: (args: Record<string, unknown>) => void) {
  const { call } = requestCall(tx);
  const args = JSON.parse(new TextDecoder().decode(fromB64(call.args))) as Record<string, unknown>;
  edit(args);
  call.args = toB64(new TextEncoder().encode(JSON.stringify(args)));
}

/** The on_execution_response outcome's SuccessValue. */
function callbackStatus(tx: TxStatus) {
  const callback = tx.receipts.find((r) =>
    (r.receipt.Action?.actions ?? []).some((a) => typeof a === "object" && a.FunctionCall?.method_name === "on_execution_response"),
  )!;
  return tx.receipts_outcome.find((o) => o.id === callback.receipt_id)!.outcome.status as { SuccessValue: string };
}

describe("the recorded testnet runs", () => {
  it.each(["key", "clear"] as const)("%s run: every check passes", (kind) => {
    const r = verifyRun(input(kind));
    expect(outcome(r)).toEqual(ALL_PASS);
    expect(r.inputHash).toBe(fixtures.attestation[kind].input_hash);
    expect(r.outputHash).toBe(fixtures.attestation[kind].output_hash);
    expect(r.run.answer).toMatchObject({ ok: true, op: kind === "key" ? "pubkey" : "clear", sale_id: SALE, pubkey: views.get_sale.sealer_pubkey });
    expect(r.run.requestId).toBe(fixtures.attestation[kind].request_id);
  });

  it("reads the quote: a TDX v4 quote whose report data is the task hash, RTMR3 the worker's measurement", () => {
    for (const kind of ["key", "clear"] as const) {
      const att = fixtures.attestation[kind];
      const parsed = parseTdxQuote(att.tdx_quote);
      if (!("quote" in parsed)) throw new Error(parsed.error);
      expect(parsed.quote.reportData.slice(0, 64)).toBe(taskHash(att));
      expect(parsed.quote.reportData.slice(64)).toBe("0".repeat(64));
      expect(parsed.quote.measurements.rtmr3).toBe(att.worker_measurement);
      expect(parsed.quote.measurements).toEqual(approvedFor(kind));
    }
  });

  it("refuses a quote that is not TDX v4", () => {
    const quote = fromB64(fixtures.attestation.clear.tdx_quote);
    quote[0] = 3;
    expect(parseTdxQuote(toB64(quote))).toEqual({ error: expect.stringMatching(/version 3, tee_type 0x81, \d+ bytes: not a TDX v4 quote/) });
    expect(parseTdxQuote(toB64(quote.subarray(0, 600)))).toHaveProperty("error");
  });

  it("the clearing answer names the bid set the contract froze", () => {
    const run = findSealerRun(fixtures.tx.clear, OUTLAYER);
    expect(run.answer?.bid_set_hash).toBe(views.get_sale.bid_set_hash);
    expect(run.predecessor).toBe(CONTRACT);
    expect(run.inputFields).toEqual({ op: "clear", contract: CONTRACT, sale_id: SALE });
  });
});

describe("each check fails when one byte changes", () => {
  const failsOnly = (kind: RunKind, ids: RunCheckId[], change: Parameters<typeof input>[1]) => {
    const got = outcome(verifyRun(input(kind, change)));
    const want = { ...ALL_PASS, ...Object.fromEntries(ids.map((id) => [id, false])) };
    expect(got).toEqual(want);
  };
  const hexFlip = (h: string) => (h[0] === "0" ? "1" : "0") + h.slice(1);

  it.each(["key", "clear"] as const)("%s run", (kind) => {
    // The attested build (it is inside the task hash too).
    failsOnly(kind, ["build", "task"], ({ att }) => void (att.wasm_hash = hexFlip(att.wasm_hash)));
    // The measured build.
    failsOnly(kind, ["executed"], ({ att }) => void (att.executed_wasm_sha256 = hexFlip(att.executed_wasm_sha256!)));
    // The request's input on chain: its sha256 no longer matches.
    failsOnly(kind, ["input"], ({ tx }) =>
      editRequestArgs(tx, (args) => void (args.input_data = String(args.input_data).replace(`"v":1`, `"v":2`))),
    );
    // The bytes OutLayer returned.
    failsOnly(kind, ["output", "key"], ({ tx }) => {
      const status = callbackStatus(tx);
      status.SuccessValue = toB64(new TextEncoder().encode(new TextDecoder().decode(fromB64(status.SuccessValue)).replace(/pubkey\\":\\"2/, 'pubkey\\":\\"3')));
    });
    // A field of the record outside the hashes (the time): the quote no longer commits to it.
    failsOnly(kind, ["task"], ({ att }) => void (att.timestamp += 1));
    // The quote's report data.
    failsOnly(kind, ["task"], ({ att }) => void (att.tdx_quote = flipB64(att.tdx_quote, QUOTE_LAYOUT.reportData)));
    // The quote's report data tail must be zero.
    failsOnly(kind, ["task"], ({ att }) => void (att.tdx_quote = flipB64(att.tdx_quote, QUOTE_LAYOUT.reportData + 40)));
    // A measurement register: the register contract does not approve it.
    failsOnly(kind, ["measurements"], ({ att }) => void (att.tdx_quote = flipB64(att.tdx_quote, QUOTE_LAYOUT.rtmr[3] + 5)));
    failsOnly(kind, ["measurements"], ({ att }) => void (att.tdx_quote = flipB64(att.tdx_quote, QUOTE_LAYOUT.mrtd)));
    // Who sent the request.
    failsOnly(kind, ["request"], ({ tx }) => void (requestCall(tx).receipt.predecessor_id = "someone.testnet"));
    // The source the request named.
    failsOnly(kind, ["request"], ({ tx }) =>
      editRequestArgs(tx, (args) => {
        const source = args.source as { Project: { version_key: string } };
        source.Project.version_key = hexFlip(source.Project.version_key);
      }),
    );
    // The key the contract stored.
    failsOnly(kind, ["key"], (i) => void (i.saleKey = hexFlip(i.saleKey)));
  });

  it("clearing run: the hashes the contract stored", () => {
    failsOnly("clear", ["input"], ({ stored }) => void (stored.inputSha256 = hexFlip(stored.inputSha256)));
    failsOnly("clear", ["output"], ({ stored }) => void (stored.resultSha256 = hexFlip(stored.resultSha256)));
  });

  it("a register contract that answers false fails the measurements, and one that cannot be asked leaves it not run", () => {
    expect(outcome(verifyRun({ ...input("clear"), measurementsApproved: false })).measurements).toBe(false);
    expect(outcome(verifyRun({ ...input("clear"), measurementsApproved: null })).measurements).toBe(null);
  });

  it("an attested block that is not the request's block fails the request", () => {
    expect(outcome(verifyRun({ ...input("clear"), requestBlockHeight: REQUEST_BLOCK.clear })).request).toBe(false);
  });

  it("a transaction with no OutLayer run is refused", () => {
    const tx = clone(fixtures.tx.clear);
    tx.receipts = tx.receipts.filter((r) => r.receiver_id !== OUTLAYER);
    expect(() => verifyRun({ ...input("clear"), tx })).toThrow(/one request_execution/);
  });
});

describe("finding the transaction in a block", () => {
  const txs = (b: { chunks: object }) =>
    Object.values(b.chunks as Record<string, { transactions: RpcTransaction[] }>).flatMap((c) => c.transactions);

  it("matches close_sale and create_sale for the sale, nothing else", () => {
    const close = txs(blockClear).filter((t) => txCallsSale(t, CONTRACT, ["close_sale"], SALE));
    expect(close.map((t) => t.hash)).toEqual([TX.clear]);
    const create = txs(blockKey).filter((t) => txCallsSale(t, CONTRACT, ["create_sale", "retry_setup"], SALE));
    expect(create.map((t) => t.hash)).toEqual([TX.key]);
    expect(txs(blockClear).filter((t) => txCallsSale(t, CONTRACT, ["close_sale"], "other-sale"))).toEqual([]);
  });

  it("matches a relayed meta-transaction whose Delegate action calls the sale", () => {
    const direct = txs(blockClear).find((t) => t.hash === TX.clear)!;
    const relayed: RpcTransaction = {
      hash: "relayed",
      signer_id: "relayer.testnet",
      receiver_id: "itzbeast.testnet",
      actions: [{ Delegate: { delegate_action: { sender_id: "itzbeast.testnet", receiver_id: CONTRACT, actions: direct.actions } } }],
    };
    expect(txCallsSale(relayed, CONTRACT, ["close_sale"], SALE)).toBe(true);
    expect(txCallsSale(relayed, CONTRACT, ["create_sale"], SALE)).toBe(false);
  });
});

// ---------- the whole flow, against fake RPC and OutLayer API ----------

type Reply = { result?: unknown; error?: unknown };

/** A fake network: an RPC node (and an archival one) and OutLayer's API, serving the fixtures. */
function network(o: { prunedPrimary?: boolean; jobs?: unknown[]; attestations?: Partial<Record<string, unknown>> } = {}) {
  const calls: string[] = [];
  const blocks = { [fixtures.block.key.block.header.height]: fixtures.block.key, [fixtures.block.clear.block.header.height]: fixtures.block.clear };
  const chunks = { ...fixtures.block.key.chunks, ...fixtures.block.clear.chunks } as Record<string, unknown>;
  const heights = views.block_heights as Record<string, number>;
  const bytes = (v: unknown) => Array.from(new TextEncoder().encode(JSON.stringify(v)));
  const unknown = (name: string): Reply => ({ error: { name: "HANDLER_ERROR", cause: { name } } });

  const rpc = (url: string, method: string, params: Record<string, unknown>): Reply => {
    const history = method === "block" || method === "chunk" || method === "EXPERIMENTAL_tx_status";
    if (o.prunedPrimary && history && url === RPC_URL) return unknown("UNKNOWN_BLOCK");
    if (method === "query") {
      const args = JSON.parse(new TextDecoder().decode(fromB64(String(params.args_base64)))) as Record<string, unknown>;
      const m = String(params.method_name);
      if (params.account_id === REGISTER && m === "is_measurements_approved") return { result: { result: bytes(register(args.measurements as TeeMeasurements)) } };
      if (params.account_id === CONTRACT && m in views) return { result: { result: bytes((views as Record<string, unknown>)[m]) } };
      return { result: { error: "MethodNotFound" } };
    }
    if (method === "block") {
      const id = params.block_id;
      if (typeof id === "number") return blocks[id] ? { result: blocks[id].block } : unknown("UNKNOWN_BLOCK");
      return heights[String(id)] ? { result: { header: { height: heights[String(id)] } } } : unknown("UNKNOWN_BLOCK");
    }
    if (method === "chunk") return chunks[String(params.chunk_id)] ? { result: chunks[String(params.chunk_id)] } : unknown("UNKNOWN_CHUNK");
    if (method === "EXPERIMENTAL_tx_status") {
      const hit = params.tx_hash === TX.clear ? txClear : params.tx_hash === TX.key ? txKey : null;
      return hit && params.sender_account_id === "itzbeast.testnet" ? { result: hit } : unknown("UNKNOWN_TRANSACTION");
    }
    return unknown("METHOD_NOT_FOUND");
  };

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { id: number; method: string; params: Record<string, unknown> };
      calls.push(`${url === RPC_URL ? "rpc" : "archival"} ${body.method}${body.method === "block" ? ` ${String(body.params.block_id)}` : ""}`);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...rpc(url, body.method, body.params) }));
    }
    calls.push(`GET ${url.replace(OUTLAYER_NETWORKS.testnet.api, "")}`);
    const byTx = /\/attestations\/by-tx\/(.+)$/.exec(url);
    if (byTx) {
      const hash = decodeURIComponent(byTx[1]);
      const att = o.attestations && hash in o.attestations ? o.attestations[hash] : hash === TX.clear ? attestationClear : hash === TX.key ? attestationKey : undefined;
      return att ? new Response(JSON.stringify(att)) : new Response("", { status: 404 });
    }
    if (url.includes("/public/jobs")) {
      const offset = Number(new URL(url).searchParams.get("offset"));
      return new Response(JSON.stringify(offset === 0 ? (o.jobs ?? jobs) : []));
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function sale(v: { withBlocks?: boolean } = {}): NonNullable<VerifySaleOptions["views"]> {
  return {
    sale: { ...views.get_sale, reveal_mode: "Tee", ...(v.withBlocks ? { key_request_block: REQUEST_BLOCK.key } : {}) },
    result: { ...views.get_result, ...(v.withBlocks ? { clear_request_block: String(REQUEST_BLOCK.clear) } : {}) },
    config: views.get_config,
  };
}

const base = (fetchImpl: typeof fetch, extra: Partial<VerifySaleOptions> = {}): VerifySaleOptions => ({
  network: "testnet",
  rpcUrl: RPC_URL,
  contractId: CONTRACT,
  saleId: SALE,
  referenceWasm: PINNED,
  fetch: fetchImpl,
  now: () => 1_794_480_000_000,
  ...extra,
});

describe("verifySaleRuns", () => {
  it("finds both transactions by scanning the recorded request blocks, and every check passes", async () => {
    const net = network();
    const { verification, found } = await verifySaleRuns(base(net.fetchImpl, { views: sale({ withBlocks: true }) }));
    for (const kind of ["key", "clear"] as const) {
      const run = verification[kind];
      if (!run?.found) throw new Error(`no ${kind} run: ${JSON.stringify(run)}`);
      expect(run).toMatchObject({
        txHash: TX[kind],
        signer: "itzbeast.testnet",
        txSource: "block_scan",
        scannedBlock: REQUEST_BLOCK[kind] - SCAN_OFFSETS[0],
        attestationId: fixtures.attestation[kind].id,
        taskId: fixtures.attestation[kind].task_id,
        requestId: fixtures.attestation[kind].request_id,
        method: kind === "key" ? "create_sale" : "close_sale",
        blockHeight: fixtures.attestation[kind].block_height,
        at: fixtures.attestation[kind].timestamp * 1000,
        verifierUrl: `https://app.outlayer.ai/attestation/${fixtures.attestation[kind].task_id}?network=testnet`,
      });
      expect(run.checks.every((c) => c.ok === true)).toBe(true);
    }
    expect(verification).toMatchObject({ simulated: false, pinnedWasm: PINNED, checkedAt: 1_794_480_000_000 });
    expect(found.clear).toMatchObject({ hash: TX.clear, source: "block_scan" });
    // No job list was needed.
    expect(net.calls.some((c) => c.includes("/public/jobs"))).toBe(false);
  });

  it("on a contract that records no request block: finds both in OutLayer's job list", async () => {
    const net = network();
    const { verification } = await verifySaleRuns(base(net.fetchImpl, { views: sale() }));
    expect(verification.key).toMatchObject({ found: true, txSource: "outlayer_jobs", txHash: TX.key });
    expect(verification.clear).toMatchObject({ found: true, txSource: "outlayer_jobs", txHash: TX.clear });
    expect(net.calls).toContain("GET /public/jobs?project=itzbeast.testnet%2Ffairground-sealer&limit=100&offset=0");
  });

  it("uses this browser's log before the job list", async () => {
    const net = network({ jobs: [] });
    const { verification } = await verifySaleRuns(
      base(net.fetchImpl, {
        views: sale(),
        logged: { key: { txHash: TX.key, account: "itzbeast.testnet" }, clear: { txHash: TX.clear, account: "itzbeast.testnet" } },
      }),
    );
    expect(verification.key).toMatchObject({ found: true, txSource: "tx_log" });
    expect(verification.clear).toMatchObject({ found: true, txSource: "tx_log" });
    expect(net.calls.some((c) => c.includes("/public/jobs"))).toBe(false);
  });

  it("says so when the transaction cannot be found", async () => {
    const net = network({ jobs: [] });
    const { verification } = await verifySaleRuns(base(net.fetchImpl, { views: sale() }));
    expect(verification.clear).toMatchObject({ found: false, reason: "not_found" });
    expect(verification.key).toMatchObject({ found: false, reason: "not_found" });
  });

  it("says so when OutLayer has no attestation for the run", async () => {
    const net = network({ attestations: { [TX.clear]: undefined } });
    const { verification } = await verifySaleRuns(base(net.fetchImpl, { views: sale({ withBlocks: true }) }));
    expect(verification.clear).toMatchObject({ found: false, reason: "no_attestation" });
    expect(verification.key).toMatchObject({ found: true });
  });

  it("fails the checks of an attestation for another run", async () => {
    const net = network({ attestations: { [TX.clear]: attestationKey } });
    const { verification } = await verifySaleRuns(base(net.fetchImpl, { views: sale({ withBlocks: true }) }));
    const run = verification.clear;
    if (!run?.found) throw new Error("no clearing run");
    const failed = run.checks.filter((c) => c.ok === false).map((c) => c.id);
    expect(failed).toEqual(["input", "output", "request"]);
  });

  it("reads pruned history from the archival node", async () => {
    const net = network({ prunedPrimary: true });
    const { verification } = await verifySaleRuns(base(net.fetchImpl, { views: sale({ withBlocks: true }) }));
    expect(verification.clear).toMatchObject({ found: true, txSource: "block_scan" });
    expect(net.calls).toContain("archival EXPERIMENTAL_tx_status");
  });

  it("skips the search when the transactions are known", async () => {
    const net = network();
    const known = { clear: { hash: TX.clear, signer: "itzbeast.testnet", source: "block_scan" as const, scannedBlock: 1 } };
    const { verification } = await verifySaleRuns(base(net.fetchImpl, { views: sale(), known }));
    expect(verification.clear).toMatchObject({ found: true, txSource: "block_scan", scannedBlock: 1 });
    expect(net.calls.filter((c) => /^rpc block \d+$/.test(c))).toEqual([]);
  });

  it("has nothing to check on a commit-reveal sale", async () => {
    const net = network();
    const v = sale();
    v.sale = { ...v.sale!, reveal_mode: "CommitReveal" };
    const { verification } = await verifySaleRuns(base(net.fetchImpl, { views: v }));
    expect([verification.key, verification.clear]).toEqual([null, null]);
  });
});

describe("the bid set", () => {
  const bids: Pick<BidRecord, "index" | "bidder" | "deposit" | "ciphertext">[] = views.get_bids.map((b) => ({
    index: b.index,
    bidder: b.bidder,
    deposit: BigInt(b.deposit),
    ciphertext: b.payload,
  }));

  it("the testnet sale's one bid recomputes to the frozen hash", () => {
    const check = checkBidSet(SALE, bids, views.get_sale.bid_set_hash, views.get_sale.bid_count);
    expect(check).toMatchObject({ matches: true, count: 1, recomputed: views.get_sale.bid_set_hash });
    expect(placeOf(check, "itzbeast.testnet")).toBe(1);
    expect(placeOf(check, "someone.testnet")).toBe(null);
  });

  it("fails when a bid is changed, missing or reordered", () => {
    const stored = views.get_sale.bid_set_hash;
    const changed = [{ ...bids[0], deposit: bids[0].deposit + 1n }];
    expect(checkBidSet(SALE, changed, stored, 1).matches).toBe(false);
    const flipped = [{ ...bids[0], ciphertext: toB64(fromB64(bids[0].ciphertext).map((b, i) => (i === 0 ? b ^ 1 : b))) }];
    expect(checkBidSet(SALE, flipped, stored, 1).matches).toBe(false);
    expect(checkBidSet(SALE, [], stored, 1).matches).toBe(false);
    const extra = { index: 1, bidder: "b.testnet", deposit: 1n, ciphertext: bids[0].ciphertext };
    const two = bidSetHash(SALE, [bids[0], extra].map((b) => ({ ...b, payload: fromB64(b.ciphertext) })));
    expect(checkBidSet(SALE, [extra, bids[0]], two, 2).matches).toBe(true);
    expect(checkBidSet(SALE, [{ ...extra, index: 0 }, { ...bids[0], index: 1 }], two, 2).matches).toBe(false);
  });
});
