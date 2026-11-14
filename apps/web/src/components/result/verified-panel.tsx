"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight, Check, ChevronDown, RefreshCw, X } from "lucide-react";
import { Tag } from "@/components/ui/badge";
import { TxLink, type CheckState } from "@/components/ui/bits";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { getClient } from "@/lib/client";
import { ago, dateTime, shortHash, txUrl } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import type { AttestedRun, MissingRun, RunCheckId, RunKind, Sale, SaleResult } from "@/lib/types";
import { CHAIN_ROWS } from "@/lib/verify/labels";
import type { FullVerification } from "@/lib/verify/types";
import { BidInclusionDetail, useBidSetCheck, useYourBidCheck } from "./bid-inclusion";
import { Chain, ChainEvidence, chainRowState, Evidence, Note, QuoteExcerpt } from "./evidence";

type Fetched = { attempt: number; verification: FullVerification | null; error?: string };

/** How many rows have been revealed for a given attempt. */
type Shown = { attempt: number; n: number };

/** Gap between two rows ticking, so the sequence reads. */
const STEP_MS = 110;

/** The checks of each enclave run (near/attestation.ts), in the order they show. */
const RUN_ROWS: { id: RunCheckId; label: string; pending: string }[] = [
  { id: "build", label: "Attested build is the sealer the contract pins", pending: "Comparing build hashes." },
  { id: "executed", label: "The worker measured the same build", pending: "Comparing the measured build." },
  { id: "input", label: "Input hash matches the request on chain", pending: "Hashing the request's input." },
  { id: "output", label: "Output hash matches what the contract received", pending: "Hashing the returned bytes." },
  { id: "task", label: "The TDX quote commits to this record", pending: "Recomputing the task hash." },
  { id: "measurements", label: "Enclave measurements are approved on chain", pending: "Asking the register contract." },
  { id: "request", label: "The request came from the sale contract, for this sale", pending: "Reading the request." },
  { id: "key", label: "The job's answer names the sale's key", pending: "Comparing keys." },
];

const RUN_NAME: Record<RunKind, string> = { clear: "Clearing", key: "Sale key" };

type Row = {
  key: string;
  label: string;
  state: CheckState;
  /** The word for a check that did not run here. */
  idle: string;
  pending: string;
  href?: string;
  body: React.ReactNode;
};

const timeStr = (at: number) =>
  new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

const reducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A run's state for one check: pass, fail, or null when it could not run here. */
function runOk(run: AttestedRun | MissingRun, id: RunCheckId): boolean | null {
  return run.found ? (run.checks.find((c) => c.id === id)?.ok ?? null) : null;
}

/**
 * The checks run in this browser. In NEAR mode they are real: the panel finds
 * the transaction behind each enclave run (the sale key run and the clearing
 * run), fetches OutLayer's attestation for it and checks it against the chain
 * (near/attestation.ts, a port of enclave/deploy/Verify-Attestation.ps1). The
 * bid set is recomputed from get_bids. The mock runs the same rows over a
 * simulated, unsigned attestation and says so.
 *
 * The panel leads with the outcome ("11 of 11 checks passed"), what the
 * checks ran against and how old the evidence is (OutLayer takes no nonce).
 * The checks follow as a ledger, each with its evidence; the raw quote and
 * what is not checked here close it.
 */
export function VerifiedPanel({ sale, result }: { sale: Sale; result: SaleResult }) {
  const [attempt, setAttempt] = useState(0);
  const [fetched, setFetched] = useState<Fetched | null>(null);
  const [shown, setShown] = useState<Shown>({ attempt: -1, n: 0 });
  const [open, setOpen] = useState(false);
  const now = useNow(30_000);
  const bidSet = useBidSetCheck(sale);
  /** Commit-reveal: the contract cleared the revealed bids itself, with no enclave. */
  const onchain = result.clearedBy === "onchain";
  const total = (onchain ? 1 : RUN_ROWS.length) + 3 + CHAIN_ROWS.length;
  const yourBid = useYourBidCheck(sale, result, bidSet.state === "pending" ? null : bidSet.bids, bidSet.error);

  useEffect(() => {
    let cancelled = false;
    const timers: number[] = [];
    const reveal = () => {
      if (reducedMotion()) {
        setShown({ attempt, n: total });
        return;
      }
      for (let i = 1; i <= total; i++) {
        timers.push(window.setTimeout(() => !cancelled && setShown({ attempt, n: i }), i * STEP_MS));
      }
    };
    // A sale the contract cleared itself (commit-reveal) has no enclave run; the contract and rule checks still run.
    const asked: Promise<FullVerification | null> = getClient().verifySale(sale.id);
    asked.then(
      (verification) => {
        if (cancelled) return;
        setFetched({ attempt, verification });
        reveal();
      },
      (e: unknown) => {
        if (cancelled) return;
        setFetched({ attempt, verification: null, error: e instanceof Error ? e.message : String(e) });
        reveal();
      },
    );
    return () => {
      cancelled = true;
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [sale.id, attempt, total]);

  const current = fetched && fetched.attempt === attempt ? fetched : null;
  const revealed = shown.attempt === attempt ? shown.n : 0;
  const v = current?.verification ?? null;
  const fetchError = current?.error;
  const client = getClient();
  const simulated = client.mode === "mock" || !!v?.simulated;
  const timedOut = result.failReason === "settle_timeout";
  const settleHref = simulated || !result.settleTx || txUrl(result.settleTx) === "#" ? undefined : txUrl(result.settleTx);
  // Clearing first: it is what the result rests on.
  const runs = v ? [v.clear, v.key].filter((r): r is AttestedRun | MissingRun => r !== null) : [];
  const attested = runs.filter((r): r is AttestedRun => r.found);
  const missing = runs.filter((r): r is MissingRun => !r.found);

  // ---------- the rows ----------

  const rows: Row[] = [];
  if (onchain) {
    rows.push({
      key: "enclave",
      label: "Enclave runs",
      state: "idle",
      idle: "Not applicable",
      pending: "",
      body: <Note>No enclave ran: the contract cleared the revealed bids itself.</Note>,
    });
  } else {
    for (const def of RUN_ROWS) {
      const oks = runs.map((r) => runOk(r, def.id));
      const state: CheckState = !current
        ? "pending"
        : oks.some((o) => o === false)
          ? "fail"
          : oks.length > 0 && oks.every((o) => o === true)
            ? "pass"
            : "idle";
      rows.push({
        key: def.id,
        label: def.label,
        state,
        idle: oks.some((o) => o === true) ? "In part" : runs.length || fetchError ? "Not run" : "Not applicable",
        pending: def.pending,
        href: attested.length === 1 && attested[0].verifierUrl ? attested[0].verifierUrl : undefined,
        body: fetchError ? (
          <Note>Not run: the evidence could not be fetched.</Note>
        ) : runs.length === 0 ? (
          <Note>No enclave run to check.</Note>
        ) : (
          <div className="flex flex-col gap-1.5">
            {runs.map((r) => (
              <div key={r.kind} className="flex flex-col gap-x-3 sm:grid sm:grid-cols-[4.5rem_minmax(0,1fr)]">
                <span className="text-label text-subtle">{RUN_NAME[r.kind]}</span>
                <div className="flex min-w-0 flex-col gap-0.5">
                  {r.found ? (
                    (r.checks.find((c) => c.id === def.id)?.items ?? []).map((item, i) => <Evidence key={i} item={item} />)
                  ) : (
                    <Note tone="subtle">Not run</Note>
                  )}
                </div>
              </div>
            ))}
          </div>
        ),
      });
    }
  }

  // The bid set the enclave (or the contract) cleared is the one frozen at close.
  const hashOk = !!sale.bidSetHash && result.bidSetHash === sale.bidSetHash;
  rows.push({
    key: "bid-set",
    label: "Result's bid-set hash equals the frozen set",
    state: timedOut || onchain ? "idle" : hashOk ? "pass" : "fail",
    idle: "Not applicable",
    pending: "Comparing bid-set hashes.",
    href: settleHref,
    body: onchain ? (
      <Note>
        The contract cleared the bid set it froze at close,{" "}
        <span className="font-mono">{shortHash(sale.bidSetHash ?? "none", 6)}</span>, with no result from outside.
      </Note>
    ) : timedOut ? (
      <Note>No enclave result. The sale moved to refunds after the settle timeout.</Note>
    ) : (
      <Chain
        values={[
          { label: "frozen at close", value: sale.bidSetHash ?? "none" },
          { label: "result", value: result.bidSetHash || "none" },
        ]}
        ok={hashOk}
      />
    ),
  });

  rows.push({
    key: "inclusion",
    label: "Recomputed bid set matches the frozen hash",
    state: bidSet.state,
    idle: bidSet.error ? "Not run" : "Not applicable",
    pending: "Recomputing the bid set.",
    body: bidSet.check ? (
      <BidInclusionDetail sale={sale} check={bidSet.check} bids={bidSet.bids} />
    ) : (
      <Note tone={bidSet.error ? "bad" : "muted"}>
        {bidSet.error ? `Could not verify the bid set: ${bidSet.error}` : "The sale has no frozen bid set."}
      </Note>
    ),
  });

  const failing = result.checks.filter((ch) => !ch.passed);
  const onlyMinRaise = result.status === "failed" && failing.length === 1 && failing[0].id === "raise_at_least_min";
  // The same check row also stands for "something was sold": a sale with no valid bid fails it without missing a raise.
  const noValidBids = result.failReason === "no_valid_bids";
  rows.push({
    key: "contract",
    label: onlyMinRaise ? "The contract correctly moved the sale to refunds" : "Contract-side checks",
    state: result.checks.length === 0 ? "idle" : failing.length === 0 || onlyMinRaise ? "pass" : "fail",
    idle: "Not applicable",
    pending: "Reading the checks again.",
    href: settleHref,
    body: (
      <>
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
      </>
    ),
  });

  // The contract account, the applied output, the rules, the lengths, the pool and your bid (lib/verify).
  for (const def of CHAIN_ROWS) {
    const check = def.id === "your_bid" ? yourBid : (v?.chain?.checks.find((c) => c.id === def.id) ?? null);
    const { state, idle } = chainRowState(check, def.id === "your_bid" ? check !== null : !!current);
    rows.push({
      key: def.id,
      label: def.label,
      state,
      idle,
      pending: def.pending,
      body: <ChainEvidence check={check} error={def.id === "your_bid" ? undefined : fetchError} />,
    });
  }

  // ---------- the verdict ----------

  const states: CheckState[] = rows.map((r, i) => (i < revealed ? r.state : "pending"));
  const done = revealed >= rows.length && rows.every((r) => r.state !== "pending");
  const notRun = rows.filter((r) => r.state === "idle" && r.idle !== "Not applicable").length;
  const passed = rows.filter((r) => r.state === "pass").length;
  const counted = rows.filter((r) => r.state === "pass" || r.state === "fail").length + notRun;

  const against = onchain
    ? ". The contract cleared this sale itself from the revealed bids, so no enclave ran"
    : fetchError
      ? `. Fetching the evidence failed: ${fetchError}`
      : simulated
        ? " against an unsigned, simulated attestation"
        : attested.length
          ? ` against OutLayer's attestation${attested.length > 1 ? "s" : ""} ${attested.map((r) => `#${r.attestationId}`).join(" and ")} and the chain`
          : " against the chain";
  const how = !done
    ? onchain
      ? "Reading the contract's result again."
      : current
        ? "Comparing the attestations with the chain."
        : "Finding the runs' transactions and fetching OutLayer's attestations."
    : `Run in your browser at ${timeStr(v?.checkedAt ?? now)}${against}.`;

  return (
    <Panel
      id="verification"
      title={
        // As tall as the button beside it, so the two share a centre line.
        <span className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1">
          Verified {simulated && <Tag>simulated</Tag>}
          {done && notRun > 0 && <Tag tone="warn">in part</Tag>}
        </span>
      }
      action={
        <Button
          size="sm"
          aria-label="Re-run checks"
          aria-disabled={!done}
          onClick={() => {
            if (!done) return;
            bidSet.refetch();
            setAttempt((a) => a + 1);
          }}
          icon={<RefreshCw className={cn("size-3.5", !done && "motion-safe:animate-spin")} strokeWidth={1.75} aria-hidden />}
        >
          <span className="hidden sm:inline">Re-run checks</span>
          <span className="sm:hidden">Re-run</span>
        </Button>
      }
      bodyClassName="p-0"
    >
      <div className="px-5 pt-5 pb-4">
        <p className="sr-only" role="status">
          {done ? `${passed} of ${counted} checks passed${notRun ? `, ${notRun} not run` : ""}.` : "Verification in progress."}
        </p>
        <div className="text-h2 text-fg" aria-hidden>
          {!done ? (
            <>
              Checking <span className="num">{Math.min(revealed + 1, rows.length)}</span> of{" "}
              <span className="num">{rows.length}</span>
            </>
          ) : (
            <>
              <span className="num">{passed}</span> of <span className="num">{counted}</span> checks passed
              {notRun > 0 && (
                <>
                  , <span className="num">{notRun}</span> not run
                </>
              )}
            </>
          )}
        </div>
        <p className="mt-1 max-w-[64ch] text-small text-muted">{how}</p>
        {done && (attested.length > 0 || missing.length > 0) && (
          <dl className="mt-3 flex flex-col gap-1 text-label">
            {attested.map((r) => (
              <div key={r.kind} className="flex flex-wrap items-baseline gap-x-2">
                <dt className="text-subtle">{RUN_NAME[r.kind]} run</dt>
                <dd className="text-muted">
                  {r.blockHeight !== null && (
                    <>
                      block <span className="num">{r.blockHeight.toLocaleString("en-US")}</span>,{" "}
                    </>
                  )}
                  {simulated ? "simulated, " : ""}
                  <span className="num">{dateTime(r.at)}</span>, <span className="num">{ago(r.at, now)}</span>
                </dd>
              </div>
            ))}
            {missing.map((r) => (
              <div key={r.kind} className="flex flex-wrap items-baseline gap-x-2">
                <dt className="text-subtle">{RUN_NAME[r.kind]} run</dt>
                <dd className="text-warn">Not checked. {r.message}</dd>
              </div>
            ))}
          </dl>
        )}
        {done && attested.length > 0 && !simulated && (
          <p className="mt-1 text-label text-subtle">
            OutLayer takes no nonce, so these are when the runs happened, not a fresh challenge.
          </p>
        )}
      </div>

      <ol className="divide-y divide-line border-t border-line">
        {rows.map((r, i) => (
          <ProofRow
            key={r.key}
            n={i + 1}
            state={states[i]}
            idle={r.idle}
            label={r.label}
            pending={r.pending}
            href={r.href}
          >
            {r.body}
          </ProofRow>
        ))}
      </ol>

      {/* The raw evidence on the recessed surface: the transactions, the quote, and what is not checked here. */}
      <div className="flex flex-col gap-3 border-t border-line bg-inset px-5 py-4">
        {onchain ? (
          <p className="text-label text-muted">
            No TDX quote: this sale was cleared on chain. Anyone can replay it from the public reveals with the
            reference clearing code.
          </p>
        ) : !current ? (
          <div className="space-y-1.5">
            <Skeleton className="h-3 w-full" rounded="sm" />
            <Skeleton className="h-3 w-2/3" rounded="sm" />
          </div>
        ) : (
          <>
            {attested.length > 0 && (
              <ul className="flex flex-col gap-1 text-label">
                {attested.map((r) => (
                  <li key={r.kind} className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-subtle">{r.method ?? RUN_NAME[r.kind]}</span>
                    <TxLink hash={r.txHash} simulated={simulated} />
                    {!simulated && (
                      <span className="text-subtle">
                        by <span className="[overflow-wrap:anywhere]">{r.signer}</span>, {foundBy(r)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {attested[0] && (
              <QuoteExcerpt
                quote={attested[0].quote}
                label={`TDX quote${simulated ? ", simulated" : `, ${RUN_NAME[attested[0].kind].toLowerCase()} run`}`}
                fileName={`tdx-quote-${sale.id}-${attested[0].kind}.bin`}
              />
            )}
            <p className="text-label text-subtle">
              {simulated ? (
                "Simulated: there is no quote whose signature could be checked."
              ) : (
                <>
                  Not checked here: the quote&apos;s signature chain up to Intel.
                  {attested.some((r) => r.verifierUrl) && (
                    <>
                      {" "}
                      OutLayer&apos;s verifier checks it in your browser:{" "}
                      {attested
                        .filter((r) => r.verifierUrl)
                        .map((r, i) => (
                          <span key={r.kind}>
                            {i > 0 && ", "}
                            <a
                              href={r.verifierUrl!}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-0.5 text-muted underline decoration-line-strong underline-offset-2 transition-colors hover:text-fg"
                            >
                              {RUN_NAME[r.kind].toLowerCase()} run <ArrowUpRight className="size-3" aria-hidden />
                            </a>
                          </span>
                        ))}
                      .
                    </>
                  )}
                </>
              )}
            </p>
          </>
        )}
      </div>
    </Panel>
  );
}

/** How the run's transaction was found, in a few words. */
function foundBy(r: AttestedRun): string {
  switch (r.txSource) {
    case "block_scan":
      return `found in block ${r.scannedBlock?.toLocaleString("en-US") ?? "?"}`;
    case "tx_log":
      return "sent from this browser";
    case "outlayer_jobs":
      return "found in OutLayer's job list";
    default:
      return "simulated";
  }
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
  label: string;
  /** What the row says while it is still checking. */
  pending: string;
  href?: string;
  children: React.ReactNode;
}) {
  const tone = { pass: "text-ok", fail: "text-bad", pending: "text-muted", idle: "text-subtle" }[state];
  const word = { pass: "Passed", fail: "Failed", pending: "Checking", idle }[state];
  return (
    <li className="grid grid-cols-[1.25rem_minmax(0,1fr)] items-baseline gap-x-2 px-5 py-3">
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
                aria-label={`Source for ${label}`}
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
