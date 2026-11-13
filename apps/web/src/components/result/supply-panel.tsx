"use client";

import { Fragment, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Check, TriangleAlert } from "lucide-react";
import { Tag } from "@/components/ui/badge";
import { TxLink } from "@/components/ui/bits";
import { TipCard, TipRow } from "@/components/visual/chart-bits";
import { cn } from "@/lib/cn";
import { getClient } from "@/lib/client";
import { isNearMode } from "@/lib/config";
import { accountUrl, dateTime, shortAccount, tokenFull } from "@/lib/format";
import { useClientQuery } from "@/lib/hooks";
import type { Sale, SaleEvent, SaleResult } from "@/lib/types";
import {
  poolLeftover,
  share,
  shareStr,
  supplyLedger,
  supplyParts,
  type SupplyLedger,
  type SupplyPartId,
} from "./supply";

/*
 * One whole (the supply minted at launch) split into where it ended up. Blue
 * is what the community bought; the other parts are context in the two
 * validated greys of the viz palette (the Arena's comparison pair, 18+ ΔE
 * apart in both themes); the burn is an empty slot, because those tokens no
 * longer exist. The pool and the simulated chain's LP reserve never appear
 * together (a reserve exists only without a launch pool), so they share a grey.
 * Text inside a block takes the canvas or the foreground colour, whichever
 * contrasts with that block's fill in the current theme.
 */
const FILL: Record<SupplyPartId, string> = {
  sold: "bg-viz-fairground text-bg",
  pool: "bg-viz-bonding text-bg",
  creator: "bg-viz-fixed text-fg",
  reserve: "bg-viz-bonding text-bg",
  burned: "bg-wash text-muted shadow-[inset_0_0_0_1px_var(--line-strong)]",
};

/** The swatch beside a row of the ledger (its legend). */
const SWATCH: Record<SupplyPartId, string> = {
  sold: "bg-viz-fairground",
  pool: "bg-viz-bonding",
  creator: "bg-viz-fixed",
  reserve: "bg-viz-bonding",
  burned: "bg-wash shadow-[inset_0_0_0_1px_var(--line-strong)]",
};

/** A share is printed inside its block only when the block is at least this wide (px). */
const LABEL_MIN_PX = 44;

/**
 * "Where every token went": the supply at launch split into what the winners
 * bought, the launch pool, the creator allocation and the burn; the supply
 * after the sale; and the log of the mint and the burn with their
 * transactions. Every amount comes from the views (get_sale, get_result) and
 * the parts add up to the supply at launch in base units.
 */
export function SupplyStory({ sale, result }: { sale: Sale; result: SaleResult }) {
  const c = sale.config;
  const sym = c.tokenSymbol;

  if (sale.tokenSetup && sale.tokenSetup !== "done") {
    return (
      <section aria-labelledby="supply-title">
        <h2 id="supply-title" className="text-h2 text-fg">
          Where every token went
        </h2>
        <p className="mt-2 max-w-[68ch] text-body text-muted">
          The {sym} token was never deployed, so no supply was minted and there is nothing to burn.
        </p>
      </section>
    );
  }

  const ledger = supplyLedger(sale, result);
  return (
    <section aria-labelledby="supply-title">
      <h2 id="supply-title" className="text-h2 text-fg">
        Where every token went
      </h2>
      <p className="mt-2 max-w-[68ch] text-body text-muted">{leadOf(sale, result, ledger)}</p>

      <div className="panel mt-5">
        <div className="px-5 pt-5 sm:px-6">
          <Head sale={sale} ledger={ledger} />
          <SupplyBar sale={sale} ledger={ledger} className="mt-5" />
        </div>
        <Ledger sale={sale} result={result} ledger={ledger} />
        <SupplyLog sale={sale} ledger={ledger} />
        {!c.liquidity && (
          <p className="border-t border-line px-5 py-3.5 text-small text-muted sm:px-6">
            <span className="text-fg">No Sealround pool.</span> This sale opened no market for {sym}: making one is the
            creator&rsquo;s job.
          </p>
        )}
      </div>
    </section>
  );
}

/** One sentence: how demand set the final supply. */
function leadOf(sale: Sale, result: SaleResult, l: SupplyLedger): string {
  const c = sale.config;
  const sym = c.tokenSymbol;
  const d = c.decimals;
  const after = `${tokenFull(l.after, d)} of ${tokenFull(l.total, d)}`;
  // Every subject below is plural ("they", "the unsold tokens", "the N SYM ...").
  const burn =
    l.burnState === "burned" ? "were burned" : l.burnState === "owed" ? "burn when the creator is paid" : "burn with the creator payout";
  const poolPart = `the ${tokenFull(l.burnPool, d)} ${sym} ${poolLeftover(result.liquidity)}`;
  if (result.status === "failed") {
    return `The sale did not go ahead, so none of the ${tokenFull(c.saleSupply, d)} ${sym} for sale were sold. They${
      l.burnPool > 0n ? `, with ${poolPart},` : ""
    } ${burn}, so the supply ends at ${after}.`;
  }
  if (l.burn === 0n) {
    return `Bidders bought every ${sym} for sale, so nothing burns and the supply stays at ${tokenFull(l.total, d)}.`;
  }
  if (l.burnUnsold === 0n) {
    return `Bidders bought every ${sym} for sale. T${poolPart.slice(1)} ${burn}, so the supply ends at ${after}.`;
  }
  return `Bidders bought ${shareStr(share(l.sold, c.saleSupply))} of the ${sym} for sale. The unsold tokens${
    l.burnPool > 0n ? `, with ${poolPart},` : ""
  } ${burn}, so demand set the final supply: ${after}.`;
}

/** Supply at launch and after the sale. */
function Head({ sale, ledger: l }: { sale: Sale; ledger: SupplyLedger }) {
  const c = sale.config;
  const change = share(l.burn, l.total);
  return (
    // Side by side from sm up; stacked on phones, where an exact amount with decimals does not fit half the width.
    <dl className="grid gap-3 sm:grid-cols-2 sm:gap-0 [&>*]:min-w-0 [&>*+*]:border-line max-sm:[&>*+*]:border-t max-sm:[&>*+*]:pt-3 sm:[&>*+*]:border-l sm:[&>*+*]:pl-6">
      <div className="sm:pr-4">
        <dt className="text-label text-subtle">Supply at launch</dt>
        <dd className="num mt-1 flex flex-wrap items-baseline gap-x-1.5 text-num-md text-fg">
          <span className="min-w-0 [overflow-wrap:anywhere]">{tokenFull(l.total, c.decimals)}</span>
          <span className="text-label font-normal tracking-normal text-muted">{c.tokenSymbol}</span>
        </dd>
      </div>
      <div>
        <dt className="text-label text-subtle">
          {l.burnState === "burned" || l.burnState === "none" ? "Supply after the sale" : "Supply once the burn lands"}
        </dt>
        <dd className="num mt-1 flex flex-wrap items-baseline gap-x-1.5 text-num-md text-fg">
          <span className="min-w-0 [overflow-wrap:anywhere]">{tokenFull(l.after, c.decimals)}</span>
          <span className="text-label font-normal tracking-normal text-muted">
            {l.burn > 0n ? `${c.tokenSymbol}, ${shareStr(change)} less` : `${c.tokenSymbol}, unchanged`}
          </span>
        </dd>
      </div>
    </dl>
  );
}

const NAME: Record<SupplyPartId, string> = {
  sold: "Sold to winners",
  pool: "Launch pool",
  creator: "Creator allocation",
  reserve: "LP reserve",
  burned: "Burned",
};

function partName(id: SupplyPartId, l: SupplyLedger): string {
  if (id === "burned") return l.burnState === "burned" ? "Burned" : "To burn";
  return NAME[id];
}

/**
 * The tall segmented bar. Each part is a block, 2px apart, its share printed
 * inside where it fits. Hover, a tap or keyboard focus (arrow keys move
 * between parts) shows the part's name, amount and share; the ledger under it
 * lists every value.
 */
function SupplyBar({ sale, ledger, className }: { sale: Sale; ledger: SupplyLedger; className?: string }) {
  const c = sale.config;
  const parts = supplyParts(ledger);
  const ref = useRef<HTMLDivElement>(null);
  const width = useWidth(ref);
  const [active, setActive] = useState<number | null>(null);
  const [focusAt, setFocusAt] = useState(0);
  const blocks = useRef<(HTMLSpanElement | null)[]>([]);
  const inner = Math.max(0, width - 2 * (parts.length - 1));
  const focusIdx = Math.min(focusAt, parts.length - 1);

  const describe = (i: number) => {
    const p = parts[i];
    return `${partName(p.id, ledger)}: ${tokenFull(p.amount, c.decimals)} ${c.tokenSymbol}, ${shareStr(share(p.amount, ledger.total))} of the supply at launch`;
  };

  const move = (to: number) => {
    const i = Math.max(0, Math.min(parts.length - 1, to));
    setFocusAt(i);
    setActive(i);
    blocks.current[i]?.focus();
  };

  const onKey = (e: React.KeyboardEvent) => {
    const keys: Record<string, number> = {
      ArrowRight: focusIdx + 1,
      ArrowDown: focusIdx + 1,
      ArrowLeft: focusIdx - 1,
      ArrowUp: focusIdx - 1,
      Home: 0,
      End: parts.length - 1,
    };
    if (e.key in keys) {
      e.preventDefault();
      move(keys[e.key]);
    } else if (e.key === "Escape") {
      setActive(null);
    }
  };

  // Where the tooltip sits: centred over its block (blocks 2px apart), kept inside the bar.
  const widths = parts.map((p) => inner * share(p.amount, ledger.total));
  const centres = widths.map((w, i) => widths.slice(0, i).reduce((a, b) => a + b + 2, 0) + w / 2);
  const tip = active !== null ? parts[active] : null;

  return (
    <div className={cn("relative", className)}>
      <div
        ref={ref}
        role="group"
        aria-label={`The ${tokenFull(ledger.total, c.decimals)} ${c.tokenSymbol} minted at launch, by where they went. Arrow keys move between parts.`}
        className="flex h-7 gap-0.5"
        onKeyDown={onKey}
        onPointerLeave={(e) => {
          if (e.pointerType === "mouse") setActive(null);
        }}
      >
        {parts.map((p, i) => {
          const f = share(p.amount, ledger.total);
          const px = inner * f;
          return (
            <span
              key={p.id}
              ref={(el) => {
                blocks.current[i] = el;
              }}
              role="img"
              tabIndex={i === focusIdx ? 0 : -1}
              aria-label={describe(i)}
              onFocus={() => {
                setFocusAt(i);
                setActive(i);
              }}
              onBlur={() => setActive((a) => (a === i ? null : a))}
              onPointerEnter={(e) => {
                if (e.pointerType === "mouse") setActive(i);
              }}
              onPointerDown={() => setActive((a) => (a === i ? null : i))}
              className={cn(
                "flex min-w-[3px] items-center rounded-[4px] outline-accent focus-visible:outline-2 focus-visible:outline-offset-2",
                FILL[p.id],
                width > 0 && px >= LABEL_MIN_PX && "px-2",
              )}
              style={{ flexGrow: f, flexBasis: 0 }}
            >
              {width > 0 && px >= LABEL_MIN_PX && (
                <span aria-hidden className="num text-label font-[510] whitespace-nowrap">
                  {shareStr(f)}
                </span>
              )}
            </span>
          );
        })}
      </div>
      {tip && active !== null && width > 0 && (
        <div
          className="pointer-events-none absolute bottom-full z-10 mb-2 -translate-x-1/2"
          style={{ left: Math.max(96, Math.min(width - 96, centres[active])) }}
          aria-hidden
        >
          <TipCard title={partName(tip.id, ledger)}>
            <TipRow
              color={tip.id === "burned" ? "var(--line-strong)" : COLOR_VAR[tip.id]}
              label={c.tokenSymbol}
              value={tokenFull(tip.amount, c.decimals)}
            />
            <div className="num text-label text-muted">{shareStr(share(tip.amount, ledger.total))} of the supply at launch</div>
          </TipCard>
        </div>
      )}
    </div>
  );
}

const COLOR_VAR: Record<SupplyPartId, string> = {
  sold: "var(--viz-fairground)",
  pool: "var(--viz-bonding)",
  creator: "var(--viz-fixed)",
  reserve: "var(--viz-bonding)",
  burned: "var(--line-strong)",
};

/**
 * The bar's legend and table in one: every part in the bar's order, with what
 * it is now, its amount and share; then the total, which must equal the
 * supply at launch.
 */
function Ledger({ sale, result, ledger: l }: { sale: Sale; result: SaleResult; ledger: SupplyLedger }) {
  const c = sale.config;
  const d = c.decimals;
  const parts = supplyParts(l);
  const winners = result.fills.filter((f) => result.status === "settled" && f.tokens > 0n);
  const claimed = winners.filter((f) => f.claimed).length;
  const liq = result.liquidity ?? null;
  const p = result.proceeds;
  const leftover = poolLeftover(liq);

  const note: Record<SupplyPartId, React.ReactNode> = {
    sold: l.locked
      ? `${winners.length} ${winners.length === 1 ? "winner" : "winners"} at the clearing price. Locked in the sale contract until the launch pool is seeded.`
      : `${winners.length} ${winners.length === 1 ? "winner" : "winners"} at the clearing price, ${claimed} claimed so far.`,
    pool:
      liq?.stage === "seeded" ? (
        <>
          Paired with the pool&rsquo;s USDC at the clearing price{liq.poolId !== null && <> in pool #{liq.poolId}</>}. The
          sale contract keeps the LP shares; see{" "}
          <a href="#launch-pool" className="underline decoration-line-strong underline-offset-2 hover:text-fg">
            the launch pool
          </a>
          .
        </>
      ) : liq?.stage === "abandoned" ? (
        "The pool was abandoned. These sit on the exchange until they are withdrawn, then they burn."
      ) : (
        "Set aside to pair with the pool's USDC at the clearing price. Being seeded."
      ),
    creator: p?.allocationLocked
      ? "Locked until the launch pool is seeded or abandoned."
      : p?.allocationPaid
        ? `Paid to ${shortAccount(sale.creator, 28)}. Disclosed before the sale opened.`
        : `Goes to ${shortAccount(sale.creator, 28)} with the creator payout. Disclosed before the sale opened.`,
    reserve:
      "Held by the sale contract. Simulated sales only: on NEAR a sale without a launch pool has no reserve, and its creator allocation is everything not for sale.",
    burned: (
      <>
        {l.burnUnsold > 0n && (
          <>
            {result.status === "failed" ? "The whole sale supply" : "Sale supply nobody bought"}:{" "}
            <span className="num text-fg">{tokenFull(l.burnUnsold, d)}</span>
            {l.burnPool > 0n && "; "}
          </>
        )}
        {l.burnPool > 0n && (
          <>
            {l.burnUnsold > 0n ? leftover : leftover.charAt(0).toUpperCase() + leftover.slice(1)}:{" "}
            <span className="num text-fg">{tokenFull(l.burnPool, d)}</span>
          </>
        )}
        .{" "}
        {l.burnState === "burned"
          ? "Burned at the creator payout."
          : l.burnState === "owed"
            ? "To be burned when the creator claims; anyone can see it is owed."
            : l.burnState === "partial"
              ? "More is owed after the pool was abandoned; an earlier payout may have burned part of it."
              : "Burns with the creator payout."}
      </>
    ),
  };

  return (
    <div className="mt-5 border-t border-line">
      <table className="w-full text-left text-small">
        <caption className="sr-only">Where every {c.tokenSymbol} of the supply at launch went</caption>
        <thead className="text-label text-subtle">
          <tr className="border-b border-line">
            <th scope="col" className="h-9 pr-3 pl-5 font-normal sm:pl-6">
              Part
            </th>
            <th scope="col" className="pr-3 text-right font-normal">
              {c.tokenSymbol}
            </th>
            <th scope="col" className="pr-5 text-right font-normal sm:pr-6">
              Share
            </th>
          </tr>
        </thead>
        <tbody>
          {/* On phones the note takes a row of its own, across the full width, under its part. */}
          {parts.map((part) => (
            <Fragment key={part.id}>
              <tr className="align-top sm:border-b sm:border-line">
                <th scope="row" className="pt-3 pr-3 pb-1 pl-5 font-normal sm:pb-3 sm:pl-6">
                  <span className="flex items-start gap-2.5">
                    <span aria-hidden className={cn("mt-[5px] size-2.5 shrink-0 rounded-[3px]", SWATCH[part.id])} />
                    <span className="min-w-0">
                      <span className="block text-fg">{partName(part.id, l)}</span>
                      <span className="mt-0.5 hidden text-label text-muted sm:block">{note[part.id]}</span>
                    </span>
                  </span>
                </th>
                <td className="num pt-3 pr-3 pb-1 text-right whitespace-nowrap text-fg sm:pb-3">{tokenFull(part.amount, d)}</td>
                <td className="num pt-3 pr-5 pb-1 text-right whitespace-nowrap text-muted sm:pr-6 sm:pb-3">
                  {shareStr(share(part.amount, l.total))}
                </td>
              </tr>
              <tr className="border-b border-line sm:hidden">
                <td colSpan={3} className="pr-5 pb-3 pl-10 text-label text-muted">
                  {note[part.id]}
                </td>
              </tr>
            </Fragment>
          ))}
        </tbody>
        <tfoot>
          <tr className="align-top">
            <th scope="row" className="py-3 pr-3 pl-5 font-normal sm:pl-6">
              <span className="block text-fg">Supply at launch</span>
              {l.gap === 0n ? (
                <span className="mt-0.5 flex items-start gap-1.5 text-label text-muted">
                  <Check className="mt-px size-3.5 shrink-0 text-ok" strokeWidth={2.5} aria-hidden />
                  The parts add up to it, to the last base unit.
                </span>
              ) : (
                <span className="mt-0.5 flex items-start gap-1.5 text-label text-warn">
                  <TriangleAlert className="mt-px size-3.5 shrink-0" strokeWidth={2} aria-hidden />
                  The views do not add up: the parts are {l.gap > 0n ? "over" : "under"} by{" "}
                  {(l.gap > 0n ? l.gap : -l.gap).toString()} base units.
                </span>
              )}
            </th>
            <td className="num py-3 pr-3 text-right whitespace-nowrap text-fg">{tokenFull(l.total, d)}</td>
            <td className="num py-3 pr-5 text-right whitespace-nowrap text-muted sm:pr-6">100%</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/**
 * The mint and the burn, with their transactions, and the token's supply now.
 * A real contract's views do not hold the burn's transaction unless this
 * browser sent it; the token's explorer page lists its ft_burn event either way.
 */
function SupplyLog({ sale, ledger: l }: { sale: Sale; ledger: SupplyLedger }) {
  const c = sale.config;
  const d = c.decimals;
  const sym = c.tokenSymbol;
  const near = isNearMode();
  const events = useClientQuery<SaleEvent[]>(() => getClient().getEvents(sale.id), ["supply-events", sale.id], 10_000);
  const created = events.data?.find((e) => e.kind === "created" && !e.detail);
  const payouts = (events.data ?? []).filter((e) => e.kind === "claimed" && e.detail === "proceeds_claimed");
  const payout = payouts[0] ?? null; // newest first
  const mintTx = sale.createTx || created?.txHash || "";
  const tokenPage = near ? accountUrl(sale.tokenAccount) : "#";

  return (
    <div className="border-t border-line px-5 pt-4 pb-5 sm:px-6">
      <div className="flex items-center gap-2">
        <h3 className="text-label text-subtle">Mint and burn log</h3>
        {!near && <Tag title="Simulated transactions on the mock chain">simulated</Tag>}
      </div>
      <ol className="mt-2 divide-y divide-line border-y border-line">
        <LogRow
          what="Minted"
          amount={`${tokenFull(l.total, d)} ${sym}`}
          detail={
            <>
              At sale creation, to the sale contract, <span suppressHydrationWarning>{dateTime(sale.createdAt)}</span>.
            </>
          }
          tx={mintTx}
          txPrefix="create tx"
          fallback={near ? <TokenEvents href={tokenPage} event="ft_mint" account={sale.tokenAccount} /> : null}
        />
        {l.burn === 0n ? (
          <LogRow
            what="Burned"
            amount={`0 ${sym}`}
            detail={
              c.liquidity
                ? "Nothing to burn: every token for sale sold and the pool took its whole reserve."
                : "Nothing to burn: every token for sale sold."
            }
          />
        ) : l.burnState === "burned" ? (
          <LogRow
            what="Burned"
            amount={`${tokenFull(l.burn, d)} ${sym}`}
            detail={
              <>
                By the creator payout (claim_proceeds){payouts.length > 1 && <>, over {payouts.length} payouts</>}
                {payout && !payout.approximate && (
                  <>
                    , <span suppressHydrationWarning>{dateTime(payout.at)}</span>
                  </>
                )}
                .
              </>
            }
            tx={payout?.txHash ?? ""}
            txPrefix="payout tx"
            fallback={near ? <TokenEvents href={tokenPage} event="ft_burn" account={sale.tokenAccount} /> : null}
          />
        ) : (
          <LogRow
            what={l.burnState === "partial" ? "Still to burn" : "To burn"}
            amount={`${tokenFull(l.burn, d)} ${sym}`}
            detail={
              <>
                Owed and public: the next creator payout (claim_proceeds) burns it, and anyone can send that payout from{" "}
                <Link href={`/sale/${encodeURIComponent(sale.id)}`} className="underline decoration-line-strong underline-offset-2 hover:text-fg">
                  the sale page
                </Link>
                .
              </>
            }
          />
        )}
      </ol>
      <div className="mt-3">
        <p className="flex flex-wrap items-baseline gap-x-1.5 text-small text-muted">
          Token supply now:
          {l.supplyNow !== null ? (
            <span className="num text-fg">
              {tokenFull(l.supplyNow, d)} {sym}
            </span>
          ) : (
            <span>part of the burn may have landed; the views do not say how much.</span>
          )}
        </p>
        <p className="mt-0.5 text-label text-subtle">
          From the sale&rsquo;s mint and burn. The token has no mint method and any holder may burn their own tokens, so
          its supply can only fall from here.
        </p>
      </div>
    </div>
  );
}

function LogRow({
  what,
  amount,
  detail,
  tx = "",
  txPrefix,
  fallback = null,
}: {
  what: string;
  amount: string;
  detail: React.ReactNode;
  tx?: string;
  txPrefix?: string;
  fallback?: React.ReactNode;
}) {
  return (
    <li className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-baseline sm:gap-4">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 text-small">
          <span className="text-fg">{what}</span>
          <span className="num text-fg">{amount}</span>
        </div>
        <p className="mt-0.5 text-label text-muted">{detail}</p>
      </div>
      {tx ? <TxLink hash={tx} prefix={txPrefix} tag={false} className="shrink-0" /> : fallback && <span className="shrink-0">{fallback}</span>}
    </li>
  );
}

/** The token's explorer page, where its NEP-297 mint and burn events are listed. Nothing without an explorer. */
function TokenEvents({ href, event, account }: { href: string; event: "ft_mint" | "ft_burn"; account: string }) {
  if (href === "#") return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-0.5 text-label text-muted underline decoration-line-strong underline-offset-2 hover:text-fg"
    >
      {event} on {shortAccount(account, 28)}
      <ArrowUpRight className="size-3" aria-hidden />
    </a>
  );
}

/** The element's width, kept current with a ResizeObserver. 0 until measured. */
function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setW(Math.round(entries[0].contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}
