import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const web = fileURLToPath(new URL("../apps/web/", import.meta.url));
const env = { ...process.env, NEXT_TELEMETRY_DISABLED: "1" };
const results = [];

function run(program, args, cwd = root) {
  console.log(`$ ${program} ${args.join(" ")}`);
  // Windows installs pnpm as a .cmd shim. These command arguments are fixed
  // below, and the working directory is passed separately.
  const result = process.platform === "win32" && program === "pnpm"
    ? spawnSync("cmd.exe", ["/d", "/v:off", "/c", "pnpm", ...args], { cwd, env, stdio: "inherit" })
    : spawnSync(program, args, { cwd, env, stdio: "inherit" });
  if (result.error) console.error(result.error.message);
  if (result.signal) console.error(`Stopped by ${result.signal}`);
  return result.status === 0;
}

function check(name, runCheck) {
  console.log(`\n== ${name} ==`);
  const start = Date.now();
  const passed = runCheck();
  results.push({ name, passed, seconds: ((Date.now() - start) / 1000).toFixed(1) });
}

check("Rust workspace unit tests", () => run("cargo", ["test", "--workspace", "--locked"]));
check("Enclave job native tests", () =>
  run("cargo", ["test", "--locked", "-p", "fairground-sealer-job"], fileURLToPath(new URL("../enclave/", import.meta.url))),
);

for (const name of ["clearing", "relayer-client", "relayer", "arena"]) {
  check(`${name} tests`, () => run("pnpm", ["--filter", `@fairground/${name}`, "test"]));
  check(`${name} TypeScript`, () => run("pnpm", ["--filter", `@fairground/${name}`, "typecheck"]));
}

check("Web tests", () => run("pnpm", ["--filter", "web", "test"]));
check("Web TypeScript", () => {
  const devLock = new URL("../apps/web/.next/dev/lock", import.meta.url);
  if (existsSync(devLock)) {
    if (!existsSync(new URL("../apps/web/.next/dev/types/routes.d.ts", import.meta.url))) {
      console.error("Next dev is active but route types are unavailable. Let it finish starting, then retry.");
      return false;
    }
    console.log("Using the running Next dev server's generated types.");
  } else if (!run("pnpm", ["exec", "next", "typegen"], web)) {
    return false;
  }
  return run("pnpm", ["exec", "tsc", "--noEmit", "--incremental", "false"], web);
});
check("Web ESLint", () => run("pnpm", ["exec", "eslint", "src", "scripts"], web));

console.log("\nCheck summary");
for (const { name, passed, seconds } of results) {
  console.log(`${passed ? "PASS" : "FAIL"}  ${name} (${seconds}s)`);
}
const failures = results.filter(({ passed }) => !passed).length;
console.log(`${results.length - failures}/${results.length} passed`);
process.exitCode = failures ? 1 : 0;
