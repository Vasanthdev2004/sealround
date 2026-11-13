/**
 * Fetches what near/attestation.ts checks, read-only: the sale contract's
 * views, the transaction behind each sealer run (NEAR JSON-RPC), OutLayer's
 * attestation record for it (OutLayer's public API, CORS open to all
 * origins) and the register contract's answer about the TEE measurements.
 * Nothing is signed or sent.
 *
 * The contract does not store transaction hashes, so the transaction behind
 * a run is found, in this order:
 * 1. by scanning the block the contract recorded for the request
 *    (get_result.clear_request_block, get_sale.key_request_block) and the
 *    few blocks before it for a transaction to the sale contract calling
 *    close_sale, create_sale or retry_setup for this sale, directly or inside
 *    a NEP-366 Delegate action (a relayed meta-transaction);
 * 2. from this browser's own log of what it sent (near/tx-log.ts);
 * 3. from OutLayer's public job list for the sealer project
 *    (GET /public/jobs?project=...), each candidate confirmed by reading its
 *    transaction. Jobs carry the transaction hash and its signer.
 * Every candidate is confirmed: its receipts must hold a request_execution
 * from the sale contract for this sale and op.
 *
 * Old transactions and blocks are pruned from regular RPC nodes after a few
 * days, so history calls fall back to a public archival node.
 */

import type { AttestedRun, MissingRun, RunKind, RunTxSource, SaleVerification } from "../types";
import {
  calledMethod,
  findSealerRun,
  parseTdxQuote,
  RUN_METHODS,
  RUN_OP,
  RunNotFoundError,
  txCallsSale,
  verifierUrl,
  verifyRun,
  type OutLayerAttestation,
  type RpcTransaction,
  type TxStatus,
} from "./attestation";

export type OutLayerNetwork = "testnet" | "mainnet";

/** OutLayer's public API, its register contract, and an archival RPC per network (enclave/deploy/networks.json). */
export const OUTLAYER_NETWORKS: Record<OutLayerNetwork, { api: string; register: string; archivalRpc: string }> = {
  testnet: {
    api: "https://testnet-api.outlayer.ai",
    register: "worker.outlayer.testnet",
    archivalRpc: "https://archival-rpc.testnet.fastnear.com",
  },
  mainnet: {
    api: "https://api.outlayer.ai",
    register: "worker.outlayer.near",
    archivalRpc: "https://archival-rpc.mainnet.fastnear.com",
  },
};

/** Looked up per call on the global object: a detached `window.fetch` throws "Illegal invocation" in some browsers. */
const globalFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

const utf8 = new TextEncoder();
function toBase64(text: string): string {
  let s = "";
  utf8.encode(text).forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s);
}

// ---------- JSON-RPC with an archival fallback ----------

export type JsonRpc = <T>(method: string, params: unknown) => Promise<T>;

/**
 * JSON-RPC over fetch. Tries each URL in turn and moves to the next when a
 * node fails or refuses (unreachable, rate limited, or the block or
 * transaction is pruned there). Throws the last error.
 */
export function jsonRpc(urls: string[], opts: { fetch?: typeof fetch; timeoutMs?: number } = {}): JsonRpc {
  const fetchImpl = opts.fetch ?? globalFetch;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  let id = 1;
  return async <T>(method: string, params: unknown): Promise<T> => {
    let last: unknown = new Error("no RPC URL");
    for (const url of urls) {
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
        const reply = (await res.json()) as { result?: T; error?: { cause?: { name?: string }; name?: string; data?: unknown; message?: string } };
        if (reply.error) {
          const e = reply.error;
          const detail = typeof e.data === "string" ? e.data : (e.message ?? "");
          throw new Error(`${method}: ${e.cause?.name ?? e.name ?? "error"} ${detail}`.trim());
        }
        if (reply.result === undefined) throw new Error(`${method}: empty answer`);
        return reply.result;
      } catch (e) {
        last = e;
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  };
}

/** A view call (finality final), its JSON result parsed. */
export async function viewCall<T>(rpc: JsonRpc, account: string, method: string, args: Record<string, unknown>): Promise<T> {
  const r = await rpc<{ result?: number[]; error?: string }>("query", {
    request_type: "call_function",
    finality: "final",
    account_id: account,
    method_name: method,
    args_base64: toBase64(JSON.stringify(args)),
  });
  if (typeof r.error === "string") throw new Error(`${account}.${method}: ${r.error.slice(0, 200)}`);
  const text = new TextDecoder().decode(Uint8Array.from(r.result ?? []));
  return (text === "" ? null : JSON.parse(text)) as T;
}

// ---------- OutLayer's public API ----------

/** One row of GET /public/jobs. */
export type OutLayerJob = {
  job_id: number;
  request_id: number;
  user_account_id: string | null;
  transaction_hash: string | null;
  project_id: string | null;
  created_at: string;
  success?: boolean | null;
};

async function getJson<T>(fetchImpl: typeof fetch, url: string): Promise<T | null> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** The attestation OutLayer filed for a transaction's run; null when it has none. */
export function fetchAttestationByTx(api: string, txHash: string, fetchImpl: typeof fetch = globalFetch) {
  return getJson<OutLayerAttestation>(fetchImpl, `${api}/attestations/by-tx/${encodeURIComponent(txHash)}`);
}

export async function fetchJobs(
  api: string,
  query: { project: string; limit: number; offset: number },
  fetchImpl: typeof fetch = globalFetch,
): Promise<OutLayerJob[]> {
  const q = new URLSearchParams({ project: query.project, limit: String(query.limit), offset: String(query.offset) });
  return (await getJson<OutLayerJob[]>(fetchImpl, `${api}/public/jobs?${q}`)) ?? [];
}

// ---------- finding the transaction ----------

/** A transaction that led to a run. `tx` is kept when it was read while confirming. */
export type FoundTx = { hash: string; signer: string; source: RunTxSource; scannedBlock?: number; tx?: TxStatus };

export type RunTarget = { kind: RunKind; contractId: string; saleId: string; outlayerContract: string };

type BlockView = {
  header: { height: number; hash: string };
  chunks: { chunk_hash: string; shard_id: number; height_included: number }[];
};
type ChunkView = { transactions: RpcTransaction[] };

/** Runs `fn` over `items`, at most `limit` at a time, in order of the results. */
async function mapLimit<A, B>(items: A[], limit: number, fn: (a: A) => Promise<B>): Promise<B[]> {
  const out: B[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export function readTx(rpc: JsonRpc, hash: string, signer: string): Promise<TxStatus> {
  return rpc<TxStatus>("EXPERIMENTAL_tx_status", { tx_hash: hash, sender_account_id: signer, wait_until: "FINAL" });
}

/** True when the transaction's receipts hold this target's run (request from the contract, right sale and op). */
export function txHoldsRun(tx: TxStatus, t: RunTarget): boolean {
  try {
    const run = findSealerRun(tx, t.outlayerContract);
    return run.predecessor === t.contractId && run.inputFields.sale_id === t.saleId && run.inputFields.op === RUN_OP[t.kind];
  } catch {
    return false;
  }
}

/**
 * Blocks scanned around the recorded request block, most likely first: the
 * request runs one block after its transaction (two for a relayed
 * meta-transaction), later when receipts are delayed.
 */
export const SCAN_OFFSETS = [1, 2, 0, 3, 4] as const;

/** Scans the blocks around `requestBlock` for a transaction calling this sale's run method. */
export async function scanForRunTx(rpc: JsonRpc, t: RunTarget, requestBlock: number): Promise<FoundTx | null> {
  for (const offset of SCAN_OFFSETS) {
    const height = requestBlock - offset;
    let block: BlockView;
    try {
      block = await rpc<BlockView>("block", { block_id: height });
    } catch {
      continue;
    }
    // A chunk repeated from an earlier block (a missed chunk) holds no new transactions.
    const fresh = block.chunks.filter((c) => c.height_included === block.header.height);
    const chunks = await mapLimit(fresh, 4, (c) => rpc<ChunkView>("chunk", { chunk_id: c.chunk_hash }).catch(() => null));
    for (const chunk of chunks) {
      for (const tx of chunk?.transactions ?? []) {
        if (txCallsSale(tx, t.contractId, RUN_METHODS[t.kind], t.saleId)) {
          return { hash: tx.hash, signer: tx.signer_id, source: "block_scan", scannedBlock: height };
        }
      }
    }
  }
  return null;
}

/**
 * OutLayer's job list for the sealer project, newest first, within a time
 * window; each candidate confirmed by reading its transaction.
 */
export async function jobsForRunTx(
  api: string,
  rpc: JsonRpc,
  t: RunTarget,
  project: string,
  window: { from: number; to: number },
  fetchImpl: typeof fetch = globalFetch,
  limits: { pageSize?: number; pages?: number; candidates?: number } = {},
): Promise<FoundTx | null> {
  const pageSize = limits.pageSize ?? 100;
  const candidates: OutLayerJob[] = [];
  for (let page = 0; page < (limits.pages ?? 10); page++) {
    const jobs = await fetchJobs(api, { project, limit: pageSize, offset: page * pageSize }, fetchImpl);
    for (const j of jobs) {
      const at = Date.parse(j.created_at);
      if (j.transaction_hash && j.user_account_id && at >= window.from && at <= window.to) candidates.push(j);
    }
    const oldest = jobs.length ? Date.parse(jobs[jobs.length - 1].created_at) : 0;
    if (jobs.length < pageSize || oldest < window.from) break;
  }
  const seen = new Set<string>();
  const unique = candidates
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .filter((j) => !seen.has(j.transaction_hash!) && !!seen.add(j.transaction_hash!))
    .slice(0, limits.candidates ?? 8);
  for (const j of unique) {
    try {
      const tx = await readTx(rpc, j.transaction_hash!, j.user_account_id!);
      if (txHoldsRun(tx, t)) return { hash: j.transaction_hash!, signer: j.user_account_id!, source: "outlayer_jobs", tx };
    } catch {
      // unreadable: try the next one
    }
  }
  return null;
}

// ---------- the sale ----------

/** The fields of get_sale, get_result and get_config this reads (contracts/fairground/src/views.rs). */
export type SaleViewFields = {
  sale_id: string;
  reveal_mode: "Tee" | "CommitReveal";
  sealer_code_hash: string;
  sealer_pubkey: string | null;
  created_at: string;
  closed_at: string | null;
  settle_timeout: string;
  /** Block height of the latest sealer key request; only on contracts that record it. */
  key_request_block?: number | string | null;
};
export type ResultViewFields = {
  result_sha256: string | null;
  input_sha256: string | null;
  clear_requests: number;
  /** Block height of the latest clear request; only on contracts that record it. */
  clear_request_block?: number | string | null;
};
export type ConfigViewFields = {
  outlayer: string;
  sealer_source: { Project?: { project_id?: string; version_key?: string }; WasmUrl?: { hash?: string } };
};

export type VerifySaleOptions = {
  network: OutLayerNetwork;
  /** The app's RPC; history calls fall back to the network's archival node. */
  rpcUrl: string;
  contractId: string;
  saleId: string;
  /** Our reproducible build's hash, when the app names one. */
  referenceWasm?: string | null;
  /** Transactions this browser sent for the sale (near/tx-log.ts). */
  logged?: Partial<Record<RunKind, { txHash: string; account: string }>>;
  /** Transactions found by an earlier run of the checks: skips the search. */
  known?: Partial<Record<RunKind, FoundTx>>;
  /** Views already read (tests); read from the chain otherwise. */
  views?: { sale: SaleViewFields | null; result: ResultViewFields | null; config: ConfigViewFields };
  fetch?: typeof fetch;
  now?: () => number;
};

const nsToMs = (ns: string | null | undefined): number | null => (ns ? Number(BigInt(ns) / 1_000_000n) : null);
const blockOf = (v: number | string | null | undefined): number | null => {
  const n = v === null || v === undefined || v === "" ? NaN : Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const missing = (kind: RunKind, reason: MissingRun["reason"], message: string): MissingRun => ({
  kind,
  found: false,
  reason,
  message,
});

/**
 * Finds, fetches and checks the sale's key run and clearing run. Returns the
 * verification and the transactions found (pass them back as `known`).
 */
export async function verifySaleRuns(
  o: VerifySaleOptions,
): Promise<{ verification: SaleVerification; found: Partial<Record<RunKind, FoundTx>> }> {
  const fetchImpl = o.fetch ?? globalFetch;
  const net = OUTLAYER_NETWORKS[o.network];
  const rpc = jsonRpc([o.rpcUrl, net.archivalRpc].filter((u, i, all) => all.indexOf(u) === i), { fetch: fetchImpl });
  const now = o.now ?? Date.now;

  let views: NonNullable<VerifySaleOptions["views"]>;
  if (o.views) {
    views = o.views;
  } else {
    const [sale, result, config] = await Promise.all([
      viewCall<SaleViewFields | null>(rpc, o.contractId, "get_sale", { sale_id: o.saleId }),
      viewCall<ResultViewFields | null>(rpc, o.contractId, "get_result", { sale_id: o.saleId }),
      viewCall<ConfigViewFields>(rpc, o.contractId, "get_config", {}),
    ]);
    views = { sale, result, config };
  }
  const { sale, result, config } = views;
  if (!sale) throw new Error(`There is no sale ${o.saleId} on ${o.contractId}.`);

  const tee = sale.reveal_mode === "Tee";
  const wants: Record<RunKind, boolean> = {
    key: tee && !!sale.sealer_pubkey,
    clear: tee && !!result?.result_sha256,
  };
  const found: Partial<Record<RunKind, FoundTx>> = {};

  const one = async (kind: RunKind): Promise<AttestedRun | MissingRun | null> => {
    if (!wants[kind]) return null;
    const target: RunTarget = { kind, contractId: o.contractId, saleId: o.saleId, outlayerContract: config.outlayer };
    let tx: FoundTx | null = o.known?.[kind] ?? null;
    try {
      // 1. The block the contract recorded for the latest request.
      const block = kind === "clear" ? blockOf(result?.clear_request_block) : blockOf(sale.key_request_block);
      if (!tx && block !== null) tx = await scanForRunTx(rpc, target, block);
      // 2. This browser's own log.
      const logged = o.logged?.[kind];
      if (!tx && logged?.txHash && logged.account) {
        const read = await readTx(rpc, logged.txHash, logged.account).catch(() => null);
        if (read && txHoldsRun(read, target)) tx = { hash: logged.txHash, signer: logged.account, source: "tx_log", tx: read };
      }
      // 3. OutLayer's job list for the sealer project, around the time of the run.
      const project = config.sealer_source.Project?.project_id;
      if (!tx && project) {
        const created = nsToMs(sale.created_at) ?? 0;
        const closed = nsToMs(sale.closed_at) ?? created;
        const window =
          kind === "key"
            ? { from: created - 10 * MINUTE, to: created + 7 * DAY }
            : { from: closed - 10 * MINUTE, to: closed + (nsToMs(sale.settle_timeout) ?? 0) + DAY };
        tx = await jobsForRunTx(net.api, rpc, target, project, window, fetchImpl);
      }
    } catch (e) {
      return missing(kind, "failed", `Searching for the transaction failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!tx) {
      const what = kind === "clear" ? "close_sale" : "create_sale or retry_setup";
      return missing(
        kind,
        "not_found",
        `Could not find the ${what} transaction behind this run: the contract records no request block, this browser did not send it, and OutLayer's job list does not show it.`,
      );
    }
    found[kind] = { hash: tx.hash, signer: tx.signer, source: tx.source, ...(tx.scannedBlock ? { scannedBlock: tx.scannedBlock } : {}) };

    let status: TxStatus;
    let attestation: OutLayerAttestation | null;
    try {
      [status, attestation] = await Promise.all([
        tx.tx ? Promise.resolve(tx.tx) : readTx(rpc, tx.hash, tx.signer),
        fetchAttestationByTx(net.api, tx.hash, fetchImpl),
      ]);
    } catch (e) {
      return missing(kind, "failed", `Reading the run failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!txHoldsRun(status, target)) {
      delete found[kind];
      return missing(kind, "not_found", `Transaction ${tx.hash} holds no ${RUN_OP[kind]} run for this sale.`);
    }
    if (!attestation) {
      return missing(
        kind,
        "no_attestation",
        `OutLayer has no attestation for transaction ${tx.hash}. A run refused before it started has none.`,
      );
    }

    const parsed = parseTdxQuote(attestation.tdx_quote);
    const run = findSealerRun(status, config.outlayer);
    const [approved, requestBlockHeight] = await Promise.all([
      "quote" in parsed
        ? viewCall<boolean>(rpc, net.register, "is_measurements_approved", { measurements: parsed.quote.measurements }).then(
            (v) => v === true,
            () => null,
          )
        : Promise.resolve(null),
      run.requestBlockHash
        ? rpc<{ header: { height: number } }>("block", { block_id: run.requestBlockHash }).then(
            (b) => b.header.height,
            () => null,
          )
        : Promise.resolve(null),
    ]);
    let checked;
    try {
      checked = verifyRun({
        kind,
        attestation,
        tx: status,
        outlayerContract: config.outlayer,
        contractId: o.contractId,
        saleId: o.saleId,
        pinnedWasm: sale.sealer_code_hash,
        referenceWasm: o.referenceWasm ?? null,
        saleKey: sale.sealer_pubkey,
        stored: kind === "clear" && result ? { inputSha256: result.input_sha256, resultSha256: result.result_sha256 } : null,
        register: net.register,
        measurementsApproved: approved,
        requestBlockHeight,
      });
    } catch (e) {
      if (e instanceof RunNotFoundError) return missing(kind, "not_found", e.message);
      throw e;
    }
    return {
      kind,
      found: true,
      simulated: false,
      attestationId: attestation.id,
      taskId: attestation.task_id,
      requestId: attestation.request_id ?? checked.run.requestId,
      txHash: tx.hash,
      signer: tx.signer,
      method: calledMethod(status.transaction, o.contractId),
      txSource: tx.source,
      ...(tx.scannedBlock ? { scannedBlock: tx.scannedBlock } : {}),
      blockHeight: attestation.block_height ?? null,
      at: attestation.timestamp * 1000,
      quote: attestation.tdx_quote,
      verifierUrl: verifierUrl(o.network, attestation.task_id),
      checks: checked.checks,
    };
  };

  const [key, clear] = await Promise.all([one("key"), one("clear")]);
  return {
    verification: { simulated: false, checkedAt: now(), pinnedWasm: sale.sealer_code_hash, key, clear },
    found,
  };
}
