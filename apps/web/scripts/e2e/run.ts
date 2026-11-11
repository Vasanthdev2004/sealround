/**
 * End-to-end run of the web app's NEAR client on a local chain.
 *
 *   pnpm --filter web e2e:sandbox        (from anywhere in the repo)
 *
 * What it proves: the code the browser runs in NEAR mode
 * (src/lib/client/near.ts, the dev signer, the bid sealing in src/lib/crypto.ts
 * and the 1Click storage helper) takes whole sales through the real contract
 * (contracts/res/fairground.wasm), OutLayer's real contract, the pinned
 * enclave job (enclave/res/fairground_sealer.wasm, run by the enclave runner
 * with a TEST master) and the real relayer (apps/relayer as its own process),
 * from Node, with no browser and no fakes.
 *
 * What it starts, and always removes again, also when a scenario fails or the
 * run is interrupted:
 * - the Docker container near-sandbox-web (nearcore sandbox, RPC on 127.0.0.1:3050);
 * - the relayer on 127.0.0.1:8790 (restarted a few times with other settings).
 *
 * Needs: Docker running; contracts/res built (scripts\build-contracts.ps1);
 * enclave/res built (scripts\build-enclave.ps1); the sandbox binary in
 * .sandbox-bin (scripts\sandbox.ps1 downloads it); Node 24 (the relayer runs
 * its TypeScript sources directly). The enclave runner is built on first use.
 *
 * It prints every check as it runs, then a pass/fail table, and exits 0 only
 * if every scenario passed. Logs of the run are kept in scripts/e2e/.run/
 * (git-ignored): the relayer's own log per configuration, each request the
 * OutLayer stand-in answered, and the table as JSON.
 *
 * Nothing here touches a public network: every account and key is made for
 * the run on the local chain and is gone with the container.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { E2E_DIR, removeSandbox, SANDBOX_NAME, SANDBOX_PORT } from "./chain";
import { RELAYER_PORT, stopLeftoverRelayer } from "./relayer";
import { Report } from "./report";
import { runScenarios } from "./scenarios";
import { buildWorld, type World } from "./world";

const RUN_DIR = path.join(E2E_DIR, ".run");
const PID_FILE = path.join(RUN_DIR, "relayer.pid");

let world: World | null = null;
let cleaned = false;

/** Stops the relayer and removes the container. Safe to call more than once and at any point. */
async function cleanup(): Promise<string[]> {
  if (cleaned) return [];
  cleaned = true;
  const problems: string[] = [];
  await world?.worker.stop().catch(() => {});
  await world?.stopRelayer().catch((e: unknown) => problems.push(`stopping the relayer: ${e instanceof Error ? e.message : String(e)}`));
  if (!(await stopLeftoverRelayer(PID_FILE))) problems.push(`port ${RELAYER_PORT} is still in use`);
  if (!removeSandbox()) problems.push(`could not remove the ${SANDBOX_NAME} container`);
  return problems;
}

async function main(): Promise<number> {
  const started = Date.now();
  console.log(`Sealround web client, end to end on a local chain (${SANDBOX_NAME} on 127.0.0.1:${SANDBOX_PORT}, relayer on 127.0.0.1:${RELAYER_PORT})\n`);

  // A run that was killed may have left its relayer behind; only that one is stopped (its pid is in the run folder).
  if (!(await stopLeftoverRelayer(PID_FILE))) {
    console.error(`Port ${RELAYER_PORT} is in use by a process this script did not start. Stop it and run again.`);
    return 2;
  }
  rmSync(RUN_DIR, { recursive: true, force: true, maxRetries: 3 });
  mkdirSync(RUN_DIR, { recursive: true });

  const report = new Report();
  try {
    world = await buildWorld(RUN_DIR, (line) => console.log(line));
    // The app reads its configuration from NEXT_PUBLIC_* variables; getClient() (used by the 1Click helper) sees these.
    Object.assign(process.env, world.publicEnv());
    await runScenarios(world, report);
  } catch (e) {
    console.error(`\nThe run could not be set up: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  }
  const problems = await cleanup();

  console.log(`\n${"=".repeat(100)}\n`);
  console.log(report.scenarios.length > 0 ? report.table() : "No scenario ran.");
  for (const problem of problems) console.log(`TEARDOWN PROBLEM: ${problem}`);
  console.log(`\nTook ${((Date.now() - started) / 1000).toFixed(0)} s. Logs: ${RUN_DIR}`);
  writeFileSync(path.join(RUN_DIR, "report.json"), JSON.stringify({ passed: report.allPassed && problems.length === 0, scenarios: report.scenarios, teardown: problems }, null, 2));
  return report.allPassed && problems.length === 0 ? 0 : 1;
}

/** Exits once everything printed so far has left the process: a piped stdout is written asynchronously on Windows. */
function exit(code: number): void {
  process.stdout.write("", () => process.stderr.write("", () => process.exit(code)));
}

for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) {
  process.on(signal, () => {
    console.error(`\n${signal}: stopping the relayer and removing the container`);
    void cleanup().finally(() => exit(130));
  });
}

main().then(exit, async (e: unknown) => {
  console.error(e);
  await cleanup();
  exit(1);
});
