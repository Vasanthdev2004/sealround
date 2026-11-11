"use client";

import { Tag } from "@/components/ui/badge";
import { CheckRow } from "@/components/ui/bits";
import { ButtonLink } from "@/components/ui/button";
import { SectionHeader } from "@/components/ui/panel";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton";
import { CipherChip } from "@/components/visual/cipher-chip";
import { LineDot, PriceLine } from "@/components/visual/price-line";
import { effectiveFills, type ResultFill } from "@/components/result/compute";
import { cn } from "@/lib/cn";
import { duration, priceStr, shortAccount, tokenStr, usdcStr } from "@/lib/format";
import { useBids, useResult, useSale } from "@/lib/hooks";
import type { BidRecord } from "@/lib/types";

/** The seeded, settled sale this section replays. It has 3 sniper bots and a copycat. */
const SALE_ID = "lantern";

/** One grid for the header, every row and the skeleton, so the columns cannot drift. */
const COLUMNS =
  "grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 px-4 sm:px-5 lg:grid-cols-[76px_minmax(0,1.7fr)_150px_104px_minmax(0,0.8fr)] lg:gap-x-5";

/** USDC paid per whole token by one fill, from its charge and tokens. */
function paidPerToken(f: ResultFill, decimals: number): bigint | null {
  return f.tokens > 0n ? (f.spent * 10n ** BigInt(decimals)) / f.tokens : null;
}

type Moment = {
  at: number;
  bot: boolean;
  account: string;
  cipher: string;
  deposit: bigint;
  void?: boolean;
  what: React.ReactNode;
  result: React.ReactNode;
  note: React.ReactNode;
};

/**
 * A recorded run, replayed from this demo's seeded Lantern sale as a ledger: a
 * sniper bot at second 0, a copycat that is voided, and a person minutes
 * before the close, with what each paid per token.
 */
export function RecordedRun() {
  const sale = useSale(SALE_ID);
  const result = useResult(SALE_ID);
  const bids = useBids(SALE_ID);

  const loading = sale.loading || result.loading || bids.loading;
  const s = sale.data;
  const r = result.data;
  const list = bids.data;
  const settled = !loading && !!s && !!list && r?.status === "settled";

  return (
    <section aria-labelledby="arena-recorded-h" className="flex flex-col gap-4 sm:gap-5">
      <SectionHeader
        id="arena-recorded-h"
        title="Recorded run: Lantern"
        description="A settled sale on this demo's simulated chain, sealed and cleared by the real code. Deposits and times were public during the window. Max prices stayed sealed."
        action={
          settled ? (
            <ButtonLink href={`/sale/${SALE_ID}/result`} size="sm" className="max-sm:h-10">
              View full result
            </ButtonLink>
          ) : undefined
        }
      />
      {loading ? (
        <ReplaySkeleton />
      ) : settled ? (
        <Replay
          saleStart={s.config.bidStart}
          saleEnd={s.config.bidEnd}
          decimals={s.config.decimals}
          clearingPrice={r.clearingPrice}
          fills={effectiveFills(r)}
          bids={list}
        />
      ) : (
        <div className="panel flex flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-5">
          <p className="text-small text-muted">
            {sale.error || result.error || bids.error
              ? "Reading the demo data failed. Reload the page to try again."
              : "This browser no longer has the seeded Lantern sale. Judge mode runs a fresh one."}
          </p>
          <ButtonLink href="/judge" size="sm" className="max-sm:h-10">
            Open judge mode
          </ButtonLink>
        </div>
      )}
    </section>
  );
}

function LedgerHead() {
  return (
    <div className={cn(COLUMNS, "h-9 items-center border-b border-line text-label text-subtle max-lg:hidden")} aria-hidden>
      <span>Placed</span>
      <span>Bidder</span>
      <span>Sealed bid</span>
      <span className="text-right">Deposit</span>
      <span className="text-right">Paid per token</span>
    </div>
  );
}

/** One line of text as a bar, in a box the height of that line (21px for text-small, 18px for text-label). */
function SkeletonLine({ small, bar, className }: { small?: boolean; bar: string; className?: string }) {
  return (
    <div className={cn("flex items-center", small ? "h-[18px]" : "h-[21px]", className)}>
      <Skeleton className={cn(small ? "h-3" : "h-3.5", bar)} />
    </div>
  );
}

/** Same header, rows and footer as the replay, line for line, so nothing shifts when it lands. */
function ReplaySkeleton() {
  return (
    <LoadingRegion label="Loading the recorded run" className="panel overflow-hidden">
      <LedgerHead />
      {[0, 1, 2].map((i) => (
        <div key={i} className={cn(COLUMNS, "gap-y-2.5 border-b border-line py-3.5 lg:min-h-[76px] lg:items-start")}>
          <SkeletonLine small bar="w-10" className="max-lg:col-span-2 lg:pt-0.5" />
          <div className="min-w-0 max-lg:col-span-2 max-lg:-mt-1.5">
            <SkeletonLine bar="w-40" />
            <SkeletonLine bar="w-full max-w-sm" className="mt-0.5" />
            {/* The copycat's row, in the middle, runs to a second line. */}
            {i === 1 && <SkeletonLine bar="w-44" />}
          </div>
          <Skeleton className="h-6 w-32" />
          <SkeletonLine bar="w-16" className="justify-end self-center lg:self-start" />
          <div className="max-lg:col-span-2">
            <SkeletonLine bar="w-24" className="justify-end" />
            <SkeletonLine small bar="w-20" className="justify-end" />
          </div>
        </div>
      ))}
      <div className="px-4 py-4 sm:px-5">
        <Skeleton className="h-7" rounded="full" />
        <SkeletonLine bar="w-96 max-w-full" className="mt-3" />
      </div>
    </LoadingRegion>
  );
}

function Replay({
  saleStart,
  saleEnd,
  decimals,
  clearingPrice,
  fills,
  bids,
}: {
  saleStart: number;
  saleEnd: number;
  decimals: number;
  clearingPrice: bigint;
  fills: ResultFill[];
  bids: BidRecord[];
}) {
  const fillOf = (b: BidRecord) => fills.find((f) => f.bidder === b.bidder);
  const byTime = [...bids].sort((a, b) => a.placedAt - b.placedAt);
  const filled = (b: BidRecord) => (fillOf(b)?.tokens ?? 0n) > 0n;

  const bot = byTime.find((b) => b.tag === "bot" && filled(b));
  const person = [...byTime].reverse().find((b) => b.tag === "sim" && filled(b));
  const copyFill = fills.find((f) => f.invalidReason === "bidder_mismatch");
  const copy = copyFill ? bids.find((b) => b.bidder === copyFill.bidder) : undefined;
  const original = copy ? byTime.find((b) => b.ciphertext === copy.ciphertext && b.bidder !== copy.bidder) : undefined;

  const paid = (b: BidRecord): Pick<Moment, "result" | "note"> => {
    const f = fillOf(b);
    const p = f ? paidPerToken(f, decimals) : null;
    return {
      result: (
        <>
          {p === null ? "–" : priceStr(p)}
          <span className="ml-1 text-label font-normal text-subtle">USDC</span>
        </>
      ),
      note: <>{tokenStr(f?.tokens ?? 0n, decimals)} tokens</>,
    };
  };

  const moments: Moment[] = [];
  if (bot) {
    moments.push({
      at: bot.placedAt,
      bot: true,
      account: bot.bidder,
      cipher: bot.ciphertext,
      deposit: bot.deposit,
      what: "Bids as the window opens, with a huge max price to be sure of a fill.",
      ...paid(bot),
    });
  }
  if (copy && copyFill) {
    moments.push({
      at: copy.placedAt,
      bot: true,
      account: copy.bidder,
      cipher: copy.ciphertext,
      deposit: copy.deposit,
      void: true,
      what: (
        <>
          Copies the sealed bid of <span className="text-fg">{original ? shortAccount(original.bidder, 22) : "another bidder"}</span>{" "}
          byte for byte. It names another account, so it is void.
        </>
      ),
      result: <span className="text-bad">Void</span>,
      note: <>0 tokens, {usdcStr(copyFill.refund, 6)} USDC refunded</>,
    });
  }
  if (person) {
    moments.push({
      at: person.placedAt,
      bot: false,
      account: person.bidder,
      cipher: person.ciphertext,
      deposit: person.deposit,
      what: (
        <>
          Bids <span className="num">{duration(saleEnd - person.placedAt)}</span> before the close.
        </>
      ),
      ...paid(person),
    });
  }
  moments.sort((a, b) => a.at - b.at);

  const botPaid = bot ? paidPerToken(fillOf(bot)!, decimals) : null;
  const personPaid = person ? paidPerToken(fillOf(person)!, decimals) : null;
  const same = botPaid !== null && botPaid === personPaid;

  return (
    <div className="panel overflow-hidden">
      <LedgerHead />
      <ol>
        {moments.map((m) => (
          <li key={m.account} className={cn(COLUMNS, "gap-y-2.5 border-b border-line py-3.5 lg:min-h-[76px] lg:items-start")}>
            <span className="num text-label text-subtle max-lg:col-span-2 lg:pt-0.5">
              <span className="sr-only">Placed </span>+{m.at <= saleStart ? "0s" : duration(m.at - saleStart)}
            </span>
            <div className="min-w-0 max-lg:col-span-2 max-lg:-mt-1.5">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-small font-[510] text-fg">{shortAccount(m.account, 26)}</span>
                {m.bot && <Tag tone="bot">bot</Tag>}
              </div>
              <p className="mt-0.5 max-w-[60ch] text-small text-muted">{m.what}</p>
            </div>
            <div className="min-w-0">
              <CipherChip
                seed={m.account}
                text={m.cipher}
                chars={12}
                size="sm"
                tone={m.void ? "bad" : "neutral"}
                struck={m.void}
                label={m.void ? "void" : undefined}
                title="Sealed box ciphertext. Only the sale's enclave can open it."
              />
            </div>
            <div className="num self-center text-right text-small text-fg lg:self-start lg:pt-px">
              <span className="sr-only">Deposit </span>
              {usdcStr(m.deposit, 6)}
              <span className="ml-1 text-label text-subtle">USDC</span>
              <span className="text-label text-subtle lg:hidden"> deposit</span>
            </div>
            <div className="max-lg:col-span-2 lg:pt-px lg:text-right">
              <div className="flex items-baseline justify-between gap-3 lg:block">
                <span className="text-small text-subtle lg:sr-only">Paid per token</span>
                <span className="num text-small font-[510] text-fg">{m.result}</span>
              </div>
              <div className="num text-right text-label text-subtle">{m.note}</div>
            </div>
          </li>
        ))}
      </ol>

      <div className="px-4 py-4 sm:px-5">
        {same ? (
          <>
            <PriceLine label="Both paid" value={priceStr(clearingPrice)} unit="USDC">
              <LineDot kind="bot" index={0} />
              <LineDot index={1} />
            </PriceLine>
            <p className="mt-3 text-small text-muted">
              The bot at second 0 and the person near the close paid the same price. Bidding first and high bought
              the bot a fill, not a better price.
            </p>
          </>
        ) : (
          <CheckRow
            className="py-0"
            state={botPaid === null || personPaid === null ? "idle" : "fail"}
            label={
              botPaid === null || personPaid === null
                ? "Not enough filled bids to compare."
                : "The bot and the person paid different prices."
            }
          />
        )}
      </div>
    </div>
  );
}
