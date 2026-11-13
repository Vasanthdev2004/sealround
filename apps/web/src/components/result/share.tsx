"use client";

import { useSyncExternalStore } from "react";
import { ButtonLink } from "@/components/ui/button";
import { getClient } from "@/lib/client";
import { networkName } from "@/lib/format";
import { APP_URL } from "@/lib/site";
import type { Sale, SaleResult } from "@/lib/types";
import { sharePath, shareText, xIntentUrl, type ShareWhere } from "./share-text";
import type { Timeline } from "./timeline";

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

/**
 * "Share on X": a plain link to X's post intent with one factual sentence and
 * the link to this result. No script from X loads on the page.
 */
export function ShareOnX({
  sale,
  result,
  timeline,
  className,
}: {
  sale: Sale;
  result: SaleResult;
  timeline: Timeline | null;
  className?: string;
}) {
  const origin = useOrigin();
  const simulated = getClient().mode === "mock";
  const net = networkName();
  const where: ShareWhere = simulated ? "simulated" : net;
  const url = origin ? `${origin}${sharePath(sale, simulated)}` : null;
  const href = xIntentUrl(shareText(sale, result, timeline, where), url);

  return (
    <ButtonLink href={href} external size="sm" variant="outline" icon={<XMark />} className={className}>
      Share on X
      <span className="sr-only"> (opens x.com in a new tab)</span>
    </ButtonLink>
  );
}
