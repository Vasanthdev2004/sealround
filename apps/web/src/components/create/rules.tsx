"use client";

import { Lock } from "lucide-react";
import { Tag } from "@/components/ui/badge";
import { TokenAvatar } from "@/components/ui/bits";
import { KV } from "@/components/ui/stat";
import { cn } from "@/lib/cn";
import { dateTime, priceStr, shortAccount, tokenFull, usdcStr } from "@/lib/format";
import { DECIMALS, REVEAL_LABEL, pctStr, tokenAccountFor, windowLabel, type Derived, type Draft } from "./model";

const Dash = () => <span className="text-subtle">—</span>;

/** Avatar, name, symbol, token account and creator. */
export function RulesIdentity({
  draft,
  account,
  size = 40,
}: {
  draft: Draft;
  account: string | null;
  size?: number;
}) {
  const name = draft.name.trim();
  return (
    <div className="flex min-w-0 items-center gap-3">
      <TokenAvatar symbol={draft.symbol} hue={draft.hue} size={size} />
      <div className="min-w-0">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className={cn("truncate font-display text-[16px] font-medium tracking-[-0.01em]", name ? "text-fg" : "text-subtle")}>
            {name || "Untitled token"}
          </span>
          {draft.symbol && <span className="num shrink-0 text-[12.5px] text-subtle">${draft.symbol}</span>}
        </div>
        <div className="num truncate text-[12px] text-subtle">{tokenAccountFor(draft.symbol)}</div>
        <div className="truncate text-[12px] text-subtle">
          by <span className="num text-muted">{account ? shortAccount(account, 26) : "your NEAR account"}</span>
        </div>
      </div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 break-inside-avoid">
      <div className="pt-3 pb-0.5 text-[11.5px] font-medium tracking-wide text-subtle uppercase">{title}</div>
      <dl className="divide-y divide-dashed divide-line">{children}</dl>
    </div>
  );
}

const Row = ({ k, v, mono }: { k: React.ReactNode; v: React.ReactNode; mono?: boolean }) => (
  <KV k={k} v={v} mono={mono} className="py-1.5 [&>dd]:min-w-0 [&>dd]:break-words [&>dt]:shrink-0" />
);

/** Every parameter, in plain words. Two columns when there is room. */
export function RulesList({ draft, derived }: { draft: Draft; derived: Derived }) {
  const v = derived.values;
  const s = derived.shares;
  const tokens = (x: bigint | undefined, bps: bigint | undefined) =>
    x !== undefined ? (
      <>
        {tokenFull(x)}
        {bps !== undefined && <span className="text-subtle"> · {pctStr(bps)}</span>}
      </>
    ) : (
      <Dash />
    );
  const usdc = (x: bigint | undefined) => (x !== undefined ? `${usdcStr(x, 6)} USDC` : <Dash />);
  const price = (x: bigint | undefined) => (x !== undefined ? `${priceStr(x)} USDC / token` : <Dash />);

  const dur = v.durationMs;
  const start = v.startAt;
  const opens =
    draft.startMode === "now" ? "When created" : typeof start === "number" ? dateTime(start) : <Dash />;
  const closes =
    dur === undefined ? (
      <Dash />
    ) : draft.startMode === "now" ? (
      `${windowLabel(dur)} after opening`
    ) : typeof start === "number" ? (
      dateTime(start + dur)
    ) : (
      <Dash />
    );

  return (
    <div className="@container">
      <div className="grid @lg:grid-cols-2 @lg:gap-x-8">
        <div className="min-w-0">
          <Group title="Token">
            <Row k="Name" v={draft.name.trim() || <Dash />} mono={false} />
            <Row k="Symbol" v={draft.symbol || <Dash />} />
            <Row k="Decimals" v={DECIMALS} />
            <Row k="Total supply" v={tokens(v.total, undefined)} />
          </Group>
          <Group title="Supply">
            <Row k="For sale" v={tokens(v.sale, s?.sale)} />
            <Row k="Creator" v={tokens(v.creator, s?.creator)} />
            <Row k="LP reserve" v={tokens(v.lp, s?.lp)} />
          </Group>
          <Group title="Price">
            <Row k="Floor" v={price(v.floor)} />
            <Row k="Max price" v={v.ceiling === null ? "None" : price(v.ceiling)} />
            <Row k="Minimum raise" v={usdc(v.minRaise)} />
          </Group>
        </div>
        <div className="min-w-0">
          <Group title="Bid window">
            <Row k="Opens" v={opens} />
            <Row k="Length" v={dur !== undefined ? windowLabel(dur) : <Dash />} />
            <Row k="Closes" v={closes} />
          </Group>
          <Group title="Deposits">
            <Row k="Minimum" v={usdc(v.minDeposit)} />
            <Row k="Max per account" v={usdc(v.maxDeposit)} />
            <Row k="Token" v="USDC only" />
          </Group>
          <Group title="Rules">
            <Row k="Bids" v={REVEAL_LABEL[draft.revealMode]} mono={false} />
            <Row k="Unsold tokens" v="Burned" mono={false} />
            <Row k="Settle timeout" v="2h, then refunds" mono={false} />
            <Row k="Admin key" v="None" mono={false} />
          </Group>
        </div>
      </div>
    </div>
  );
}

/** The one promise the summary makes. */
export function LockStatement({ className }: { className?: string }) {
  return (
    <div className={cn("inset flex items-start gap-2.5 px-3 py-2.5", className)}>
      <Lock className="mt-px size-4 shrink-0 text-accent" strokeWidth={1.75} aria-hidden />
      <p className="text-[12.5px] leading-snug text-fg/90">
        No admin key. Nothing here can change after you create the sale.
      </p>
    </div>
  );
}

/** Storage and gas, as estimates. */
export function CostPreview({ className }: { className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11.5px] font-medium tracking-wide text-subtle uppercase">Cost to create</span>
        <Tag tone="warn">estimate</Tag>
      </div>
      <dl className="mt-0.5 divide-y divide-dashed divide-line">
        <Row k="Token contract storage" v="~2.5 NEAR" />
        <Row k="Sale storage" v="~0.1 NEAR" />
        <Row k="Gas" v="Covered by the relayer" mono={false} />
      </dl>
      <p className="mt-1.5 text-[11.5px] leading-snug text-subtle">
        Estimated cost once the contract is on testnet. Nothing is charged in this demo.
      </p>
    </div>
  );
}
