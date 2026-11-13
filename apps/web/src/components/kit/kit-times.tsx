"use client";

import { CalendarPlus } from "lucide-react";
import { icsFileName, revealIcs } from "@/components/sale/ics";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { duration } from "@/lib/format";
import type { Sale } from "@/lib/types";
import { saveAs, useSaleUrl } from "./kit-bits";
import { isUtcZone, localStamp, utcStamp } from "./kit-text";

/** "in 1h 20m" or "2h ago", to the minute. */
function relative(at: number, now: number): string {
  const d = at - now;
  if (Math.abs(d) < 60_000) return d >= 0 ? "in under a minute" : "just now";
  return d > 0 ? `in ${duration(d)}` : `${duration(-d)} ago`;
}

function Row({ label, at, now, note }: { label: string; at: number; now: number; note?: string }) {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <div className="grid gap-x-6 gap-y-1 py-3 sm:grid-cols-[9rem_minmax(0,1fr)_auto] sm:items-baseline">
      <dt className="text-small text-muted">{label}</dt>
      <dd className="min-w-0">
        <div className="num text-body text-fg">{utcStamp(at)}</div>
        {!isUtcZone(zone) && <div className="num mt-0.5 text-label text-subtle">{localStamp(at)} your time</div>}
        {note && <div className="mt-0.5 text-label text-subtle">{note}</div>}
      </dd>
      <dd className="num text-small text-muted sm:text-right">{relative(at, now)}</dd>
    </div>
  );
}

/** When bids open, when they close and when the reveal comes, in UTC and the viewer's zone, with the reveal as a calendar file. */
export function KitTimes({ sale, now }: { sale: Sale; now: number }) {
  const c = sale.config;
  const url = useSaleUrl(sale.id);
  const tee = c.revealMode === "tee";

  const addToCalendar = () => {
    if (!url) return;
    const ics = revealIcs({
      saleId: sale.id,
      tokenName: c.tokenName,
      tokenSymbol: c.tokenSymbol,
      at: c.bidEnd,
      url,
      now: Date.now(),
      host: new URL(url).host,
      commit: !tee,
    });
    saveAs(new Blob([ics], { type: "text/calendar;charset=utf-8" }), icsFileName(sale.id));
  };

  // Once the close has passed there is nothing left to put in a calendar.
  const calendar = now < c.bidEnd && (
    <Button
      variant="ghost"
      size="sm"
      className="-mr-2 max-sm:h-10"
      disabled={!url}
      onClick={addToCalendar}
      icon={<CalendarPlus className="size-3.5" aria-hidden />}
    >
      Add the reveal to a calendar
    </Button>
  );

  return (
    <Panel title="Key times" action={calendar} bodyClassName="px-5 pb-2">
      <dl className="divide-y divide-line">
        <Row label="Bids open" at={c.bidStart} now={now} />
        <Row label="Bids close" at={c.bidEnd} now={now} />
        <Row
          label="Reveal"
          at={c.bidEnd}
          now={now}
          note={
            tee
              ? "From the close: once anyone closes the sale, an enclave opens every bid at once."
              : `From the close: bidders reveal their own bids within ${duration(c.revealWindowMs ?? 600_000)}.`
          }
        />
      </dl>
    </Panel>
  );
}
