"use client";

import Link from "next/link";
import { report } from "@/components/arena/data";
import { cn } from "@/lib/cn";
import type { ResultFill } from "./compute";
import { scorecard, scoreRows, SIM_LAUNCHES, type Scorecard } from "./supply";

const SIM_NAME: Record<(typeof SIM_LAUNCHES)[number], string> = {
  fairground: "Sealround",
  bonding_curve: "Bonding curve",
  fixed_price: "First come",
};

/** The same names where three share a phone's width. */
const SIM_SHORT: Record<(typeof SIM_LAUNCHES)[number], string> = {
  fairground: "Sealround",
  bonding_curve: "Curve",
  fixed_price: "First come",
};

/**
 * Fair-launch scorecard: this sale's measures next to the Bot Arena's
 * simulated averages for a Sealround sale, a bonding curve and a first-come
 * fixed-price sale. Lower is better on every row. The simulations are labelled
 * as such, with their crowd, and so is what this sale's numbers count.
 */
export function FairScorecard({ fills, decimals, className }: { fills: ResultFill[]; decimals: number; className?: string }) {
  const card = scorecard(fills, decimals);
  const rows = scoreRows(card, report.summary);

  return (
    <div className={className}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-small font-[510] text-fg">Fair-launch scorecard</h3>
        <span className="text-label text-subtle">Lower is better on every row</span>
      </div>

      {/* Wide screens: one table. */}
      <div className="mt-2 max-sm:hidden">
        <table className="w-full text-left text-small">
          <caption className="sr-only">
            This sale against the Bot Arena&rsquo;s simulated launches. Lower is better on every row.
          </caption>
          <thead className="text-label text-subtle">
            <tr>
              <td className="h-7" />
              <td />
              <th scope="colgroup" colSpan={3} className="border-b border-line px-3 text-center font-normal">
                Simulated averages
              </th>
            </tr>
            <tr className="border-b border-line">
              <th scope="col" className="h-9 pr-3 font-normal">
                Measure
              </th>
              <th scope="col" className="px-3 text-right font-normal text-muted">
                This sale
              </th>
              {SIM_LAUNCHES.map((t) => (
                <th key={t} scope="col" className="px-3 text-right font-normal last:pr-0">
                  {SIM_NAME[t]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-line">
                <th scope="row" className="h-10 pr-3 font-normal text-muted">
                  {r.label}
                </th>
                <td className="num px-3 text-right font-[510] whitespace-nowrap text-fg">{r.sale}</td>
                {SIM_LAUNCHES.map((t) => (
                  <td key={t} className="num px-3 text-right whitespace-nowrap text-muted last:pr-0">
                    {r.sims ? r.sims[t] : <span title="The simulation does not measure this">–</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Phones: one block per measure, this sale first. */}
      <p className="mt-2 text-label text-subtle sm:hidden">This sale, then the Arena&rsquo;s simulated averages.</p>
      <dl className="mt-2 divide-y divide-line border-y border-line sm:hidden">
        {rows.map((r) => (
          <div key={r.id} className="py-3">
            <dt className="flex items-baseline justify-between gap-3 text-small">
              <span className="text-muted">{r.label}</span>
              <span className="num shrink-0 font-[510] text-fg">
                <span className="sr-only">This sale: </span>
                {r.sale}
              </span>
            </dt>
            {r.sims ? (
              <dd className="mt-1 grid grid-cols-3 gap-2 text-label">
                {SIM_LAUNCHES.map((t) => (
                  <span key={t} className="min-w-0">
                    <span className="block truncate text-subtle">
                      <span className="sr-only">Simulated </span>
                      {SIM_SHORT[t]}
                    </span>
                    <span className="num block text-muted">{r.sims?.[t]}</span>
                  </span>
                ))}
              </dd>
            ) : (
              <dd className="mt-1 text-label text-subtle">Not measured in the simulations.</dd>
            )}
          </div>
        ))}
      </dl>

      <ScoreNote card={card} className="mt-3" />
    </div>
  );
}

/** Says what each side counts, so unlike things are never compared silently. */
function ScoreNote({ card, className }: { card: Scorecard; className?: string }) {
  const r = report;
  return (
    <div className={cn("flex flex-col gap-1.5 text-label text-subtle", className)}>
      <p>
        This sale: <span className="num text-muted">{card.bids}</span> {card.bids === 1 ? "bid" : "bids"},{" "}
        <span className="num text-muted">{card.winners}</span> {card.winners === 1 ? "winner" : "winners"}
        {card.rolesKnown && (
          <>
            , <span className="num text-muted">{card.botBids}</span> bids from accounts the demo labels as bots
          </>
        )}
        . It counts the sale only. Bot profit is what bots would make reselling to people at the median price people
        paid; concentration is over what each winner bought.
      </p>
      {card.bounded && (
        <p>
          A real contract stores no roles, so the bot share is not known, and the price and profit rows are bounds that
          hold whoever the bots were: the highest price per token any winner paid over the lowest, and what reselling
          every token sold at that highest price would make.
        </p>
      )}
      <p>
        Simulated averages: <span className="num text-muted">{r.runs}</span> Bot Arena runs, each with{" "}
        <span className="num text-muted">{r.config.humans}</span> people and{" "}
        <span className="num text-muted">{r.config.bots}</span> sniper bots at{" "}
        <span className="num text-muted">
          {r.demandMin}× to {r.demandMax}×
        </span>{" "}
        demand. Their premium and bot profit include trading in a pool after launch, and their concentration counts
        final holdings. They do not measure the top 10 share.{" "}
        <Link href="/arena" className="text-muted underline decoration-line-strong underline-offset-2 hover:text-fg">
          Open the Bot Arena
        </Link>
      </p>
    </div>
  );
}
