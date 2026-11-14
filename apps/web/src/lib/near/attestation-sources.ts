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

import { sha256Bytes, toHex } from "@fairground/clearing";
import { PINNED_CONTRACT_SHA256 } from "../../components/deploy/chain";
import type { AttestedRun, MissingRun, RunKind, RunTxSource } from "../types";
import { jsonRpc, viewCall, type JsonRpc } from "../verify/rpc";
import { chainChecks, readChain, type ChainRead } from "../verify/sources";
import type { FullVerification } from "../verify/types";
import type { BidTerms } from "../verify/your-bid";
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
  type SealerAnswer,
  type TxStatus,
} from "./attestation";
import { rpcEndpoints } from "./rpc";
import type { ResultView, SaleView } from "./views";

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

// JSON-RPC with an archival fallback lives in verify/rpc.ts; re-exported for the scripts that import it from here.
export { jsonRpc, viewCall, type JsonRpc };

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

/**
 * Runs `fn` over `items`, at most `limit` at a time, and stops starting new
 * ones once one gives a result that is not null. Returns that result, or null.
 */
async function firstOf<A, B>(items: A[], limit: number, fn: (a: A) => Promise<B | null>): Promise<B | null> {
  let next = 0;
  let hit: B | null = null;
  const worker = async () => {
    while (hit === null && next < items.length) {
      const got = await fn(items[next++]);
      if (got !== null && hit === null) hit = got;
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return hit;
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
    // Two chunks at a time, and no more once the transaction is found: each read counts against the node's rate limit.
    const hit = await firstOf(fresh, 2, async (c) => {
      const chunk = await rpc<ChunkView>("chunk", { chunk_id: c.chunk_hash }).catch(() => null);
      const tx = chunk?.transactions.find((x) => txCallsSale(x, t.contractId, RUN_METHODS[t.kind], t.saleId));
      return tx ? ({ hash: tx.hash, signer: tx.signer_id, source: "block_scan", scannedBlock: height } satisfies FoundTx) : null;
    });
    if (hit) return hit;
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
  /**
   * The contract and rule checks (verify/checks.ts): on unless false. They read
   * the contract account, its keys, get_bids, get_fills and the pool.
   */
  chain?: boolean;
  /** sha256 hex of the contract build to expect; contracts/res/fairground.wasm unless given. */
  pinnedContract?: string;
  /** Bidders' own terms (verify-sale --bid-secret): a your_bid check each. */
  bidTerms?: readonly BidTerms[];
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
 * Finds, fetches and checks the sale's key run and clearing run, then (unless
 * `chain` is false) the contract and rule checks. Returns the verification and
 * the transactions found (pass them back as `known`).
 */
export async function verifySaleRuns(
  o: VerifySaleOptions,
): Promise<{ verification: FullVerification; found: Partial<Record<RunKind, FoundTx>>; chain?: ChainRead }> {
  const fetchImpl = o.fetch ?? globalFetch;
  const net = OUTLAYER_NETWORKS[o.network];
  // The configured endpoint and its fallbacks (rpc.ts), then the archival node for history.
  const rpc = jsonRpc([...rpcEndpoints(o.rpcUrl), net.archivalRpc].filter((u, i, all) => all.indexOf(u) === i), { fetch: fetchImpl });
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

  // The contract and rule reads run while the runs are searched for. get_sale and get_result are the full views.
  const chainRead: Promise<ChainRead> | null =
    o.chain === false
      ? null
      : readChain(rpc, o.contractId, o.saleId, { sale: sale as SaleView, result: result as ResultView | null });

  const tee = sale.reveal_mode === "Tee";
  const wants: Record<RunKind, boolean> = {
    key: tee && !!sale.sealer_pubkey,
    clear: tee && !!result?.result_sha256,
  };
  const found: Partial<Record<RunKind, FoundTx>> = {};
  // Both runs usually share the enclave measurements; ask the register contract once per set, and read each block once.
  const approvals = new Map<string, Promise<boolean | null>>();
  const heights = new Map<string, Promise<number | null>>();
  /** The clearing run's answer, read from the close transaction, for the applied-output check. */
  let clearOut: { answer: SealerAnswer | null; bytes: number; sha256: string } | null = null;

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
    // A final transaction never changes: passed back as `known`, it spares the next run of the checks this read.
    found[kind] = { ...found[kind]!, tx: status };
    if (kind === "clear") {
      // The bytes on_execution_response returned: what the contract received, attested or not.
      const r = findSealerRun(status, config.outlayer);
      clearOut = { answer: r.answer, bytes: r.output.length, sha256: toHex(sha256Bytes(r.output)) };
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
    const approvedOf = (measurements: unknown): Promise<boolean | null> => {
      const k = JSON.stringify(measurements);
      if (!approvals.has(k)) {
        approvals.set(
          k,
          viewCall<boolean>(rpc, net.register, "is_measurements_approved", { measurements }).then(
            (v) => v === true,
            () => null,
          ),
        );
      }
      return approvals.get(k)!;
    };
    const heightOf = (hash: string): Promise<number | null> => {
      if (!heights.has(hash)) {
        heights.set(
          hash,
          rpc<{ header: { height: number } }>("block", { block_id: hash }).then(
            (b) => b.header.height,
            () => null,
          ),
        );
      }
      return heights.get(hash)!;
    };
    const [approved, requestBlockHeight] = await Promise.all([
      "quote" in parsed ? approvedOf(parsed.quote.measurements) : Promise.resolve(null),
      run.requestBlockHash ? heightOf(run.requestBlockHash) : Promise.resolve(null),
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
  const read = chainRead ? await chainRead : null;
  const chain = read
    ? chainChecks(read, {
        contractId: o.contractId,
        pinnedContract: o.pinnedContract ?? PINNED_CONTRACT_SHA256,
        clear: clearOut,
        terms: o.bidTerms,
      })
    : undefined;
  return {
    verification: { simulated: false, checkedAt: now(), pinnedWasm: sale.sealer_code_hash, key, clear, ...(chain ? { chain } : {}) },
    found,
    ...(read ? { chain: read } : {}),
  };
}
