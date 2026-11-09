"use client";

import { ArrowRight, Lock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { TxLink } from "@/components/ui/bits";
import { ButtonLink } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { KV } from "@/components/ui/stat";
import type { Tone } from "@/lib/format";
import { ago, dateTime, priceStr, usdcStr } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import type { BidRecord, Sale } from "@/lib/types";
import { useLocalBid } from "./local-bid";

const b64Bytes = (s: string) => Math.floor((s.length * 3) / 4) - (s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0);

function bidStatus(sale: Sale, bid: BidRecord): { label: string; tone: Tone } {
  switch (sale.status) {
    case "upcoming":
    case "open":
      return { label: "Sealed, deposit locked", tone: "accent" };
    case "awaiting_close":
      return { label: "Waiting for close", tone: "warn" };
    case "clearing":
    case "revealing":
      return { label: "Being cleared", tone: "warn" };
    case "settled":
      return bid.claimed ? { label: "Claimed", tone: "ok" } : { label: "Ready to claim", tone: "ok" };
    case "failed":
      return bid.claimed ? { label: "Refunded", tone: "neutral" } : { label: "Refund ready", tone: "bad" };
  }
}

/** The connected account's bid: public record plus the price remembered in this browser. */
export function MyBidCard({
  sale,
  account,
  bid,
  loading,
}: {
  sale: Sale;
  account: string;
  bid: BidRecord | null | undefined;
  loading: boolean;
}) {
  const local = useLocalBid(sale.id, account);
  const now = useNow(5000);

  if (loading) {
    return (
      <Panel title="My bid">
        <div className="shimmer h-[120px] rounded-tile bg-elev-2" />
      </Panel>
    );
  }

  if (!bid) {
    return (
      <Panel title="My bid">
        <p className="text-[13px] text-muted">
          {sale.status === "open"
            ? "No bid from this account yet. Use the bid form to place one sealed bid."
            : sale.status === "upcoming"
              ? "Bidding has not opened yet. You can fund your account now."
              : "This account did not bid in this sale."}
        </p>
      </Panel>
    );
  }

  const st = bidStatus(sale, bid);
  const done = sale.status === "settled" || sale.status === "failed";

  return (
    <Panel title="My bid" action={<Badge tone={st.tone} dot pulse={sale.status === "clearing"}>{st.label}</Badge>}>
      <dl className="-mt-1">
        <KV k="Deposit" v={`${usdcStr(bid.deposit)} USDC`} />
        <KV
          k="Placed"
          v={
            <span title={dateTime(bid.placedAt)} suppressHydrationWarning>
              {ago(bid.placedAt, Math.max(now, bid.placedAt))}
            </span>
          }
        />
        <KV k="Transaction" v={<TxLink hash={bid.txHash} />} />
      </dl>

      <div className="mt-3 rounded-tile border border-dashed border-line-dashed p-3">
        <div className="flex items-center gap-1.5 text-[12px] text-subtle">
          <Lock className="size-3.5" strokeWidth={1.75} /> Your sealed values
        </div>
        {local ? (
          <dl className="mt-1">
            <KV k="Max price" v={`${priceStr(BigInt(local.max_price))} USDC`} className="py-1.5" />
            <KV k="Max spend" v={`${usdcStr(BigInt(local.max_spend))} USDC`} className="py-1.5" />
          </dl>
        ) : (
          <p className="mt-1.5 text-[12.5px] text-muted">
            Your max price and max spend are not stored in this browser. They are sealed on-chain; only the enclave can
            read them.
          </p>
        )}
        <p className="mt-1.5 text-[11.5px] leading-snug text-subtle">Stored only in this browser. No server keeps your price.</p>
      </div>

      <div className="mt-3">
        <div className="text-[12px] text-subtle">Sealed bid on-chain</div>
        <div className="inset mt-1.5 px-3 py-2.5">
          <span className="cipher line-clamp-2">{bid.ciphertext}</span>
        </div>
        <div className="num mt-1 text-[11px] text-subtle">{b64Bytes(bid.ciphertext)} bytes</div>
      </div>

      {done && (
        <ButtonLink href={`/sale/${encodeURIComponent(sale.id)}/result`} size="sm" className="mt-4 w-full">
          {sale.status === "failed" ? "Claim your refund" : "See your fill"} <ArrowRight className="size-3.5" />
        </ButtonLink>
      )}
    </Panel>
  );
}
