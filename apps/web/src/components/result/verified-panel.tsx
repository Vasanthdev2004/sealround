"use client";

import { useEffect, useState } from "react";
import { Check, ChevronDown, RefreshCw, X } from "lucide-react";
import { Tag } from "@/components/ui/badge";
import { CheckRow, SimulatedNote, type CheckState } from "@/components/ui/bits";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
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

const timeStr = (at: number) =>
  new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/**
 * The five checks from the spec, run in this browser. The attestation is
 * fetched with a fresh random nonce every run, so a replayed answer fails.
 */
export function VerifiedPanel({ sale, result }: { sale: Sale; result: SaleResult }) {
  const [attempt, setAttempt] = useState(0);
  const [run, setRun] = useState<Run | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const nonce = randomHex(16);
    getClient()
      .getAttestation(sale.id, nonce)
      .then(
        (attestation) => {
          if (!cancelled) setRun({ attempt, nonce, attestation });
        },
        (e: unknown) => {
          if (!cancelled) setRun({ attempt, nonce, error: e instanceof Error ? e.message : String(e) });
        },
      );
    return () => {
      cancelled = true;
    };
  }, [sale.id, attempt]);

  const pending = !run || run.attempt !== attempt;
  const att = !pending ? run.attestation : undefined;
  const fetchError = !pending ? run.error : undefined;
  const sentNonce = run?.nonce ?? "";
  const client = getClient();
  const expected = client.expectedCodeHash();
  const timedOut = result.failReason === "settle_timeout";
  // On the mock chain the attestation is signed by nothing and the settle
  // transaction has no explorer page: say so up front, and link nowhere fake.
  const simulated = client.mode === "mock" || !!att?.simulated;
  const settleHref = simulated ? undefined : txUrl(result.settleTx);

  // 1. Fresh nonce
  const nonceOk = !!att && att.nonce === sentNonce;
  const c1: CheckState = pending ? "pending" : nonceOk ? "pass" : "fail";
  // 2. Code hash
  const c2: CheckState = pending ? "pending" : att && att.codeHash === expected ? "pass" : "fail";
  // 3. Public key
  const c3: CheckState = pending ? "pending" : att && att.reportedPubkey === sale.sealerPubkey ? "pass" : "fail";
  // 4. Bid-set hash
  const hashOk = !!sale.bidSetHash && result.bidSetHash === sale.bidSetHash;
  const c4: CheckState = timedOut ? "idle" : pending ? "pending" : hashOk ? "pass" : "fail";
  // 5. Contract checks
  const failing = result.checks.filter((ch) => !ch.passed);
  const onlyMinRaise =
    result.status === "failed" && failing.length === 1 && failing[0].id === "raise_at_least_min";
  const c5: CheckState =
    result.checks.length === 0 ? "idle" : pending ? "pending" : failing.length === 0 || onlyMinRaise ? "pass" : "fail";

  const states = [c1, c2, c3, c4, c5];
  const applicable = states.filter((s) => s !== "idle");
  const passed = applicable.filter((s) => s === "pass").length;

  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          Verified {simulated && <Tag tone="warn">simulated</Tag>}
        </span>
      }
      subtitle={
        pending
          ? "Running checks in your browser…"
          : `${passed} of ${applicable.length} checks passed${simulated ? " against a simulated attestation" : ""}, just now, in your browser.`
      }
      action={
        <Button
          size="sm"
          onClick={() => setAttempt((a) => a + 1)}
          disabled={pending}
          icon={<RefreshCw className={cn("size-3.5", pending && "animate-spin")} strokeWidth={1.75} />}
        >
          <span className="hidden sm:inline">Re-run checks</span>
          <span className="sm:hidden">Re-run</span>
        </Button>
      }
      bodyClassName="px-5 py-2"
    >
      {simulated && (
        <SimulatedNote className="pt-2 pb-1">
          This attestation is simulated in the demo, signed by nothing. On testnet it will be a real Intel TDX quote
          fetched from OutLayer, covering the sealer&apos;s code hash, its input (the bid set) and its output. The
          checks below run for real against it.
        </SimulatedNote>
      )}
      <div className="divide-y divide-dashed divide-line-dashed">
        <CheckRow
          state={c1}
          label="OutLayer attestation fetched with a fresh random nonce"
          detail={
            pending
              ? "Sending a new 16-byte nonce…"
              : fetchError
                ? `Fetch failed: ${fetchError}`
                : nonceOk && att
                  ? `nonce ${shortHash(sentNonce, 6)} echoed back · ${timeStr(att.fetchedAt)}`
                  : "The attestation answered a different nonce. It could be a replay."
          }
          href={att?.url}
        />
        <CheckRow
          state={c2}
          label="Enclave code hash equals our reproducible build"
          detail={
            pending
              ? "Comparing code hashes…"
              : att
                ? att.codeHash === expected
                  ? `${shortHash(att.codeHash, 8)} matches the build from the public repo`
                  : `attested ${shortHash(att.codeHash, 6)}, expected ${shortHash(expected, 6)}`
                : "No attestation to compare."
          }
          href={att?.url}
        />
        <CheckRow
          state={c3}
          label="Sealer public key on-chain matches the attestation"
          detail={
            pending
              ? "Comparing public keys…"
              : att
                ? att.reportedPubkey === sale.sealerPubkey
                  ? `${shortHash(sale.sealerPubkey, 8)} on-chain and attested`
                  : `on-chain ${shortHash(sale.sealerPubkey, 6)}, attested ${shortHash(att.reportedPubkey, 6)}`
                : "No attestation to compare."
          }
          href={simulated ? undefined : accountUrl(client.contractId)}
        />
        <CheckRow
          state={c4}
          label="Result's bid-set hash equals the contract's stored hash"
          detail={
            timedOut
              ? "No enclave result. The sale moved to refunds after the settle timeout."
              : pending
                ? "Comparing bid-set hashes…"
                : hashOk
                  ? `${shortHash(result.bidSetHash, 8)} stored at close and reported by the enclave`
                  : `stored ${shortHash(sale.bidSetHash ?? "none", 6)}, reported ${shortHash(result.bidSetHash, 6)}`
          }
          href={settleHref}
        />
        <div>
          <CheckRow
            state={c5}
            label="All contract-side checks passed"
            detail={
              result.checks.length === 0
                ? "No enclave result to check. Refunds need no checks."
                : pending
                  ? "Re-reading the checks…"
                  : onlyMinRaise
                    ? `${result.checks.length - 1} of ${result.checks.length} passed. Minimum raise not met: the contract correctly moved the sale to refunds.`
                    : `${result.checks.length - failing.length} of ${result.checks.length} passed`
            }
            href={settleHref}
          />
          {result.checks.length > 0 && (
            <div className="pb-2 pl-8">
              <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                aria-expanded={open}
                className="inline-flex items-center gap-1 text-[12px] text-muted hover:text-fg"
              >
                <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} strokeWidth={1.75} />
                {open ? "Hide" : "Show"} the {result.checks.length} checks
              </button>
              {open && (
                <ul className="inset mt-2 divide-y divide-line px-3">
                  {result.checks.map((ch) => {
                    const expectedFail = onlyMinRaise && ch.id === "raise_at_least_min";
                    return (
                      <li key={ch.id} className="flex items-start gap-2.5 py-2">
                        {ch.passed ? (
                          <Check className="mt-0.5 size-3.5 shrink-0 text-ok" strokeWidth={2.5} />
                        ) : (
                          <X
                            className={cn("mt-0.5 size-3.5 shrink-0", expectedFail ? "text-warn" : "text-bad")}
                            strokeWidth={2.5}
                          />
                        )}
                        <div className="min-w-0 text-[12.5px] leading-snug">
                          <span className={ch.passed ? "text-muted" : "text-fg"}>{ch.label}</span>
                          {expectedFail && (
                            <span className="mt-0.5 block text-[11.5px] text-subtle">
                              Expected on this sale: the raise fell short, so the contract refunded everyone instead of
                              settling.
                            </span>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>

      {att && (
        <div className="inset my-3 space-y-1.5 p-3">
          <div className="flex items-center justify-between gap-3 text-[11.5px]">
            <span className="text-subtle">TDX quote (truncated)</span>
            <span className="num text-subtle">{timeStr(att.fetchedAt)}</span>
          </div>
          <p className="cipher line-clamp-2">{att.quote}</p>
        </div>
      )}
    </Panel>
  );
}
