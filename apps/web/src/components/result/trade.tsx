"use client";

import { useState } from "react";
import { ArrowUpRight, Check, Copy } from "lucide-react";
import { Tag } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { isNearMode } from "@/lib/config";
import { accountUrl, tokenFull } from "@/lib/format";
import type { Sale, SaleResult } from "@/lib/types";
import { tradeState } from "./supply";

/**
 * The hand-off to trading. A seeded launch pool gets the "Trade on Rhea"
 * button; on the simulated chain the button opens Rhea's home page and says
 * there is no real pool behind it. While the pool is being seeded: trading
 * opens once it is. No pool (none planned, skipped, cancelled, abandoned):
 * Sealround opened no market, and making one is the creator's job.
 */
export function TradeAction({
  sale,
  result,
  className,
}: {
  sale: Sale;
  result: SaleResult;
  className?: string;
}) {
  const t = tradeState(result.liquidity);
  const sym = sale.config.tokenSymbol;

  if (t.kind === "soon") {
    return <p className={cn("text-small text-muted", className)}>Trading opens once the pool is seeded.</p>;
  }
  if (t.kind === "none") {
    return (
      <p className={cn("text-small text-muted", className)}>
        <span className="text-fg">No Sealround pool,</span> so nothing trades here. Making a market for {sym} is the
        creator&rsquo;s job.
      </p>
    );
  }

  const label = t.venue ? `Trade on ${t.venue}` : "Open the exchange";
  return (
    <div className={cn("flex flex-col gap-2.5", className)}>
      {t.href ? (
        <ButtonLink href={t.href} external variant="primary" size="lg" className="w-full">
          {label}
          <ArrowUpRight className="size-4" strokeWidth={1.75} aria-hidden />
        </ButtonLink>
      ) : (
        <p className="text-small text-fg">This network has no exchange app to link to.</p>
      )}
      {t.simulated ? (
        <p className="flex items-start gap-2 text-label text-subtle">
          <Tag title="No exchange was called on the mock chain">sim</Tag>
          <span>
            Simulated pool: nothing trades on it, so this opens {t.venue ?? "the exchange"}&rsquo;s home page. A real
            sale links its own pool.
          </span>
        </p>
      ) : (
        <p className="text-label text-subtle">
          {t.poolId !== null && <>Pool #{t.poolId}, opened at the clearing price. </>}
          Trades move a pool&rsquo;s price; the contract controls only the price it opens at.
        </p>
      )}
    </div>
  );
}

/**
 * The connected account's claimed tokens: how many, the token contract with a
 * copy button and an explorer link, and how to see them in a wallet. Then the
 * way to trade them (or why there is none).
 */
export function YourTokens({
  sale,
  result,
  tokens,
  className,
}: {
  sale: Sale;
  result: SaleResult;
  tokens: bigint;
  className?: string;
}) {
  const c = sale.config;
  const near = isNearMode();
  const page = near ? accountUrl(sale.tokenAccount) : "#";

  return (
    <div className={cn("flex flex-col gap-2.5", className)}>
      <div>
        <div className="text-label text-subtle">Your tokens</div>
        <p className="mt-1 text-small text-muted">
          <span className="num text-fg">
            {tokenFull(tokens, c.decimals)} {c.tokenSymbol}
          </span>{" "}
          are in your wallet.
        </p>
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <code className="min-w-0 flex-1 font-mono text-label text-fg select-all [overflow-wrap:anywhere]" title={sale.tokenAccount}>
          {sale.tokenAccount}
        </code>
        <CopyButton text={sale.tokenAccount} what="token contract id" />
        {page !== "#" ? (
          <a
            href={page}
            target="_blank"
            rel="noreferrer"
            aria-label={`${sale.tokenAccount} on the explorer`}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-[8px] text-muted transition-colors hover:bg-wash hover:text-fg"
          >
            <ArrowUpRight className="size-4" strokeWidth={1.75} aria-hidden />
          </a>
        ) : (
          !near && <Tag title="The mock chain's token has no explorer page">sim</Tag>
        )}
      </div>
      <p className="text-label text-subtle">
        Any NEAR wallet shows NEP-141 tokens. Some need this contract id added by hand.
      </p>
      <TradeAction sale={sale} result={result} className="mt-1" />
    </div>
  );
}

/**
 * A small copy button; says "Copied" for a moment, or "Copy failed" if the
 * clipboard refuses (the id beside it selects in one click for a manual copy).
 */
export function CopyButton({ text, what }: { text: string; what: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
      window.setTimeout(() => setState("idle"), 1600);
    } catch {
      setState("failed");
    }
  };
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        className="shrink-0 px-2"
        onClick={() => void copy()}
        aria-label={state === "copied" ? `Copied the ${what}` : `Copy the ${what}`}
        icon={state === "copied" ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
      >
        {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}
      </Button>
      <span role="status" className="sr-only">
        {state === "copied" ? `Copied the ${what}.` : state === "failed" ? `Could not copy. Select the ${what} and copy it by hand.` : ""}
      </span>
    </>
  );
}
