"use client";

import { ArrowUpRight, Check, Circle, Loader2, X } from "lucide-react";
import { Tag } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { duration, shortHash, txUrl } from "@/lib/format";
import { useNow } from "@/lib/hooks";

/** Glossy orb avatar for a token, coloured by hue. */
export function TokenAvatar({
  symbol,
  hue,
  size = 36,
  className,
}: {
  symbol: string;
  hue: number;
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={cn("relative inline-flex shrink-0 items-center justify-center rounded-[28%] font-semibold text-white", className)}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.32),
        background: `radial-gradient(120% 120% at 30% 20%, hsl(${hue} 90% 72%), hsl(${hue} 70% 45%) 55%, hsl(${(hue + 30) % 360} 60% 22%))`,
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,.45), inset 0 -3px 6px rgba(0,0,0,.25), 0 0 0 1px rgba(255,255,255,.08), 0 4px 10px rgba(0,0,0,.4)",
      }}
      aria-hidden
    >
      {symbol.slice(0, 2)}
    </span>
  );
}

/** Live countdown to `to` (unix ms). */
export function Countdown({ to, className, prefix }: { to: number; className?: string; prefix?: string }) {
  const now = useNow(1000);
  const left = to - now;
  return (
    <span className={cn("num", className)} suppressHydrationWarning>
      {prefix}
      {left > 0 ? duration(left) : "0s"}
    </span>
  );
}

/**
 * Explorer link for a tx. A simulated hash (mock chain) has no explorer page,
 * so it is plain text with a visible "sim" tag instead of a dead link. Pass
 * `tag={false}` where the surrounding table or panel already says so.
 */
export function TxLink({
  hash,
  simulated = true,
  tag = true,
  className,
  label,
}: {
  hash: string;
  simulated?: boolean;
  tag?: boolean;
  className?: string;
  label?: React.ReactNode;
}) {
  if (simulated) {
    return (
      <span
        title={`Simulated transaction on the mock chain: ${hash}. It has no explorer page.`}
        className={cn("num inline-flex items-center gap-1.5 text-[12px] whitespace-nowrap text-muted", className)}
      >
        {label ?? shortHash(hash, 5)}
        {tag && <Tag tone="warn">sim</Tag>}
      </span>
    );
  }
  return (
    <a
      href={txUrl(hash)}
      target="_blank"
      rel="noreferrer"
      title={hash}
      className={cn(
        "num inline-flex items-center gap-0.5 text-[12px] text-muted underline decoration-line-strong underline-offset-2 hover:text-fg",
        className,
      )}
    >
      {label ?? shortHash(hash, 5)}
      <ArrowUpRight className="size-3" aria-hidden />
    </a>
  );
}

export type CheckState = "pass" | "fail" | "pending" | "idle";

/** One verification row: icon, label, optional detail and link. */
export function CheckRow({
  state,
  label,
  detail,
  href,
  className,
}: {
  state: CheckState;
  label: React.ReactNode;
  detail?: React.ReactNode;
  href?: string;
  className?: string;
}) {
  const icon = {
    pass: <Check className="size-3.5 text-ok" strokeWidth={2.5} />,
    fail: <X className="size-3.5 text-bad" strokeWidth={2.5} />,
    pending: <Loader2 className="size-3.5 animate-spin text-warn" />,
    idle: <Circle className="size-3 text-subtle" />,
  }[state];
  const ring = {
    pass: "bg-ok-soft ring-ok/25",
    fail: "bg-bad-soft ring-bad/25",
    pending: "bg-warn-soft ring-warn/25",
    idle: "bg-hover ring-line",
  }[state];
  return (
    <div className={cn("flex items-start gap-3 py-2.5", className)}>
      <span className={cn("mt-px flex size-5 shrink-0 items-center justify-center rounded-full ring-1", ring)}>{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] text-fg">{label}</div>
        {detail && <div className="num mt-0.5 truncate text-[11.5px] text-subtle">{detail}</div>}
      </div>
      {href && (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="mt-0.5 shrink-0 text-subtle hover:text-fg"
          aria-label="Open source"
        >
          <ArrowUpRight className="size-3.5" />
        </a>
      )}
    </div>
  );
}

/** Small "simulated" disclosure with a tooltip. */
export function SimulatedNote({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <p className={cn("flex items-start gap-1.5 text-[11.5px] leading-snug text-subtle", className)}>
      <span className="mt-[5px] size-1 shrink-0 rounded-full bg-warn" />
      <span>{children ?? "Simulated on a mock chain until the contract is on testnet. Encryption and clearing math are real."}</span>
    </p>
  );
}
