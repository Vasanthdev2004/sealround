/**
 * The OutLayer stand-in of the sandbox end-to-end run.
 *
 * OutLayer's real contract (contracts/res/outlayer_contract.wasm) is deployed
 * on the sandbox, so Fairground's `request_execution` calls, the payment and
 * the yield/resume are the real thing. What is missing locally is OutLayer's
 * worker, the machine that runs the job in a TEE. This module is that worker:
 * it answers every pending request by running the pinned job itself,
 * enclave/res/fairground_sealer.wasm, the exact bytes whose sha256 the
 * contract is deployed with, through the enclave runner (enclave/tools/runner,
 * a copy of the worker's WASI path), with a TEST master secret. It then
 * resolves the request the way the worker does.
 *
 * So a TEE sale in this run goes: bids sealed by the web app's crypto, the
 * contract, OutLayer's contract, the pinned wasm, and back through the
 * contract's integrity checks. Only the TEE hardware and its attestation are
 * not there.
 */
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { teraToGas } from "near-api-js";
import { REPO_DIR, sleep, type Chain, type Named } from "./chain";

const ENCLAVE_DIR = path.join(REPO_DIR, "enclave");
export const SEALER_WASM = path.join(ENCLAVE_DIR, "res", "fairground_sealer.wasm");
const SEALER_PIN = `${SEALER_WASM}.sha256`;
/**
 * "fairground TEST master, not real" in hex: the documented test value
 * (scripts/run-enclave.ps1). Never a real master secret: it is passed on a
 * command line.
 */
export const TEST_MASTER = "6661697267726f756e642054455354206d61737465722c206e6f74207265616c";
/** What the contract asks for in resource_limits (contracts/fairground/src/costs.rs). */
const MAX_INSTRUCTIONS = "50000000000";
/** The worker resolves through the yield directly only below this size (OutLayer's max_yield_payload_size). */
const MAX_YIELD_PAYLOAD = 1024;

export const sha256Hex = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

/**
 * The sha256 of enclave/res/fairground_sealer.wasm, after checking that the
 * file is the one enclave/res/fairground_sealer.wasm.sha256 pins.
 */
export function pinnedSealerHash(): string {
  if (!existsSync(SEALER_WASM)) throw new Error(`${SEALER_WASM} is missing: build it with scripts\\build-enclave.ps1`);
  const pinned = readFileSync(SEALER_PIN, "utf8").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  const actual = sha256Hex(readFileSync(SEALER_WASM));
  if (!/^[0-9a-f]{64}$/.test(pinned) || pinned !== actual) {
    throw new Error(`enclave/res/fairground_sealer.wasm has sha256 ${actual}, but its .sha256 file pins ${pinned || "(nothing)"}`);
  }
  return actual;
}

/** The enclave runner, built on first use (a few minutes: it compiles wasmtime). */
export function runnerPath(): string {
  const exe = path.join(ENCLAVE_DIR, "target", "tools", process.platform === "win32" ? "fairground-runner.exe" : "fairground-runner");
  if (existsSync(exe)) return exe;
  console.log("building the enclave runner (enclave/tools/runner); this happens once and takes a few minutes");
  // Both tools together, as scripts/run-enclave.ps1 does: building one alone rebuilds shared dependencies.
  const build = spawnSync("cargo", ["build", "--locked", "--profile", "tools", "-p", "fairground-runner", "-p", "fairground-harness"], {
    cwd: ENCLAVE_DIR,
    stdio: "inherit",
    windowsHide: true,
  });
  if (build.status !== 0 || !existsSync(exe)) {
    throw new Error(`could not build the enclave runner (cargo exit ${build.status}); run scripts\\run-enclave.ps1 -Fixtures once and try again`);
  }
  return exe;
}

export type SealerRun = {
  /** The job exited 0. */
  success: boolean;
  /** stdout, byte for byte. */
  output: string;
  /** The job's stderr line, when it failed. */
  stderr: string;
  instructions: number;
  runMs: number;
};

/**
 * Runs the pinned job on `input` as an on-chain run whose predecessor is
 * `predecessor`. Without the master secret the job refuses the run
 * (`missing_master`), as it would if OutLayer's keystore withheld the secret.
 */
export function runSealer(runner: string, input: string, predecessor: string, workDir: string, tag: string, withMaster = true): Promise<SealerRun> {
  mkdirSync(workDir, { recursive: true });
  const inFile = path.join(workDir, `${tag}.input.json`);
  const outFile = path.join(workDir, `${tag}.output.json`);
  writeFileSync(inFile, input);
  const args = [
    "--wasm", SEALER_WASM, "--input", inFile, "--out", outFile, "--near", predecessor, "--max-instructions", MAX_INSTRUCTIONS,
    ...(withMaster ? ["--env", `PROTECTED_FAIRGROUND_MASTER=${TEST_MASTER}`] : []),
  ];
  return new Promise((resolve, reject) => {
    execFile(runner, args, { encoding: "utf8", windowsHide: true, timeout: 120_000 }, (error, _stdout, report) => {
      const code = error ? (typeof error.code === "number" ? error.code : 2) : 0;
      // 0: the run succeeded. 1: it failed as the worker counts it. Anything else: the runner could not run it.
      if (code !== 0 && code !== 1) return reject(new Error(`fairground-runner could not run the job: ${report || error?.message}`));
      const field = (name: string) => new RegExp(`^${name}: (.*)$`, "m").exec(report)?.[1] ?? "";
      resolve({
        success: code === 0,
        output: existsSync(outFile) ? readFileSync(outFile, "utf8") : "",
        stderr: field("stderr"),
        instructions: Number(field("instructions") || 0),
        runMs: Number(field("run_ms") || 0),
      });
    });
  });
}

export type Served = {
  requestId: number;
  /** "pubkey" or "clear", from the input. */
  op: string;
  saleId: string;
  /** `input_data` as OutLayer stored it. */
  input: string;
  /** OutLayer's own record of the request (its `get_request` view). */
  request: Record<string, unknown>;
  run: SealerRun;
  /** How the answer was delivered: through the yield, or stored first because it is large. */
  delivery: "resolve_execution" | "submit_execution_output_and_resolve";
};

/** Polls OutLayer's contract for pending requests and answers each with the pinned job's output. */
export class OutlayerWorker {
  readonly served: Served[] = [];
  /** Requests the worker could not answer. A scenario that finds one here has failed. */
  readonly errors: string[] = [];
  private readonly handled = new Set<number>();
  private running = false;
  private loop: Promise<void> | null = null;
  private withoutMaster = 0;

  constructor(
    private readonly chain: Chain,
    private readonly outlayerId: string,
    private readonly operator: Named,
    private readonly fairgroundId: string,
    private readonly runner: string,
    private readonly workDir: string,
    /** sha256 of the module this worker runs: it answers no request for another. */
    private readonly sealerHash: string,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        try {
          const ids = await this.chain.view<number[]>(this.outlayerId, "get_pending_request_ids");
          for (const id of ids) {
            if (this.handled.has(id) || !this.running) continue;
            this.handled.add(id);
            await this.answer(id).catch((e: unknown) => {
              this.errors.push(`request ${id}: ${e instanceof Error ? e.message : String(e)}`);
            });
          }
        } catch {
          // The node was busy: ask again.
        }
        await sleep(150);
      }
    })();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
    this.loop = null;
  }

  /**
   * Makes the next `count` runs happen without the master secret. The job
   * itself then refuses them (`missing_master`), and the request is reported
   * as a failed run: a real way for an OutLayer request to fail.
   */
  failNext(count = 1): void {
    this.withoutMaster += count;
  }

  /**
   * The last answered request of a kind for a sale. Waits for it: the answer
   * is recorded when the worker's own transaction returns, which can be a
   * moment after the caller's transaction did.
   */
  async last(op: "pubkey" | "clear", saleId: string, timeoutMs = 20_000): Promise<Served> {
    return (await this.answers(op, saleId, 1, timeoutMs)).at(-1)!;
  }

  /** Every answered request of a kind for a sale, oldest first, once there are at least `atLeast` of them. */
  async answers(op: "pubkey" | "clear", saleId: string, atLeast: number, timeoutMs = 20_000): Promise<Served[]> {
    for (const deadline = Date.now() + timeoutMs; ; ) {
      const found = this.served.filter((s) => s.op === op && s.saleId === saleId);
      if (found.length >= atLeast) return found;
      if (this.errors.length > 0) throw new Error(`the OutLayer stand-in failed: ${this.errors.join("; ")}`);
      if (Date.now() >= deadline) {
        throw new Error(`the OutLayer stand-in answered ${found.length} ${op} request(s) for ${saleId} within ${timeoutMs} ms, not ${atLeast}`);
      }
      await sleep(100);
    }
  }

  private async answer(requestId: number): Promise<void> {
    const request = await this.chain.view<Record<string, unknown>>(this.outlayerId, "get_request", { request_id: requestId });
    const input = String(request["input_data"] ?? "");
    mkdirSync(this.workDir, { recursive: true });
    writeFileSync(path.join(this.workDir, `request-${requestId}.request.json`), JSON.stringify(request, null, 2));
    const parsed = JSON.parse(input) as { op?: string; sale_id?: string };
    // OutLayer runs the module the request names by hash. This worker has exactly one: the pinned job.
    const source = (request["resolved_source"] ?? request["execution_source"]) as { WasmUrl?: { hash?: string } } | null;
    const asked = source?.WasmUrl?.hash;
    let run: SealerRun;
    if (asked !== this.sealerHash) {
      this.errors.push(`request ${requestId} asks for module ${String(asked)}, not the pinned ${this.sealerHash}`);
      run = { success: false, output: "", stderr: "the requested module is not the pinned job", instructions: 0, runMs: 0 };
    } else {
      const withMaster = this.withoutMaster === 0;
      if (!withMaster) this.withoutMaster -= 1;
      run = await runSealer(this.runner, input, this.fairgroundId, this.workDir, `request-${requestId}`, withMaster);
    }
    const resources = { instructions: run.instructions, time_ms: Math.max(1, Math.round(run.runMs)), compile_time_ms: null };

    let delivery: Served["delivery"] = "resolve_execution";
    let args: Record<string, unknown>;
    if (!run.success) {
      // A failed run: the worker reports stderr, and the caller's callback sees `null`.
      args = {
        request_id: requestId,
        response: { success: false, output: null, error: run.stderr || "the job failed", resources_used: resources, compilation_note: null, refund_usd: null },
      };
    } else {
      const response = { success: true, output: { Text: run.output }, error: null, resources_used: resources, compilation_note: null, refund_usd: null };
      if (JSON.stringify(response).length < MAX_YIELD_PAYLOAD) {
        args = { request_id: requestId, response };
      } else {
        delivery = "submit_execution_output_and_resolve";
        args = { request_id: requestId, output: { Text: run.output }, success: true, error: null, resources_used: resources, compilation_note: null };
      }
    }
    await this.operator.account.callFunction({ contractId: this.outlayerId, methodName: delivery, args, gas: teraToGas(300) });
    this.served.push({ requestId, op: parsed.op ?? "", saleId: parsed.sale_id ?? "", input, request, run, delivery });
  }
}
