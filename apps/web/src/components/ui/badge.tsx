import { CircleCheck, CircleDashed, CircleDot, Clock, Eye, LoaderCircle, RotateCcw } from "lucide-react";
import { cn } from "@/lib/cn";
import { STATUS_LABEL, type Tone } from "@/lib/format";
import type { SaleStatus } from "@/lib/types";

/**
 * State is a dot and a word. The chip is always the same hairline outline, so
 * a row of badges never turns into a row of coloured boxes. `text` is for the
 * few places a tone colours the word itself (Tag).
 */
const tones: Record<Tone, { dot: string; text: string }> = {
  accent: { dot: "bg-live", text: "text-accent-bright" },
  ok: { dot: "bg-ok", text: "text-ok" },
  warn: { dot: "bg-warn", text: "text-warn" },
  bad: { dot: "bg-bad", text: "text-bad" },
  bot: { dot: "bg-bot", text: "text-bot" },
  neutral: { dot: "bg-subtle", text: "text-muted" },
};

/**
 * Status pill. `dot` adds a state dot (only for real state, never decoration);
 * `pulse` adds a soft ring leaving the dot, for live states.
 * `size="lg"` for headers and hero cards.
 */
export function Badge({
  tone = "neutral",
  dot,
  pulse,
  plain,
  size = "md",
  className,
  children,
}: {
  tone?: Tone;
  dot?: boolean;
  pulse?: boolean;
  plain?: boolean;
  size?: "md" | "lg";
  className?: string;
  children: React.ReactNode;
}) {
  const t = tones[tone];
  return (
    <span
      className={cn(
        "inline-flex items-center font-[510] whitespace-nowrap text-fg",
        !plain && "rounded-full border border-line",
        size === "md" ? "h-6 gap-1.5 text-[12.5px]" : "h-7 gap-2 text-label",
        !plain && (size === "md" ? "px-2" : "px-2.5"),
        className,
      )}
    >
      {dot && (
        <span className="relative inline-flex size-1.5 shrink-0" aria-hidden>
          {pulse && <span className={cn("ping-ring absolute inset-0 rounded-full", t.dot)} />}
          <span className={cn("relative size-1.5 rounded-full", t.dot)} />
        </span>
      )}
      {children}
    </span>
  );
}

const SALE_STATUS_ICONS = {
  upcoming: CircleDashed,
  open: CircleDot,
  awaiting_close: Clock,
  clearing: LoaderCircle,
  revealing: Eye,
  settled: CircleCheck,
  failed: RotateCcw,
} satisfies Record<SaleStatus, typeof CircleDot>;

export function SaleStatusBadge({
  status,
  className,
  size,
  plain,
}: {
  status: SaleStatus;
  className?: string;
  size?: "md" | "lg";
  plain?: boolean;
}) {
  const Icon = SALE_STATUS_ICONS[status];
  return (
    <Badge plain={plain} size={size} className={className}>
      <Icon className="size-3.5 shrink-0 text-muted" strokeWidth={1.75} aria-hidden />
      {STATUS_LABEL[status]}
    </Badge>
  );
}

/**
 * Small tag for honest labels and kinds: "simulated", "testnet", "sim", "bot",
 * "estimate". Sentence case, 12px, the tone colours the word only.
 */
export function Tag({
  children,
  tone = "neutral",
  className,
  title,
}: {
  children: React.ReactNode;
  tone?: Tone;
  className?: string;
  title?: string;
}) {
  const t = tones[tone];
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-5 shrink-0 items-center rounded-[5px] bg-wash px-1.5 text-tag font-[510] whitespace-nowrap",
        t.text,
        className,
      )}
    >
      {children}
    </span>
  );
}
