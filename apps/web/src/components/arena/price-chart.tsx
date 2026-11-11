"use client";

import type { PriceTrace, TracePoint } from "@fairground/arena";
import { CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  CHART_CURSOR,
  CHART_GRID,
  CHART_SURFACE,
  CHART_TICK,
  Legend,
  LegendItem,
  PricePill,
  TipCard,
  TipRow,
  useSeriesMotion,
} from "./chart-bits";
import { BOT_COLOR, LAUNCH_COLOR, SERIES_MS, fmtPrice, fmtSeconds } from "./data";

const TIME_TICKS = [0, 60, 300, 900, 1800];

type Row = TracePoint & { end?: boolean };

/**
 * One run: the bonding-curve price over time (bots buy at second 0, marked)
 * against Sealround's single clearing price and the fixed-price sale.
 * Time uses a square-root scale so the first seconds are readable.
 */
export function PriceChart({ trace }: { trace: PriceTrace }) {
  const end = trace.curveSoldOutAt ?? trace.windowSeconds;
  const last = trace.curve[trace.curve.length - 1];
  // Extend the step line to the end of the launch so it reads as "price stayed here".
  const data: Row[] = last && last.t < end ? [...trace.curve, { ...last, t: end, end: true }] : trace.curve;
  const fixedEnd = trace.fixedSoldOutAt ?? trace.windowSeconds;
  const ticks = TIME_TICKS.filter((t) => t <= trace.windowSeconds);
  const animate = useSeriesMotion();

  return (
    <div>
      <Legend>
        <LegendItem color={LAUNCH_COLOR.fairground} mark="dash" label="Sealround clearing price" />
        <LegendItem color={LAUNCH_COLOR.bonding_curve} label="Bonding curve price" />
        <LegendItem color={LAUNCH_COLOR.fixed_price} label="Fixed price, until it sells out" />
        <LegendItem color={BOT_COLOR} label="Bot buys at second 0" />
      </Legend>

      <div
        className="mt-3 h-[320px] w-full"
        role="img"
        aria-label={`Bonding-curve price from ${fmtPrice(trace.curve[0]?.price ?? 0)} to ${fmtPrice(last?.price ?? 0)} USDC per token. Sealround clearing price ${fmtPrice(trace.clearingPrice)} for every buyer.`}
      >
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 640, height: 320 }}>
          <ComposedChart data={data} margin={{ top: 14, right: 14, bottom: 4, left: 0 }}>
            <CartesianGrid vertical={false} stroke={CHART_GRID} />
            <XAxis
              dataKey="t"
              type="number"
              scale="sqrt"
              domain={[0, trace.windowSeconds]}
              ticks={ticks}
              tickFormatter={(v: number) => fmtSeconds(v)}
              tick={CHART_TICK}
              tickLine={false}
              axisLine={false}
              tickMargin={10}
              padding={{ left: 10, right: 4 }}
            />
            <YAxis
              width={52}
              domain={[0, "auto"]}
              tickCount={5}
              tickFormatter={(v: number) => fmtPrice(v)}
              tick={CHART_TICK}
              tickLine={false}
              axisLine={false}
              tickMargin={8}
            />
            <ReferenceLine
              segment={[
                { x: 0, y: trace.launchPrice },
                { x: fixedEnd, y: trace.launchPrice },
              ]}
              stroke={LAUNCH_COLOR.fixed_price}
              strokeWidth={2}
              ifOverflow="extendDomain"
            />
            <Tooltip
              cursor={CHART_CURSOR}
              isAnimationActive={false}
              content={({ active, payload }) => (
                <PriceTip active={active} point={payload?.[0]?.payload as Row | undefined} trace={trace} />
              )}
            />
            <Line
              dataKey="price"
              type="stepAfter"
              stroke={LAUNCH_COLOR.bonding_curve}
              strokeWidth={2}
              strokeLinejoin="round"
              isAnimationActive={animate}
              animationDuration={SERIES_MS}
              animationEasing="ease-out"
              activeDot={{ r: 4, fill: LAUNCH_COLOR.bonding_curve, stroke: CHART_SURFACE, strokeWidth: 2 }}
              dot={(props) => {
                const p = props.payload as Row;
                if (p.actor !== "bot") return <g key={`d-${props.index}`} />;
                return (
                  <circle
                    key={`d-${props.index}`}
                    cx={props.cx}
                    cy={props.cy}
                    r={4}
                    fill={BOT_COLOR}
                    stroke={CHART_SURFACE}
                    strokeWidth={2}
                  />
                );
              }}
            />
            {/* Last, so the one price and its pill sit over the curve. */}
            <ReferenceLine
              y={trace.clearingPrice}
              stroke={LAUNCH_COLOR.fairground}
              strokeWidth={1.5}
              ifOverflow="extendDomain"
              label={<PricePill label="Everyone pays" text={fmtPrice(trace.clearingPrice)} />}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-1 text-center text-label text-subtle">
        Time after launch, square-root scale. Price in USDC per token.
      </div>
    </div>
  );
}

function PriceTip({ active, point, trace }: { active?: boolean; point?: Row; trace: PriceTrace }) {
  if (!active || !point) return null;
  const who =
    point.actor === "start"
      ? "Curve opens"
      : point.end
        ? "No more buyers"
        : point.actor === "bot"
          ? `${point.id} (bot) bought ${point.tokens.toLocaleString("en-US", { maximumFractionDigits: 0 })} tokens`
          : `${point.id} bought ${point.tokens.toLocaleString("en-US", { maximumFractionDigits: 0 })} tokens`;
  return (
    <TipCard title={<span className="num">{fmtSeconds(point.t)}</span>}>
      <TipRow color={LAUNCH_COLOR.fairground} value={fmtPrice(trace.clearingPrice)} label="Sealround, everyone" />
      <TipRow color={LAUNCH_COLOR.bonding_curve} value={fmtPrice(point.price)} label="Curve price" />
      <div className="mt-1 max-w-[240px] text-label text-muted">
        {who}
        {!point.end && point.usdc > 0 && (
          <>
            {" "}
            for <span className="num text-fg">{point.usdc.toLocaleString("en-US", { maximumFractionDigits: 2 })}</span> USDC
          </>
        )}
        {point.botsSold > 0 && (
          <>
            . Bots sold{" "}
            <span className="num text-fg">{point.botsSold.toLocaleString("en-US", { maximumFractionDigits: 0 })}</span>{" "}
            back right after.
          </>
        )}
      </div>
    </TipCard>
  );
}
