"use client";

import { useState } from "react";
import { Download } from "lucide-react";
import { countdownImagePath, kitFileName, type CountdownPhase } from "@/app/api/og/countdown/share";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { cn } from "@/lib/cn";
import { isNearMode } from "@/lib/config";
import type { Sale } from "@/lib/types";
import { saveAs } from "./kit-bits";

/** The countdown image's address for this sale; in mock mode it carries the facts the server cannot read. */
export function countdownSrc(sale: Pick<Sale, "id" | "config">, near: boolean): string {
  const c = sale.config;
  return countdownImagePath({
    saleId: sale.id,
    sim: near
      ? null
      : { name: c.tokenName, ticker: c.tokenSymbol, bidStart: c.bidStart, bidEnd: c.bidEnd, floorPrice: c.floorPrice },
  });
}

/** One image, 1200 x 630, with a caption and a Download button. Draws no frame of its own beyond the image's hairline. */
function ImageTile({
  src,
  alt,
  title,
  caption,
  fileName,
}: {
  src: string;
  alt: string;
  title: string;
  caption: React.ReactNode;
  fileName: string;
}) {
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const loaded = loadedSrc === src;
  const failed = failedSrc === src;
  return (
    <figure className="flex min-w-0 flex-col">
      <div
        className={cn(
          "relative aspect-[1200/630] w-full overflow-hidden rounded-tile bg-elev-2",
          "after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:ring-1 after:ring-line after:ring-inset",
        )}
      >
        {!loaded && !failed && <div className="shimmer absolute inset-0" aria-hidden />}
        {failed ? (
          <p className="flex size-full items-center justify-center px-4 text-center text-label text-subtle">
            The preview did not load. Download still asks the server again.
          </p>
        ) : (
          // A card drawn by this app's own route: next/image would only add a loader in front of it.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt={alt}
            width={1200}
            height={630}
            decoding="async"
            onLoad={() => setLoadedSrc(src)}
            onError={() => setFailedSrc(src)}
            className="relative block size-full object-cover"
          />
        )}
      </div>
      <figcaption className="mt-3 flex min-w-0 flex-1 flex-col">
        <h3 className="text-h3 text-fg">{title}</h3>
        <p className="mt-1 text-small text-muted">{caption}</p>
        <div className="mt-3">
          <Button
            size="sm"
            variant="outline"
            className="max-sm:h-10"
            onClick={() => saveAs(src, fileName)}
            icon={<Download className="size-3.5" aria-hidden />}
          >
            Download PNG
          </Button>
        </div>
      </figcaption>
    </figure>
  );
}

/** The countdown image to attach to a post, and the preview X and others draw for the sale link. */
export function KitImages({ sale, phase }: { sale: Sale; phase: Exclude<CountdownPhase, "final"> }) {
  const near = isNearMode();
  const c = sale.config;
  const sym = c.tokenSymbol;
  const countdown = countdownSrc(sale, near);
  const what = phase === "upcoming" ? "when bids open" : phase === "open" ? "when sealed bids close" : "when bidding closed";
  return (
    <Panel title="Images" bodyClassName="px-5 pt-2 pb-5">
      <div className="grid gap-6 sm:grid-cols-2 sm:gap-5">
        <ImageTile
          // A new phase draws a new card: the key makes the tile load it again.
          key={`${countdown}#${phase}`}
          src={countdown}
          alt={`Countdown image for $${sym}: ${what}, in UTC, and "One price for everyone. Bots can't snipe what they can't see."`}
          title="Countdown"
          caption={<>Says {what}, in UTC, so it stays right however late someone sees it. Attach it to a post.</>}
          fileName={kitFileName(sym, "countdown", "png")}
        />
        <ImageTile
          src={`/sale/${encodeURIComponent(sale.id)}/kit/share-card`}
          alt={near ? `Link preview of the $${sym} sale: the token and where the sale stands.` : "Link preview: the generic Sealround card."}
          title="Link preview"
          caption={
            near
              ? "What X and other apps show under the sale link, drawn from the contract."
              : "What the sale link shows on X. A simulated sale has no server copy, so this is the generic card; on a contract it shows your token."
          }
          fileName={kitFileName(sym, "card", "png")}
        />
      </div>
    </Panel>
  );
}
