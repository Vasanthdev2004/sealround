"use client";

import { useEffect } from "react";
import { ArrowUpRight } from "lucide-react";
import { Tag } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { TxLink, type CheckState } from "@/components/ui/bits";
import { getClient } from "@/lib/client";
import { cn } from "@/lib/cn";
import { accountUrl, networkName, shortHash, tokenStr, usdcStr } from "@/lib/format";
import { ONECLICK_STATUS_TEXT, type FundingRecord } from "@/lib/funding";
import { useClientQuery, useNow } from "@/lib/hooks";
import { canTrackFunding, isTerminal, resumeLiveSwaps } from "@/lib/oneclick";
import { locksTokens } from "@/lib/liquidity";
import type { BidRecord, Sale, SaleResult } from "@/lib/types";

type HopState = CheckState | "skip";

type Hop = {
  title: string;
  state: HopState;
  /** The amount sitting at this hop, shown on the right. */
  value?: React.ReactNode;
  /** Word for the state, on the right. `null` when the amount says it all. Defaults to STATE_LABEL. */
  word?: string | null;
  /** One quiet line under the title. */
  detail?: React.ReactNode;
  link?: React.ReactNode;
};

const STATE_LABEL: Record<HopState, string> = {
  pass: "Done",
  fail: "Failed",
  pending: "Waiting",
  idle: "Not started",
  skip: "Not used",
};

const STATE_TONE: Record<HopState, string> = {
  pass: "text-ok",
  fail: "text-bad",
  pending: "text-warn",
  idle: "text-subtle",
  skip: "text-subtle",
};

const ExtLink = ({ href, children }: { href: string; children: React.ReactNode }) => (
  <a
    href={href}
    target="_blank"
    rel="noreferrer"
    className="inline-flex items-center gap-0.5 text-label text-muted underline decoration-line-strong underline-offset-2 transition-colors duration-[120ms] hover:text-fg"
  >
    {children} <ArrowUpRight className="size-3" aria-hidden />
  </a>
);

function LiveFundingStatus({ funding }: { funding: FundingRecord }) {
  const now = useNow(5000);
  if (funding.status === "FAILED") return "1Click reported a failure. A refund is unconfirmed.";
  if (!isTerminal(funding.status) && !canTrackFunding(funding, now)) {
    return (
      <>
        Tracking has ended for this receipt. Keep the deposit transaction for 1Click support.
        {funding.correlationId && <> Quote reference <span className="num break-all">{funding.correlationId}</span>.</>}
      </>
    );
  }
  if (funding.statusCheckFailed) return "1Click status is temporarily unavailable. This page will retry.";
  if (funding.status === "INCOMPLETE_DEPOSIT") return "1Click detected a short deposit. Waiting for refund status.";
  if (funding.status === "PENDING_DEPOSIT" && funding.depositExpiresAt !== undefined && now >= funding.depositExpiresAt) {
    return "Deposit window expired. Tracking continues for deposits already sent.";
  }
  return ONECLICK_STATUS_TEXT[funding.status];
}

/**
 * A ledger with one row per hop: origin chain -> 1Click deposit address ->
 * your NEAR account -> Sealround contract -> tokens and refund claimed. The
 * hop on the left, the amount and its state on the right. REFUNDED and FAILED
 * are spelled out in plain words. Simulated hops carry a "sim" tag instead of
 * an explorer link that would lead nowhere.
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
  const onMainnet = !mockChain && networkName() === "mainnet";
  const sim = <Tag>sim</Tag>;
  const hops: Hop[] = [];

  useEffect(() => {
    if (account && onMainnet) return resumeLiveSwaps(account);
  }, [account, onMainnet]);

  // 1. Origin chain
  if (funding) {
    const failed = funding.status === "REFUNDED" || funding.status === "FAILED" || funding.status === "INCOMPLETE_DEPOSIT";
    const state: HopState =
      funding.status === "SUCCESS" ? "pass" : failed ? "fail" : funding.status === "PENDING_DEPOSIT" ? "idle" : "pending";
    const failLabel = funding.status === "REFUNDED" ? "Refunded" : funding.status === "INCOMPLETE_DEPOSIT" ? "Short deposit" : "Failed";
    const refunded = funding.status === "REFUNDED";
    const refundAmount = funding.refundedAmount;
    hops.push({
      title: funding.originChain,
      state,
      value: funding.simulated
        ? `${funding.amountIn} ${funding.originAsset}`
        : refunded && refundAmount !== undefined ? `${refundAmount} ${funding.originAsset}` : undefined,
      word: failed ? failLabel : state === "pass" ? "Sent" : undefined,
      detail: failed ? (
        <>
          {funding.simulated ? "Refund goes to " : refunded ? "Refunded to " : "Refund address "}
          <span className="num" title={funding.refundTo}>{shortHash(funding.refundTo, 6)}</span>
        </>
      ) : (
        "From your wallet"
      ),
      link: funding.originTxUrl ? <ExtLink href={funding.originTxUrl}>{funding.simulated ? "explorer" : "deposit tx"}</ExtLink> : funding.simulated ? sim : undefined,
    });
    hops.push({
      title: "1Click address",
      state,
      value: <span title={funding.depositAddress}>{shortHash(funding.depositAddress, 5)}</span>,
      word: failed ? failLabel : undefined,
      detail: funding.simulated ? ONECLICK_STATUS_TEXT[funding.status] : <LiveFundingStatus funding={funding} />,
      link: funding.simulated ? sim : funding.destinationTxUrl ? <ExtLink href={funding.destinationTxUrl}>delivery tx</ExtLink> : undefined,
    });
  } else {
    hops.push({ title: "Origin chain", state: "skip" });
  }

  // 2. Your NEAR account
  const balance = account && usdcBalance != null ? `${usdcStr(usdcBalance)} USDC` : undefined;
  hops.push({
    title: "Your NEAR account",
    state: !account ? "idle" : bid || (usdcBalance ?? 0n) > 0n || funding?.status === "SUCCESS" ? "pass" : "idle",
    value: balance,
    word: !account ? "Not connected" : balance ? null : undefined,
    detail: account ? <span className="num">{account}</span> : undefined,
    // The demo account lives only on the simulated chain, so it has no explorer page.
    link: account ? mockChain ? sim : <ExtLink href={accountUrl(account)}>account</ExtLink> : undefined,
  });

  // 3. Sealround contract
  const st = sale.status;
  const closed = st === "settled" || st === "failed";
  const needsPoolState = !!bid && !!sale.config.liquidity && st === "settled";
  const poolResult = useClientQuery(
    () => needsPoolState ? getClient().getResult(sale.id) : Promise.resolve(null),
    [sale.id, needsPoolState],
    5000,
  );
  const claimed = fill?.claimed ?? bid?.claimed ?? false;
  const refundClaimed = fill?.refundClaimed === true;
  const checkingPool = needsPoolState && !claimed && !poolResult.data && (fill?.tokens ?? 1n) > 0n;
  const tokensLocked = !claimed && locksTokens(poolResult.data?.liquidity) && !!fill && fill.tokens > 0n;
  const refundAvailable = tokensLocked && !refundClaimed && !!fill && fill.refund > 0n;
  // Without a bid, the last two rows only describe what would happen while a bid can still be placed.
  const biddable = st === "upcoming" || st === "open";
  // The 1 % a void bid loses. It never comes back, so it gets its own row below.
  const penalty = fill?.penalty ?? 0n;
  hops.push({
    title: "Sealround contract",
    state: !bid ? "idle" : claimed || (closed && !tokensLocked && !checkingPool) ? "pass" : "pending",
    value: bid ? `${usdcStr(bid.deposit, 6)} USDC` : undefined,
    word: !bid
      ? biddable
        ? "No bid yet"
        : "No bid"
      : claimed
        ? "Released"
        : checkingPool
          ? "Checking pool status"
        : tokensLocked
          ? refundAvailable ? "Refund available" : "Tokens locked"
        : st === "failed"
          ? "Refundable"
          : st === "settled"
            ? "Ready to claim"
            : "Locked",
    detail: !bid
      ? biddable
        ? "A deposit sits here, locked, until the sale settles."
        : undefined
      : claimed
        ? undefined
        : tokensLocked
          ? "Tokens unlock when the launch pool is seeded or abandoned."
        : !closed
          ? "Until the sale settles"
          : st === "failed" && penalty > 0n
            ? "Less the penalty below"
            : undefined,
    link: bid ? <TxLink hash={bid.txHash} prefix="bid tx" /> : undefined,
  });

  // 3b. The invalid-bid penalty, when this bid was void.
  if (bid && penalty > 0n) {
    hops.push({
      title: "Invalid-bid penalty",
      state: "fail",
      value: `${usdcStr(penalty, 6)} USDC`,
      word: "Kept",
      detail: `1\u00a0% of the deposit of a void bid${fill?.revealed === false ? " (it was not revealed)" : ""}. It stays in the contract whether the sale settles or not.`,
    });
  }

  // 4. Claimed
  const tokens = fill && fill.tokens > 0n ? `${tokenStr(fill.tokens, sale.config.decimals)} ${sym}` : null;
  hops.push({
    title: "Tokens and refund",
    state: claimed ? "pass" : bid && closed ? "pending" : "idle",
    word: claimed ? "Claimed" : refundClaimed ? "Refund claimed" : checkingPool ? "Checking pool status" : tokensLocked ? "Tokens locked" : bid && closed ? "Unclaimed" : bid || biddable ? "After settlement" : "Nothing to claim",
    detail:
      bid && closed ? (
        checkingPool ? "Checking when the sale tokens can be claimed." : fill ? (
          <span className="num">
            {tokensLocked ? (
              <>
                {tokens} locked.
                {fill.refund > 0n && <> {usdcStr(fill.refund, 6)} USDC {refundClaimed ? "already refunded." : "available to claim."}</>}
              </>
            ) : refundClaimed && !claimed ? (
              <>{tokens} available to claim. {usdcStr(fill.refund, 6)} USDC already refunded.</>
            ) : (
              <>
                {tokens && `${tokens} and `}
                {usdcStr(fill.refund, 6)} USDC {claimed ? "sent to your account" : "waiting for you"}
              </>
            )}
          </span>
        ) : claimed ? (
          "Sent to your account"
        ) : undefined
      ) : bid || biddable ? (
        "Tokens at the clearing price, plus any unspent USDC"
      ) : undefined,
    link: bid?.claimTx ? <TxLink hash={bid.claimTx} prefix="claim tx" /> : undefined,
  });

  return (
    <Panel title="Where's my money" className={className} bodyClassName="p-0">
      <ol className="divide-y divide-line">
        {hops.map((h, i) => {
          const word = h.word === null ? null : (h.word ?? STATE_LABEL[h.state]);
          return (
            <li key={i} className="min-w-0 px-5 py-3">
              <div className="flex items-baseline justify-between gap-4">
                <span className="min-w-0 text-small text-fg">{h.title}</span>
                <span className="shrink-0 text-right text-small">
                  {h.value && <span className="num text-fg">{h.value}</span>}
                  {word && <span className={cn("text-label", h.value && "ml-2", STATE_TONE[h.state])}>{word}</span>}
                </span>
              </div>
              {(h.detail || h.link) && (
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-label text-subtle [overflow-wrap:anywhere]">
                  {h.detail && <span className="min-w-0">{h.detail}</span>}
                  {h.link}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}
