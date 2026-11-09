"use client";

import { demandAt } from "@fairground/clearing";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from "recharts";

type Pt = { x: number; y: number };
type CurveBid = { maxPrice: bigint; maxSpend: bigint };

// Chart-only colours (SVG attributes cannot read Tailwind classes).
const INK = "#fafafa";
const MUTED = "#a8a8ad";
const SUBTLE = "#85858c";
const ACCENT = "#2b85ff";
const SURFACE = "#17171a";

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

const priceTick = (v: number) => v.toLocaleString("en-US", { maximumSignificantDigits: 3 });
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

function Tip({ active, payload }: TooltipContentProps) {
  const pt = payload?.[0]?.payload as Pt | undefined;
  if (!active || !pt) return null;
  return (
    <div className="rounded-tile border border-line-strong bg-elev-2 px-3 py-2 text-[12px] shadow-xl shadow-black/50">
      <div className="text-subtle">
        At <span className="num text-fg">{pt.x.toLocaleString("en-US", { maximumFractionDigits: 6 })}</span> USDC
        per token
      </div>
      <div className="mt-0.5 text-subtle">
        bids could buy{" "}
        <span className="num text-fg">{pt.y.toLocaleString("en-US", { maximumFractionDigits: 0 })}</span> tokens
      </div>
    </div>
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

  return (
    <div
      role="img"
      aria-label={`Demand curve. Supply is ${s.toLocaleString("en-US")} tokens. Demand meets supply at a clearing price of ${pStar} USDC per token.`}
    >
      <ResponsiveContainer width="100%" height={250} initialDimension={{ width: 640, height: 250 }}>
        <LineChart data={points} margin={{ top: 22, right: 18, bottom: 4, left: 0 }}>
          <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.05)" />
          <XAxis
            dataKey="x"
            type="number"
            scale="log"
            domain={[usd(floor), usd(hi)]}
            allowDataOverflow
            ticks={ticks}
            tickFormatter={priceTick}
            tick={{ fill: SUBTLE, fontSize: 11, fontFamily: "var(--font-mono)" }}
            tickLine={false}
            axisLine={{ stroke: "rgba(255,255,255,0.12)" }}
          />
          <YAxis
            type="number"
            domain={[0, Math.ceil(top * 1.12)]}
            tickFormatter={(v: number) => compact.format(v)}
            tick={{ fill: SUBTLE, fontSize: 11, fontFamily: "var(--font-mono)" }}
            tickLine={false}
            axisLine={false}
            width={44}
          />
          <Tooltip
            content={Tip}
            cursor={{ stroke: "rgba(255,255,255,0.2)", strokeWidth: 1 }}
            isAnimationActive={false}
          />
          <ReferenceLine
            y={s}
            stroke="rgba(255,255,255,0.32)"
            strokeDasharray="4 4"
            label={{ value: "supply S", position: "insideTopRight", fill: MUTED, fontSize: 11 }}
          />
          <ReferenceLine
            x={pStar}
            stroke={ACCENT}
            strokeWidth={1.5}
            label={{ value: "P*", position: "top", fill: ACCENT, fontSize: 11 }}
          />
          <Line
            type="linear"
            dataKey="y"
            stroke={INK}
            strokeOpacity={0.85}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, fill: INK, stroke: SURFACE, strokeWidth: 2 }}
            isAnimationActive={false}
          />
          <ReferenceDot x={pStar} y={s} r={4.5} fill={ACCENT} stroke={SURFACE} strokeWidth={2} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
