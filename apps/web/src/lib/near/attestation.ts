/**
 * Checks OutLayer's attestation of one sealer run against the chain. A port
 * of enclave/deploy/Verify-Attestation.ps1 (its header documents every check)
 * that runs in the browser: pure functions over the attestation record
 * (GET {api}/attestations/by-tx/{hash}) and the transaction's receipts
 * (NEAR RPC EXPERIMENTAL_tx_status). No network, no storage, no Node APIs;
 * attestation-sources.ts fetches the inputs.
 *
 * A run is one request_execution to OutLayer: the sale key run (create_sale or
 * retry_setup, op "pubkey") or the clearing run (close_sale, op "clear").
 *
 * Checked here:
 *   build         the attested wasm_hash is the build the contract pins
 *   executed      the worker's measured executed_wasm_sha256 is the same build
 *   input         sha256 of the request's input_data = the attested input_hash
 *                 (= the contract's input_sha256 for a clear)
 *   output        sha256 of the exact bytes on_execution_response returned =
 *                 the attested output_hash (= the contract's result_sha256)
 *   task          SHA-256 over the record's fields (OutLayer worker/src/
 *                 tdx_attestation.rs:173-213) = the quote's report_data[0..32],
 *                 and report_data[32..64] is zero
 *   measurements  MRTD and RTMR0-3 read from the quote are approved by the
 *                 register contract (the caller passes the view's answer)
 *   request       the request came from the sale contract, for this sale and
 *                 op, with the pinned source, in the attested block
 *   key           the job's answer names the sale's key
 *
 * Not checked: the quote's signature chain up to Intel. OutLayer's verifier
 * page and its outlayer-verify tool do that.
 *
 * Quote layout (TDX quote v4): a 48-byte header, then the TD report: MRTD at
 * 184, RTMR0-3 at 376/424/472/520 (48 bytes each), report_data at 568.
 */

import { sha256Bytes, toHex } from "@fairground/clearing";
import { fromB64 } from "../crypto";
import type { AttestationFact, RunCheck, RunCheckId, RunKind, TeeMeasurements } from "../types";

// ---------- what the API and the RPC return ----------

/** OutLayer's attestation record (`/attestations/by-tx/{hash}`, `/attestations/by-request/{id}`). */
export type OutLayerAttestation = {
  id: number;
  task_id: number;
  task_type: string;
  /** The TDX quote, standard base64. */
  tdx_quote: string;
  /** RTMR3 of the worker, hex. */
  worker_measurement?: string | null;
  request_id?: number | null;
  /** The account that signed the transaction (not the contract). */
  caller_account_id?: string | null;
  transaction_hash?: string | null;
  /** Block of the request_execution receipt. */
  block_height?: number | null;
  build_target?: string | null;
  repo?: string | null;
  commit?: string | null;
  wasm_hash: string;
  executed_wasm_sha256?: string | null;
  input_hash: string;
  output_hash: string;
  project_id?: string | null;
  secrets_ref?: string | null;
  attached_usd?: string | null;
  /** Unix seconds. */
  timestamp: number;
};

export type RpcFunctionCall = { method_name: string; args: string; gas?: number | string; deposit?: string };
/** A transaction or receipt action as the RPC prints it ("CreateAccount" is a bare string). */
export type RpcAction =
  | string
  | {
      FunctionCall?: RpcFunctionCall;
      Delegate?: { delegate_action: { sender_id: string; receiver_id: string; actions: RpcAction[] } };
      [other: string]: unknown;
    };
export type RpcTransaction = {
  hash: string;
  signer_id: string;
  receiver_id: string;
  actions: RpcAction[];
};
export type RpcReceipt = {
  receipt_id: string;
  predecessor_id: string;
  receiver_id: string;
  receipt: { Action?: { signer_id: string; actions: RpcAction[] }; [other: string]: unknown };
};
export type RpcOutcome = {
  id: string;
  block_hash: string;
  outcome: {
    logs: string[];
    executor_id: string;
    status: string | { SuccessValue?: string; SuccessReceiptId?: string; Failure?: unknown };
  };
};
/** EXPERIMENTAL_tx_status `result`. */
export type TxStatus = {
  transaction: RpcTransaction;
  transaction_outcome: { id: string; block_hash: string };
  receipts: RpcReceipt[];
  receipts_outcome: RpcOutcome[];
};

/** The sealer's answer (enclave/job, DESIGN output format), as far as the checks read it. */
export type SealerAnswer = {
  v?: number;
  ok?: boolean;
  op?: string;
  sale_id?: string;
  pubkey?: string;
  bid_set_hash?: string;
  error?: string;
  [other: string]: unknown;
};

// ---------- small helpers ----------

const utf8 = new TextEncoder();
const sha256Hex = (bytes: Uint8Array): string => toHex(sha256Bytes(bytes));
const lower = (v: unknown): string => (typeof v === "string" ? v.trim().toLowerCase() : "");

function utf8Text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function functionCalls(actions: RpcAction[] | undefined): RpcFunctionCall[] {
  return (actions ?? []).flatMap((a) => (typeof a === "object" && a.FunctionCall ? [a.FunctionCall] : []));
}

/** The arguments of a function call, parsed; undefined when they are not JSON. */
export function callArgs(call: RpcFunctionCall): Record<string, unknown> | undefined {
  try {
    const parsed = parseJson(utf8Text(fromB64(call.args)));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** "1,234,567" for block heights. */
const grouped = (n: number): string => n.toLocaleString("en-US");

// ---------- the quote ----------

export const QUOTE_LAYOUT = {
  version: 4,
  teeType: 0x81,
  mrtd: 184,
  rtmr: [376, 424, 472, 520],
  reportData: 568,
  minLength: 632,
} as const;

export type TdxQuote = {
  measurements: TeeMeasurements;
  /** report_data, 64 bytes as hex. */
  reportData: string;
  length: number;
};

/** The fields this check reads from a TDX v4 quote, or an error saying why it is not one. */
export function parseTdxQuote(base64: string): { quote: TdxQuote } | { error: string } {
  let bytes: Uint8Array;
  try {
    bytes = fromB64(base64);
  } catch {
    return { error: "the quote is not base64" };
  }
  if (bytes.length < 8) return { error: `the quote is ${bytes.length} bytes` };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(0, true);
  const teeType = view.getUint32(4, true);
  if (version !== QUOTE_LAYOUT.version || teeType !== QUOTE_LAYOUT.teeType || bytes.length < QUOTE_LAYOUT.minLength) {
    return {
      error: `version ${version}, tee_type 0x${teeType.toString(16)}, ${bytes.length} bytes: not a TDX v4 quote`,
    };
  }
  const hex = (offset: number, length: number) => toHex(bytes.subarray(offset, offset + length));
  const [r0, r1, r2, r3] = QUOTE_LAYOUT.rtmr;
  return {
    quote: {
      measurements: {
        mrtd: hex(QUOTE_LAYOUT.mrtd, 48),
        rtmr0: hex(r0, 48),
        rtmr1: hex(r1, 48),
        rtmr2: hex(r2, 48),
        rtmr3: hex(r3, 48),
      },
      reportData: hex(QUOTE_LAYOUT.reportData, 64),
      length: bytes.length,
    },
  };
}

/**
 * The task hash OutLayer's worker puts in report_data[0..32]
 * (worker/src/tdx_attestation.rs:173-213): SHA-256 over the record's fields in
 * this order, text fields as UTF-8 and skipped when empty, numbers as 8-byte
 * little-endian.
 */
export function taskHash(att: OutLayerAttestation): string {
  const parts: Uint8Array[] = [];
  const text = (v: unknown) => {
    if (v !== null && v !== undefined && String(v) !== "") parts.push(utf8.encode(String(v)));
  };
  const le64 = (v: number | string) => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(v), true);
    parts.push(b);
  };
  text(att.task_type);
  le64(att.task_id);
  text(att.repo);
  text(att.commit);
  text(att.build_target);
  text(att.wasm_hash);
  text(att.input_hash);
  text(att.output_hash);
  if (att.block_height !== null && att.block_height !== undefined) le64(att.block_height);
  text(att.caller_account_id);
  text(att.project_id);
  text(att.secrets_ref);
  le64(att.timestamp);
  text(att.attached_usd);
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  return sha256Hex(all);
}

// ---------- the run inside the transaction ----------

/** The OutLayer request and its answer, read from a transaction's receipts. */
export type SealerRun = {
  /** The request_execution receipt. */
  receiptId: string;
  /** Who sent the request: the sale contract. */
  predecessor: string;
  /** The transaction's signer. */
  signer: string;
  /** The request receipt's signer: who OutLayer records as the caller. */
  receiptSigner: string | null;
  /** Block of the request_execution receipt's outcome. */
  requestBlockHash: string | null;
  /** `source` of the request, as sent. */
  source: unknown;
  /** The request's input_data, exactly as sent. */
  input: string;
  /** The input's own fields (op, contract, sale_id), when it is JSON. */
  inputFields: { op?: string; contract?: string; sale_id?: string };
  /** The exact bytes on_execution_response returned: what the contract's callback received. */
  output: Uint8Array;
  /** The sealer's answer inside the output (a Text response: a JSON string holding JSON). */
  answer: SealerAnswer | null;
  /** OutLayer's request id from its execution_requested event, when logged. */
  requestId: number | null;
  /** OutLayer's execution_completed event (success, error_message), when logged. */
  completed: { success?: boolean; error_message?: string | null } | null;
};

export class RunNotFoundError extends Error {
  override readonly name = "RunNotFoundError";
}

function eventData(log: string, event: string): Record<string, unknown> | null {
  if (!log.startsWith("EVENT_JSON:") || !log.includes(`"${event}"`)) return null;
  const parsed = parseJson(log.slice("EVENT_JSON:".length)) as { event?: string; data?: unknown } | undefined;
  if (!parsed || parsed.event !== event) return null;
  const data = Array.isArray(parsed.data) ? parsed.data[0] : parsed.data;
  return data && typeof data === "object" ? (data as Record<string, unknown>) : null;
}

/** The answer inside a Text response: the output is a JSON string whose content is the sealer's JSON. */
export function sealerAnswer(output: Uint8Array): SealerAnswer | null {
  const outer = parseJson(utf8Text(output));
  const inner = typeof outer === "string" ? parseJson(outer) : undefined;
  return inner && typeof inner === "object" && !Array.isArray(inner) ? (inner as SealerAnswer) : null;
}

/**
 * The one request_execution to `outlayer` in the transaction and the bytes its
 * on_execution_response returned. Throws RunNotFoundError when there is not
 * exactly one of each, or the response did not succeed.
 */
export function findSealerRun(tx: TxStatus, outlayer: string): SealerRun {
  const requests: { receipt: RpcReceipt; call: RpcFunctionCall }[] = [];
  const callbacks: RpcReceipt[] = [];
  for (const r of tx.receipts ?? []) {
    if (r.receiver_id !== outlayer) continue;
    for (const call of functionCalls(r.receipt.Action?.actions)) {
      if (call.method_name === "request_execution") requests.push({ receipt: r, call });
      if (call.method_name === "on_execution_response") callbacks.push(r);
    }
  }
  if (requests.length !== 1 || callbacks.length !== 1) {
    throw new RunNotFoundError(
      `Expected one request_execution and one on_execution_response receipt to ${outlayer}, found ${requests.length} and ${callbacks.length}.`,
    );
  }
  const [{ receipt, call }] = requests;
  const args = callArgs(call);
  if (!args || typeof args.input_data !== "string") {
    throw new RunNotFoundError("The request_execution arguments have no input_data.");
  }
  const input = args.input_data;
  const fields = parseJson(input);
  const inputFields =
    fields && typeof fields === "object"
      ? (({ op, contract, sale_id }) => ({
          ...(typeof op === "string" ? { op } : {}),
          ...(typeof contract === "string" ? { contract } : {}),
          ...(typeof sale_id === "string" ? { sale_id } : {}),
        }))(fields as Record<string, unknown>)
      : {};

  const outcomes = tx.receipts_outcome ?? [];
  const requestOutcome = outcomes.find((o) => o.id === receipt.receipt_id);
  const callbackOutcome = outcomes.find((o) => o.id === callbacks[0].receipt_id);
  const status = callbackOutcome?.outcome.status;
  const success = status && typeof status === "object" ? status.SuccessValue : undefined;
  if (success === undefined) {
    throw new RunNotFoundError(`on_execution_response did not succeed: ${JSON.stringify(status ?? null).slice(0, 200)}`);
  }

  let requestId: number | null = null;
  for (const log of requestOutcome?.outcome.logs ?? []) {
    const data = eventData(log, "execution_requested");
    const raw = typeof data?.request_data === "string" ? (parseJson(data.request_data) as { request_id?: unknown }) : data;
    if (raw && typeof raw.request_id === "number") requestId = raw.request_id;
  }
  let completed: SealerRun["completed"] = null;
  for (const log of callbackOutcome?.outcome.logs ?? []) {
    const data = eventData(log, "execution_completed");
    if (data) completed = { success: data.success as boolean | undefined, error_message: (data.error_message as string | null) ?? null };
  }

  const output = fromB64(success);
  return {
    receiptId: receipt.receipt_id,
    predecessor: receipt.predecessor_id,
    signer: tx.transaction.signer_id,
    receiptSigner: receipt.receipt.Action?.signer_id ?? null,
    requestBlockHash: requestOutcome?.block_hash ?? null,
    source: args.source,
    input,
    inputFields,
    output,
    answer: sealerAnswer(output),
    requestId,
    completed,
  };
}

/** The op a run of this kind sends to the sealer. */
export const RUN_OP: Record<RunKind, string> = { key: "pubkey", clear: "clear" };

/** The contract methods whose transaction makes a run of this kind. */
export const RUN_METHODS: Record<RunKind, readonly string[]> = {
  key: ["create_sale", "retry_setup"],
  clear: ["close_sale"],
};

/** The sale id a Fairground call names: `params.sale_id` for create_sale, `sale_id` otherwise. */
export function saleIdOfCall(call: RpcFunctionCall): string | undefined {
  const args = callArgs(call);
  if (!args) return undefined;
  const params = args.params as { sale_id?: unknown } | undefined;
  const id = call.method_name === "create_sale" ? params?.sale_id : args.sale_id;
  return typeof id === "string" ? id : undefined;
}

/**
 * True when a transaction calls `contract` with one of `methods` for `saleId`,
 * directly or inside a NEP-366 Delegate action (a relayed meta-transaction).
 */
export function txCallsSale(tx: RpcTransaction, contract: string, methods: readonly string[], saleId: string): boolean {
  const matches = (receiver: string, actions: RpcAction[]) =>
    receiver === contract &&
    functionCalls(actions).some((c) => methods.includes(c.method_name) && saleIdOfCall(c) === saleId);
  if (matches(tx.receiver_id, tx.actions)) return true;
  return tx.actions.some(
    (a) =>
      typeof a === "object" &&
      !!a.Delegate &&
      matches(a.Delegate.delegate_action.receiver_id, a.Delegate.delegate_action.actions),
  );
}

/** The Fairground method a transaction called (directly or delegated), for display. */
export function calledMethod(tx: RpcTransaction, contract: string): string | null {
  const direct = tx.receiver_id === contract ? functionCalls(tx.actions)[0]?.method_name : undefined;
  if (direct) return direct;
  for (const a of tx.actions) {
    if (typeof a === "object" && a.Delegate && a.Delegate.delegate_action.receiver_id === contract) {
      const m = functionCalls(a.Delegate.delegate_action.actions)[0]?.method_name;
      if (m) return m;
    }
  }
  return null;
}

// ---------- the checks ----------

export type VerifyRunInput = {
  kind: RunKind;
  attestation: OutLayerAttestation;
  tx: TxStatus;
  /** OutLayer's contract (get_config.outlayer). */
  outlayerContract: string;
  /** The sale contract. */
  contractId: string;
  saleId: string;
  /** The build the contract pins (get_sale.sealer_code_hash). */
  pinnedWasm: string;
  /** Our reproducible build's hash, when this app names one; must equal the pinned build. */
  referenceWasm?: string | null;
  /** get_sale.sealer_pubkey. */
  saleKey: string | null;
  /** get_result's hashes, for a clearing run. */
  stored?: { inputSha256: string | null; resultSha256: string | null } | null;
  /** The register contract asked about the measurements, and its answer (null: it could not be asked). */
  register: string;
  measurementsApproved: boolean | null;
  /** Height of the block the request_execution receipt ran in, read from the chain (null: not read). */
  requestBlockHeight?: number | null;
};

export type RunVerification = {
  checks: RunCheck[];
  run: SealerRun;
  quote: TdxQuote | null;
  /** sha256 of the request's input and of the returned bytes, recomputed here. */
  inputHash: string;
  outputHash: string;
};

const equal = (values: { label: string; value: string }[]): AttestationFact => {
  const first = lower(values[0]?.value);
  return {
    kind: "equal",
    values,
    ok: !!first && values.every((v) => lower(v.value) === first),
  };
};
const fact = (label: string, value: string, ok: boolean): AttestationFact => ({ kind: "fact", label, value, ok });
const check = (id: RunCheckId, items: AttestationFact[], ok: boolean | null = items.every((i) => i.ok)): RunCheck => ({
  id,
  ok,
  items,
});

/**
 * Every check of one run. Throws RunNotFoundError when the transaction holds
 * no OutLayer run; everything else is reported as a failed check.
 */
export function verifyRun(i: VerifyRunInput): RunVerification {
  const att = i.attestation;
  const run = findSealerRun(i.tx, i.outlayerContract);
  const pinned = lower(i.pinnedWasm);
  const reference = lower(i.referenceWasm);
  const checks: RunCheck[] = [];

  // build: the attested build is the one the contract pins (and our reproducible build, when named).
  checks.push(
    check("build", [
      equal([
        { label: "attested", value: lower(att.wasm_hash) },
        { label: "contract pins", value: pinned },
        ...(reference ? [{ label: "public build", value: reference }] : []),
      ]),
    ]),
  );

  // executed: the bytes the worker measured. An older worker may not report them.
  const executed = lower(att.executed_wasm_sha256);
  checks.push(
    executed
      ? check("executed", [equal([{ label: "measured", value: executed }, { label: "contract pins", value: pinned }])])
      : check("executed", [fact("measured", "not reported by this worker", false)], null),
  );

  // input and output: recomputed from the chain, attested, and (clearing) stored by the contract.
  const inputHash = sha256Hex(utf8.encode(run.input));
  const outputHash = sha256Hex(run.output);
  const clearing = i.kind === "clear";
  checks.push(
    check("input", [
      equal([
        { label: "sha256(input on chain)", value: inputHash },
        { label: "attested", value: lower(att.input_hash) },
        ...(clearing ? [{ label: "contract stored", value: lower(i.stored?.inputSha256) || "none" }] : []),
      ]),
    ]),
  );
  checks.push(
    check("output", [
      equal([
        { label: `sha256(${run.output.length} returned bytes)`, value: outputHash },
        { label: "attested", value: lower(att.output_hash) },
        ...(clearing ? [{ label: "contract stored", value: lower(i.stored?.resultSha256) || "none" }] : []),
      ]),
    ]),
  );

  // task: the quote's report data is the hash of this record.
  const parsed = parseTdxQuote(att.tdx_quote);
  const quote = "quote" in parsed ? parsed.quote : null;
  if (!quote) {
    checks.push(check("task", [fact("quote", "error" in parsed ? parsed.error : "unreadable", false)]));
  } else {
    const recomputed = taskHash(att);
    checks.push(
      check("task", [
        equal([
          { label: "task hash", value: recomputed },
          { label: "report_data[0..32]", value: quote.reportData.slice(0, 64) },
        ]),
        fact("report_data[32..64]", /^0{64}$/.test(quote.reportData.slice(64)) ? "zero" : "not zero", /^0{64}$/.test(quote.reportData.slice(64))),
      ]),
    );
  }

  // measurements: the register contract approves the five registers read from the quote.
  if (!quote) {
    checks.push(check("measurements", [fact("quote", "no measurements to read", false)]));
  } else if (i.measurementsApproved === null) {
    checks.push(
      check(
        "measurements",
        [fact(`${i.register}.is_measurements_approved`, "could not be read", false)],
        null,
      ),
    );
  } else {
    checks.push(
      check("measurements", [
        fact(`${i.register}.is_measurements_approved`, String(i.measurementsApproved), i.measurementsApproved),
        fact("rtmr3", quote.measurements.rtmr3, true),
      ]),
    );
  }

  // request: from the sale contract, for this sale and op, with the pinned source, in the attested block.
  const src = run.source as { Project?: { project_id?: string; version_key?: string }; WasmUrl?: { hash?: string } } | undefined;
  const sourceHash = lower(src?.Project?.version_key ?? src?.WasmUrl?.hash);
  const sourceName = src?.Project?.project_id ? `${src.Project.project_id} @ ${sourceHash}` : sourceHash || "unknown";
  const op = RUN_OP[i.kind];
  const items: AttestationFact[] = [
    fact("sent by", run.predecessor, run.predecessor === i.contractId),
    fact(
      "for",
      `${run.inputFields.sale_id ?? "no sale id"}, op ${run.inputFields.op ?? "none"}`,
      run.inputFields.sale_id === i.saleId &&
        run.inputFields.op === op &&
        (run.inputFields.contract === undefined || run.inputFields.contract === i.contractId),
    ),
    fact("source", sourceName, !!sourceHash && sourceHash === pinned),
  ];
  // The record names this request and its caller (both are inside the task hash).
  if (att.request_id !== null && att.request_id !== undefined && run.requestId !== null) {
    items.push(fact("request id", String(att.request_id), att.request_id === run.requestId));
  }
  if (att.caller_account_id && run.receiptSigner) {
    items.push(fact("signed by", att.caller_account_id, att.caller_account_id === run.receiptSigner));
  }
  if (att.block_height !== null && att.block_height !== undefined && i.requestBlockHeight !== null && i.requestBlockHeight !== undefined) {
    items.push(
      fact(
        "block",
        i.requestBlockHeight === att.block_height
          ? grouped(att.block_height)
          : `chain ${grouped(i.requestBlockHeight)}, attested ${grouped(att.block_height)}`,
        i.requestBlockHeight === att.block_height,
      ),
    );
  }
  checks.push(check("request", items));

  // key: the job's answer names the sale's key (a clear answer names the key it opened the bids with).
  const answer = run.answer;
  const saleKey = lower(i.saleKey);
  if (!answer) {
    checks.push(check("key", [fact("answer", "not the sealer's Text answer", false)]));
  } else if (answer.ok === false) {
    checks.push(
      check("key", [fact("answer", `the job answered an error: ${String(answer.error ?? "unknown")}`, false)], i.kind === "clear" ? null : false),
    );
  } else {
    checks.push(
      check("key", [
        equal([
          { label: i.kind === "key" ? "job made" : "job opened bids with", value: lower(answer.pubkey) || "none" },
          { label: "sale key", value: saleKey || "none" },
        ]),
        fact("answer for", `${answer.sale_id ?? "no sale id"}, op ${answer.op ?? "none"}`, answer.sale_id === i.saleId && answer.op === op),
      ]),
    );
  }

  return { checks, run, quote, inputHash, outputHash };
}

/** OutLayer's own verifier page for a run: it checks the quote's signature chain up to Intel. */
export const verifierUrl = (network: "testnet" | "mainnet", taskId: number): string =>
  `https://app.outlayer.ai/attestation/${taskId}?network=${network}`;
