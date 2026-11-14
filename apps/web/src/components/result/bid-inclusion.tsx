"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import { localBidKey } from "@/components/sale/local-bid";
import { Tag } from "@/components/ui/badge";
import type { CheckState } from "@/components/ui/bits";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Panel } from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { checkBidSet, placeOf, type BidSetCheck } from "@/lib/bid-inclusion";
import { listBidSecrets, subscribeBidSecrets } from "@/lib/bid-secrets";
import { getClient } from "@/lib/client";
import { cn } from "@/lib/cn";
import { useBids } from "@/lib/hooks";
import type { BidRecord, Sale, SaleResult } from "@/lib/types";
import { notApplicable, notRun } from "@/lib/verify/checks";
import { factsFromApp } from "@/lib/verify/facts";
import type { ChainCheck } from "@/lib/verify/types";
import { checkYourBid, combineYourBid, type BidTerms } from "@/lib/verify/your-bid";
import { useWallet } from "@/lib/wallet";
import { Chain, Note } from "./evidence";

/**
 * The frozen bid set recomputed in this browser: every bid the contract
 * lists (get_bids, paged), hashed with the reference chain from
 * @fairground/clearing and compared with the hash the contract froze at
 * close (lib/bid-inclusion.ts). Null until the sale is closed.
 */
export function useBidSetCheck(sale: Sale): {
  check: BidSetCheck | null;
  state: CheckState;
  bids: BidRecord[];
  error: string | null;
  refetch: () => void;
} {
  const bids = useBids(sale.id);
  const closed = sale.bidSetHash !== null;
  const { check, malformed } = useMemo(() => {
    if (!closed || !bids.data) return { check: null, malformed: false };
    try {
      return { check: checkBidSet(sale.id, bids.data, sale.bidSetHash, sale.bidCount), malformed: false };
    } catch {
      return { check: null, malformed: true };
    }
  }, [closed, bids.data, sale.id, sale.bidSetHash, sale.bidCount]);
  const error = malformed ? "A bid has invalid data." : bids.error?.message ?? null;
  const state: CheckState = !closed ? "idle" : check ? (check.matches ? "pass" : "fail") : error ? "idle" : "pending";
  return { check, state, bids: bids.data ?? [], error, refetch: bids.refetch };
}

/** Accounts with a bid saved in this browser for the sale (the plaintext kept after bidding, or a commit-reveal secret), one per line. */
function savedBidders(saleId: string, scope: string): string {
  const out = new Set<string>();
  try {
    const prefix = localBidKey(saleId, "");
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(prefix)) out.add(k.slice(prefix.length));
    }
  } catch {
    // no storage: nothing saved
  }
  for (const s of listBidSecrets(scope)) if (s.saleId === saleId) out.add(s.bidder);
  return [...out].sort().join("\n");
}

function subscribeSaved(cb: () => void): () => void {
  window.addEventListener("storage", cb);
  const off = subscribeBidSecrets(cb);
  return () => {
    window.removeEventListener("storage", cb);
    off();
  };
}

/**
 * The bidders this browser knows as "yours": the connected account, bids
 * saved here, and bids this browser sent (NEAR: the transaction log; the
 * mock: the bids it tags as yours).
 */
function useMyBidders(sale: Sale, bids: BidRecord[]): { account: string | null; mine: string[] } {
  const { account } = useWallet();
  const client = getClient();
  const saved = useSyncExternalStore(
    subscribeSaved,
    () => savedBidders(sale.id, client.secretsScope),
    () => "",
  );
  const mine = useMemo(() => {
    const out = new Set<string>(saved ? saved.split("\n") : []);
    for (const b of bids) if (b.tag === "you" || (client.mode === "near" && b.txHash)) out.add(b.bidder);
    if (account) out.add(account);
    return [...out];
  }, [saved, bids, account, client.mode]);
  return { account, mine };
}

type SavedTerms = { bidder: string; maxPrice: string; maxSpend: string; commitment: string | null; source: string };

/**
 * The sealed terms this browser kept for bids in the sale: the plaintext saved
 * after a sealed bid (components/sale/local-bid.ts) and commit-reveal bid
 * secrets (lib/bid-secrets.ts). As one JSON string, so the snapshot compares
 * by value.
 */
function savedTerms(saleId: string, scope: string): string {
  const out = new Map<string, SavedTerms>();
  try {
    const prefix = localBidKey(saleId, "");
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(prefix)) continue;
      const j = JSON.parse(localStorage.getItem(k) ?? "null") as { max_price?: unknown; max_spend?: unknown } | null;
      if (typeof j?.max_price !== "string" || typeof j.max_spend !== "string") continue;
      const bidder = k.slice(prefix.length);
      out.set(bidder, { bidder, maxPrice: j.max_price, maxSpend: j.max_spend, commitment: null, source: "terms kept in this browser" });
    }
  } catch {
    // no storage, or a broken entry: nothing more saved
  }
  for (const s of listBidSecrets(scope)) {
    if (s.saleId !== saleId) continue;
    out.set(s.bidder, { bidder: s.bidder, maxPrice: s.maxPrice, maxSpend: s.maxSpend, commitment: s.commitment, source: "bid secret kept in this browser" });
  }
  return JSON.stringify([...out.values()].sort((a, b) => (a.bidder < b.bidder ? -1 : 1)));
}

function subscribeTerms(cb: () => void): () => void {
  window.addEventListener("fairground:mybid", cb);
  const off = subscribeSaved(cb);
  return () => {
    window.removeEventListener("fairground:mybid", cb);
    off();
  };
}

const DEC = /^d+$/;

/**
 * "Your bid got what the rule gives at this price", for every bid whose
 * sealed terms this browser kept (lib/verify/your-bid.ts). Null while the
 * bids are still loading.
 */
export function useYourBidCheck(
  sale: Sale,
  result: SaleResult,
  bids: BidRecord[] | null,
  bidsError: string | null,
): ChainCheck | null {
  const client = getClient();
  const raw = useSyncExternalStore(
    subscribeTerms,
    () => savedTerms(sale.id, client.secretsScope),
    () => "[]",
  );
  return useMemo(() => {
    const terms: BidTerms[] = (JSON.parse(raw) as SavedTerms[])
      .filter((t) => DEC.test(t.maxPrice) && DEC.test(t.maxSpend))
      .map((t) => ({
        saleId: sale.id,
        bidder: t.bidder,
        maxPrice: BigInt(t.maxPrice),
        maxSpend: BigInt(t.maxSpend),
        commitment: t.commitment,
        source: t.source,
      }));
    if (terms.length === 0) return notApplicable("your_bid", "This browser kept no sealed terms for a bid in this sale.");
    if (bidsError) return notRun("your_bid", `Not run: the bids could not be read (${bidsError}).`);
    if (!bids) return null;
    const facts = factsFromApp(client.secretsScope, sale, result, bids);
    return combineYourBid(terms.map((t) => checkYourBid(t, facts)));
  }, [raw, sale, result, bids, bidsError, client.secretsScope]);
}

/** The evidence under the inclusion check: the two hashes, your bid's place, and a lookup for any account. */
export function BidInclusionDetail({ sale, check, bids }: { sale: Sale; check: BidSetCheck; bids: BidRecord[] }) {
  const { account, mine } = useMyBidders(sale, bids);
  const [query, setQuery] = useState("");
  const [looked, setLooked] = useState<string | null>(null);
  const n = check.count;
  const placed = mine.map((a) => ({ account: a, place: placeOf(check, a) })).filter((m) => m.place !== null || m.account === account);
  const lookedPlace = looked ? placeOf(check, looked) : null;

  return (
    <div className="flex flex-col gap-2">
      <Chain
        values={[
          { label: "recomputed", value: check.recomputed },
          { label: "frozen at close", value: check.stored ?? "none" },
        ]}
        ok={check.matches}
      />
      <Note>
        {check.count === check.expectedCount ? (
          <>
            <span className="num">{n}</span> {n === 1 ? "bid" : "bids"} from get_bids, hashed in your browser with the
            same chain the contract and the enclave use.
          </>
        ) : (
          <>
            The contract lists <span className="num">{check.count}</span> bids but counts{" "}
            <span className="num">{check.expectedCount}</span>.
          </>
        )}
      </Note>
      {placed.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {placed.map((m) => (
            <li key={m.account} className="text-small text-fg">
              {m.place !== null ? (
                <>
                  Your bid{mine.length > 1 || m.account !== account ? <> from <span className="[overflow-wrap:anywhere]">{m.account}</span></> : null} is{" "}
                  <span className="num">#{m.place}</span> of <span className="num">{n}</span>
                  {check.matches ? "; the recomputed hash matches the frozen set." : ", but the set does not match its hash."}
                </>
              ) : (
                <span className="text-muted">
                  <span className="[overflow-wrap:anywhere]">{m.account}</span>
                  {check.matches ? " has no bid in this sale." : " was not found in the list. Inclusion could not be verified."}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <form
        className="mt-1 flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const a = query.trim().toLowerCase();
          setLooked(a || null);
        }}
      >
        <Field
          className="min-w-0 flex-1"
          label="Check any account"
          placeholder="alice.testnet"
          value={query}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Button type="submit" size="md" className="h-10">
          Check
        </Button>
      </form>
      <p className={cn("text-small", !looked && "sr-only", lookedPlace !== null ? "text-fg" : "text-muted")} role="status">
        {looked && <>
          <span className="[overflow-wrap:anywhere]">{looked}</span>
          {lookedPlace !== null ? (
            <>
              : bid <span className="num">#{lookedPlace}</span> of <span className="num">{n}</span>
              {check.matches ? ", counted." : " in the list. Inclusion could not be verified."}
            </>
          ) : (
            check.matches ? " has no bid in this sale." : " was not found in the list. Inclusion could not be verified."
          )}
        </>}
      </p>
    </div>
  );
}

/** The sale page's bid-set check, once the sale is closed. */
export function BidSetPanel({ sale }: { sale: Sale }) {
  const { check, state, bids, error } = useBidSetCheck(sale);
  const simulated = getClient().capabilities.simulated;
  if (sale.bidSetHash === null) return null;
  return (
    <Panel
      id="bid-set"
      title={
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          Bid set {simulated && <Tag>simulated</Tag>}
        </span>
      }
    >
      <div>
        <p role="status" className={cn("text-body", state === "fail" ? "text-bad" : "text-fg")}>
          {state === "pass"
            ? "The recomputed hash matches the frozen set."
            : state === "fail"
              ? "The recomputed hash does not match the frozen set."
              : error
                ? `Could not verify the bid set: ${error}`
                : "Recomputing the bid-set hash."}
        </p>
        <div className="mt-2">
          {check ? (
            <BidInclusionDetail sale={sale} check={check} bids={bids} />
          ) : (
            !error && (
              <div className="space-y-1.5">
                <Skeleton className="h-3 w-full" rounded="sm" />
                <Skeleton className="h-3 w-2/3" rounded="sm" />
              </div>
            )
          )}
        </div>
      </div>
    </Panel>
  );
}
