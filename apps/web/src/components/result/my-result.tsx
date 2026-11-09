"use client";

import { useState } from "react";
import { Check, Wallet } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { TxLink } from "@/components/ui/bits";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { KV } from "@/components/ui/stat";
import { getClient } from "@/lib/client";
import { priceStr, shortAccount, tokenFull, tokenStr, usdcStr } from "@/lib/format";
import { useAction } from "@/lib/hooks";
import type { ClaimReceipt, Sale, SaleResult } from "@/lib/types";
import { useWallet } from "@/lib/wallet";
import { fillStatus, STATUS_BADGE, VOID_LONG, VOID_TEXT, type ResultFill } from "./compute";

/** The connected account's outcome and the one main action on this page: Claim. */
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
  const { account, connect, connecting } = useWallet();

  return (
    <Panel title="Your result" subtitle={account ? shortAccount(account, 30) : "Not connected"} className="h-full">
      {!account ? (
        <div className="flex flex-col items-start gap-3">
          <p className="text-[13px] leading-relaxed text-muted">
            Connect to see your tokens and refund, and to claim them. The demo account is a simulated testnet
            account with test USDC.
          </p>
          <Button variant="primary" onClick={connect} loading={connecting} icon={<Wallet className="size-4" />}>
            Connect
          </Button>
        </div>
      ) : !fill ? (
        <p className="text-[13px] leading-relaxed text-muted">
          This account did not bid in this sale, so there is nothing to claim. Bids are public once placed: the
          fills table below lists every one.
        </p>
      ) : (
        <Mine key={account} sale={sale} result={result} fill={fill} account={account} />
      )}
    </Panel>
  );
}

function Mine({ sale, result, fill, account }: { sale: Sale; result: SaleResult; fill: ResultFill; account: string }) {
  const c = sale.config;
  const status = fillStatus(fill);
  const badge = STATUS_BADGE[status];
  const [receipt, setReceipt] = useState<ClaimReceipt | null>(null);
  const claim = useAction((saleId: string, bidder: string) => getClient().claim(saleId, bidder));

  const onClaim = async () => {
    const r = await claim.run(sale.id, account);
    if (r) setReceipt(r);
  };

  const claimTx = receipt?.txHash ?? fill.claimTx;
  const claimed = fill.claimed || !!receipt;
  const failed = result.status === "failed";

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="min-w-0">
          <div className="text-[12px] text-subtle">Tokens</div>
          <div className="num mt-1 truncate text-[26px] leading-none tracking-[-0.03em] text-fg" title={tokenFull(fill.tokens, c.decimals)}>
            {tokenStr(fill.tokens, c.decimals)}
          </div>
          <div className="mt-1 text-[12px] text-muted">{c.tokenSymbol}</div>
        </div>
        <div className="min-w-0">
          <div className="text-[12px] text-subtle">Refund</div>
          <div className="num mt-1 truncate text-[26px] leading-none tracking-[-0.03em] text-fg">
            {usdcStr(fill.refund, 6)}
          </div>
          <div className="mt-1 text-[12px] text-muted">USDC</div>
        </div>
      </div>

      <dl className="divide-y divide-dashed divide-line-dashed border-y border-dashed border-line-dashed">
        <KV k="Deposit" v={`${usdcStr(fill.deposit, 6)} USDC`} />
        <KV
          k="Spent"
          v={
            fill.tokens > 0n ? (
              <span>
                {usdcStr(fill.spent, 6)} USDC
                <span className="block text-[11.5px] text-subtle">at {priceStr(result.clearingPrice)} per token</span>
              </span>
            ) : (
              "0 USDC"
            )
          }
        />
        <KV k="Status" mono={false} v={<Badge tone={badge.tone}>{badge.label}</Badge>} />
      </dl>

      <p className="text-[12.5px] leading-relaxed text-muted">
        {!fill.valid && fill.invalidReason
          ? `${VOID_TEXT[fill.invalidReason]}. ${VOID_LONG[fill.invalidReason]} Your full deposit comes back.`
          : failed
            ? "The sale did not go ahead. Your whole deposit comes back."
            : status === "refunded"
              ? "Your bid did not reach the clearing price, so you bought nothing. Your whole deposit comes back."
              : status === "partial"
                ? "You pay the clearing price for your tokens. The rest of your deposit comes back."
                : "You pay the clearing price for your tokens. Your whole deposit was used."}
      </p>

      {claimed ? (
        <div className="inset flex items-start gap-3 p-3.5">
          <span className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full bg-ok-soft ring-1 ring-ok/25">
            <Check className="size-3.5 text-ok" strokeWidth={2.5} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] text-fg">Claimed</div>
            <div className="mt-0.5 text-[12px] leading-snug text-muted">
              {fill.tokens > 0n && (
                <>
                  <span className="num">{tokenStr(fill.tokens, c.decimals)} {c.tokenSymbol}</span> and{" "}
                </>
              )}
              <span className="num">{usdcStr(fill.refund, 6)} USDC</span> sent to your account.
            </div>
          </div>
          {claimTx && <TxLink hash={claimTx} label="claim tx" className="mt-0.5 shrink-0" />}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <Button variant="primary" size="lg" className="w-full" loading={claim.pending} onClick={onClaim}>
            {fill.tokens > 0n
              ? `Claim ${tokenStr(fill.tokens, c.decimals)} ${c.tokenSymbol}${fill.refund > 0n ? ` + ${usdcStr(fill.refund, 6)} USDC` : ""}`
              : `Claim ${usdcStr(fill.refund, 6)} USDC refund`}
          </Button>
          {claim.error ? (
            <p className="text-[12.5px] text-bad" role="alert">
              Claim failed: {claim.error}
            </p>
          ) : (
            <p className="text-[12px] text-subtle">One transaction. Tokens and unspent USDC arrive together.</p>
          )}
        </div>
      )}
    </div>
  );
}
