"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { ArrowDownToLine, ArrowRight, Check, Clock3, Eye, Layers3, LockKeyhole, RefreshCw, Wallet } from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/button";
import { TokenAvatar } from "@/components/ui/bits";
import { Segmented } from "@/components/ui/field";
import { bidActivity, creatorActivity, type ActivityRecord, type ActivityState } from "@/lib/activity";
import { getClient } from "@/lib/client";
import { cn } from "@/lib/cn";
import { dateTime, shortAccount, tokenFull, usdcStr } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import { useWallet } from "@/lib/wallet";
import { useActivity } from "./use-activity";

type View = "bids" | "claims" | "created";
type Row = { record: ActivityRecord; state: ActivityState };
const PAGE_SIZE = 12;
const rank: Record<ActivityState["kind"], number> = { reveal: 0, claim: 1, manage: 2, unavailable: 3, locked: 4, pending: 5, complete: 6 };

function order(a: Row, b: Row) {
  return rank[a.state.kind] - rank[b.state.kind] || b.record.sale.createdAt - a.record.sale.createdAt;
}

export function ActivityPage() {
  const wallet = useWallet();
  const client = getClient();
  const scope = `${wallet.mode}:${wallet.network ?? "mock"}:${client.contractId}:${client.secretsScope}`;

  return (
    <div className="flex w-full flex-col gap-8 sm:gap-10">
      <header className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-h1 text-fg">Activity</h1>
          <p className="mt-3 max-w-[54ch] text-body text-muted">Track your bids, collect allocations and manage the sales you created.</p>
        </div>
        {wallet.account && (
          <div className="min-w-0 shrink-0 sm:max-w-[40%] sm:text-right">
            <div className="truncate text-small font-[510] text-fg" title={wallet.account}>{shortAccount(wallet.account, 30)}</div>
            <div className="mt-1 text-label text-subtle">{wallet.mode === "mock" ? "Simulated · this browser" : `${wallet.network} · ${client.contractId}`}</div>
          </div>
        )}
      </header>

      {!wallet.account ? (
        <section className="panel flex min-h-[340px] flex-col items-center justify-center px-6 py-12 text-center" aria-labelledby="activity-connect-title">
          <span className="mb-5 flex size-12 items-center justify-center rounded-[14px] border border-line bg-elev-2 text-muted"><Wallet className="size-5" strokeWidth={1.5} aria-hidden /></span>
          <h2 id="activity-connect-title" className="text-h2 text-fg">All your sales activity, together</h2>
          <p className="mt-3 max-w-[44ch] text-small leading-relaxed text-muted">Connect your wallet to find your bids, see what needs attention and collect any tokens or refunds.</p>
          <Button className="mt-6" variant="primary" size="lg" onClick={wallet.connect} loading={wallet.connecting}>
            {wallet.mode === "mock" ? "Connect demo wallet" : "Connect wallet"}
          </Button>
          {wallet.error && <p role="alert" className="mt-4 max-w-[44ch] text-small text-muted">{wallet.error}</p>}
          <Link href="/sales" className="mt-5 inline-flex min-h-11 items-center gap-1.5 text-small text-muted underline decoration-line-strong underline-offset-4 hover:text-fg">Browse sales<ArrowRight className="size-3.5" aria-hidden /></Link>
        </section>
      ) : (
        <ConnectedActivity key={`${scope}:${wallet.account}`} account={wallet.account} scope={scope} />
      )}
    </div>
  );
}

function ConnectedActivity({ account, scope }: { account: string; scope: string }) {
  const query = useActivity(account, scope);
  const now = useNow(10_000);
  const router = useRouter();
  const search = useSearchParams();
  const requested = search.get("view");
  const view: View = requested === "claims" || requested === "created" ? requested : "bids";
  const records = query.records ?? [];
  const bids: Row[] = records.flatMap((record) => {
    const state = bidActivity(record, account, now);
    return state ? [{ record, state }] : [];
  }).sort(order);
  const claims = bids.filter((row) => row.state.outstandingClaim);
  const created = records.filter((record) => record.sale.creator === account).map((record) => ({ record, state: creatorActivity(record, now) })).sort(order);
  const ready = claims.filter((row) => row.state.claimable);
  const reveals = bids.filter((row) => row.state.kind === "reveal");
  const incomplete = records.filter((record) => record.issue).length;
  const rows = view === "bids" ? bids : view === "claims" ? claims : created;
  const count = (n: number) => query.records ? String(n) : "—";

  return (
    <>
      <dl className="grid grid-cols-3 divide-x divide-line border-y border-line py-5 sm:py-6">
        <Metric label="Your bids" value={count(bids.length)} hint="Across all sales" />
        <Metric label="Ready to claim" value={count(ready.length)} hint="Tokens or refunds" accent={ready.length > 0} />
        <Metric label="Created sales" value={count(created.length)} hint="Managed by you" />
      </dl>

      {reveals.length > 0 && (
        <section className="flex flex-col gap-4 rounded-panel border border-accent/25 bg-accent-soft p-5 sm:flex-row sm:items-center sm:justify-between" aria-labelledby="activity-reveal-title">
          <div className="flex items-start gap-3">
            <Eye className="mt-0.5 size-5 shrink-0 text-accent" strokeWidth={1.7} aria-hidden />
            <div>
              <h2 id="activity-reveal-title" className="text-small font-[550] text-fg">{reveals.length === 1 ? "One bid needs your reveal" : `${reveals.length} bids need your reveal`}</h2>
              <p className="mt-1 text-small text-muted">Reveal before the window closes to include your bid in clearing.</p>
            </div>
          </div>
          <ButtonLink href={reveals[0].state.href} variant="primary" size="lg">Review reveal</ButtonLink>
        </section>
      )}

      <section aria-label="Account activity" className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Segmented<View>
            value={view}
            onChange={(next) => router.replace(`/activity?view=${next}`, { scroll: false })}
            label="Activity view"
            options={[
              { value: "bids", label: "My bids", count: query.records ? bids.length : undefined },
              { value: "claims", label: "Claims", count: query.records ? claims.length : undefined },
              { value: "created", label: "Created sales", count: query.records ? created.length : undefined },
            ]}
          />
          <Button variant="ghost" size="md" className="min-h-11" onClick={query.refresh} loading={query.refreshing} icon={<RefreshCw className="size-3.5" aria-hidden />}>
            Refresh
          </Button>
        </div>

        <p className="-mt-1 text-small text-muted">
          {view === "bids" ? "Your deposits, sale progress and the next step for each bid."
            : view === "claims" ? "Outstanding bid allocations and refunds, including tokens waiting for liquidity."
              : "Sales created by this account, with setup, settlement and payout actions."}
        </p>

        {(query.error || incomplete > 0) && (
          <div role="status" className="rounded-panel border border-line-strong bg-elev p-4 text-small text-muted">
            <p className="font-[510] text-fg">{query.error ? "Activity could not be fully refreshed" : `${incomplete} ${incomplete === 1 ? "sale could" : "sales could"} not be fully read`}</p>
            <p className="mt-1">The list may be incomplete. Refresh to check missing bids and payout status.{query.updatedAt ? " Previously loaded records are still shown." : ""}</p>
          </div>
        )}

        {query.loading ? <RowsSkeleton /> : rows.length > 0 ? (
          <ActivityList key={view} rows={rows} view={view} />
        ) : (
          <EmptyState view={view} incomplete={!!query.error || incomplete > 0} />
        )}

        <div className="flex flex-wrap justify-between gap-x-4 gap-y-2 border-t border-line pt-4 text-label text-subtle">
          <span>{query.updatedAt ? `Updated ${dateTime(query.updatedAt)}` : "Reading this account’s activity"}</span>
          <span>Refreshes every 30 seconds while visible</span>
        </div>
      </section>
    </>
  );
}

function Metric({ label, value, hint, accent = false }: { label: string; value: string; hint: string; accent?: boolean }) {
  return (
    <div className="px-3 first:pl-0 last:pr-0 sm:px-6">
      <dt className="min-h-10 text-label text-muted sm:min-h-0">{label}</dt>
      <dd className={cn("num mt-2 text-[28px] leading-none tracking-[-0.04em] sm:text-[36px]", accent ? "text-accent" : "text-fg")}>{value}</dd>
      <div className="mt-2 hidden text-label text-subtle sm:block">{hint}</div>
    </div>
  );
}

function ActivityList({ rows, view }: { rows: Row[]; view: View }) {
  const [page, setPage] = useState(0);
  const pageCount = Math.ceil(rows.length / PAGE_SIZE);
  const currentPage = Math.min(page, pageCount - 1);
  const visible = rows.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  return (
    <div>
      <ul className="panel divide-y divide-line overflow-hidden" aria-label={view === "created" ? "Created sales" : view === "claims" ? "Outstanding claims" : "Your bids"}>
        {visible.map((row) => <ActivityRow key={row.record.sale.id} {...row} view={view} />)}
      </ul>
      {pageCount > 1 && (
        <nav className="mt-4 flex items-center justify-between gap-3" aria-label="Activity pages">
          <span className="text-label text-subtle">{currentPage * PAGE_SIZE + 1}–{Math.min((currentPage + 1) * PAGE_SIZE, rows.length)} of {rows.length}</span>
          <div className="flex gap-2">
            <Button variant="outline" className="min-h-11" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</Button>
            <Button variant="outline" className="min-h-11" disabled={currentPage === pageCount - 1} onClick={() => setPage(currentPage + 1)}>Next</Button>
          </div>
        </nav>
      )}
    </div>
  );
}

function ActivityRow({ record, state, view }: Row & { view: View }) {
  const { sale, bid } = record;
  const saleHref = `/sale/${encodeURIComponent(sale.id)}`;
  const Icon = state.kind === "reveal" ? Eye : state.kind === "claim" ? ArrowDownToLine : state.kind === "locked" ? LockKeyhole : state.kind === "complete" ? Check : Clock3;
  return (
    <li className="p-5 sm:p-6">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1.5fr)_minmax(100px,0.7fr)_160px] lg:items-center">
        <div className="flex min-w-0 items-center gap-3">
          <TokenAvatar symbol={sale.config.tokenSymbol} hue={sale.meta.hue} size={40} />
          <div className="min-w-0">
            <Link href={saleHref} className="inline-block max-w-full truncate text-small font-[550] text-fg underline-offset-4 hover:underline">{sale.config.tokenName}</Link>
            <p className="mt-0.5 text-label text-subtle"><span className="break-all">${sale.config.tokenSymbol}</span><span className="mx-1.5" aria-hidden>·</span>{view === "created" ? `${sale.bidCount} ${sale.bidCount === 1 ? "bid" : "bids"}` : `Bid ${(bid?.index ?? 0) + 1}`}</p>
          </div>
        </div>

        <div>
          <div className={cn("flex items-center gap-1.5 text-small font-[510]", state.attention ? "text-accent" : "text-fg")}><Icon className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden />{state.label}</div>
          <p className="mt-1.5 max-w-[56ch] text-label leading-relaxed text-muted">{state.description}</p>
          {state.deadline !== null && <p className="mt-1.5 text-label text-subtle">{state.kind === "reveal" || sale.status === "revealing" ? "Reveal deadline" : sale.status === "upcoming" && view === "created" ? "Opens" : "Bidding ends"} <time dateTime={new Date(state.deadline).toISOString()}>{dateTime(state.deadline)}</time></p>}
        </div>

        <dl className="flex flex-wrap gap-x-8 gap-y-3 lg:flex-col lg:gap-2">
          {view === "claims" ? (
            <>
              {state.tokensDue > 0n && <Amount label={state.tokensLocked ? "Tokens locked" : "Tokens ready"} value={tokenFull(state.tokensDue, sale.config.decimals)} unit={sale.config.tokenSymbol} />}
              {state.refundDue > 0n && <Amount label="Refund ready" value={usdcStr(state.refundDue, 6)} unit="USDC" />}
              {state.refundUncertain && <div><dt className="text-label text-subtle">Refund status</dt><dd className="mt-1 text-label text-muted">Check availability</dd></div>}
            </>
          ) : <Amount label={view === "created" ? "Deposited" : "Your deposit"} value={usdcStr(view === "created" ? sale.totalDeposits : bid?.deposit ?? 0n, 6)} unit="USDC" />}
        </dl>

        <div className="flex flex-col gap-1.5">
          <ButtonLink href={state.href} variant={state.attention ? "primary" : "outline"} size="lg" className="w-full text-[13px]">{state.action}</ButtonLink>
          {view === "created" && <Link href={`${saleHref}/kit`} className="inline-flex min-h-11 items-center justify-center gap-1 text-label text-muted underline-offset-4 hover:text-fg hover:underline">Open launch kit<ArrowRight className="size-3.5" aria-hidden /></Link>}
        </div>
      </div>
    </li>
  );
}

function Amount({ label, value, unit }: { label: string; value: string; unit: string }) {
  return <div className="min-w-0"><dt className="text-label text-subtle">{label}</dt><dd className="num mt-1 break-all text-small font-[510] text-fg">{value} <span className="text-label font-normal text-muted">{unit}</span></dd></div>;
}

function EmptyState({ view, incomplete }: { view: View; incomplete: boolean }) {
  const Icon = view === "created" ? Layers3 : view === "claims" ? ArrowDownToLine : LockKeyhole;
  return (
    <div className="panel flex min-h-[280px] flex-col items-center justify-center px-6 py-10 text-center">
      <span className="mb-4 flex size-11 items-center justify-center rounded-[12px] border border-line bg-elev-2 text-muted"><Icon className="size-5" strokeWidth={1.5} aria-hidden /></span>
      <h2 className="text-h3 text-fg">{incomplete ? "No activity found in the loaded records" : view === "created" ? "Your first sale starts here" : view === "claims" ? "No outstanding claims" : "Your bids will appear here"}</h2>
      <p className="mt-2 max-w-[46ch] text-small leading-relaxed text-muted">{incomplete ? "Some sale data is unavailable. Refresh to finish checking this account."
        : view === "created" ? "Create a sale, choose its terms and share it with your community."
          : view === "claims" ? "Allocations and refunds appear after a sale finishes. Completed claims stay in My bids."
            : "Find a sale and place a bid. Return here to follow its progress and see your next step."}</p>
      {!incomplete && <ButtonLink className="mt-5" href={view === "created" ? "/create" : "/sales"} variant="outline" size="lg">{view === "created" ? "Create a sale" : "Explore sales"}</ButtonLink>}
    </div>
  );
}

function RowsSkeleton() {
  return <div className="panel divide-y divide-line" aria-label="Loading activity" aria-busy="true">{[0, 1, 2].map((i) => <div key={i} className="flex items-center gap-4 p-6 motion-safe:animate-pulse"><div className="size-10 shrink-0 rounded-tile bg-wash" /><div className="flex-1"><div className="h-3 w-32 rounded bg-wash" /><div className="mt-3 h-2.5 w-3/5 rounded bg-wash" /></div><div className="hidden h-10 w-28 rounded-btn bg-wash sm:block" /></div>)}</div>;
}

export function ActivitySkeleton() {
  return <div className="flex w-full flex-col gap-8"><div><div className="h-10 w-40 rounded bg-wash" /><div className="mt-4 h-4 w-3/5 rounded bg-wash" /></div><RowsSkeleton /></div>;
}
