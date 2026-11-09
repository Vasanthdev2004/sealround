/**
 * `pnpm arena`: run the 60 seeded runs, print a summary table and write
 * apps/web/src/data/arena-results.json (every chart on /arena reads it).
 *
 * Flags: --seed <n>  --runs <n>  --out <path>  --no-write
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LAUNCH_LABEL, LAUNCH_TYPES } from "./config";
import { METRICS } from "./metrics";
import { runArena } from "./run";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const here = dirname(fileURLToPath(import.meta.url));
const defaultOut = resolve(here, "../../../apps/web/src/data/arena-results.json");

const seed = flag("seed") ? Number(flag("seed")) : undefined;
const runs = flag("runs") ? Number(flag("runs")) : undefined;
const out = flag("out") ? resolve(process.cwd(), flag("out")!) : defaultOut;

const started = performance.now();
const report = runArena({ seed, runs });
const ms = Math.round(performance.now() - started);

const fmt: Record<string, (v: number) => string> = {
  share: (v) => `${(v * 100).toFixed(1)}%`,
  usdc: (v) => `${v.toLocaleString("en-US", { maximumFractionDigits: 0 })} USDC`,
  ratio: (v) => `${v.toFixed(2)}x`,
  index: (v) => v.toFixed(3),
};

const cols = LAUNCH_TYPES.map((t) => LAUNCH_LABEL[t]);
const w0 = Math.max(...METRICS.map((m) => m.label.length)) + 2;
const w = Math.max(...cols.map((c) => c.length)) + 2;
const line = "-".repeat(w0 + w * cols.length);

console.log(
  `\nBot Arena: ${report.runs} runs, seed ${report.seed}, demand ${report.demandMin}x to ${report.demandMax}x, ` +
    `${report.config.humans} humans + ${report.config.bots} bots (${ms} ms)\n`,
);
console.log("Average over all runs".padEnd(w0) + cols.map((c) => c.padStart(w)).join(""));
console.log(line);
for (const m of METRICS) {
  const cells = LAUNCH_TYPES.map((t) => fmt[m.unit](report.summary[t][m.id].mean).padStart(w));
  console.log(m.label.padEnd(w0) + cells.join(""));
}
console.log(line);

if (!process.argv.includes("--no-write")) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
  console.log(`\nWrote ${out}`);
}
