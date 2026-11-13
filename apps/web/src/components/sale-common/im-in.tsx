"use client";

import { useId, useState, useSyncExternalStore } from "react";
import { Check, Download, Link2 } from "lucide-react";
import {
  bidImageFileName,
  bidImagePath,
  bidShareText,
  bidSharePath,
  tickerOf,
  type BidCardInput,
  type BidShareWhere,
} from "@/app/api/og/bid/share";
import { xIntentUrl } from "@/components/result/share-text";
import { Tag } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { isNearMode } from "@/lib/config";
import { networkName, shortAccount } from "@/lib/format";
import { APP_URL } from "@/lib/site";
import type { BidRecord, Sale } from "@/lib/types";

export type ImInProps = {
  /** The sale the bid is in: its id, token name and ticker, and `bidEnd` (the reveal time on the card). */
  sale: Pick<Sale, "id"> & { config: Pick<Sale["config"], "tokenName" | "tokenSymbol" | "bidEnd"> };
  /** The connected account's bid, as `useMyBid` returns it: `index` is 0-based (bid #1 is index 0). */
  bid: Pick<BidRecord, "index" | "bidder">;
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

/** What the share link, the card and the post are built from. Exported for tests. */
export function imInShare(
  { sale, bid }: Pick<ImInProps, "sale" | "bid">,
  o: { showAccount: boolean; near: boolean; where: BidShareWhere; origin: string },
) {
  const c = sale.config;
  const input: BidCardInput = {
    saleId: sale.id,
    bidNumber: bid.index + 1,
    account: o.showAccount ? bid.bidder : null,
    // The server cannot read a simulated sale, so the link carries what the card shows.
    sim: o.near ? null : { name: c.tokenName, ticker: c.tokenSymbol, revealAt: c.bidEnd },
  };
  const text = bidShareText({ ticker: c.tokenSymbol, bidNumber: input.bidNumber, revealAt: c.bidEnd, where: o.where });
  const url = o.origin ? `${o.origin}${bidSharePath(input)}` : null;
  return {
    input,
    text,
    url,
    imageSrc: bidImagePath(input),
    xHref: xIntentUrl(text, url),
    fileName: bidImageFileName(c.tokenSymbol, input.bidNumber),
  };
}

/**
 * "I'm in": after a bid, a card to post that says you are in this sale
 * without saying how much or at what price. A preview of the card, "Share
 * on X" (a plain link to X's post intent, no script from X), "Copy link"
 * (the sale page with `?bid=`, which previews as this card) and "Download
 * image". The account is left off the card unless the bidder ticks the box.
 * On the simulated chain the card and the post say the sale is simulated.
 *
 * Place it where the bid is confirmed, inside a card: it draws no frame of
 * its own.
 */
export function ImIn({ sale, bid, className }: ImInProps) {
  const [showAccount, setShowAccount] = useState(false);
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const origin = useOrigin();
  const headingId = useId();
  const accountId = useId();

  const near = isNearMode();
  const where: BidShareWhere = near ? networkName() : "simulated";
  const s = imInShare({ sale, bid }, { showAccount, near, where, origin });
  const ticker = `$${tickerOf(sale.config.tokenSymbol)}`;
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

  const download = () => {
    const a = document.createElement("a");
    a.href = s.imageSrc;
    a.download = s.fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <section aria-labelledby={headingId} className={cn("flex flex-col gap-4 sm:flex-row sm:items-start", className)}>
      <div
        className={cn(
          "relative aspect-[1200/630] w-full shrink-0 overflow-hidden rounded-tile bg-elev-2 sm:w-[300px]",
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
            alt={`Your share card: I'm in. Sealed bid #${s.input.bidNumber} in ${ticker}.${showAccount ? ` By ${bid.bidder}.` : ""} Price and amount sealed until the reveal.`}
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
        <h3 id={headingId} className="text-h3 text-fg">
          Show you&rsquo;re in
        </h3>
        <p className="mt-1 max-w-[52ch] text-small text-muted">
          Your bid number and the reveal time. Your price and amount stay sealed, on the card too.
        </p>

        <label htmlFor={accountId} className="mt-3 flex min-h-10 items-center gap-2 text-small text-fg sm:min-h-8">
          <input
            id={accountId}
            type="checkbox"
            checked={showAccount}
            onChange={(e) => setShowAccount(e.target.checked)}
          />
          <span className="min-w-0 truncate">
            Show <span className="text-muted">{shortAccount(bid.bidder, 28)}</span> on the card
          </span>
        </label>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <ButtonLink href={s.xHref} external size="sm" variant="primary" icon={<XMark />} className="max-sm:h-10">
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
            {copied === "copied" ? "Link copied" : "Copy link"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="max-sm:h-10"
            onClick={download}
            icon={<Download className="size-3.5" aria-hidden />}
          >
            Download image
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
            <span>Simulated sale. The card and the post say so.</span>
          </p>
        )}
      </div>
    </section>
  );
}
