"use client";

import { ArrowRight } from "lucide-react";
import { timelineHeadline, type Timeline } from "@/components/result/timeline";
import { ButtonLink } from "@/components/ui/button";
import { priceStr } from "@/lib/format";
import type { Sale, SaleResult } from "@/lib/types";

/**
 * The fair-launch proof, short: how many bids, one price, the timeline's
 * headline (a bot early and a person late paid the same on the simulated
 * chain; the first and last winning bids on a real contract), and the way to
 * the full result and its Verified panel.
 */
export function LaunchProof({
  sale,
  result,
  holders,
  timeline,
}: {
  sale: Sale;
  result: SaleResult;
  holders: number;
  /** Null while the public bids load, or when they could not be read. */
  timeline: Timeline | null;
}) {
  const bids = result.nValid + result.nInvalid;
  const href = `/sale/${encodeURIComponent(sale.id)}/result`;
  const enclave = result.clearedBy !== "onchain" && sale.config.revealMode !== "commit_reveal";
  const price = `${priceStr(result.clearingPrice)} USDC per token`;
  const headline = timeline
    ? timelineHeadline(timeline, result)
    : holders === 1
      ? `The one winning bid paid ${price}.`
      : `All ${holders} winners paid ${price}.`;

  return (
    <section aria-labelledby="proof-title">
      <h2 id="proof-title" className="text-h2 text-fg">
        How it launched
      </h2>
      <div className="panel mt-5 p-5 sm:p-6">
        <p className="text-h3 text-fg">
          <span className="num">{bids.toLocaleString("en-US")}</span> {bids === 1 ? "bid" : "bids"}, one price.
        </p>
        <p className="mt-2 max-w-[68ch] text-body text-muted">{headline}</p>
        <p className="mt-2 max-w-[68ch] text-small text-muted">
          {enclave
            ? "Every bid stayed sealed until the sale closed. An attested enclave then opened them all at once, and the contract checked its result before anyone was paid."
            : "Bids stayed hidden as commitments until the sale closed. Bidders then revealed them, and the contract cleared the sale itself."}
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          <ButtonLink href={href} size="sm">
            Full result
            <ArrowRight className="size-3.5" strokeWidth={1.75} aria-hidden />
          </ButtonLink>
          <ButtonLink href={`${href}#verification`} size="sm" variant="ghost">
            Check it yourself
          </ButtonLink>
        </div>
      </div>
    </section>
  );
}
