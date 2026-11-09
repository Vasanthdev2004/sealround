import { cn } from "@/lib/cn";
import { STATUS_LABEL, STATUS_TONE, type Tone } from "@/lib/format";
import type { SaleStatus } from "@/lib/types";

const tones: Record<Tone, { box: string; dot: string }> = {
  accent: { box: "bg-accent-soft text-accent", dot: "bg-accent" },
  ok: { box: "bg-ok-soft text-ok", dot: "bg-ok" },
  warn: { box: "bg-warn-soft text-warn", dot: "bg-warn" },
  bad: { box: "bg-bad-soft text-bad", dot: "bg-bad" },
  bot: { box: "bg-bot-soft text-bot", dot: "bg-bot" },
  neutral: { box: "bg-hover text-muted", dot: "bg-subtle" },
};

export function Badge({
  tone = "neutral",
  dot,
  pulse,
  className,
  children,
}: {
  tone?: Tone;
  dot?: boolean;
  pulse?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const t = tones[tone];
  return (
    <span
      className={cn(
        "inline-flex h-[22px] items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium whitespace-nowrap",
        t.box,
        className,
      )}
    >
      {dot && <span className={cn("size-1.5 rounded-full", t.dot, pulse && "pulse-dot")} />}
      {children}
    </span>
  );
}

export function SaleStatusBadge({ status, className }: { status: SaleStatus; className?: string }) {
  const live = status === "open" || status === "clearing";
  return (
    <Badge tone={STATUS_TONE[status]} dot pulse={live} className={className}>
      {STATUS_LABEL[status]}
    </Badge>
  );
}

/** Small mono tag, e.g. "simulated", "testnet", "bot". */
export function Tag({ children, tone = "neutral" }: { children: React.ReactNode; tone?: Tone }) {
  const t = tones[tone];
  return (
    <span
      className={cn(
        "inline-flex h-[18px] items-center rounded-[5px] px-1.5 font-mono text-[10.5px] tracking-wide uppercase",
        t.box,
      )}
    >
      {children}
    </span>
  );
}
