"use client";

import { useEffect, useState } from "react";
import { CalendarPlus } from "lucide-react";
import { saveAs } from "@/components/kit/kit-bits";
import { Button, ButtonLink } from "@/components/ui/button";
import { listDemoChapterSales, readDemoView, subscribeDemo } from "@/lib/chapters/demo";
import { seriesFor, type ChapterRound, type ChapterSeries } from "@/lib/chapters/model";
import { chapterLink, chapterReminderNetwork, chapterRevealCalendar, pendingChapterReveals, rememberedChapterSales } from "@/lib/chapters/reminders";
import { readSandbox, resolveChapterSandbox } from "@/lib/chapters/sandbox";
import { getClient } from "@/lib/client";
import { appConfig } from "@/lib/config";
import { dateTime } from "@/lib/format";

export function ChapterRevealReminder({ round, contract, series }: { round: ChapterRound; contract?: string; series: ChapterSeries }) {
  const [message, setMessage] = useState("");
  const end = Number(BigInt(round.reveal_end) / 1_000_000n);
  const open = Number(BigInt(round.commit_end) / 1_000_000n);
  const live = round.phase === "reveal";

  function download() {
    if (!contract) return;
    const calendar = chapterRevealCalendar(round, window.location.origin, contract, Date.now(), series);
    if (!calendar) { setMessage("The reveal deadline has passed."); return; }
    saveAs(new Blob([calendar], { type: "text/calendar;charset=utf-8" }), `${series.saleId}-chapter-${round.round_id}-reveal.ics`);
    setMessage("Open the calendar file and save the event to receive its reminder.");
  }

  return (
    <div className="space-y-2 rounded-tile bg-accent-soft p-4 text-small">
      <p className="font-[510] text-fg">{live ? "Reveal your chapter vote" : "Your vote is sealed"}</p>
      <p className="text-muted">{contract
        ? live ? `Reveal by ${dateTime(end)}.` : `Reveal opens ${dateTime(open)} and ends ${dateTime(end)}.`
        : live ? "Reveal before ending this demo window." : "Reveal after voting ends in this demo."}</p>
      {contract && <Button size="sm" variant="outline" onClick={download} icon={<CalendarPlus className="size-4" aria-hidden />}>Add reveal reminder</Button>}
      {message && <p role="status" className="text-label text-muted">{message}</p>}
    </div>
  );
}

type Reminder = { series: ChapterSeries; round: ChapterRound };

export function ActivityChapterReminders({ account }: { account: string }) {
  const [snapshot, setSnapshot] = useState<{ account: string; rows: Reminder[]; failed: boolean } | null>(null);

  useEffect(() => {
    const app = appConfig();
    const network = app.mode === "near" ? chapterReminderNetwork(app.near) : null;
    if (app.mode === "near" && !network) return;
    let active = true;
    let reading = false;
    let queued = false;
    async function refresh() {
      if (!active || document.hidden) return;
      if (reading) {
        queued = true;
        return;
      }
      reading = true;
      const rows: Reminder[] = [];
      let failed = false;
      try {
        const ids = app.mode === "mock" ? listDemoChapterSales() : [
          ...rememberedChapterSales(app.near.rpcUrl, account),
          ...(network === "sandbox" && process.env.NEXT_PUBLIC_CHAPTERS_CONTRACT ? ["lantern"] : []),
        ];
        const sales = [...new Set(ids)];
        let cursor = 0;
        const worker = async () => {
          while (active && cursor < sales.length) {
            try {
              const sale = await getClient().getSale(sales[cursor++]);
              if (!active || sale?.status !== "settled") continue;
              const series = seriesFor(sale);
              const sandbox = app.mode === "near" ? await resolveChapterSandbox(sale, app) : null;
              const state = sandbox ? await readSandbox(sandbox, account) : app.mode === "mock" ? readDemoView(account, series) : null;
              for (const round of state ? pendingChapterReveals(state) : []) rows.push({ series, round });
            } catch {
              failed = true;
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(4, sales.length) }, worker));
        if (active) {
          rows.sort((a, b) => Number(b.round.phase === "reveal") - Number(a.round.phase === "reveal")
            || a.series.saleId.localeCompare(b.series.saleId) || a.round.round_id - b.round.round_id);
          setSnapshot({ account, rows, failed });
        }
      } catch {
        if (active) setSnapshot({ account, rows, failed: true });
      } finally {
        reading = false;
        if (queued) {
          queued = false;
          void refresh();
        }
      }
    }
    void refresh();
    const unsubscribe = app.mode === "mock" ? subscribeDemo(() => void refresh()) : undefined;
    const interval = app.mode === "near" ? window.setInterval(() => void refresh(), 15_000) : undefined;
    const visible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => {
      active = false;
      unsubscribe?.();
      if (interval !== undefined) window.clearInterval(interval);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [account]);

  if (!snapshot || snapshot.account !== account || (!snapshot.rows.length && !snapshot.failed)) return null;
  return (
    <section aria-labelledby="chapter-reminders-title" className="panel divide-y divide-line">
      <h2 id="chapter-reminders-title" className="px-5 py-4 text-h3 text-fg">Chapter reveal reminders</h2>
      {snapshot.failed && <p role="status" className="px-5 py-4 text-small text-muted">Some chapter reminders could not refresh.</p>}
      {snapshot.rows.map(({ round, series }) => (
        <div key={`${series.saleId}:${round.round_id}`} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
          <div className="min-w-0">
            <p className="text-small font-[510] text-fg">{series.tokenName} · {round.title}</p>
            <p className="mt-1 text-small text-muted">{round.phase === "reveal" ? "Reveal is open" : "Waiting for reveal"}
              {round.reveal_end !== "0" && ` · ${round.phase === "reveal" ? "Closes" : "Opens"} ${dateTime(Number(BigInt(round.phase === "reveal" ? round.reveal_end : round.commit_end) / 1_000_000n))}`}</p>
          </div>
          <ButtonLink href={chapterLink(round.round_id, series.saleId)} variant={round.phase === "reveal" ? "primary" : "outline"}>
            {round.phase === "reveal" ? "Reveal chapter vote" : "View chapter vote"}
          </ButtonLink>
        </div>
      ))}
    </section>
  );
}
