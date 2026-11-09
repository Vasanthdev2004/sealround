"use client";

import { ArrowUpRight } from "lucide-react";
import { Tag } from "@/components/ui/badge";
import { CheckRow, SimulatedNote } from "@/components/ui/bits";
import { ButtonLink } from "@/components/ui/button";
import { Empty, Panel } from "@/components/ui/panel";
import { effectiveFills, type ResultFill } from "@/components/result/compute";
import { duration, priceStr, shortAccount, tokenStr, usdcStr } from "@/lib/format";
import { useBids, useResult, useSale } from "@/lib/hooks";
import type { BidRecord } from "@/lib/types";

/** The seeded, settled sale this panel replays. It has 3 sniper bots and a copycat. */
const SALE_ID = "lantern";

/** USDC paid per whole token by one fill, from its charge and tokens. */
function paidPerToken(f: ResultFill, decimals: number): bigint | null {
  return f.tokens > 0n ? (f.spent * 10n ** BigInt(decimals)) / f.tokens : null;
}

type Moment = {
  at: number;
  who: "bot" | "person";
  account: string;
  what: React.ReactNode;
  outcome: React.ReactNode;
  tone: "ok" | "bad";
};

/**
 * A recorded run, replayed from this demo's seeded Lantern sale: a sniper bot
 * at second 0, a person minutes before the close, both paying one clearing
 * price; a copycat voided; and what a watcher could read during the window.
 */
export function RecordedRun() {
  const sale = useSale(SALE_ID);
  const result = useResult(SALE_ID);
  const bids = useBids(SALE_ID);

  const action = (
    <ButtonLink href={`/sale/${SALE_ID}/result`} size="sm">
      Full result <ArrowUpRight className="size-3.5" strokeWidth={1.75} />
    </ButtonLink>
  );

  const loading = sale.loading || result.loading || bids.loading;
  const s = sale.data;
  const r = result.data;
  const list = bids.data;

  let body: React.ReactNode;
  if (loading) {
    body = (
      <div className="space-y-2" aria-busy="true">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="shimmer h-12 rounded-lg bg-elev-2" />
        ))}
      </div>
    );
  } else if (!s || !r || !list || r.status !== "settled") {
    body = (
      <Empty
        title="The recorded run is not in this browser"
        body={
          sale.error || result.error || bids.error
            ? "Reading the demo data failed. Reload the page to try again."
            : "This replay reads the seeded Lantern sale, which this browser no longer has. Judge mode runs a fresh one."
        }
        action={
          <ButtonLink href="/judge" size="sm">
            Open judge mode
          </ButtonLink>
        }
      />
    );
  } else {
    body = (
      <Replay
        saleStart={s.config.bidStart}
        saleEnd={s.config.bidEnd}
        decimals={s.config.decimals}
        clearingPrice={r.clearingPrice}
        fills={effectiveFills(r)}
        bids={list}
      />
    );
  }

  return (
    <Panel
      title="Recorded run: Lantern"
      subtitle="A seeded sale from this demo, replayed. Who bid when, what a bot could see, and what each paid."
      action={action}
    >
      {body}
    </Panel>
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

  const paid = (b: BidRecord) => {
    const f = fillOf(b);
    const p = f ? paidPerToken(f, decimals) : null;
    return (
      <>
        Filled <span className="num">{tokenStr(f?.tokens ?? 0n, decimals)}</span> tokens at{" "}
        <span className="num text-fg">{p === null ? "–" : priceStr(p)}</span> USDC each
      </>
    );
  };

  const moments: Moment[] = [];
  if (bot) {
    moments.push({
      at: bot.placedAt,
      who: "bot",
      account: bot.bidder,
      what: "Bids the moment the window opens, with a huge max price to be sure of a fill.",
      outcome: paid(bot),
      tone: "ok",
    });
  }
  if (copy && copyFill) {
    moments.push({
      at: copy.placedAt,
      who: "bot",
      account: copy.bidder,
      what: (
        <>
          Copies the sealed bid of <span className="num">{original ? shortAccount(original.bidder, 22) : "another bidder"}</span>{" "}
          byte for byte and submits it as its own.
        </>
      ),
      outcome: (
        <>
          Void: the sealed bid names another account. <span className="num">{usdcStr(copyFill.refund, 6)}</span> USDC
          refunded, 0 tokens
        </>
      ),
      tone: "bad",
    });
  }
  if (person) {
    moments.push({
      at: person.placedAt,
      who: "person",
      account: person.bidder,
      what: (
        <>
          Bids <span className="num">{duration(saleEnd - person.placedAt)}</span> before the close.
        </>
      ),
      outcome: paid(person),
      tone: "ok",
    });
  }
  moments.sort((a, b) => a.at - b.at);

  const botPaid = bot ? paidPerToken(fillOf(bot)!, decimals) : null;
  const personPaid = person ? paidPerToken(fillOf(person)!, decimals) : null;
  const same = botPaid !== null && botPaid === personPaid;

  return (
    <div className="space-y-4">
      <ol>
        {moments.map((m) => (
          <li
            key={m.account}
            className="flex gap-3.5 border-b border-dashed border-line-dashed py-3 first:pt-0 last:border-b-0 last:pb-0"
          >
            <span className="num relative w-[56px] shrink-0 pt-px text-right text-[12px] text-subtle">
              +{m.at <= saleStart ? "0s" : duration(m.at - saleStart)}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="num truncate text-[13px] text-fg">{shortAccount(m.account, 24)}</span>
                {m.who === "bot" ? <Tag tone="bot">bot</Tag> : <Tag>person</Tag>}
              </div>
              <p className="mt-0.5 text-[12.5px] leading-snug text-muted">{m.what}</p>
              <p className={m.tone === "ok" ? "mt-1 text-[12.5px] text-ok" : "mt-1 text-[12.5px] text-bad"}>{m.outcome}</p>
            </div>
          </li>
        ))}
      </ol>

      {bot && (
        <div className="inset p-3.5">
          <div className="text-[12px] text-subtle">
            What any watcher could read about the bot&apos;s bid during the window
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-muted">
            <span>
              deposit <span className="num text-fg">{usdcStr(bot.deposit, 6)}</span> USDC
            </span>
            <span>
              placed <span className="num text-fg">+{duration(Math.max(0, bot.placedAt - saleStart))}</span>
            </span>
            <span>max price: sealed</span>
          </div>
          <p className="cipher mt-2 line-clamp-2" title="Sealed box ciphertext. Only the sale's enclave can open it.">
            {bot.ciphertext}
          </p>
        </div>
      )}

      <div className="border-t border-dashed border-line-dashed pt-1">
        <CheckRow
          state={same ? "pass" : botPaid === null || personPaid === null ? "idle" : "fail"}
          label={
            same ? (
              <>
                The bot at second 0 and the person near the close paid the same{" "}
                <span className="num">{priceStr(clearingPrice)}</span> USDC per token.
              </>
            ) : botPaid === null || personPaid === null ? (
              "Not enough filled bids to compare."
            ) : (
              "The bot and the person paid different prices."
            )
          }
          detail={same ? "Bidding first and high bought the bot a fill, not a better price." : undefined}
        />
      </div>
      <SimulatedNote>Recorded on this demo&apos;s simulated chain. Encryption and clearing are the real code.</SimulatedNote>
    </div>
  );
}
