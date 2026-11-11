/**
 * The real gas relayer (apps/relayer) as its own process on 127.0.0.1:8790,
 * for the sandbox end-to-end run. It is started the way `pnpm dev` starts it
 * (`node src/main.ts`, Node's type stripping), configured only through
 * environment variables, and reached only over HTTP, so the web client talks
 * to it exactly as a browser would.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { REPO_DIR, sleep } from "./chain";

export const RELAYER_PORT = 8790;
export const RELAYER_URL = `http://127.0.0.1:${RELAYER_PORT}`;
const RELAYER_DIR = path.join(REPO_DIR, "apps", "relayer");
/** Every variable apps/relayer/src/config.ts reads, so none leaks in from the shell that started the run. */
const RELAYER_VARIABLES =
  /^(NETWORK|NEAR_RPC_URL|RELAYER_ACCOUNT_ID|RELAYER_PRIVATE_KEY|FAIRGROUND_CONTRACT|USDC_CONTRACTS|CORS_ORIGINS|CLIENT_IP_HEADER|TRUSTED_PROXY_HOPS|MAX_GAS_TGAS|MAX_DELEGATE_BLOCKS|RELAYS_PER_SENDER_PER_HOUR|REQUESTS_PER_IP_PER_HOUR|STORAGE_PER_IP_PER_DAY|DAILY_BUDGET_NEAR|STORAGE_BUDGET_NEAR|RELAY_WAIT_MS|PORT)$/;

export type RelayerProcess = {
  readonly url: string;
  readonly pid: number;
  /** Stops the process and waits until the port is closed. */
  stop(): Promise<void>;
  /** The end of the relayer's own log (JSON lines; no payloads, no IPs). */
  logTail(lines?: number): string;
};

/** Whether something accepts connections on the relayer's port. */
export function portInUse(port = RELAYER_PORT): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (used: boolean) => {
      socket.destroy();
      resolve(used);
    };
    socket.setTimeout(1_000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function killPid(pid: number): void {
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    else process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

/**
 * Stops a relayer an earlier run of this script left behind (a run that was
 * killed before it could clean up). Only a process this script started is
 * touched: its pid is in `pidFile`. Returns false when the port is still in
 * use afterwards, which means something else owns it.
 */
export async function stopLeftoverRelayer(pidFile: string): Promise<boolean> {
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    if (Number.isInteger(pid) && pid > 0 && (await portInUse())) killPid(pid);
    rmSync(pidFile, { force: true });
    for (let i = 0; i < 20 && (await portInUse()); i++) await sleep(250);
  }
  return !(await portInUse());
}

/**
 * Starts the relayer with `env` (NETWORK, NEAR_RPC_URL, RELAYER_ACCOUNT_ID,
 * RELAYER_PRIVATE_KEY, FAIRGROUND_CONTRACT, USDC_CONTRACTS and any limits) and
 * waits until it answers. Its output goes to `logFile`.
 */
export async function startRelayer(env: Record<string, string>, runDir: string, label: string): Promise<RelayerProcess> {
  if (await portInUse()) throw new Error(`port ${RELAYER_PORT} is already in use; the relayer cannot start`);
  mkdirSync(runDir, { recursive: true });
  const logFile = path.join(runDir, `relayer-${label}.log`);
  const pidFile = path.join(runDir, "relayer.pid");
  const log = openSync(logFile, "w");
  // PATH and the like are kept for Node itself; every variable the relayer reads comes from `env` alone.
  const childEnv: Record<string, string | undefined> = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !RELAYER_VARIABLES.test(name) && !/^(NODE_OPTIONS$|NEXT_PUBLIC_)/.test(name))),
    ...env,
    PORT: String(RELAYER_PORT),
  };
  const child: ChildProcess = spawn(process.execPath, ["src/main.ts"], {
    cwd: RELAYER_DIR,
    env: childEnv as NodeJS.ProcessEnv,
    stdio: ["ignore", log, log],
    windowsHide: true,
  });
  closeSync(log);
  if (child.pid === undefined) throw new Error("could not start the relayer process");
  writeFileSync(pidFile, String(child.pid));

  let exited: number | null | undefined;
  const whenExited = new Promise<void>((resolve) => {
    child.once("exit", (code) => {
      exited = code;
      resolve();
    });
  });
  const logTail = (lines = 20) => {
    try {
      return readFileSync(logFile, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
    } catch {
      return "";
    }
  };
  const stop = async () => {
    if (exited === undefined) {
      child.kill();
      await Promise.race([whenExited, sleep(5_000)]);
      if (exited === undefined && child.pid !== undefined) killPid(child.pid);
      await Promise.race([whenExited, sleep(5_000)]);
    }
    rmSync(pidFile, { force: true });
    for (let i = 0; i < 40 && (await portInUse()); i++) await sleep(250);
    if (await portInUse()) throw new Error(`the relayer was stopped but port ${RELAYER_PORT} is still in use`);
  };

  for (let i = 0; i < 120; i++) {
    if (exited !== undefined) throw new Error(`the relayer exited with code ${exited} while starting:\n${logTail()}`);
    try {
      // 200 or 503 (budget used up): either way it is serving.
      const res = await fetch(`${RELAYER_URL}/health`, { signal: AbortSignal.timeout(2_000) });
      const body = (await res.json()) as { network?: string };
      if (body.network === env["NETWORK"]) return { url: RELAYER_URL, pid: child.pid, stop, logTail };
    } catch {
      // not listening yet
    }
    await sleep(250);
  }
  await stop().catch(() => {});
  throw new Error(`the relayer did not answer on ${RELAYER_URL} within 30 s:\n${logTail()}`);
}
