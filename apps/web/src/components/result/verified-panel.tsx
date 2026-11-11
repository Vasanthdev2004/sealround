"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight, Check, ChevronDown, RefreshCw, X } from "lucide-react";
import { Tag } from "@/components/ui/badge";
import type { CheckState } from "@/components/ui/bits";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { getClient } from "@/lib/client";
import { randomHex } from "@/lib/crypto";
import { accountUrl, shortHash, txUrl } from "@/lib/format";
import type { Attestation, Sale, SaleResult } from "@/lib/types";

type Run = {
  attempt: number;
  nonce: string;
  attestation?: Attestation;
  error?: string;
};

/** How many checks have been revealed for a given attempt. */
type Shown = { attempt: number; n: number };

const CHECKS = 5;
/** Gap between two checks ticking, so the sequence reads (5 x 240 ms). */
const STEP_MS = 240;

const timeStr = (at: number) =>
  new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

const reducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * The five checks from the spec, run in this browser. The attestation is
 * fetched with a fresh random nonce every run, so a replayed answer fails.
 * Results tick in one by one, in order, each time the checks run.
 *
 * The panel leads with the outcome ("5 of 5 checks passed") and one line
 * saying what the checks ran against: a fetched attestation, a simulated one,
 * or only the values the contract stored. The checks follow as a ledger.
 */
export function VerifiedPanel({ sale, result }: { sale: Sale; result: SaleResult }) {
  const [attempt, setAttempt] = useState(0);
  const [run, setRun] = useState<Run | null>(null);
  const [shown, setShown] = useState<Shown>({ attempt: -1, n: 0 });
  const [open, setOpen] = useState(false);
  /** Commit-reveal: the contract cleared the revealed bids itself, with no enclave. */
  const onchain = result.clearedBy === "onchain";

  useEffect(() => {
    let cancelled = false;
    const timers: number[] = [];
    const nonce = randomHex(16);
    const reveal = () => {
      if (reducedMotion()) {
        setShown({ attempt, n: CHECKS });
        return;
      }
      for (let i = 1; i <= CHECKS; i++) {
        timers.push(window.setTimeout(() => !cancelled && setShown({ attempt, n: i }), i * STEP_MS));
      }
    };
    // A sale the contract cleared itself (commit-reveal) never ran an enclave: there is no attestation to ask for.
    const asked: Promise<Attestation | undefined> = onchain
      ? Promise.resolve(undefined)
      : getClient().getAttestation(sale.id, nonce);
    asked.then(
      (attestation) => {
        if (cancelled) return;
        setRun({ attempt, nonce, attestation });
        reveal();
      },
      (e: unknown) => {
        if (cancelled) return;
        setRun({ attempt, nonce, error: e instanceof Error ? e.message : String(e) });
        reveal();
      },
    );
    return () => {
      cancelled = true;
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [sale.id, attempt, onchain]);

  const fetched = !!run && run.attempt === attempt;
  const revealed = shown.attempt === attempt ? shown.n : 0;
  const att = fetched ? run.attestation : undefined;
  const fetchError = fetched ? run.error : undefined;
  const sentNonce = run?.nonce ?? "";
  const client = getClient();
  const expected = client.expectedCodeHash();
  const timedOut = result.failReason === "settle_timeout";
  // On the mock chain the attestation is signed by nothing and the settle
  // transaction has no explorer page: say so up front, and link nowhere fake.
  const simulated = client.mode === "mock" || !!att?.simulated;
  const settleHref = simulated || !result.settleTx || txUrl(result.settleTx) === "#" ? undefined : txUrl(result.settleTx);
  // Against a real contract the app reads what the contract stored (the pinned
  // code hash, the sale key, the hashes of the run's input and output). It
  // fetches no attestation of its own, so the checks that need one say so
  // instead of passing or failing on values that were never compared.
  const fromChain = att?.source === "chain";

  // 1. Fresh nonce
  const nonceOk = !!att && !fromChain && att.nonce === sentNonce;
  const r1: CheckState = onchain || fromChain ? "idle" : nonceOk ? "pass" : "fail";
  // 2. Code hash
  const codeOk = !!att && !!expected && att.codeHash === expected;
  const r2: CheckState = onchain || (fromChain && !expected) ? "idle" : codeOk ? "pass" : "fail";
  // 3. Public key
  const keyOk = !!att && att.reportedPubkey === sale.sealerPubkey;
  const r3: CheckState = onchain || fromChain ? "idle" : keyOk ? "pass" : "fail";
  // 4. Bid-set hash
  const hashOk = !!sale.bidSetHash && result.bidSetHash === sale.bidSetHash;
  const r4: CheckState = timedOut || onchain ? "idle" : hashOk ? "pass" : "fail";
  // 5. Contract checks
  const failing = result.checks.filter((ch) => !ch.passed);
  const onlyMinRaise =
    result.status === "failed" && failing.length === 1 && failing[0].id === "raise_at_least_min";
  // The same check row also stands for "something was sold": a sale with no valid bid fails it without missing a raise.
  const noValidBids = result.failReason === "no_valid_bids";
  const r5: CheckState =
    result.checks.length === 0 ? "idle" : failing.length === 0 || onlyMinRaise ? "pass" : "fail";

  const finals = [r1, r2, r3, r4, r5];
  const states: CheckState[] = finals.map((s, i) => (i < revealed ? s : "pending"));
  const done = revealed >= CHECKS;
  const applicable = finals.filter((s) => s !== "idle");
  const passed = applicable.filter((s) => s === "pass").length;
  // Checks that do apply to this sale but could not be run here, because no
  // attestation was fetched. They are not passes: the verdict counts them out
  // loud and never turns fully green while any is left.
  const unchecked = fromChain && !onchain ? [r1, r2, r3].filter((s) => s === "idle").length : 0;
  // A check the attestation would answer: not applicable when no enclave ran, not run when none was fetched.
  const attIdle = onchain ? "Not applicable" : "Not run";

  // Where the checks ran and against what. This one line tells fetched
  // evidence from simulated evidence and from evidence this build cannot fetch.
  const against = onchain
    ? ". The contract cleared this sale itself from the revealed bids, so no enclave ran"
    : fromChain
      ? " against the values the contract stored"
      : simulated
        ? " against an unsigned, simulated attestation"
        : " against a freshly fetched attestation";
  const left =
    unchecked > 0
      ? ` ${unchecked} need OutLayer's attestation, which this build does not fetch.`
      : applicable.length < CHECKS
        ? ` ${CHECKS - applicable.length} do not apply here.`
        : "";
  const how = !done
    ? onchain
      ? "Reading the contract's result again."
      : fetched
        ? "Comparing the attestation with the chain."
        : "Fetching the attestation with a fresh nonce."
    : `Run in your browser${att ? ` at ${timeStr(att.fetchedAt)}` : ""}${against}.${left}`;

  return (
    <Panel
      title={
        // As tall as the button beside it, so the two share a centre line.
        <span className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1">
          Verified {simulated && <Tag>simulated</Tag>}
          {unchecked > 0 && <Tag tone="warn">in part</Tag>}
        </span>
      }
      action={
        <Button
          size="sm"
          onClick={() => setAttempt((a) => a + 1)}
          disabled={!done}
          icon={<RefreshCw className={cn("size-3.5", !done && "animate-spin")} strokeWidth={1.75} />}
        >
          <span className="hidden sm:inline">Re-run checks</span>
          <span className="sm:hidden">Re-run</span>
        </Button>
      }
      bodyClassName="p-0"
    >
      <div className="px-5 pt-5 pb-4" aria-live="polite">
        <div className="text-h2 text-fg">
          {!done ? (
            <>
              Checking <span className="num">{Math.min(revealed + 1, CHECKS)}</span> of{" "}
              <span className="num">{CHECKS}</span>
            </>
          ) : (
            <>
              <span className="num">{passed}</span> of <span className="num">{applicable.length + unchecked}</span>{" "}
              checks passed
              {unchecked > 0 && (
                <>
                  , <span className="num">{unchecked}</span> not run
                </>
              )}
            </>
          )}
        </div>
        <p className="mt-1 max-w-[64ch] text-small text-muted">{how}</p>
      </div>

      <ol className="divide-y divide-line border-t border-line">
        <ProofRow
          n={1}
          state={states[0]}
          idle={attIdle}
          label="OutLayer attestation fetched with a fresh random nonce"
          pending="Sending a new 16-byte nonce."
          href={onchain || fromChain ? undefined : att?.url}
        >
          {onchain ? (
            <Note>No enclave ran for this sale.</Note>
          ) : fromChain ? (
            <Note>
              This build reads the values the contract stored and does not fetch OutLayer&apos;s attestation itself,
              so there is no nonce to compare.
            </Note>
          ) : fetchError ? (
            <Note tone="bad">Fetch failed: {fetchError}</Note>
          ) : (
            <>
              <Pair a={["sent", shortHash(sentNonce, 6)]} b={["echoed", shortHash(att?.nonce ?? "", 6)]} ok={nonceOk} />
              {!nonceOk && <Note>The attestation answered a different nonce. It could be a replay.</Note>}
            </>
          )}
        </ProofRow>
        <ProofRow
          n={2}
          state={states[1]}
          idle={attIdle}
          label={
            fromChain
              ? "Enclave code hash pinned in the contract equals our reproducible build"
              : "Enclave code hash equals our reproducible build"
          }
          pending="Comparing code hashes."
          href={onchain || fromChain ? undefined : att?.url}
        >
          {onchain ? (
            <Note>The contract ran the clearing rule itself.</Note>
          ) : fromChain && !expected ? (
            <Note>
              No reference build hash is set for this deployment. The contract pins{" "}
              <span className="font-mono">{shortHash(att?.codeHash ?? "", 6)}</span> and only accepts results for it.
            </Note>
          ) : att ? (
            <Pair
              a={[fromChain ? "pinned" : "attested", shortHash(att.codeHash, 6)]}
              b={["public build", shortHash(expected, 6)]}
              ok={codeOk}
            />
          ) : (
            <Note>No attestation to compare.</Note>
          )}
        </ProofRow>
        <ProofRow
          n={3}
          state={states[2]}
          idle={attIdle}
          label="Sealer public key on chain matches the attestation"
          pending="Comparing public keys."
          href={
            simulated || onchain || fromChain || accountUrl(client.contractId) === "#"
              ? undefined
              : accountUrl(client.contractId)
          }
        >
          {onchain ? (
            <Note>A commit-reveal sale has no sealer key.</Note>
          ) : fromChain ? (
            <Note>
              This needs the attestation. The contract itself refused any result not opened with this sale&apos;s key{" "}
              <span className="font-mono">{shortHash(sale.sealerPubkey, 6)}</span> (see the contract checks below).
            </Note>
          ) : att ? (
            <Pair
              a={["on chain", shortHash(sale.sealerPubkey, 6)]}
              b={["attested", shortHash(att.reportedPubkey, 6)]}
              ok={keyOk}
            />
          ) : (
            <Note>No attestation to compare.</Note>
          )}
        </ProofRow>
        <ProofRow
          n={4}
          state={states[3]}
          idle="Not applicable"
          label="Result's bid-set hash equals the contract's stored hash"
          pending="Comparing bid-set hashes."
          href={settleHref}
        >
          {onchain ? (
            <Note>
              The contract cleared the bid set it froze at close,{" "}
              <span className="font-mono">{shortHash(sale.bidSetHash ?? "none", 6)}</span>, with no result from outside.
            </Note>
          ) : timedOut ? (
            <Note>No enclave result. The sale moved to refunds after the settle timeout.</Note>
          ) : (
            <Pair
              a={["stored at close", shortHash(sale.bidSetHash ?? "none", 6)]}
              b={["reported", shortHash(result.bidSetHash, 6)]}
              ok={hashOk}
            />
          )}
        </ProofRow>
        <ProofRow
          n={5}
          state={states[4]}
          idle="Not applicable"
          label="All contract-side checks passed"
          pending="Reading the checks again."
          href={settleHref}
        >
          <Note>
            {result.checks.length === 0
              ? "No enclave result to check. Refunds need no checks."
              : onlyMinRaise
                ? `${result.checks.length - 1} of ${result.checks.length} passed. ${
                    noValidBids ? "No bid was valid, so nothing was sold" : "Minimum raise not met"
                  }: the contract correctly moved the sale to refunds.`
                : `${result.checks.length - failing.length} of ${result.checks.length} passed.`}
          </Note>
          {result.checks.length > 0 && (
            <>
              <Button
                size="sm"
                variant="ghost"
                className="mt-1 -ml-3"
                onClick={() => setOpen((o) => !o)}
                aria-expanded={open}
                aria-controls="contract-checks"
                icon={
                  <ChevronDown
                    className={cn("size-3.5 transition-transform duration-200", open && "rotate-180")}
                    strokeWidth={1.75}
                  />
                }
              >
                {open ? "Hide" : "Show"} the {result.checks.length} checks
              </Button>
              {open && (
                <ul id="contract-checks" className="anim-fade mt-1 divide-y divide-line border-t border-line">
                  {result.checks.map((ch) => {
                    const expectedFail = onlyMinRaise && ch.id === "raise_at_least_min";
                    return (
                      <li key={ch.id} className="flex items-start gap-2.5 py-2">
                        {ch.passed ? (
                          <Check className="mt-[3px] size-3.5 shrink-0 text-ok" strokeWidth={2.5} aria-label="passed" />
                        ) : (
                          <X
                            className={cn("mt-[3px] size-3.5 shrink-0", expectedFail ? "text-warn" : "text-bad")}
                            strokeWidth={2.5}
                            aria-label="failed"
                          />
                        )}
                        <div className="min-w-0 text-small">
                          <span className={ch.passed ? "text-muted" : "text-fg"}>{ch.label}</span>
                          {expectedFail && (
                            <span className="mt-0.5 block text-label text-subtle">
                              {noValidBids
                                ? "Expected on this sale: no bid was valid, so nothing was sold and the contract moved it to refunds instead of settling."
                                : "Expected on this sale: the raise fell short, so the contract refunded everyone instead of settling."}
                            </span>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </ProofRow>
      </ol>

      {/* The raw evidence on the recessed surface: the quote, or what stands in for it. */}
      <div className="border-t border-line bg-inset px-5 py-4">
        {onchain ? (
          <p className="text-label text-muted">
            No TDX quote: this sale was cleared on chain. Anyone can replay it from the public reveals with the
            reference clearing code.
          </p>
        ) : fromChain ? (
          // No quote was fetched; show what the contract holds about the run instead.
          <dl className="space-y-1.5 text-label">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <dt className="text-subtle">Clearing input, sha256</dt>
              <dd className="font-mono text-muted" title={att?.inputHash}>
                {att?.inputHash ? shortHash(att.inputHash, 8) : "not stored"}
              </dd>
            </div>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <dt className="text-subtle">Clearing output, sha256</dt>
              <dd className="font-mono text-muted" title={att?.outputHash}>
                {att?.outputHash ? shortHash(att.outputHash, 8) : "not stored"}
              </dd>
            </div>
            <p className="pt-1 text-subtle">
              Stored by the contract. OutLayer&apos;s attestation covers the same two hashes; compare them there to
              check the run yourself.
            </p>
          </dl>
        ) : (
          <>
            <div className="text-label text-subtle">TDX quote, truncated</div>
            {att ? (
              <p className="cipher mt-1.5 line-clamp-2">{att.quote}</p>
            ) : (
              <div className="mt-2 space-y-1.5">
                <Skeleton className="h-3 w-full" rounded="sm" />
                <Skeleton className="h-3 w-2/3" rounded="sm" />
              </div>
            )}
          </>
        )}
      </div>
    </Panel>
  );
}

/** One numbered check in the ledger: what was checked, its state, and the proof underneath. */
function ProofRow({
  n,
  state,
  idle,
  label,
  pending,
  href,
  children,
}: {
  n: number;
  state: CheckState;
  /** The word for a check that did not run: it does not apply to this sale, or it could not be run here. */
  idle: string;
  label: React.ReactNode;
  /** What the row says while it is still checking. */
  pending: string;
  href?: string;
  children: React.ReactNode;
}) {
  const tone = { pass: "text-ok", fail: "text-bad", pending: "text-muted", idle: "text-subtle" }[state];
  const word = { pass: "Passed", fail: "Failed", pending: "Checking", idle }[state];
  return (
    <li className="grid grid-cols-[1rem_minmax(0,1fr)] items-baseline gap-x-2.5 px-5 py-3">
      <span className="num text-label text-subtle" aria-hidden>
        {n}
      </span>
      <div className="min-w-0">
        <div className="flex items-baseline justify-between gap-x-4">
          <span className={cn("min-w-0 text-small", state === "pending" ? "text-muted" : "text-fg")}>
            {label}
            {href && (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="ml-2 inline-flex items-center gap-0.5 text-label text-muted underline decoration-line-strong underline-offset-2 transition-colors hover:text-fg"
                aria-label="Open the source of this check"
              >
                source <ArrowUpRight className="size-3" aria-hidden />
              </a>
            )}
          </span>
          <span className={cn("shrink-0 text-label font-[510]", tone)}>{word}</span>
        </div>
        <div className="mt-1 min-h-5">
          {state === "pending" ? (
            <Note tone="subtle">{pending}</Note>
          ) : (
            <div key={state} className="anim-fade">
              {children}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

/** Two hashes on one mono line with = or ≠ between them. It wraps on phones. */
function Pair({ a, b, ok }: { a: [string, string]; b: [string, string]; ok: boolean }) {
  return (
    <p className="cipher flex flex-wrap items-baseline gap-x-2">
      <span>
        <span className="font-sans text-label text-subtle">{a[0]}</span> {a[1]}
      </span>
      <span className={ok ? "text-ok" : "text-bad"} role="img" aria-label={ok ? "equals" : "does not equal"}>
        {ok ? "=" : "≠"}
      </span>
      <span>
        <span className="font-sans text-label text-subtle">{b[0]}</span> {b[1]}
      </span>
    </p>
  );
}

function Note({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "subtle" | "bad" }) {
  return (
    <p className={cn("text-label", { muted: "text-muted", subtle: "text-subtle", bad: "text-bad" }[tone])}>
      {children}
    </p>
  );
}
