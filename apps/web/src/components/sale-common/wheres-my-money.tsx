"use client";

import { ArrowUpRight } from "lucide-react";
import { Tag } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { TxLink, type CheckState } from "@/components/ui/bits";
import { getClient } from "@/lib/client";
import { cn } from "@/lib/cn";
import { accountUrl, shortHash, tokenStr, usdcStr } from "@/lib/format";
import { ONECLICK_STATUS_TEXT, type FundingRecord } from "@/lib/funding";
import type { BidRecord, Sale, SaleResult } from "@/lib/types";

type HopState = CheckState | "skip";

type Hop = {
  title: string;
  state: HopState;
  /** Word for the state, read out and, for failed or waiting hops, shown. */
  stateLabel?: string;
  body: React.ReactNode;
  link?: React.ReactNode;
};

const DOT: Record<HopState, string> = {
  pass: "bg-ok ring-ok/25",
  fail: "bg-bad ring-bad/25",
  pending: "bg-warn ring-warn/25 pulse-dot",
  idle: "bg-subtle/40 ring-line",
  skip: "bg-transparent ring-line-strong",
};

const STATE_LABEL: Record<HopState, string> = {
  pass: "Done",
  fail: "Failed",
  pending: "Waiting",
  idle: "Not started",
  skip: "Skipped",
};

const STATE_TONE: Partial<Record<HopState, string>> = {
  fail: "text-bad",
  pending: "text-warn",
};

const ExtLink = ({ href, children }: { href: string; children: React.ReactNode }) => (
  <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-[12px] text-muted hover:text-fg">
    {children} <ArrowUpRight className="size-3" aria-hidden />
  </a>
);

/**
 * One row per hop: origin chain -> 1Click deposit address -> your NEAR
 * account -> Fairground contract -> tokens and refund claimed.
 * REFUNDED and FAILED are spelled out in plain words. Simulated hops carry a
 * "sim" tag instead of an explorer link that would lead nowhere.
 */
export function WheresMyMoney({
  sale,
  account,
  bid,
  fill,
  funding,
  usdcBalance,
  className,
}: {
  sale: Sale;
  account: string | null;
  bid: BidRecord | null;
  fill?: SaleResult["fills"][number] | null;
  funding?: FundingRecord | null;
  usdcBalance?: bigint | null;
  className?: string;
}) {
  const sym = sale.config.tokenSymbol;
  const mockChain = getClient().mode === "mock";
  const sim = <Tag tone="warn">sim</Tag>;
  const hops: Hop[] = [];

  // 1. Origin chain
  if (funding) {
    const failed = funding.status === "REFUNDED" || funding.status === "FAILED" || funding.status === "INCOMPLETE_DEPOSIT";
    const state: HopState =
      funding.status === "SUCCESS" ? "pass" : failed ? "fail" : funding.status === "PENDING_DEPOSIT" ? "idle" : "pending";
    const failLabel = funding.status === "REFUNDED" ? "Refunded" : funding.status === "INCOMPLETE_DEPOSIT" ? "Short deposit" : "Failed";
    hops.push({
      title: `${funding.originChain}`,
      state,
      stateLabel: failed ? failLabel : undefined,
      body: (
        <>
          <span className="num">{funding.amountIn} {funding.originAsset}</span> sent from your wallet.
          {failed && <> Refund goes to <span className="num">{shortHash(funding.refundTo, 6)}</span>.</>}
        </>
      ),
      link: funding.originTxUrl ? <ExtLink href={funding.originTxUrl}>explorer</ExtLink> : funding.simulated ? sim : undefined,
    });
    hops.push({
      title: "1Click deposit address",
      state,
      stateLabel: failed ? failLabel : undefined,
      body: (
        <>
          {ONECLICK_STATUS_TEXT[funding.status]}.{" "}
          <span className="num text-subtle">{shortHash(funding.depositAddress, 6)}</span>
        </>
      ),
      link: funding.simulated ? sim : undefined,
    });
  } else {
    hops.push({
      title: "Origin chain",
      state: "skip",
      body: "Not used. You paid with USDC already on NEAR.",
    });
  }

  // 2. Your NEAR account
  hops.push({
    title: "Your NEAR account",
    state: !account ? "idle" : bid || (usdcBalance ?? 0n) > 0n || funding?.status === "SUCCESS" ? "pass" : "idle",
    body: account ? (
      <>
        <span className="num">{account}</span>
        {usdcBalance !== undefined && usdcBalance !== null && (
          <> holds <span className="num">{usdcStr(usdcBalance)} USDC</span>.</>
        )}
      </>
    ) : (
      "Connect a wallet to track your funds."
    ),
    // The demo account lives only on the simulated chain, so it has no explorer page.
    link: account ? mockChain ? sim : <ExtLink href={accountUrl(account)}>account</ExtLink> : undefined,
  });

  // 3. Fairground contract
  const st = sale.status;
  hops.push({
    title: "Fairground contract",
    state: !bid ? "idle" : bid.claimed ? "pass" : st === "settled" || st === "failed" ? "pass" : "pending",
    stateLabel: bid && !bid.claimed && st !== "settled" && st !== "failed" ? "Locked" : undefined,
    body: !bid ? (
      "No bid yet. Your deposit will sit here, locked, until the sale settles."
    ) : (
      <>
        <span className="num">{usdcStr(bid.deposit, 6)} USDC</span> deposit{" "}
        {bid.claimed
          ? "released."
          : st === "open" || st === "awaiting_close"
            ? "locked until the sale closes."
            : st === "clearing"
              ? "locked while the enclave clears the sale."
              : st === "failed"
                ? "is fully refundable. Claim it any time."
                : "ready to claim."}
      </>
    ),
    link: bid ? <TxLink hash={bid.txHash} label="bid tx" /> : undefined,
  });

  // 4. Claimed
  const claimable = st === "settled" || st === "failed";
  hops.push({
    title: "Tokens and refund",
    state: bid?.claimed ? "pass" : bid && claimable ? "pending" : "idle",
    stateLabel: bid && !bid.claimed && claimable ? "Unclaimed" : undefined,
    body: bid?.claimed ? (
      fill ? (
        <>
          {fill.tokens > 0n && <><span className="num">{tokenStr(fill.tokens, sale.config.decimals)} {sym}</span> and </>}
          <span className="num">{usdcStr(fill.refund, 6)} USDC</span> sent to your account.
        </>
      ) : (
        "Claimed. Your tokens and unspent USDC were sent to your account."
      )
    ) : bid && claimable ? (
      fill ? (
        <>
          Waiting for you to claim
          {fill.tokens > 0n && <> <span className="num">{tokenStr(fill.tokens, sale.config.decimals)} {sym}</span> +</>}{" "}
          <span className="num">{usdcStr(fill.refund, 6)} USDC</span>.
        </>
      ) : (
        "Ready to claim."
      )
    ) : (
      "After settlement: tokens at the clearing price plus any unspent USDC."
    ),
    link: bid?.claimTx ? <TxLink hash={bid.claimTx} label="claim tx" /> : undefined,
  });

  return (
    <Panel title="Where's my money" subtitle="Every hop your funds take, and where they are now." className={className}>
      <ol className="relative">
        {hops.map((h, i) => {
          const word = h.stateLabel ?? STATE_LABEL[h.state];
          const tone = STATE_TONE[h.state];
          return (
            <li key={i} className="relative flex gap-3.5 pb-4 last:pb-0">
              {i < hops.length - 1 && (
                <span aria-hidden className="absolute top-4 bottom-0 left-[5px] border-l border-dashed border-line-dashed" />
              )}
              <span aria-hidden className={cn("relative mt-1.5 size-[11px] shrink-0 rounded-full ring-4", DOT[h.state])} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-baseline gap-2">
                    <span className="text-[13px] font-medium text-fg">{h.title}</span>
                    {/* Failed and waiting hops say so in words, not only by colour. */}
                    {tone ? (
                      <span className={cn("shrink-0 text-[11.5px] font-medium", tone)}>{word}</span>
                    ) : (
                      <span className="sr-only">{word}</span>
                    )}
                  </div>
                  {h.link}
                </div>
                <div className="mt-0.5 text-[12.5px] leading-snug text-muted">{h.body}</div>
              </div>
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}
