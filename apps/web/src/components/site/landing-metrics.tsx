"use client";

import { useEffect, useState } from "react";
import { formatUnits } from "@fairground/clearing";
import { BurnCounter } from "@/components/burn/burn-counter";
import { Tag } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { BURNED_DECIMALS, LANDING_METRICS_REFRESH_SECONDS, restoreBurn, type LandingMetrics } from "@/lib/landing-metrics-format";

const SOURCE = {
  simulated: "Simulated",
  sandbox: "Local sandbox",
  testnet: "NEAR testnet",
  mainnet: "NEAR mainnet",
} as const;

let pendingSnapshot: Promise<LandingMetrics> | undefined;

function loadSnapshot() {
  pendingSnapshot ??= fetch("/api/landing-metrics")
    .then((response): Promise<LandingMetrics> => {
      if (!response.ok) throw new Error("Activity totals unavailable");
      return response.json();
    })
    .finally(() => { pendingSnapshot = undefined; });
  return pendingSnapshot;
}

export function LandingMetricsPanel({ simulated }: { simulated: boolean }) {
  const [snapshot, setSnapshot] = useState<{ data: LandingMetrics; expired: boolean }>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    let pending = false;
    async function refresh() {
      if (pending || !active) return;
      pending = true;
      try {
        const data = await loadSnapshot();
        if (active) {
          setSnapshot({ data, expired: Date.now() - data.updatedAt > LANDING_METRICS_REFRESH_SECONDS * 1000 });
          setFailed(false);
        }
      } catch {
        if (active) setFailed(true);
      } finally {
        pending = false;
      }
    }
    void refresh();
    const timer = simulated ? null : window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, LANDING_METRICS_REFRESH_SECONDS * 1000);
    return () => {
      active = false;
      if (timer !== null) window.clearInterval(timer);
    };
  }, [simulated]);

  const metrics = snapshot?.data;
  const loading = !metrics && !failed;
  const stamp = metrics && new Date(metrics.updatedAt);
  const figures: [string, number | string | null | undefined, string?][] = [
    ["Sales", metrics?.saleCount],
    ["Bids", metrics?.bidCount],
    ["Distinct bidders", metrics?.bidderCount, "Unique bidder accounts across all sales listed by this contract."],
    ["Tokens burned", metrics?.burned == null ? null : formatUnits(BigInt(metrics.burned), BURNED_DECIMALS), "Total supply removed across sale tokens."],
    ["Chapter votes", metrics?.chapterVotes, metrics?.chaptersConfigured === false ? "Chapters not configured for this deployment." : "Votes committed across Chapters rounds."],
  ];

  return (
    <div className="space-y-4">
      <div className="panel overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 py-4 sm:px-6">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-h3 text-fg">Sealround activity</h3>
            {(metrics || simulated) && <Tag>{metrics ? SOURCE[metrics.source] : SOURCE.simulated}</Tag>}
          </div>
          {stamp && !simulated && <time className="text-label text-subtle" dateTime={stamp.toISOString()}>
            {failed || snapshot?.expired ? "Last snapshot" : "Snapshot"}{" "}
            {stamp.toISOString().slice(0, 16).replace("T", " ")} UTC
          </time>}
        </div>
        <dl className="grid grid-cols-2 gap-px border-t border-line bg-line sm:grid-cols-5" aria-busy={loading}>
          {figures.map(([label, value, note]) => (
            <div key={label} className="min-w-0 bg-bg px-5 py-4 last:col-span-2 sm:px-6 sm:last:col-span-1">
              <dt className="text-label text-subtle" title={note}>{label}</dt>
              <dd className="num mt-1 text-num-sm text-fg [overflow-wrap:anywhere]">
                {loading ? <Skeleton className="h-6 w-20 max-w-full" /> :
                  value == null ? <span className="text-small text-muted">Unavailable</span> :
                    typeof value === "number" ? value.toLocaleString("en-US") : value}
              </dd>
            </div>
          ))}
        </dl>
        {metrics?.chaptersConfigured === false && <p className="border-t border-line px-5 py-2.5 text-label text-subtle sm:px-6">
          Chapters are awaiting configuration on this network.
        </p>}
      </div>
      <BurnCounter total={metrics && restoreBurn(metrics.burnDetail)} simulated={simulated} loading={loading} />
    </div>
  );
}
