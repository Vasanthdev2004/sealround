"use client";

import { Badge } from "@/components/ui/badge";
import { TxLink } from "@/components/ui/bits";
import { ButtonLink } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton";
import { KV } from "@/components/ui/stat";
import type { Tone } from "@/lib/format";
import { ago, dateTime, priceStr, usdcStr } from "@/lib/format";
import { useBidSecret, useNow } from "@/lib/hooks";
import type { BidRecord, Sale } from "@/lib/types";
import { ExportSecretButton, ImportSecrets } from "./bid-secret";
import { useLocalBid } from "./local-bid";

const b64Bytes = (s: string) => Math.floor((s.length * 3) / 4) - (s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0);

function bidStatus(sale: Sale, bid: BidRecord, now: number): { label: string; tone: Tone } {
  const commit = sale.config.revealMode === "commit_reveal";
  switch (sale.status) {
    case "upcoming":
    case "open":
      return { label: commit ? "Committed" : "Sealed", tone: "accent" };
    case "awaiting_close":
      return { label: "Waiting for close", tone: "warn" };
    case "clearing":
      return { label: "Being cleared", tone: "warn" };
    case "revealing":
      if (bid.revealed) return { label: "Revealed", tone: "ok" };
      // Past the reveal window nothing can be revealed any more: the bid is void.
      return sale.revealEnd != null && now >= sale.revealEnd
        ? { label: "Not revealed", tone: "bad" }
        : { label: "Reveal needed", tone: "warn" };
    case "settled":
      return bid.claimed ? { label: "Claimed", tone: "ok" } : { label: "Ready to claim", tone: "ok" };
    case "failed":
      return bid.claimed ? { label: "Refunded", tone: "neutral" } : { label: "Refund ready", tone: "bad" };
  }
}

/** Rows of the ledger: 41px each, divided by hairlines. */
const LEDGER = "divide-y divide-line px-5 [&>div]:py-2.5";

/**
 * The connected account's bid as a ledger: the public record (deposit, time,
 * transaction, the sealed payload) and the price remembered in this browser.
 */
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
  // Commit-reveal: the secret this browser needs to reveal the bid (null when it is not here).
  const secret = useBidSecret(sale.id, account);
  const commit = sale.config.revealMode === "commit_reveal";
  const now = useNow(5000);

  if (loading) {
    return (
      <Panel title="My bid" bodyClassName="p-0">
        <LoadingRegion label="Loading your bid" className={LEDGER}>
          {["w-16", "w-14", "w-24"].map((w) => (
            <div key={w} className="flex h-[41px] items-center justify-between">
              <Skeleton className="h-3 w-20" rounded="sm" />
              <Skeleton className={`h-3 ${w}`} rounded="sm" />
            </div>
          ))}
        </LoadingRegion>
      </Panel>
    );
  }

  if (!bid) {
    return (
      <Panel title="My bid">
        <p className="text-small text-muted">
          {sale.status === "open"
            ? "No bid from this account yet."
            : sale.status === "upcoming"
              ? "Bidding has not opened yet."
              : "This account did not bid in this sale."}
        </p>
      </Panel>
    );
  }

  const st = bidStatus(sale, bid, now);
  const done = sale.status === "settled" || sale.status === "failed";
  const terms = commit
    ? secret && { maxPrice: BigInt(secret.maxPrice), maxSpend: BigInt(secret.maxSpend) }
    : local && { maxPrice: BigInt(local.max_price), maxSpend: BigInt(local.max_spend) };

  return (
    <Panel
      title="My bid"
      bodyClassName="p-0"
      action={
        <Badge tone={st.tone} dot pulse={sale.status === "clearing"}>
          {st.label}
        </Badge>
      }
    >
      <dl className={LEDGER}>
        <KV k={done ? "Deposit" : "Deposit, locked"} v={`${usdcStr(bid.deposit)} USDC`} />
        <KV
          k="Placed"
          v={
            <span title={dateTime(bid.placedAt)} suppressHydrationWarning>
              {ago(bid.placedAt, Math.max(now, bid.placedAt))}
            </span>
          }
        />
        {bid.txHash && <KV k="Bid transaction" v={<TxLink hash={bid.txHash} />} />}
        {terms && (
          <>
            <KV k="Max price" v={`${priceStr(terms.maxPrice)} USDC`} />
            <KV k="Max spend" v={`${usdcStr(terms.maxSpend)} USDC`} />
          </>
        )}
      </dl>

      <div className="border-t border-line px-5 py-4">
        <p className="text-label text-subtle">
          {commit
            ? secret
              ? bid.revealed
                ? "Revealed on chain. The salt stays in this browser."
                : "Max price, max spend and salt are kept only in this browser. Without them the bid cannot be revealed, and an unrevealed bid is void and loses 1\u00a0% of its deposit."
              : "The max price, max spend and salt of this bid are not in this browser, so it cannot be revealed from here."
            : terms
              ? "Max price and max spend are stored only in this browser. No server keeps them."
              : "Your max price and max spend are not stored in this browser. They are sealed on chain, and only the enclave can read them."}
        </p>
        {commit && !bid.revealed && !done && (secret ? <ExportSecretButton account={account} className="mt-3 w-full" /> : <ImportSecrets className="mt-3" />)}

        <div className="mt-4 flex items-center justify-between gap-3 text-label text-subtle">
          <span>
            {commit ? "Commitment" : "Sealed bid"} on chain
          </span>
          <span className="num shrink-0">{b64Bytes(bid.ciphertext)} bytes</span>
        </div>
        <div className="inset mt-1.5 px-3 py-2.5">
          <span className="cipher line-clamp-2">{bid.ciphertext}</span>
        </div>

        {done && (
          <ButtonLink href={`/sale/${encodeURIComponent(sale.id)}/result`} className="mt-4 w-full max-sm:h-10">
            {sale.status === "failed" ? "Claim your refund" : "See your fill"}
          </ButtonLink>
        )}
      </div>
    </Panel>
  );
}
