"use client";

import { use } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { BidSetPanel } from "@/components/result/bid-inclusion";
import { VerifiedPanel } from "@/components/result/verified-panel";
import { EventLog } from "@/components/sale-common/event-log";
import { SaleStatusBadge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Empty, PageHeader, Panel } from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { getClient } from "@/lib/client";
import { dateTime } from "@/lib/format";
import { DocumentTitle, useClientQuery } from "@/lib/hooks";
import { EvidenceExport } from "./evidence-export";
import { VerifyEnvironment } from "./environment";
import { validVerifyId } from "./public-evidence";
import { TrustBoundaries } from "./trust-boundaries";

export function VerifySkeleton() {
  return <div className="space-y-6" aria-label="Loading sale evidence"><Skeleton className="h-12 w-3/4" /><Skeleton className="h-20 w-full" /><Skeleton className="h-80 w-full" /></div>;
}

export function VerifySaleRoute({ params }: { params: Promise<{ id: string }> }) {
  // Next has decoded this segment. Decoding it again changes the requested ID.
  const { id } = use(params);
  if (!validVerifyId(id)) return <Empty title="Invalid sale ID" body="Use the sale’s short ID, not a full URL or account name." action={<ButtonLink href="/verify">Find a sale</ButtonLink>} />;
  return <VerifySale key={id} id={id} />;
}

function VerifySale({ id }: { id: string }) {
  const snapshot = useClientQuery(async () => {
    const client = getClient();
    const sale = await client.getSale(id);
    if (!sale) return { sale: null, result: null, readAt: Date.now() };
    const result = await client.getResult(id);
    return { sale, result, readAt: Date.now() };
  }, ["verify-snapshot", id], 30_000);

  if (snapshot.loading) return <VerifySkeleton />;
  if (snapshot.error && !snapshot.data) return <Empty title="Could not load the evidence" body="The active environment did not return the sale data. No checks have run on this page." action={<Button onClick={snapshot.refetch}>Try again</Button>} />;
  const sale = snapshot.data?.sale;
  if (!sale) return <Empty title="Sale not found here" body={`No sale named “${id}” was found in the active environment. A simulated sale only exists in the browser where it was created.`} action={<ButtonLink href="/verify">Find another sale</ButtonLink>} />;
  const result = snapshot.data?.result;
  const path = encodeURIComponent(sale.id);
  const final = sale.status === "settled" || sale.status === "failed";

  return (
    <div className="flex w-full flex-col gap-8 sm:gap-10">
      <DocumentTitle title={`Verify ${sale.config.tokenName}`} />
      <Link href="/verify" className="inline-flex w-fit items-center gap-2 text-label text-muted hover:text-fg"><ArrowLeft className="size-3.5" aria-hidden />All sale evidence</Link>
      <PageHeader title={<>Verify {sale.config.tokenName}</>} description="Inspect the records behind this sale. Expand each check to see its evidence and limits." actions={<><ButtonLink href={`/sale/${path}${final ? "/result" : ""}`} variant="primary">{final ? "View result" : "View sale"}</ButtonLink><ButtonLink href={`/token/${path}`} variant="ghost">Token page</ButtonLink><ButtonLink href="#activity" variant="ghost">Activity</ButtonLink></>} />
      <VerifyEnvironment />
      <Panel bodyClassName="p-5">
        <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:gap-8">
          <div><dl className="flex flex-col gap-3 text-small">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1"><dt className="w-20 shrink-0 text-subtle">Sale</dt><dd className="break-all font-mono text-fg">{sale.id}</dd></div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1"><dt className="w-20 shrink-0 text-subtle">Status</dt><dd><SaleStatusBadge status={sale.status} plain /></dd></div>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1"><dt className="w-20 shrink-0 text-subtle">Data read</dt><dd className="text-muted">{snapshot.data ? dateTime(snapshot.data.readAt) : "Unavailable"}</dd></div>
          </dl><p className="mt-3 text-label text-subtle">Sale data refreshes every 30 seconds. Check timestamps appear below; use Re-run checks to refresh them.</p></div>
          <EvidenceExport saleId={sale.id} />
        </div>
        {snapshot.error && <p role="status" className="mt-4 text-small text-bad">The latest data refresh failed. The last successful snapshot is still shown.</p>}
      </Panel>
      <details className="panel overflow-hidden">
        <summary className="cursor-pointer px-5 py-4 text-small font-medium text-fg">Sale identifiers and pinned hashes</summary>
        <dl className="grid gap-4 border-t border-line p-5 text-label sm:grid-cols-2">
          {[
            ["Token account", sale.tokenAccount],
            ["Pinned sealer build", sale.config.revealMode === "tee" ? sale.sealerCodeHash || "Not available yet" : "Not applicable: on-chain reveal"],
            ["Sale encryption public key", sale.config.revealMode === "tee" ? sale.sealerPubkey || "Not available yet" : "Not applicable: on-chain reveal"],
            ["Frozen bid-set hash", sale.bidSetHash ?? "Not frozen yet"],
          ].map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-subtle">{label}</dt><dd className="mt-1 break-all font-mono leading-relaxed text-muted">{value}</dd></div>)}
        </dl>
      </details>
      {final && result ? (
        <VerifiedPanel key={`${sale.id}:${result.resultSha256 ?? result.settleTx}`} sale={sale} result={result} />
      ) : (
        <>
          <Panel title={final ? "Result evidence unavailable" : "Settlement checks are not available yet"}>
            <p className="max-w-[65ch] text-small leading-relaxed text-muted">{final ? "The sale is final, but no result was returned. This page cannot run the result checks until that evidence is available." : "This sale has not reached a final result. There is no clearing outcome to verify yet. Once the bid set is frozen, its public hash check appears below."}</p>
            {final && <Button onClick={snapshot.refetch} size="sm" className="mt-4">Retry result</Button>}
          </Panel>
          {sale.bidSetHash !== null && <BidSetPanel sale={sale} />}
        </>
      )}
      <TrustBoundaries />
      <div id="activity" className="scroll-mt-24"><EventLog saleId={sale.id} title="Public activity" includeBids /></div>
    </div>
  );
}
