"use client";

import { useState } from "react";
import { Wallet } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  ActionError,
  GasNote,
  PaidFallbackPrompt,
  RelayLine,
  useGasMode,
  usePaidFallback,
} from "@/components/sale-common/relay";
import { TxLink } from "@/components/ui/bits";
import { Button } from "@/components/ui/button";
import { KV } from "@/components/ui/stat";
import { getClient } from "@/lib/client";
import { priceStr, shortAccount, tokenFull, usdcStr } from "@/lib/format";
import { useAction } from "@/lib/hooks";
import type { ClaimResult, Sale, SaleResult } from "@/lib/types";
import { useWallet } from "@/lib/wallet";
import { fillStatus, isPenalized, penaltyOf, STATUS_BADGE, voidSentence, type ResultFill } from "./compute";

/**
 * The connected account's outcome and the one main action on this page:
 * Claim. Plain content; the outcome block gives it its place and its frame.
 */
export function MyResult({
  sale,
  result,
  fill,
}: {
  sale: Sale;
  result: SaleResult;
  /** The connected account's fill, with failed-sale refunds applied. */
  fill: ResultFill | null;
}) {
  const { account, connect, connecting, mode } = useWallet();
  const badge = fill ? STATUS_BADGE[fillStatus(fill)] : null;

  return (
    <div className="flex h-full flex-col p-5 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-h3 text-fg">Your result</h2>
          <p className="mt-0.5 truncate text-label text-subtle">
            {account ? (
              <>
                {shortAccount(account, 26)}
                {fill && <span className="num">, bid {fill.index + 1}</span>}
              </>
            ) : (
              "Not connected"
            )}
          </p>
        </div>
        {account && badge && (
          <span title={badge.title} className="mt-px shrink-0">
            <Badge tone={badge.tone} dot plain>
              {badge.label}
            </Badge>
          </span>
        )}
      </div>

      {!account ? (
        <>
          <p className="mt-4 text-small text-muted">
            Connect to see your tokens and refund, and to claim them in one transaction.
          </p>
          <Button
            variant="primary"
            size="lg"
            className="mt-5 w-full"
            onClick={connect}
            loading={connecting}
            icon={<Wallet className="size-4" strokeWidth={1.75} />}
          >
            {mode === "mock" ? "Connect demo wallet" : "Connect wallet"}
          </Button>
        </>
      ) : !fill ? (
        <p className="mt-4 text-small text-muted">This account did not bid in this sale, so there is nothing to claim.</p>
      ) : (
        <Mine key={account} sale={sale} result={result} fill={fill} account={account} />
      )}
    </div>
  );
}

function Mine({ sale, result, fill, account }: { sale: Sale; result: SaleResult; fill: ResultFill; account: string }) {
  const c = sale.config;
  const status = fillStatus(fill);
  const [receipt, setReceipt] = useState<ClaimResult | null>(null);
  const gas = useGasMode();
  const fallback = usePaidFallback(gas.paidBy === "user" ? gas.reason : null);
  const { onPaidFallback } = fallback;
  const claim = useAction((saleId: string, bidder: string) => getClient().claim(saleId, bidder, { onPaidFallback }));

  const onClaim = async () => {
    const r = await claim.run(sale.id, account);
    if (r) setReceipt(r);
  };

  const claimTx = receipt?.txHash ?? fill.claimTx;
  const claimed = fill.claimed || !!receipt;
  const failed = result.status === "failed";
  const penalty = penaltyOf(fill);
  const hasTokens = fill.tokens > 0n;
  const hasRefund = fill.refund > 0n;
  // The last claim may still land: no second one until the chain has spoken.
  const inDoubt = !!claim.errorDetails?.maybeSubmitted;

  // One line, only where the numbers do not explain themselves.
  const note = !fill.valid
    ? `${voidSentence(fill)} ${
        isPenalized(fill)
          ? "A void bid loses 1 % of its deposit, which the contract keeps."
          : "Your whole deposit comes back."
      }`
    : failed
      ? "The sale did not go ahead, so your whole deposit comes back."
      : status === "refunded"
        ? "Your bid did not reach the clearing price, so you bought nothing."
        : null;

  const tokens = `${tokenFull(fill.tokens, c.decimals)} ${c.tokenSymbol}`;
  const refund = `${usdcStr(fill.refund, 6)} USDC`;

  return (
    <>
      {/* What the claim pays, largest first: tokens when there are any, otherwise the refund. */}
      <div className="mt-4 min-w-0 sm:mt-5">
        <div className="text-label text-subtle">
          {hasTokens ? "Tokens" : penalty > 0n ? "Refund, after the penalty" : "Refund"}
        </div>
        <div className="num mt-1 flex flex-wrap items-baseline gap-x-2 text-num-lg text-fg">
          <span className="min-w-0 [overflow-wrap:anywhere]">
            {hasTokens ? tokenFull(fill.tokens, c.decimals) : usdcStr(fill.refund, 6)}
          </span>
          <span className="text-small font-normal tracking-normal text-muted">{hasTokens ? c.tokenSymbol : "USDC"}</span>
        </div>
      </div>

      {/* Deposit less what was spent and any penalty is the refund. */}
      <dl className="mt-3 divide-y divide-line border-y border-line sm:mt-4">
        <KV k="Deposit" v={`${usdcStr(fill.deposit, 6)} USDC`} />
        {hasTokens && <KV k={`Spent at ${priceStr(result.clearingPrice)}`} v={`${usdcStr(fill.spent, 6)} USDC`} />}
        {penalty > 0n && <KV k="Penalty, 1 %" v={`${usdcStr(penalty, 6)} USDC`} />}
        {hasTokens && <KV k="Refund" v={refund} />}
      </dl>

      {note && <p className="mt-3 text-small text-muted">{note}</p>}

      <div className="mt-4 sm:mt-5 lg:mt-auto lg:pt-5">
        {claimed ? (
          <div className="anim-fade" role="status">
            <div className="flex items-center gap-2 text-small font-[510] text-fg">
              <span className="size-1.5 shrink-0 rounded-full bg-ok" aria-hidden />
              Claimed
            </div>
            <p className="mt-1 text-small text-muted">
              <span className="num text-fg">
                {hasTokens && hasRefund ? `${tokens} and ${refund}` : hasTokens ? tokens : refund}
              </span>{" "}
              sent to your account.
            </p>
            {claimTx && <TxLink hash={claimTx} prefix="claim tx" className="mt-2" />}
            <RelayLine relay={receipt?.relay} className="mt-2" />
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            <PaidFallbackPrompt fallback={fallback} what="the claim" />
            <Button
              variant="primary"
              size="lg"
              className="w-full"
              loading={claim.pending}
              disabled={inDoubt}
              onClick={onClaim}
            >
              {inDoubt
                ? "Checking the chain"
                : hasTokens && hasRefund
                  ? "Claim tokens and refund"
                  : hasTokens
                    ? "Claim tokens"
                    : "Claim refund"}
            </Button>
            {claim.errorDetails ? <ActionError info={claim.errorDetails} what="claim" /> : <GasNote what="The claim" />}
          </div>
        )}
      </div>
    </>
  );
}
