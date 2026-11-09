"use client";

import { ArrowRight } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { Countdown } from "@/components/ui/bits";
import { Empty } from "@/components/ui/panel";
import { duration } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import type { Sale } from "@/lib/types";

/** Shown when the sale has no result yet: says where it is and links back. */
export function NotReady({ sale }: { sale: Sale }) {
  const now = useNow(1000);
  const c = sale.config;
  let title: React.ReactNode = "No result yet";
  let body: React.ReactNode = "This sale has not settled. The result appears here once it does.";

  switch (sale.status) {
    case "upcoming":
      title = "Bidding has not started";
      body = (
        <>
          The bid window opens in <Countdown to={c.bidStart} className="text-fg" />. The clearing price and every
          fill appear here after the window closes and the enclave clears the sealed bids.
        </>
      );
      break;
    case "open":
      title = "Bidding is open";
      body = (
        <>
          Sealed bids are coming in for another <Countdown to={c.bidEnd} className="text-fg" />. Nobody, including
          us, can see a price until the window closes. The result appears here after clearing.
        </>
      );
      break;
    case "awaiting_close":
      title = "Waiting for someone to close the sale";
      body =
        "The bid window has ended. Anyone can close the sale from the sale page. That freezes the bid set and sends it to the enclave to clear.";
      break;
    case "clearing": {
      const due = (sale.closedAt ?? now) + c.settleTimeoutMs;
      if (now >= due) {
        title = "The enclave has not answered";
        body = (
          <>
            The sale closed <span className="num text-fg">{duration(now - (sale.closedAt ?? now))}</span> ago and no
            clearing result has arrived. The settle timeout has passed, so anyone can move the sale to refunds from
            the sale page. Every deposit then comes back in full.
          </>
        );
      } else {
        title = "Clearing now";
        body = (
          <>
            The bid set is frozen and the enclave is opening the sealed bids. Results usually land within two
            minutes. If nothing arrives in <Countdown to={due} className="text-fg" />, anyone can switch the sale to
            refunds.
          </>
        );
      }
      break;
    }
    case "revealing":
      title = "Reveal window is open";
      body = "This sale runs in commit-reveal fallback mode. Bidders are revealing their bids. The contract clears once the window ends.";
      break;
  }

  return (
    <Empty
      className="py-14"
      title={title}
      body={<span className="leading-relaxed">{body}</span>}
      action={
        <ButtonLink href={`/sale/${sale.id}`} variant="primary" size="md">
          Go to the sale <ArrowRight className="size-4" strokeWidth={1.75} />
        </ButtonLink>
      }
    />
  );
}
