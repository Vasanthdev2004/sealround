"use client";

import { useId, useRef, useState, useSyncExternalStore } from "react";
import { Check, ChevronDown, Download, Link2 } from "lucide-react";
import { tickerOf } from "@/app/api/og/bid/share";
import {
  tokenAmount,
  winImageFileName,
  winImagePath,
  winSharePath,
  winShareText,
  type WinCardInput,
  type WinShareWhere,
} from "@/app/api/og/win/share";
import { Tag } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { isNearMode } from "@/lib/config";
import { networkName, priceStr, shortAccount } from "@/lib/format";
import { APP_URL } from "@/lib/site";
import type { Sale, SaleResult } from "@/lib/types";
import type { ResultFill } from "./compute";
import { xIntentUrl } from "./share-text";

export type WinCardProps = {
  sale: Pick<Sale, "id" | "isJudgeSale" | "bidCount"> & {
    config: Pick<Sale["config"], "tokenName" | "tokenSymbol" | "decimals">;
  };
  result: Pick<SaleResult, "status" | "clearingPrice" | "fills">;
  /** The connected account's fill. */
  fill: Pick<ResultFill, "index" | "bidder" | "tokens" | "valid">;
  className?: string;
};

const noSubscribe = () => () => {};

/** The app's origin: the app host when one is set, else this page's own. Empty while rendering on the server. */
function useOrigin(): string {
  return useSyncExternalStore(
    noSubscribe,
    () => APP_URL || window.location.origin,
    () => APP_URL,
  );
}

/** The X logo, drawn in the text colour. */
function XMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="size-3.5" fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" />
    </svg>
  );
}

/** A winner: a settled sale and a valid fill with tokens. Only then is there a card to share. */
export function isWinner(result: Pick<SaleResult, "status">, fill: Pick<ResultFill, "tokens" | "valid"> | null): boolean {
  return result.status === "settled" && !!fill && fill.valid && fill.tokens > 0n;
}

/** What the share link, the card and the post are built from. Exported for tests. */
export function winShare(
  { sale, result, fill }: Pick<WinCardProps, "sale" | "result" | "fill">,
  o: { showAccount: boolean; near: boolean; where: WinShareWhere; origin: string },
) {
  const c = sale.config;
  const winners = result.fills.filter((f) => f.tokens > 0n).length;
  const input: WinCardInput = {
    saleId: sale.id,
    bidNumber: fill.index + 1,
    account: o.showAccount ? fill.bidder : null,
    // The server cannot read a simulated sale, so the link carries what the card shows.
    sim: o.near
      ? null
      : {
          name: c.tokenName,
          ticker: c.tokenSymbol,
          decimals: c.decimals,
          tokens: fill.tokens,
          price: result.clearingPrice,
          winners,
          bids: Math.max(sale.bidCount, result.fills.length),
        },
  };
  const text = winShareText({
    ticker: c.tokenSymbol,
    tokens: fill.tokens,
    decimals: c.decimals,
    price: result.clearingPrice,
    winners,
    where: o.where,
  });
  // A judge-mode sale exists only in the browser that ran it: the link is the judge page, as for the result's own share.
  const path = !o.near && sale.isJudgeSale ? "/judge" : winSharePath(input);
  const url = o.origin ? `${o.origin}${path}` : null;
  return {
    input,
    text,
    url,
    imageSrc: winImagePath(input),
    xHref: xIntentUrl(text, url),
    fileName: winImageFileName(c.tokenSymbol, input.bidNumber),
  };
}

/**
 * The winner card: after the sale settles, a card to post that says how many
 * tokens you got and that you paid the one clearing price every winner paid,
 * bots included. A preview of the card, "Share on X" (a plain link to X's
 * post intent, no script from X), "Copy link" (the result page with `?win=`,
 * which previews as this card) and "Download". The account is left off the
 * card unless the winner ticks the box. On the simulated chain the card and
 * the post say the sale is simulated. Renders nothing for a bid that won no
 * tokens or a sale that did not clear.
 *
 * Narrow by design: it sits in the result's 340px column. On desktop that
 * column runs beside the outcome, and a tall block would stretch the outcome
 * with empty space, so there it starts folded to a thumbnail and a "Share your win" button.
 * Below desktop it is always open, the preview beside the controls from
 * tablet width.
 */
export function WinCard({ sale, result, fill, className }: WinCardProps) {
  const [showAccount, setShowAccount] = useState(false);
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const openRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const origin = useOrigin();
  const headingId = useId();
  const accountId = useId();
  const panelId = useId();

  if (!isWinner(result, fill)) return null;

  const near = isNearMode();
  const where: WinShareWhere = near ? networkName() : "simulated";
  const s = winShare({ sale, result, fill }, { showAccount, near, where, origin });
  const judgeLink = !near && sale.isJudgeSale;
  const amount = `${tokenAmount(fill.tokens, sale.config.decimals)} $${tickerOf(sale.config.tokenSymbol)}`;
  const loaded = loadedSrc === s.imageSrc;
  const failed = failedSrc === s.imageSrc;

  const copy = async () => {
    if (!s.url) return;
    try {
      await navigator.clipboard.writeText(s.url);
      setCopied("copied");
      window.setTimeout(() => setCopied((c) => (c === "copied" ? "idle" : c)), 2500);
    } catch {
      // No clipboard here (an insecure origin, a denied permission): show the link to copy by hand.
      setCopied("failed");
    }
  };

  // The control that was clicked disappears, so focus moves to what replaced it.
  const unfold = () => {
    setOpen(true);
    requestAnimationFrame(() => panelRef.current?.focus());
  };
  const fold = () => {
    setOpen(false);
    requestAnimationFrame(() => openRef.current?.focus());
  };

  const download = () => {
    const a = document.createElement("a");
    a.href = s.imageSrc;
    a.download = s.fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <section aria-labelledby={headingId} className={className}>
      {/* Desktop, folded: a thumbnail of the card and the control that opens it. */}
      <div className={cn("hidden items-center gap-3", !open && "lg:flex")}>
        <div
          aria-hidden
          className="relative aspect-[1200/630] w-24 shrink-0 overflow-hidden rounded-[6px] bg-elev-2 after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:ring-1 after:ring-line after:ring-inset"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {!failed && <img src={s.imageSrc} alt="" width={1200} height={630} decoding="async" className="block size-full object-cover" />}
        </div>
        <Button
          ref={openRef}
          size="sm"
          variant="outline"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={unfold}
          icon={<ChevronDown className="size-3.5" aria-hidden />}
        >
          Share your win
        </Button>
      </div>

      <div
        id={panelId}
        ref={panelRef}
        tabIndex={-1}
        className={cn(
          "flex flex-col gap-4 outline-none sm:flex-row sm:items-start lg:flex-col lg:items-stretch",
          !open && "lg:hidden",
        )}
      >
        <div
          className={cn(
            "relative aspect-[1200/630] w-full shrink-0 overflow-hidden rounded-tile bg-elev-2 sm:w-[280px] lg:w-full",
            "after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:ring-1 after:ring-line after:ring-inset",
          )}
        >
          {!loaded && !failed && <div className="shimmer absolute inset-0" aria-hidden />}
          {failed ? (
            <p className="flex size-full items-center justify-center px-4 text-center text-label text-subtle">
              The preview did not load. The link and the post still work.
            </p>
          ) : (
            // A card drawn by this app's own route: next/image would only add a loader in front of it.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={s.imageSrc}
              alt={`Your winner card: ${showAccount ? fill.bidder : "I"} got ${amount} at ${priceStr(result.clearingPrice)} USDC each. No bot paid less.`}
              width={1200}
              height={630}
              decoding="async"
              onLoad={() => setLoadedSrc(s.imageSrc)}
              onError={() => setFailedSrc(s.imageSrc)}
              // Above the shimmer, which it covers once drawn.
              className="relative block size-full object-cover"
            />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <h3 id={headingId} className="text-small font-[510] text-fg">
              Share your win
            </h3>
            {/* Folding back is a desktop affair: below it the block is always open. */}
            <span className="hidden lg:block">
              <Button size="sm" variant="ghost" className="-my-1" aria-expanded={open} aria-controls={panelId} onClick={fold}>
                Hide
              </Button>
            </span>
          </div>
          <p className="mt-0.5 text-label text-subtle">
            Your tokens and the one price every winner paid. Never your max price or deposit.
          </p>

          <label htmlFor={accountId} className="mt-2 flex min-h-10 items-center gap-2 text-small text-fg sm:min-h-8">
            <input id={accountId} type="checkbox" checked={showAccount} onChange={(e) => setShowAccount(e.target.checked)} />
            <span className="min-w-0 truncate">
              Show <span className="text-muted">{shortAccount(fill.bidder, 24)}</span> on the card
            </span>
          </label>

          <div className="mt-2 grid grid-cols-2 gap-2">
            <ButtonLink
              href={s.xHref}
              external
              size="sm"
              variant="outline"
              icon={<XMark />}
              className="col-span-2 max-sm:h-10"
            >
              Share on X
              <span className="sr-only"> (opens x.com in a new tab)</span>
            </ButtonLink>
            <Button
              size="sm"
              variant="outline"
              className="max-sm:h-10"
              disabled={!s.url}
              onClick={() => void copy()}
              icon={copied === "copied" ? <Check className="size-3.5 text-ok" aria-hidden /> : <Link2 className="size-3.5" aria-hidden />}
            >
              {copied === "copied" ? "Copied" : "Copy link"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="max-sm:h-10"
              onClick={download}
              icon={<Download className="size-3.5" aria-hidden />}
            >
              Download
            </Button>
          </div>

          <p role="status" className={cn("mt-2 text-label text-subtle", copied !== "failed" && "sr-only")}>
            {copied === "copied" ? (
              "Share link copied."
            ) : copied === "failed" ? (
              <>
                Copy this link: <span className="num text-muted [overflow-wrap:anywhere] select-all">{s.url}</span>
              </>
            ) : (
              ""
            )}
          </p>

          {!near && (
            <p className="mt-2 flex items-start gap-2 text-label text-subtle">
              <Tag title="This sale runs on the mock chain in this browser">sim</Tag>
              <span>
                {judgeLink
                  ? "Simulated sale. The card and the post say so. The link opens Judge mode, since this sale lives only in this browser."
                  : "Simulated sale. The card and the post say so."}
              </span>
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
