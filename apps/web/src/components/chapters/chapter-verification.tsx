"use client";

import { useState, useSyncExternalStore } from "react";
import { Download, Link2, ShieldCheck } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Tag } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { chapterAmount, type ChapterRound, type ChapterSeries } from "@/lib/chapters/model";
import { readPayoutReceipt, subscribePayoutReceipt } from "@/lib/chapters/payout-receipt";
import { chapterLink } from "@/lib/chapters/reminders";
import type { ChapterSandbox } from "@/lib/chapters/sandbox";
import { dateTime } from "@/lib/format";
import {
  chapterSnapshot,
  verifyChapter,
  type ChapterCheck,
  type ChapterPublicEvidence,
  type ChapterVerificationReport,
} from "@/lib/chapters/verification";

type Report = Omit<ChapterVerificationReport, "snapshot">;

const STATUS = {
  passed: "Passed", failed: "Failed", pending: "Pending", unavailable: "Unavailable", not_applicable: "Not applicable",
} as const satisfies Record<ChapterCheck["status"], string>;

const SOURCE = {
  "simulated": "Simulated records checked in this browser.",
  "local-sandbox": "Local sandbox records checked in this browser.",
  "testnet": "NEAR testnet records checked in this browser.",
} satisfies Record<Report["source"], string>;

function CheckRow({ title, check, children }: { title: string; check: ChapterCheck; children?: React.ReactNode }) {
  return (
    <li className="space-y-2 py-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
        <h5 className="text-small font-[510] text-fg">{title}</h5>
        <Tag tone={check.status === "passed" ? "ok" : check.status === "failed" ? "bad" : "neutral"}>
          {STATUS[check.status]}
        </Tag>
      </div>
      <p className="text-small text-muted">{check.message}</p>
      {children}
    </li>
  );
}

function Digest({ label, sha256 }: { label: string; sha256: string }) {
  return <p className="text-label text-muted">{label} <code className="break-all text-fg">{sha256}</code></p>;
}

function confirmationTime(ns: string) {
  if (!/^[0-9]{1,20}$/.test(ns)) return ns;
  return dateTime(Number(BigInt(ns) / 1_000_000n));
}

function payoutAmount(amount: string, decimals: number, symbol: string) {
  return /^(0|[1-9][0-9]{0,38})$/.test(amount) ? chapterAmount(amount, decimals, symbol) : amount;
}

function PayoutLink({ saleId, roundId, hash }: { saleId: string; roundId: number; hash: string }) {
  const [feedback, setFeedback] = useState<{ copied: boolean; url: string } | null>(null);

  async function copyLink() {
    const url = new URL(chapterLink(roundId, saleId), window.location.origin);
    url.searchParams.set("payoutRound", String(roundId));
    url.searchParams.set("payout", hash);
    url.hash = `verify-chapter-${roundId}`;
    try {
      await navigator.clipboard.writeText(url.href);
      setFeedback({ copied: true, url: url.href });
    } catch {
      setFeedback({ copied: false, url: url.href });
    }
  }

  return <div className="space-y-1.5">
    <Button type="button" size="sm" variant="outline" onClick={() => void copyLink()} icon={<Link2 className="size-3.5" aria-hidden />}>
      Copy payout verification link
    </Button>
    {feedback && <p role="status" className="text-label text-muted">
      {feedback.copied ? "Verification link copied." : <>Copy this link <span className="select-all break-all text-fg">{feedback.url}</span></>}
    </p>}
  </div>;
}

function downloadReport(report: Report) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${report.saleId}-chapter-${report.round.id}-evidence.json`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ChapterVerification({ round, sandbox, series, decimals = series.decimals, readMockEvidence, mockQuoteToken }: {
  round: ChapterRound;
  sandbox: ChapterSandbox | null;
  series: ChapterSeries;
  decimals?: number;
  readMockEvidence?: () => ChapterPublicEvidence | Promise<ChapterPublicEvidence>;
  mockQuoteToken?: string;
}) {
  const [verified, setVerified] = useState<{ report: Report; requested: string; read: string; hash: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [manualHash, setManualHash] = useState<string | null>(null);
  const params = useSearchParams();
  const cachedHash = useSyncExternalStore(subscribePayoutReceipt, () => sandbox && readPayoutReceipt(sandbox, round.round_id), () => null);
  const linkedHash = params.get("payoutRound") === String(round.round_id) ? params.get("payout")?.slice(0, 48) : null;
  const canCheckReceipt = sandbox && round.phase === "finalized" && round.bounty_state === "paid";
  const hashInput = manualHash ?? linkedHash ?? cachedHash ?? "";
  const hash = canCheckReceipt ? hashInput.trim() : "";
  const report = verified?.report;
  const currentSnapshot = chapterSnapshot(round);
  const isCurrent = verified && verified.hash === hash && (currentSnapshot === verified.requested || currentSnapshot === verified.read);

  async function run() {
    setBusy(true);
    setVerified(null);
    setError(null);
    try {
      const { snapshot: read, ...report } = await verifyChapter({ round, sandbox, series, decimals, readMockEvidence, mockQuoteToken, payoutHash: hash });
      setVerified({ report, requested: currentSnapshot, read, hash });
    } catch {
      setError("The chapter records could not be read. Run the checks again.");
    } finally {
      setBusy(false);
    }
  }

  const computed = report?.tally.computed;
  const receipt = report?.payoutReceipt.evidence;

  return (
    <section id={`verify-chapter-${round.round_id}`} className="scroll-mt-20 border-t border-line px-5 py-5 sm:px-6" aria-labelledby={`verify-chapter-heading-${round.round_id}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h4 id={`verify-chapter-heading-${round.round_id}`} className="text-h3 text-fg">Verify chapter</h4>
          <p className="mt-1 text-small text-muted">Check the public tally, artwork and payout.</p>
        </div>
        <Button variant="outline" onClick={() => void run()} loading={busy} icon={<ShieldCheck className="size-4" aria-hidden />}>
          {report ? "Run checks again" : "Run public checks"}
        </Button>
      </div>
      {canCheckReceipt && <Field label="Payout transaction hash" className="mt-4 max-w-lg" inputClassName="font-mono"
        hint="The app fills this in when the wallet returns the claim hash. You can also paste it from the wallet’s transaction history."
        autoComplete="off" spellCheck={false} maxLength={48} value={hashInput} disabled={busy}
        onChange={(event) => setManualHash(event.target.value)} onKeyDown={(event) => {
          if (event.key === "Enter" && !busy) {
            event.preventDefault();
            void run();
          }
        }} />}
      {error && <p className="mt-3 text-small text-bad" role="alert">{error}</p>}
      {report && !isCurrent && <p className="mt-3 text-small text-muted" role="status">Run the checks again for the current chapter and transaction.</p>}
      {report && isCurrent && <div className="mt-4">
        <p className="text-label text-muted" role="status">{SOURCE[report.source]}</p>
        <ul className="mt-3 divide-y divide-line border-y border-line">
          <CheckRow title="Tally and quorum" check={report.tally.check}>
            {computed && <p className="text-label text-muted">
              {report.artwork.map((art, index) => `${art.title} ${chapterAmount(computed.tallies[index], decimals, series.symbol)}`).join(" · ")}
            </p>}
            <p className="text-label text-subtle">The recount uses recorded choices. The contract checks the opening code when each holder reveals.</p>
          </CheckRow>
          {report.artwork.map((art, index) => <CheckRow key={index} title={`${art.title} artwork`} check={art.check}>
            <Digest label={report.round.winner === index ? "Winning SHA-256" : "Recorded SHA-256"} sha256={art.expected} />
            {art.actual && art.actual !== art.expected && <Digest label="Downloaded SHA-256" sha256={art.actual} />}
          </CheckRow>)}
          <CheckRow title={sandbox ? "Contract-confirmed payout" : "Simulated payout"} check={report.payoutCheck}>
            {report.payout && <dl className="grid gap-1.5 text-label text-muted sm:grid-cols-2">
              <div><dt className="inline">Recipient </dt><dd className="inline break-all text-fg">{report.payout.recipient}</dd></div>
              <div><dt className="inline">Asset </dt><dd className="inline break-all text-fg">{report.payout.token_id}</dd></div>
              <div><dt className="inline">Amount </dt><dd className="num inline break-all text-fg">
                {payoutAmount(report.payout.amount, report.quoteDecimals, sandbox?.quoteSymbol ?? "test USDC")}
              </dd></div>
              {report.payout.paid_at && <div><dt className="inline">Confirmed at </dt><dd className="num inline break-all text-fg">{confirmationTime(report.payout.paid_at)}</dd></div>}
            </dl>}
          </CheckRow>
          {sandbox && <CheckRow title="Token transfer receipt" check={report.payoutReceipt.check}>
            {receipt && <>
              <Digest label="Payout transaction" sha256={receipt.transactionHash} />
              <Digest label="Token receipt" sha256={receipt.transferReceiptId} />
              <Digest label="Callback receipt" sha256={receipt.callbackReceiptId} />
              <PayoutLink key={receipt.transactionHash} saleId={series.saleId} roundId={report.round.id} hash={receipt.transactionHash} />
            </>}
          </CheckRow>}
        </ul>
        <Button className="mt-4" variant="outline" onClick={() => downloadReport(report)} icon={<Download className="size-4" aria-hidden />}>
          Download chapter evidence
        </Button>
      </div>}
    </section>
  );
}
