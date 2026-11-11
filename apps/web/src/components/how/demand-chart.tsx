"use client";

import { demandAt } from "@fairground/clearing";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from "recharts";
import {
  CHART_CURSOR,
  CHART_GRID,
  CHART_SURFACE,
  CHART_TICK,
  PricePill,
  TipCard,
  useSeriesMotion,
} from "@/components/visual/chart-bits";

type Pt = { x: number; y: number };
type CurveBid = { maxPrice: bigint; maxSpend: bigint };

// Series colours from the tokens: demand in the neutral "people" ink, the clearing price in blue.
const INK = "var(--viz-people)";
const ACCENT = "var(--viz-fairground)";

/** Whole tokens as a float. Display only. */
const whole = (v: bigint, decimals: number) => Number(v / 10n ** BigInt(Math.max(0, decimals - 6))) / 1e6;
/** USDC per token as a float. Display only. */
const usd = (p: bigint) => Number(p) / 1e6;

/**
 * Samples D(P) from the floor to a bit past the highest max price. Each max
 * price gets two points (at p and one base unit above), so the drops are vertical.
 */
export function demandCurve(bids: CurveBid[], floor: bigint, decimals: number): { points: Pt[]; hi: bigint } {
  const one = 10n ** BigInt(decimals);
  const valid = bids.map((b, i) => ({ i, maxPrice: b.maxPrice, maxSpend: b.maxSpend }));
  const top = valid.reduce((m, b) => (b.maxPrice > m ? b.maxPrice : m), floor);
  const hi = (top * 13n) / 10n > floor * 2n ? (top * 13n) / 10n : floor * 2n;

  const breaks = new Set<bigint>([floor, hi]);
  for (const b of valid) {
    if (b.maxPrice >= floor && b.maxPrice < hi) {
      breaks.add(b.maxPrice);
      breaks.add(b.maxPrice + 1n);
    }
  }
  const sorted = [...breaks].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const prices = new Set<bigint>();
  sorted.forEach((a, k) => {
    prices.add(a);
    const b = sorted[k + 1];
    if (b === undefined || b - a < 2n) return;
    // Geometric steps: the x axis is logarithmic.
    const steps = 14;
    const ratio = Number(b) / Number(a);
    for (let j = 1; j < steps; j++) {
      const p = BigInt(Math.round(Number(a) * ratio ** (j / steps)));
      if (p > a && p < b) prices.add(p);
    }
  });

  const points = [...prices]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((p) => ({ x: usd(p), y: whole(demandAt(valid, p, one), decimals) }));
  return { points, hi };
}

/** A zero-based axis that ends on a round number: 3 to 5 even steps, the smallest top that holds `target`. */
function niceAxis(target: number): { max: number; ticks: number[] } {
  if (!(target > 0)) return { max: 1, ticks: [0, 1] };
  let best = { max: Infinity, step: 1, n: 4 };
  for (const n of [3, 4, 5]) {
    const raw = target / n;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((m) => m * mag).find((x) => x >= raw)!;
    if (step * n < best.max) best = { max: step * n, step, n };
  }
  return { max: best.max, ticks: Array.from({ length: best.n + 1 }, (_, i) => i * best.step) };
}

const priceTick = (v: number) => v.toLocaleString("en-US", { maximumSignificantDigits: 3 });
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

function Tip({ active, payload }: TooltipContentProps) {
  const pt = payload?.[0]?.payload as Pt | undefined;
  if (!active || !pt) return null;
  return (
    <TipCard
      title={
        <>
          At <span className="num text-fg">{pt.x.toLocaleString("en-US", { maximumFractionDigits: 6 })}</span> USDC per
          token
        </>
      }
    >
      <div className="text-label text-muted">
        bids could buy <span className="num font-[510] text-fg">{pt.y.toLocaleString("en-US", { maximumFractionDigits: 0 })}</span>{" "}
        tokens
      </div>
    </TipCard>
  );
}

export function DemandChart({
  bids,
  floor,
  supply,
  clearingPrice,
  decimals,
}: {
  bids: CurveBid[];
  floor: bigint;
  supply: bigint;
  clearingPrice: bigint;
  decimals: number;
}) {
  const { points, hi } = demandCurve(bids, floor, decimals);
  const s = whole(supply, decimals);
  const pStar = usd(clearingPrice);
  const top = Math.max(s, ...points.map((p) => p.y));
  const maxBid = bids.reduce((m, b) => (b.maxPrice > m ? b.maxPrice : m), floor);
  const ticks = [...new Set([usd(floor), pStar, usd(maxBid)])].sort((a, b) => a - b);
  const animate = useSeriesMotion();
  const yAxis = niceAxis(top * 1.08);

  return (
    <div
      role="img"
      aria-label={`Demand curve. Supply is ${s.toLocaleString("en-US")} tokens. Demand meets supply at a clearing price of ${pStar} USDC per token.`}
    >
      <ResponsiveContainer width="100%" height={270} initialDimension={{ width: 640, height: 270 }}>
        <ComposedChart data={points} margin={{ top: 40, right: 18, bottom: 4, left: 0 }}>
          <CartesianGrid vertical={false} stroke={CHART_GRID} />
          <XAxis
            dataKey="x"
            type="number"
            scale="log"
            domain={[usd(floor), usd(hi)]}
            allowDataOverflow
            ticks={ticks}
            tickFormatter={priceTick}
            tick={CHART_TICK}
            tickLine={false}
            axisLine={false}
            tickMargin={10}
          />
          <YAxis
            type="number"
            domain={[0, yAxis.max]}
            ticks={yAxis.ticks}
            tickFormatter={(v: number) => compact.format(v)}
            tick={CHART_TICK}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            width={44}
          />
          <Tooltip content={Tip} cursor={CHART_CURSOR} isAnimationActive={false} />
          <ReferenceLine
            y={s}
            stroke="var(--line-strong)"
            label={<PricePill label="Supply" text={compact.format(s)} tone="neutral" />}
          />
          <Area
            type="linear"
            dataKey="y"
            stroke="none"
            fill={INK}
            fillOpacity={0.05}
            isAnimationActive={animate}
            animationDuration={450}
            animationEasing="ease-out"
            activeDot={false}
          />
          <Line
            type="linear"
            dataKey="y"
            stroke={INK}
            strokeWidth={1.75}
            dot={false}
            activeDot={{ r: 4, fill: INK, stroke: CHART_SURFACE, strokeWidth: 2 }}
            isAnimationActive={animate}
            animationDuration={450}
            animationEasing="ease-out"
          />
          <ReferenceLine
            x={pStar}
            stroke={ACCENT}
            strokeWidth={1.5}
            label={<PricePill label="P*" text={pStar.toLocaleString("en-US", { maximumFractionDigits: 6 })} at="top" />}
          />
          <ReferenceDot x={pStar} y={s} r={4} fill={ACCENT} stroke={CHART_SURFACE} strokeWidth={2} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
