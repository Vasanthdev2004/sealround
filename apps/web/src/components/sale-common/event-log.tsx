"use client";

import { useState } from "react";
import {
  CircleCheck,
  CircleX,
  Coins,
  Cpu,
  Lock,
  Rocket,
  RotateCw,
  ShieldAlert,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import { Tag } from "@/components/ui/badge";
import { TxLink } from "@/components/ui/bits";
import { Button } from "@/components/ui/button";
import { Panel, Empty } from "@/components/ui/panel";
import { cn } from "@/lib/cn";
import { ago, shortAccount, usdcStr } from "@/lib/format";
import { useEvents, useNow } from "@/lib/hooks";
import type { SaleEventKind } from "@/lib/types";

const ICON: Record<SaleEventKind, { icon: LucideIcon; tone: string }> = {
  created: { icon: Rocket, tone: "text-accent" },
  bid: { icon: Lock, tone: "text-muted" },
  bid_rejected: { icon: ShieldAlert, tone: "text-warn" },
  closed: { icon: Lock, tone: "text-warn" },
  clearing_requested: { icon: Cpu, tone: "text-warn" },
  settled: { icon: CircleCheck, tone: "text-ok" },
  failed: { icon: CircleX, tone: "text-bad" },
  claimed: { icon: Coins, tone: "text-ok" },
  refund_mode: { icon: Undo2, tone: "text-bad" },
};

/**
 * Live on-chain event log for a sale, newest first, each row with its
 * transaction. Shows `limit` rows, and every row on request.
 */
export function EventLog({
  saleId,
  limit = 12,
  title = "Event log",
  className,
}: {
  saleId: string;
  limit?: number;
  title?: string;
  className?: string;
}) {
  const { data: events, error, refetch } = useEvents(saleId);
  const now = useNow(5000);
  const [all, setAll] = useState(false);
  const shown = (all ? events : events?.slice(0, limit)) ?? [];

  return (
    <Panel
      title={title}
      subtitle={events ? `${events.length} events, newest first` : undefined}
      action={<Tag tone="warn">sim tx</Tag>}
      className={className}
      bodyClassName="p-0"
    >
      {error && !events ? (
        <div className="flex flex-wrap items-center justify-between gap-3 p-5">
          <p className="text-[13px] text-fg">
            Could not load events. <span className="text-muted">{error.message}</span>
          </p>
          <Button size="sm" onClick={refetch} icon={<RotateCw className="size-3.5" />}>
            Try again
          </Button>
        </div>
      ) : !events ? (
        <div className="space-y-2 p-5">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="shimmer h-9 rounded-lg bg-elev-2" />
          ))}
        </div>
      ) : shown.length === 0 ? (
        <div className="p-5">
          <Empty title="No events yet" />
        </div>
      ) : (
        <ol className="divide-y divide-line">
          {shown.map((e, i) => {
            const { icon: Icon, tone } = ICON[e.kind];
            return (
              <li key={`${e.txHash}-${i}`} className="flex items-start gap-3 px-5 py-3">
                <Icon className={cn("mt-0.5 size-4 shrink-0", tone)} strokeWidth={1.75} />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] leading-snug text-fg">{e.note}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 text-[11.5px] text-subtle">
                    {e.account && <span className="num">{shortAccount(e.account, 24)}</span>}
                    {e.amount !== undefined && e.kind !== "settled" && (
                      <span className="num">{usdcStr(e.amount)} USDC</span>
                    )}
                    <span suppressHydrationWarning>{ago(e.at, now)}</span>
                  </div>
                </div>
                <TxLink hash={e.txHash} tag={false} className="mt-0.5 shrink-0" />
              </li>
            );
          })}
        </ol>
      )}
      {events && events.length > limit && (
        <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3">
          <span className="text-[12px] text-subtle">
            Showing <span className="num">{shown.length}</span> of <span className="num">{events.length}</span>
          </span>
          <Button size="sm" variant="ghost" onClick={() => setAll((v) => !v)}>
            {all ? `Show latest ${limit}` : `Show all ${events.length}`}
          </Button>
        </div>
      )}
    </Panel>
  );
}
