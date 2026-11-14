"use client";

import { useEffect, useRef, useState } from "react";
import { ListChecks } from "lucide-react";
import { Tag } from "@/components/ui/badge";
import { QuietLink } from "@/components/ui/bits";
import { Button } from "@/components/ui/button";
import { PageHeader, Panel } from "@/components/ui/panel";
import { getClient } from "@/lib/client";
import { appConfig } from "@/lib/config";
import { listVerificationSales, verifyAllSales } from "../verify-hub/verify-all";
import { checkAttackEvidence, checkBidSizes, checkChapters, checkCI, listOutLayerEvidence, MANIFEST_URL, summarizeSales, WORKFLOW_URL, type CheckId, type JudgeResult } from "./checks";

const STEPS = [
  { id: "sales", title: "Verify every final sale", summary: "Check the sale and settlement evidence.", href: "/verify", link: "Verify a sale", simulated: true },
  { id: "bids", title: "Check every recorded bid size", summary: "Read all recorded bids, including open sales.", href: null, link: null, simulated: true },
  { id: "ci", title: "Check the CI badge", summary: "Read the latest Check workflow on GitHub’s main branch.", href: WORKFLOW_URL, link: "GitHub Actions", simulated: false },
  { id: "outlayer", title: "List OutLayer evidence", summary: "Open the recorded proof bundles and verifier results.", href: MANIFEST_URL, link: "Proof manifest", simulated: false },
  { id: "attacks", title: "Inspect the attack proofs", summary: "Find the named tests and published transaction receipts.", href: "/attack", link: "Try to beat it", simulated: false },
  { id: "chapters", title: "Check Chapters status", summary: "Read the rounds and winning artist payout records.", href: null, link: null, simulated: true },
] as const;

const VERDICT = {
  passed: "Pass",
  failed: "Fail",
  unavailable: "Unavailable",
  pending: "Pending",
  listed: "Listed",
} as const;

export function JudgeChecklist() {
  const [results, setResults] = useState<Partial<Record<CheckId, JudgeResult>>>({});
  const [running, setRunning] = useState(false);
  const active = useRef<AbortController | null>(null);
  const app = appConfig();
  const mock = app.mode === "mock";
  const finished = Object.keys(results).length;

  useEffect(() => () => active.current?.abort(), []);

  async function run() {
    if (active.current) return;
    const controller = new AbortController();
    const { signal } = controller;
    active.current = controller;
    setResults({});
    setRunning(true);
    const client = getClient();
    // One sale snapshot and one chain-heavy step at a time.
    const listed = listVerificationSales(app, client, signal).catch(() => null);
    async function store(id: CheckId, check: () => Promise<JudgeResult> | JudgeResult) {
      try {
        signal.throwIfAborted();
        const result = await check();
        if (!signal.aborted) setResults((current) => ({ ...current, [id]: result }));
      } catch {
        if (!signal.aborted) setResults((current) => ({
          ...current, [id]: { state: "unavailable", detail: "This check could not finish. Try running the checklist again." },
        }));
      }
    }
    async function salesOrThrow() {
      const sales = await listed;
      if (!sales) throw new Error("The sale list is unavailable.");
      return sales;
    }

    try {
      await Promise.all([
        store("ci", () => checkCI(signal)),
        store("outlayer", listOutLayerEvidence),
        (async () => {
          await store("sales", async () => summarizeSales(await verifyAllSales(app, client, () => {}, signal, await salesOrThrow())));
          await store("bids", async () => checkBidSizes(app, client, await salesOrThrow(), signal));
          await store("attacks", () => checkAttackEvidence(app, signal));
          await store("chapters", async () => checkChapters(app, client, await salesOrThrow(), signal));
        })(),
      ]);
    } finally {
      if (active.current === controller) active.current = null;
      if (!signal.aborted) setRunning(false);
    }
  }

  return (
    <div className="flex w-full flex-col gap-6">
      <PageHeader
        title="Check us in 5 minutes"
        description="Run the public evidence checklist in your browser. You can inspect the results and their sources without a wallet."
      />
      <Panel
        title="Evidence checklist"
        subtitle={mock ? "Sales, bids and Chapters use this browser’s simulation. GitHub and the recorded evidence have their own sources." : `NEAR ${app.near.network} · ${app.near.contractId}`}
        headerClassName="flex-wrap items-center"
        action={<Button variant="primary" loading={running} onClick={run} icon={<ListChecks className="size-4" aria-hidden />}>Run all</Button>}
        bodyClassName="px-5 pb-5"
      >
        <p className="py-2 text-small text-muted" aria-live="polite">
          {running ? `${finished} of ${STEPS.length} steps complete…`
            : finished ? `${finished} of ${STEPS.length} steps complete. See each result below.` : "Each row will show its result after you run the checklist."}
        </p>
        <ol className="divide-y divide-line border-t border-line" aria-label="Judge checks">
          {STEPS.map(({ id, title, summary, href, link, simulated }) => {
            const result = results[id];
            return (
              <li key={id} className="grid gap-2 py-4 sm:grid-cols-[minmax(0,1fr)_6.5rem]">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <h3 className="text-small font-medium text-fg">{title}</h3>
                    {mock && simulated && <Tag>Simulated</Tag>}
                  </div>
                  <p className="mt-1 text-small text-muted">{result?.detail ?? summary}</p>
                  {href && link && <p className="mt-1 text-small"><QuietLink href={href}>{link}</QuietLink></p>}
                  {!!result?.links?.length && (
                    <details className="mt-2 text-small text-muted">
                      <summary className="w-fit cursor-pointer text-fg">See evidence ({result.links.length})</summary>
                      <ul className="mt-1 space-y-1">
                        {result.links.map(({ href: target, label, detail }) => (
                          <li key={target} className="break-words">
                            <QuietLink href={target}>{label}</QuietLink>
                            {detail && <span> · {detail}</span>}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
                <div className="sm:text-right">
                  <Tag tone={result?.state === "passed" ? "ok" : result?.state === "failed" ? "bad" : "neutral"}>
                    {result ? VERDICT[result.state] : running ? "Waiting" : "Ready"}
                  </Tag>
                </div>
              </li>
            );
          })}
        </ol>
      </Panel>
    </div>
  );
}
