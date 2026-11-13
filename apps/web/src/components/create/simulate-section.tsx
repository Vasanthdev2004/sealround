"use client";

import { memo, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { CREATOR_SEEDS, CREATOR_TABLE_DEMANDS, type CreatorLevel, type CreatorRules } from "@fairground/arena";
import { BURN_COLOR, BurnChart, burnPct, type BurnPoint } from "@/components/arena/burn-chart";
import { TipCard, TipRow } from "@/components/arena/chart-bits";
import { Tag } from "@/components/ui/badge";
import { Segmented } from "@/components/ui/field";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { priceStr, tokenStr, usdcStr } from "@/lib/format";
import { scrollToEl } from "@/lib/scroll";
import { Label, Note } from "./form-kit";
import type { Derived, Notice } from "./model";
import { simRules, useLaunchSim } from "./use-launch-sim";

type Crowd = "50" | "200" | "1000";
const CROWDS: { value: Crowd; label: string }[] = [
  { value: "50", label: "50" },
  { value: "200", label: "200" },
  { value: "1000", label: "1,000" },
];

const DOM_ID = "create-simulate";
const LINK =
  "inline-flex min-h-10 items-center rounded-sm text-small text-muted underline decoration-line-strong underline-offset-4 transition-colors hover:text-fg sm:min-h-8";

/** Share of `whole` as a 0 to 1 number. */
const shareOf = (part: bigint, whole: bigint) => (whole > 0n ? Number((part * 10_000n) / whole) / 10_000 : 0);
const pct = (v: number) => `${Math.round(v * 100)}%`;
const count = (v: number) => Math.round(v).toLocaleString("en-US");
const demandStr = (d: number) => `${Number(d.toFixed(2))}×`;

/**
 * Simulate this launch: the Bot Arena's crowd model bids into a sale with the
 * creator's own rules, from 0.5× to 4× demand, five crowds per level. Shows
 * what sells, what burns, whether the min raise is met and what bots make.
 */
export function SimulateSection({ derived }: { derived: Derived }) {
  const crowdId = useId();
  const [crowd, setCrowd] = useState<Crowd>("200");
  const rules = simRules(derived);
  const { result, stale } = useLaunchSim(rules, Number(crowd));
  const done = result && "levels" in result ? result : null;

  // A link to /create#create-simulate (the Arena page has one) lands before the
  // sections above have loaded and shifted this one down: go to it again once
  // the first result is on screen.
  const landed = useRef(false);
  const ready = done !== null;
  useEffect(() => {
    if (!ready || landed.current) return;
    landed.current = true;
    if (window.location.hash === `#${DOM_ID}`) scrollToEl(document.getElementById(DOM_ID));
  }, [ready]);

  return (
    <section id={DOM_ID} aria-labelledby={`${DOM_ID}-h`} className="scroll-mt-[72px] border-t border-line pt-6">
      <header className="mb-5">
        <div className="flex items-baseline gap-3">
          <h2 id={`${DOM_ID}-h`} className="min-w-0 flex-1 text-h2 text-fg">
            Simulate this launch
          </h2>
          <Tag className="shrink-0">Simulation</Tag>
        </div>
        <p className="mt-1 max-w-[62ch] text-small text-muted">
          A crowd from the Bot Arena bids into a sale with your rules, from half to four times the demand that would buy
          every token at the floor. {CREATOR_SEEDS} crowds per level, each with 5 sniper bots that bid first.
        </p>
      </header>

      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <Label id={crowdId}>People in each crowd</Label>
          <Segmented<Crowd>
            labelledBy={crowdId}
            value={crowd}
            onChange={setCrowd}
            options={CROWDS}
            className="self-start"
          />
        </div>

        {!rules && (
          <p className="text-small text-muted">
            Fill in the sale supply, the floor price, the min raise and the deposit limits to{" "}
            {done ? "update it" : "run it"}.
          </p>
        )}
        {result && "error" in result && !stale ? (
          <Note tone="bad">These numbers are outside what the simulator can run: {result.error}</Note>
        ) : done ? (
          <Results levels={done.levels} rules={done.input.rules} humans={done.input.humans} stale={stale} />
        ) : rules ? (
          <Loading />
        ) : null}

        <p className="max-w-[68ch] text-small text-muted">
          A model, not a forecast: real people value and bid differently. It uses the Bot Arena&apos;s assumptions about
          valuations, budgets and bots; nobody splits a bid across accounts. Trading after the sale runs in your launch
          pool, or without one in the Arena&apos;s pool.{" "}
          <Link href="/arena#arena-method" className={LINK}>
            Arena method and assumptions
          </Link>
        </p>
      </div>
    </section>
  );
}

function Loading() {
  return (
    <div className="panel overflow-hidden" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">Running the simulation</span>
      <div className="flex flex-col gap-3 p-4 sm:p-5">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="mt-2 h-[240px] w-full" rounded="tile" />
      </div>
    </div>
  );
}

/**
 * The finished sweep. Memoized: its props change only when a sweep lands or
 * goes stale, so typing elsewhere in the form does not redraw the chart.
 */
const Results = memo(function Results({
  levels,
  rules,
  humans,
  stale,
}: {
  levels: CreatorLevel[];
  rules: CreatorRules;
  humans: number;
  stale: boolean;
}) {
  const n = levels[0]?.runs.length ?? CREATOR_SEEDS;
  const raiseAtFloor = (rules.supply * rules.floor) / 10n ** BigInt(rules.decimals);
  const points: BurnPoint[] = levels.map((l) => ({
    demand: l.demand,
    line: shareOf(l.burned, rules.supply),
    runs: l.runs.map((r) => shareOf(r.burned, rules.supply)),
  }));
  const table = levels.filter((l) => CREATOR_TABLE_DEMANDS.includes(l.demand));
  const fade = cn("transition-opacity duration-150", stale && "opacity-60");

  return (
    <div className={cn("flex flex-col gap-5", fade)} aria-busy={stale}>
      <div className="flex flex-col gap-2">
        {findings(levels, rules, raiseAtFloor, n).map((f) => (
          <Note key={f.id} tone={f.tone}>
            {f.text}
          </Note>
        ))}
      </div>

      <div className="panel overflow-hidden">
        <div className="p-4 sm:p-5">
          <h3 className="text-h3 text-fg">Supply burned as demand changes</h3>
          <p className="mt-0.5 max-w-[62ch] text-small text-muted">
            Tokens nobody buys are burned when you are paid, so the supply follows demand.
          </p>
          <div className="mt-4">
            <BurnChart
              data={points}
              height={240}
              animate={false}
              lineLabel={`Mean of ${n} crowds`}
              runLabel="One crowd"
              xLabel="Demand: the crowd's total budget ÷ (sale supply × floor price)"
              ariaLabel={`Share of the sale supply burned against demand, ${levels.length} levels from ${demandStr(levels[0].demand)} to ${demandStr(levels[levels.length - 1].demand)}. The tables below list the numbers.`}
              tip={(i) => <LevelTip level={levels[i]} supply={rules.supply} n={n} />}
            />
          </div>
        </div>

        <SummaryTable levels={table} rules={rules} n={n} humans={humans} />

        <details className="group border-t border-line">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 px-4 text-small text-muted transition-colors select-none hover:text-fg sm:px-5 [&::-webkit-details-marker]:hidden">
            All {levels.length} levels as a table
            <ChevronDown
              className="size-4 text-subtle transition-transform duration-200 group-open:rotate-180"
              strokeWidth={1.75}
              aria-hidden
            />
          </summary>
          <div className="max-h-80 overflow-auto border-t border-line">
            <table className="data-table min-w-[480px] [&_td]:h-9">
              <caption className="sr-only">Every simulated demand level</caption>
              <thead>
                <tr className="[&>th]:sticky [&>th]:top-0 [&>th]:border-b-0 [&>th]:bg-elev [&>th]:shadow-[inset_0_-1px_0_var(--line)]">
                  <th scope="col" className="pl-4 sm:pl-5">
                    Demand
                  </th>
                  <th scope="col" className="text-right">
                    Min raise met
                  </th>
                  <th scope="col" className="text-right">
                    Clearing price
                  </th>
                  <th scope="col" className="pr-4 text-right sm:pr-5">
                    Burned
                  </th>
                </tr>
              </thead>
              <tbody>
                {levels.map((l) => (
                  <tr key={l.demand}>
                    <td className="num pl-4 text-muted sm:pl-5">{demandStr(l.demand)}</td>
                    <td className="num text-right text-fg">
                      {l.settled} of {n}
                    </td>
                    <td className="num text-right text-fg">
                      {l.clearingPrice === null ? "Fails" : priceStr(l.clearingPrice)}
                      {l.clearingPrice !== null && <span className="ml-1 text-label text-subtle">USDC</span>}
                    </td>
                    <td className="num pr-4 text-right text-fg sm:pr-5">
                      {tokenStr(l.burned)}
                      <span className="ml-1 text-label text-subtle">{burnPct(shareOf(l.burned, rules.supply))}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </div>
    </div>
  );
});

function LevelTip({ level: l, supply, n }: { level: CreatorLevel; supply: bigint; n: number }) {
  return (
    <TipCard
      title={
        <>
          Demand <span className="num">{demandStr(l.demand)}</span>, mean of <span className="num">{n}</span> crowds
        </>
      }
    >
      <TipRow
        color={BURN_COLOR}
        label="Burned"
        value={`${tokenStr(l.burned)} (${burnPct(shareOf(l.burned, supply))})`}
      />
      <TipRow
        color={BURN_COLOR}
        label="Clearing price"
        value={l.clearingPrice === null ? "Fails" : `${priceStr(l.clearingPrice)} USDC`}
      />
      <TipRow color={BURN_COLOR} label="Min raise met" value={`${l.settled} of ${n}`} />
    </TipCard>
  );
}

type Row = { label: React.ReactNode; cell: (l: CreatorLevel) => React.ReactNode };

/** The four headline levels, one column each; one row per measure. */
function SummaryTable({
  levels,
  rules,
  n,
  humans,
}: {
  levels: CreatorLevel[];
  rules: CreatorRules;
  n: number;
  humans: number;
}) {
  const pool = rules.pool !== null;
  const rows: Row[] = [
    {
      label: "Min raise met",
      cell: (l) => <Outcome settled={l.settled} n={n} />,
    },
    {
      label: <Unit unit="USDC">Clearing price</Unit>,
      cell: (l) => (l.clearingPrice === null ? "–" : priceStr(l.clearingPrice)),
    },
    { label: <Unit unit="USDC">Raise</Unit>, cell: (l) => usdcStr(l.raised, 2) },
    { label: "Tokens sold", cell: (l) => tokenStr(l.sold) },
    {
      label: "Burned",
      cell: (l) => (
        <>
          {tokenStr(l.burned)}
          <span className="ml-1 text-label text-subtle">{burnPct(shareOf(l.burned, rules.supply))}</span>
        </>
      ),
    },
    ...(pool ? [{ label: "Pool reserve burned", cell: (l: CreatorLevel) => tokenStr(l.reserveBurned) }] : []),
    { label: "Bids filled", cell: (l) => pct(l.filledShare) },
    {
      label: "Bids taken",
      cell: (l) => (
        <>
          {count(l.bids)}
          <span className="ml-1 text-label text-subtle">of {count(l.wanted)}</span>
        </>
      ),
    },
    { label: <Unit unit="USDC">Bot profit</Unit>, cell: (l) => usdcStr(BigInt(Math.round(l.botProfit * 1e6)), 2) },
    ...(pool
      ? [
          {
            label: <Unit unit="USDC">Pool opens at</Unit>,
            cell: (l: CreatorLevel) => (l.poolPrice === null ? "–" : priceStr(l.poolPrice)),
          },
        ]
      : []),
  ];

  return (
    <>
      <PhoneLevels levels={levels} rows={rows} />
      <div className="overflow-x-auto border-t border-line max-sm:hidden">
        <table className="data-table min-w-[540px] [&_td]:h-10">
          <caption className="sr-only">
            Mean of {n} crowds of {humans.toLocaleString("en-US")} people and 5 bots at four demand levels
          </caption>
          <thead>
            <tr>
              <th scope="col" className="sticky left-0 z-[1] bg-elev pl-4 sm:pl-5">
                Demand
              </th>
              {levels.map((l) => (
                <th key={l.demand} scope="col" className="num text-right last:pr-4 sm:last:pr-5">
                  {demandStr(l.demand)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <th scope="row" className="sticky left-0 z-[1] bg-elev pl-4 text-small font-normal text-muted sm:pl-5">
                  {r.label}
                </th>
                {levels.map((l) => (
                  <td key={l.demand} className="num text-right whitespace-nowrap text-fg last:pr-4 sm:last:pr-5">
                    {r.cell(l)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** Phones: the four columns do not fit, so pick one demand level and read its numbers as a list. */
function PhoneLevels({ levels, rows }: { levels: CreatorLevel[]; rows: Row[] }) {
  const id = useId();
  const [pick, setPick] = useState("1");
  const level = levels.find((l) => String(l.demand) === pick) ?? levels[0];
  if (!level) return null;
  return (
    <div className="border-t border-line px-4 pt-4 sm:hidden">
      <div className="flex items-center justify-between gap-3">
        <span id={id} className="text-label font-[510] text-muted">
          Demand
        </span>
        <Segmented
          labelledBy={id}
          value={String(level.demand)}
          onChange={setPick}
          options={levels.map((l) => ({ value: String(l.demand), label: demandStr(l.demand) }))}
        />
      </div>
      <dl className="mt-2 divide-y divide-line">
        {rows.map((r, i) => (
          <div key={i} className="flex min-h-10 items-center justify-between gap-4 py-2">
            <dt className="text-small text-muted">{r.label}</dt>
            <dd className="num text-right text-small whitespace-nowrap text-fg">{r.cell(level)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** A row label with its unit, quieter. */
function Unit({ unit, children }: { unit: string; children: React.ReactNode }) {
  return (
    <>
      {children}
      <span className="ml-1 text-label text-subtle">{unit}</span>
    </>
  );
}

/** "Yes", "No" or "3 of 5", with a state dot. */
function Outcome({ settled, n }: { settled: number; n: number }) {
  const tone = settled === n ? "bg-ok" : settled === 0 ? "bg-bad" : "bg-warn";
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className={cn("size-1.5 rounded-full", tone)} />
      {settled === n ? "Yes" : settled === 0 ? "No" : `${settled} of ${n}`}
    </span>
  );
}

type Finding = { id: string; tone: Notice["tone"]; text: React.ReactNode };

/** The few things the sweep says about these rules, in plain words. */
function findings(levels: CreatorLevel[], rules: CreatorRules, raiseAtFloor: bigint | null, n: number): Finding[] {
  const out: Finding[] = [];
  const min = `${usdcStr(rules.minRaise, 6)} USDC`;
  const last = levels[levels.length - 1];
  const at1 = levels.find((l) => l.demand === 1) ?? levels[0];

  // 1. Does the sale succeed?
  if (rules.minRaise > 0n) {
    if (levels.every((l) => l.settled === 0)) {
      out.push({
        id: "fails",
        tone: "bad",
        text: `No crowd meets the ${min} min raise, even at ${demandStr(last.demand)} demand. The sale would fail and refund every bid.`,
      });
    } else if (levels.some((l) => l.settled < n)) {
      const from = levels.findIndex((l, i) => levels.slice(i).every((m) => m.settled === n));
      out.push({
        id: "fails-low",
        tone: "warn",
        text:
          from > 0
            ? `Below ${demandStr(levels[from].demand)} demand some or all crowds miss the ${min} min raise. A sale that misses it fails and refunds every bid.`
            : `Some crowds miss the ${min} min raise at every level up to ${demandStr(last.demand)}. A sale that misses it fails and refunds every bid.`,
      });
    } else {
      out.push({ id: "settles", tone: "neutral", text: `Every crowd meets the ${min} min raise.` });
    }
  }

  // 2. What sells and what burns.
  const soldOut = levels.find((l) => l.settled === n && l.runs.every((r) => r.burned === 0n));
  const capacity = BigInt(rules.maxBids) * rules.maxDeposit;
  if (soldOut) {
    const at1Text =
      at1.burned === 0n
        ? ""
        : at1.settled === 0
          ? ` At ${demandStr(at1.demand)} the sale fails, so the whole sale supply is burned.`
          : ` At ${demandStr(at1.demand)}, ${burnPct(shareOf(at1.burned, rules.supply))} of the sale supply is left over and burned.`;
    out.push({
      id: "sells-out",
      tone: "neutral",
      text: `Every token sells from ${demandStr(soldOut.demand)} demand.${at1Text}`,
    });
  } else if (last.settled > 0) {
    const limit =
      raiseAtFloor !== null && capacity < raiseAtFloor
        ? ` ${rules.maxBids} bids at the ${usdcStr(rules.maxDeposit, 6)} USDC cap bring at most ${usdcStr(capacity, 2)} USDC, less than the ${usdcStr(raiseAtFloor, 2)} USDC every token costs at the floor.`
        : "";
    out.push({
      id: "never-sells-out",
      tone: limit ? "warn" : "neutral",
      text: `Even at ${demandStr(last.demand)} demand, ${burnPct(shareOf(last.burned, rules.supply))} of the sale supply is left over and burned.${limit}`,
    });
  }

  // 3. Who could not bid.
  if (at1.slotsFull >= 0.5 || at1.belowMin >= 0.5) {
    const parts = [
      at1.slotsFull >= 0.5 ? `about ${count(at1.slotsFull)} find all ${rules.maxBids} bid slots taken` : null,
      at1.belowMin >= 0.5
        ? `about ${count(at1.belowMin)} have less than the ${usdcStr(rules.minDeposit, 6)} USDC minimum deposit`
        : null,
    ].filter(Boolean);
    out.push({
      id: "turned-away",
      tone: "neutral",
      text: `Of about ${count(at1.wanted)} people and bots who would bid at ${demandStr(at1.demand)} demand, ${parts.join(" and ")}.`,
    });
  }

  // 4. Bots.
  const most = levels.reduce((m, l) => (l.botProfit > m.botProfit ? l : m), levels[0]);
  out.push(
    most.botProfit < 0.01
      ? {
          id: "bots",
          tone: "neutral",
          text: "Bots pay the clearing price like everyone, and make nothing selling after the sale.",
        }
      : {
          id: "bots",
          tone: "neutral",
          text: `Bots pay the clearing price like everyone. After the sale they make up to ${usdcStr(BigInt(Math.round(most.botProfit * 1e6)), 2)} USDC (at ${demandStr(most.demand)} demand) selling to people the sale turned away or held to the deposit cap.`,
        },
  );

  return out;
}
