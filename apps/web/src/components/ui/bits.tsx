"use client";

import { ArrowUpRight, Check, Circle, Loader2, X } from "lucide-react";
import { LIVE_CONTRACT, explorerAddress } from "@/components/site/live-evidence";
import { Tag } from "@/components/ui/badge";
import { palette } from "@/lib/palette";
import { cn } from "@/lib/cn";
import { isNearMode } from "@/lib/config";
import { duration, shortHash, txUrl } from "@/lib/format";
import { useNow } from "@/lib/hooks";

/**
 * A token's monogram on a quiet tint of its hue: the mark that stands in for a
 * logo. `cut` wraps it in a collar of that background class (for
 * example "bg-elev" or "bg-bg").
 */
export function TokenAvatar({
  symbol,
  hue,
  size = 36,
  cut,
  className,
}: {
  symbol: string;
  hue: number;
  size?: number;
  cut?: string;
  className?: string;
}) {
  if (cut) {
    return (
      <span
        className={cn("inline-flex shrink-0 rounded-[30%]", cut, className)}
        style={{ padding: Math.max(3, Math.round(size * 0.075)) }}
        aria-hidden
      >
        <TokenAvatar symbol={symbol} hue={hue} size={size} />
      </span>
    );
  }
  const tint = palette(hue).ground;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-tile font-semibold tracking-[-0.02em] text-muted ring-1 ring-line ring-inset",
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(10, Math.round(size * 0.36)),
        background: `color-mix(in srgb, ${tint} 6%, var(--bg-elev-2))`,
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
 *
 * `simulated` defaults to what the app runs on: true on the mock chain, false
 * against a real contract. There a hash is "" unless this browser sent the
 * transaction (the contract's views do not keep hashes): nothing is rendered
 * then, and a sandbox, which has no explorer, shows the hash as plain text.
 */
export function TxLink({
  hash,
  simulated = !isNearMode(),
  tag = true,
  className,
  label,
  prefix,
}: {
  hash: string;
  simulated?: boolean;
  tag?: boolean;
  className?: string;
  /** Replaces the short hash. Prefer `prefix`, which keeps the hash visible. */
  label?: React.ReactNode;
  /** Words before the short hash, for example "bid tx". */
  prefix?: React.ReactNode;
}) {
  if (!hash) return null;
  if (!simulated && txUrl(hash) === "#") {
    return (
      <span title={hash} className={cn("num inline-flex items-center gap-1.5 text-label whitespace-nowrap text-muted", className)}>
        {prefix && <span className="font-sans text-subtle">{prefix}</span>}
        {label ?? shortHash(hash, 5)}
      </span>
    );
  }
  if (simulated) {
    return (
      <span
        title={`Simulated transaction on the mock chain: ${hash}. It has no explorer page.`}
        className={cn("num inline-flex items-center gap-1.5 text-label whitespace-nowrap text-muted", className)}
      >
        {prefix && <span className="font-sans text-subtle">{prefix}</span>}
        {label ?? shortHash(hash, 5)}
        {tag && <Tag>sim</Tag>}
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
        "num inline-flex items-center gap-0.5 text-label text-muted underline decoration-line-strong underline-offset-2 transition-colors hover:text-fg hover:decoration-fg/40",
        className,
      )}
    >
      {prefix && <span className="mr-1 font-sans text-subtle">{prefix}</span>}
      {label ?? shortHash(hash, 5)}
      <ArrowUpRight className="size-3" aria-hidden />
    </a>
  );
}

export type CheckState = "pass" | "fail" | "pending" | "idle";

/**
 * One verification row: icon, label, optional detail and link. The detail
 * wraps (hashes break anywhere); it is mono for proofs, or sans with
 * `detailMono={false}` for sentences.
 */
export function CheckRow({
  state,
  label,
  detail,
  detailMono = true,
  href,
  className,
}: {
  state: CheckState;
  label: React.ReactNode;
  detail?: React.ReactNode;
  detailMono?: boolean;
  href?: string;
  className?: string;
}) {
  const icon = {
    pass: <Check className="size-3.5 text-ok" strokeWidth={2.5} />,
    fail: <X className="size-3.5 text-bad" strokeWidth={2.5} />,
    pending: <Loader2 className="size-3.5 animate-spin text-warn" />,
    idle: <Circle className="size-3 text-subtle" />,
  }[state];
  const stateText = {
    pass: "Passed",
    fail: "Failed",
    pending: "In progress",
    idle: "Waiting",
  }[state];
  return (
    <div className={cn("flex items-start gap-3 py-2.5", className)}>
      <span aria-hidden className="mt-px flex size-5 shrink-0 items-center justify-center">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-body text-fg">
          {label}
          <span className="sr-only">{`, ${stateText}`}</span>
        </div>
        {detail && (
          <div
            className={cn(
              "mt-0.5 text-label text-subtle [overflow-wrap:anywhere]",
              detailMono ? "font-mono" : "leading-[1.45]",
            )}
          >
            {detail}
          </div>
        )}
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

/** An inline link in quiet text to a page off the app (the block explorer). */
export function QuietLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-muted underline decoration-line-strong underline-offset-2 transition-colors [overflow-wrap:anywhere] hover:text-fg"
    >
      {children}
    </a>
  );
}

/** Quiet disclosure for views that show simulated data. */
export function SimulatedNote({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <p className={cn("text-label text-subtle", className)}>
      {children ?? (
        <>
          Simulated on a mock chain in your browser. Encryption and clearing math are real. The contract also runs on
          NEAR testnet, with settled sales: <QuietLink href={explorerAddress(LIVE_CONTRACT)}>{LIVE_CONTRACT}</QuietLink>.
        </>
      )}
    </p>
  );
}
