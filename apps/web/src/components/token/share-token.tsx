"use client";

import { useSyncExternalStore } from "react";
import { xIntentUrl } from "@/components/result/share-text";
import { tradeState } from "@/components/result/supply";
import { ButtonLink } from "@/components/ui/button";
import { getClient } from "@/lib/client";
import { networkName } from "@/lib/format";
import { APP_URL } from "@/lib/site";
import type { Sale, SaleResult } from "@/lib/types";
import { tokenSharePath, tokenShareText, type TokenFigures } from "./figures";

const noSubscribe = () => () => {};

/** The app's origin: the app host when one is set, else this page's own. Empty while rendering on the server. */
export function useOrigin(): string {
  return useSyncExternalStore(
    noSubscribe,
    () => APP_URL || window.location.origin,
    () => APP_URL,
  );
}

/** The X logo, drawn in the text colour. */
export function XMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="size-3.5" fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" />
    </svg>
  );
}

/**
 * "Share on X" for a token: a plain link to X's post intent with the launch
 * price, the burn and where it trades, and the link to this page. No script
 * from X loads on the page.
 */
export function ShareToken({
  sale,
  result,
  figures,
  className,
}: {
  sale: Sale;
  result: SaleResult;
  figures: TokenFigures;
  className?: string;
}) {
  const origin = useOrigin();
  const simulated = getClient().mode === "mock";
  const where = simulated ? "simulated" : networkName();
  const url = origin ? `${origin}${tokenSharePath(sale, simulated)}` : null;
  const href = xIntentUrl(tokenShareText(sale, figures, tradeState(result.liquidity), where), url);

  return (
    <ButtonLink href={href} external size="sm" variant="outline" icon={<XMark />} className={className}>
      Share on X
      <span className="sr-only"> (opens x.com in a new tab)</span>
    </ButtonLink>
  );
}
