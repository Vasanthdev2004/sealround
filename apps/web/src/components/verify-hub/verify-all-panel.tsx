"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { SaleStatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { getClient } from "@/lib/client";
import { appConfig } from "@/lib/config";
import { verifyHref } from "./public-evidence";
import { verifyAllSales, type VerificationRow } from "./verify-all";

export function VerifyAllPanel() {
  const [rows, setRows] = useState<VerificationRow[] | null>(null);
  const [running, setRunning] = useState(false);
  const [listError, setListError] = useState(false);
  const active = useRef<AbortController | null>(null);
  const config = appConfig();
  const final = rows?.filter(({ sale }) => sale.status === "settled" || sale.status === "failed") ?? [];
  const finished = final.filter(({ result }) => result).length;
  const checking = final.find(({ result }) => !result)?.sale.id;

  useEffect(() => () => { active.current?.abort(); }, []);

  async function run() {
    if (active.current) return;
    const request = new AbortController();
    active.current = request;
    setRunning(true);
    setRows(null);
    setListError(false);
    try {
      await verifyAllSales(config, getClient(), setRows, request.signal);
    } catch {
      if (!request.signal.aborted) setListError(true);
    } finally {
      if (active.current === request) active.current = null;
      if (!request.signal.aborted) setRunning(false);
    }
  }

  return (
    <Panel title={config.mode === "mock" ? "All sales · Simulated" : "All sales"} subtitle="Run public checks for every settled or failed sale, one at a time."
      headerClassName="flex-wrap items-center"
      action={<Button variant="primary" loading={running} onClick={run} icon={<ShieldCheck className="size-4" aria-hidden />}>Verify all</Button>}>
      {listError && <p role="alert" className="text-small text-bad">Could not read the sale list. Choose Verify all to try again.</p>}
      {!listError && <p aria-live="polite" className="text-small text-muted">
        {rows ? final.length === 0 ? "No settled or failed sales to check." : `${finished} of ${final.length} final sales checked.`
          : running ? "Reading the sale list…" : "Check results and any failed or unavailable check IDs will appear here."}
      </p>}
      {rows && rows.length > 0 && (
        <ul aria-label="Sale verification outcomes" className="mt-4 divide-y divide-line border-t border-line">
          {rows.map(({ sale, result }) => {
            const isFinal = sale.status === "settled" || sale.status === "failed";
            return (
              <li key={sale.id} className="grid min-w-0 grid-cols-1 gap-1 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] sm:gap-4">
                <div className="min-w-0">
                  <Link href={verifyHref(sale.id)} prefetch={false} className="break-words text-small font-medium text-fg underline-offset-4 hover:underline">{sale.name || sale.id}</Link>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    {sale.name !== sale.id && <code className="break-all text-label text-subtle">{sale.id}</code>}
                    <SaleStatusBadge status={sale.status} plain />
                  </div>
                </div>
                <div className="min-w-0 text-small text-muted">
                  {result ? (
                    <>
                      <p className="font-medium text-fg">{result.passed} of {result.total} checks passed</p>
                      {result.failed.length > 0 && <p className="break-words text-label">Failed <code>{result.failed.join(", ")}</code></p>}
                      {result.unavailable.length > 0 && <p className="break-words text-label">Unavailable <code>{result.unavailable.join(", ")}</code></p>}
                    </>
                  ) : isFinal ? (sale.id === checking && running ? "Checking…" : "Waiting to check") : "Not final yet"}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
