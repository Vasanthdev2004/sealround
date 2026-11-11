import type { Sale, SaleStatus } from "@/lib/types";

export type SaleFilter = "all" | "live" | "upcoming" | "ready" | "clearing" | "settled" | "refunding";

export const FILTERS: { value: SaleFilter; label: string; statuses: SaleStatus[] | null }[] = [
  { value: "all", label: "All", statuses: null },
  { value: "live", label: "Live", statuses: ["open"] },
  { value: "upcoming", label: "Upcoming", statuses: ["upcoming"] },
  { value: "ready", label: "Ready to close", statuses: ["awaiting_close"] },
  { value: "clearing", label: "Clearing", statuses: ["clearing", "revealing"] },
  { value: "settled", label: "Settled", statuses: ["settled"] },
  { value: "refunding", label: "Refunding", statuses: ["failed"] },
];

export function matchesFilter(filter: SaleFilter, status: SaleStatus): boolean {
  const f = FILTERS.find((x) => x.value === filter);
  return !f?.statuses || f.statuses.includes(status);
}

/** Copy for an empty filter. */
export const EMPTY_COPY: Record<SaleFilter, { title: string; body: string }> = {
  all: {
    title: "No sales yet",
    body: "Launch the first one, or run judge mode to watch a full sale from bids to claims.",
  },
  live: {
    title: "No sale is taking bids right now",
    body: "Upcoming sales open on their own schedule. Judge mode starts one right away.",
  },
  upcoming: {
    title: "Nothing scheduled",
    body: "New sales show up here before their window opens, with their rules already locked.",
  },
  ready: {
    title: "No sale is waiting to close",
    body: "When a bid window ends, anyone can close the sale. It waits here until someone does.",
  },
  clearing: {
    title: "Nothing is clearing",
    body: "Closed sales wait here while the enclave computes the clearing price.",
  },
  settled: {
    title: "No settled sales yet",
    body: "Settled sales show their clearing price, every fill and every refund.",
  },
  refunding: {
    title: "No sales are refunding",
    body: "A sale lands here if it misses its minimum raise or the enclave times out. Every bidder can then claim their deposit back.",
  },
};

const ORDER: Record<SaleStatus, number> = {
  open: 0,
  awaiting_close: 1,
  clearing: 2,
  revealing: 2,
  upcoming: 3,
  settled: 4,
  failed: 5,
};

/** Live first, then ready to close, clearing, upcoming, settled, refunding. */
export function sortSales(sales: Sale[]): Sale[] {
  const key = (s: Sale): number => {
    switch (s.status) {
      case "open":
        return s.config.bidEnd; // closing soonest first
      case "upcoming":
        return s.config.bidStart; // opening soonest first
      case "awaiting_close":
        return -s.config.bidEnd;
      case "clearing":
      case "revealing":
        return -(s.closedAt ?? s.config.bidEnd);
      default:
        return -(s.settledAt ?? s.refundModeAt ?? s.closedAt ?? s.config.bidEnd);
    }
  };
  return [...sales].sort((a, b) => ORDER[a.status] - ORDER[b.status] || key(a) - key(b));
}
