/**
 * Scenario bookkeeping for the sandbox end-to-end run: named checks grouped
 * into scenarios, and the pass/fail table printed at the end.
 *
 * A check that fails is recorded and the scenario goes on, so one run reports
 * every problem it can see. A scenario that throws is "aborted": the scenarios
 * that need it are skipped rather than run on a state they do not expect.
 */

export type CheckResult = { name: string; ok: boolean; detail?: string };

export type ScenarioResult = {
  id: string;
  title: string;
  status: "pass" | "fail" | "skip";
  /** The scenario threw before finishing. */
  aborted: boolean;
  checks: CheckResult[];
  error?: string;
  ms: number;
};

/**
 * Text for any value, for comparing and for check details. A bigint is
 * written with a trailing n, so 5n, 5 and "5" are three different values:
 * a client that returned a string where the app expects a bigint fails a check.
 */
export function show(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? `${v}n` : v === undefined ? "undefined" : v)).replace(/"(-?\d+n)"/g, "$1");
  } catch {
    return String(value);
  }
}

/** The checks of one scenario. */
export class Checks {
  readonly results: CheckResult[] = [];

  constructor(private readonly print: (line: string) => void) {}

  ok(name: string, condition: boolean, detail?: string): boolean {
    this.results.push({ name, ok: condition, ...(condition || detail === undefined ? {} : { detail }) });
    this.print(condition ? `    ok    ${name}` : `    FAIL  ${name}${detail ? `: ${detail}` : ""}`);
    return condition;
  }

  /** Strict equality after `show`, so bigints, arrays and plain objects compare by value. */
  eq(name: string, actual: unknown, expected: unknown): boolean {
    const [a, e] = [show(actual), show(expected)];
    return this.ok(name, a === e, `got ${a}, want ${e}`);
  }

  /**
   * Runs `run` and checks that it throws an error whose fields equal `want`
   * (each given field is compared with `show`). Returns the error, or null.
   */
  async throws(name: string, run: () => Promise<unknown>, want: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    let thrown: unknown;
    try {
      const value = await run();
      this.ok(name, false, `did not throw; returned ${show(value).slice(0, 200)}`);
      return null;
    } catch (e) {
      thrown = e;
    }
    const error = (typeof thrown === "object" && thrown !== null ? thrown : { message: String(thrown) }) as Record<string, unknown>;
    const wrong = Object.entries(want).filter(([key, value]) => show(error[key]) !== show(value));
    this.ok(
      name,
      wrong.length === 0,
      `${wrong.map(([key, value]) => `${key} is ${show(error[key])}, want ${show(value)}`).join("; ")} (message: ${show(error["message"])})`,
    );
    return error;
  }
}

export class Report {
  readonly scenarios: ScenarioResult[] = [];

  constructor(private readonly print: (line: string) => void = (line) => console.log(line)) {}

  /**
   * Runs one scenario. `needs` names scenarios that must have run to their end
   * (their checks may have failed): if one of them aborted or was skipped,
   * this one is skipped.
   */
  async scenario(id: string, title: string, needs: readonly string[], body: (t: Checks) => Promise<void>): Promise<ScenarioResult> {
    const blocker = needs.find((need) => {
      const dep = this.scenarios.find((s) => s.id === need);
      return !dep || dep.aborted || dep.status === "skip";
    });
    this.print(`\n[${id}] ${title}`);
    if (blocker) {
      const result: ScenarioResult = { id, title, status: "skip", aborted: false, checks: [], error: `skipped: needs "${blocker}"`, ms: 0 };
      this.print(`    SKIP  needs "${blocker}", which did not finish`);
      this.scenarios.push(result);
      return result;
    }
    const checks = new Checks(this.print);
    const started = Date.now();
    let error: string | undefined;
    try {
      await body(checks);
    } catch (e) {
      error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      const extra = typeof e === "object" && e !== null ? show({ ...(e as Record<string, unknown>) }) : "";
      this.print(`    ABORT ${error}${extra && extra !== "{}" ? ` ${extra.slice(0, 600)}` : ""}`);
      if (e instanceof Error && e.stack && process.env["E2E_DEBUG"]) this.print(e.stack);
    }
    const failed = checks.results.some((c) => !c.ok);
    const result: ScenarioResult = {
      id,
      title,
      status: error === undefined && !failed ? "pass" : "fail",
      aborted: error !== undefined,
      checks: checks.results,
      ...(error === undefined ? {} : { error }),
      ms: Date.now() - started,
    };
    this.scenarios.push(result);
    return result;
  }

  get allPassed(): boolean {
    return this.scenarios.length > 0 && this.scenarios.every((s) => s.status === "pass");
  }

  /** The pass/fail table, then every failed check and abort with its detail. */
  table(): string {
    const rows = this.scenarios.map((s, i) => {
      const passed = s.checks.filter((c) => c.ok).length;
      return {
        n: String(i + 1),
        title: s.title,
        result: s.status === "pass" ? "PASS" : s.status === "skip" ? "SKIP" : "FAIL",
        checks: `${passed}/${s.checks.length}`,
        time: `${(s.ms / 1000).toFixed(1)}s`,
      };
    });
    const width = (key: keyof (typeof rows)[number], head: string) => Math.max(head.length, ...rows.map((r) => r[key].length));
    const w = { n: width("n", "#"), title: width("title", "scenario"), result: width("result", "result"), checks: width("checks", "checks"), time: width("time", "time") };
    const line = (n: string, title: string, result: string, checks: string, time: string) =>
      `${n.padStart(w.n)}  ${title.padEnd(w.title)}  ${result.padEnd(w.result)}  ${checks.padStart(w.checks)}  ${time.padStart(w.time)}`;
    const out = [line("#", "scenario", "result", "checks", "time"), line("-".repeat(w.n), "-".repeat(w.title), "-".repeat(w.result), "-".repeat(w.checks), "-".repeat(w.time))];
    for (const r of rows) out.push(line(r.n, r.title, r.result, r.checks, r.time));

    const count = (status: ScenarioResult["status"]) => this.scenarios.filter((s) => s.status === status).length;
    const checks = this.scenarios.flatMap((s) => s.checks);
    out.push("");
    out.push(
      `${count("pass")} passed, ${count("fail")} failed, ${count("skip")} skipped of ${this.scenarios.length} scenarios; ` +
        `${checks.filter((c) => c.ok).length} of ${checks.length} checks passed.`,
    );
    const problems = this.scenarios.filter((s) => s.status !== "pass");
    if (problems.length > 0) {
      out.push("");
      out.push("Failures:");
      for (const s of problems) {
        if (s.error) out.push(`  [${s.id}] ${s.error}`);
        for (const c of s.checks.filter((c) => !c.ok)) out.push(`  [${s.id}] ${c.name}${c.detail ? `: ${c.detail}` : ""}`);
      }
    }
    return out.join("\n");
  }
}
