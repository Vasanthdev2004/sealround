"use client";

import type { PriceTrace, TracePoint } from "@fairground/arena";
import { CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { LegendItem, TipCard, TipRow } from "./chart-bits";
import { BOT_COLOR, CHART, LAUNCH_COLOR, fmtPrice, fmtSeconds } from "./data";

const TIME_TICKS = [0, 60, 300, 900, 1800];

type Row = TracePoint & { end?: boolean };

/**
 * One run: the bonding-curve price over time (bots buy at second 0, marked)
 * against Fairground's single clearing price and the fixed-price sale.
 * Time uses a square-root scale so the first seconds are readable.
 */
export function PriceChart({ trace }: { trace: PriceTrace }) {
  const end = trace.curveSoldOutAt ?? trace.windowSeconds;
  const last = trace.curve[trace.curve.length - 1];
  // Extend the step line to the end of the launch so it reads as "price stayed here".
  const data: Row[] = last && last.t < end ? [...trace.curve, { ...last, t: end, end: true }] : trace.curve;
  const fixedEnd = trace.fixedSoldOutAt ?? trace.windowSeconds;
  const ticks = TIME_TICKS.filter((t) => t <= trace.windowSeconds);

  return (
    <div>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        <LegendItem color={LAUNCH_COLOR.bonding_curve} label="Bonding curve price" />
        <LegendItem color={BOT_COLOR} mark="dot" label="Bot buys at second 0" />
        <LegendItem color={LAUNCH_COLOR.fixed_price} label="Fixed price, until sold out" />
        <LegendItem color={LAUNCH_COLOR.fairground} label="Fairground clearing price, the same for everyone" />
      </div>

      <div
        className="mt-3 h-[320px] w-full"
        role="img"
        aria-label={`Bonding-curve price from ${fmtPrice(trace.curve[0]?.price ?? 0)} to ${fmtPrice(last?.price ?? 0)} USDC per token. Fairground clearing price ${fmtPrice(trace.clearingPrice)} for every buyer.`}
      >
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 640, height: 320 }}>
          <ComposedChart data={data} margin={{ top: 10, right: 14, bottom: 4, left: 0 }}>
            <CartesianGrid vertical={false} stroke={CHART.grid} />
            <XAxis
              dataKey="t"
              type="number"
              scale="sqrt"
              domain={[0, trace.windowSeconds]}
              ticks={ticks}
              tickFormatter={(v: number) => fmtSeconds(v)}
              tick={{ fill: CHART.tick, fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: CHART.axis }}
              tickMargin={8}
              padding={{ left: 10, right: 4 }}
            />
            <YAxis
              width={50}
              domain={[0, "auto"]}
              tickFormatter={(v: number) => fmtPrice(v)}
              tick={{ fill: CHART.tick, fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              tickMargin={6}
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
            <ReferenceLine y={trace.clearingPrice} stroke={LAUNCH_COLOR.fairground} strokeWidth={2} ifOverflow="extendDomain" />
            <Tooltip
              cursor={{ stroke: CHART.axis, strokeWidth: 1 }}
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
              isAnimationActive={false}
              activeDot={{ r: 4, fill: LAUNCH_COLOR.bonding_curve, stroke: CHART.surface, strokeWidth: 2 }}
              dot={(props) => {
                const p = props.payload as Row;
                if (p.actor !== "bot") return <g key={`d-${props.index}`} />;
                return (
                  <circle
                    key={`d-${props.index}`}
                    cx={props.cx}
                    cy={props.cy}
                    r={4.5}
                    fill={BOT_COLOR}
                    stroke={CHART.surface}
                    strokeWidth={2}
                  />
                );
              }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-1 text-center text-[11.5px] text-subtle">
        Time after launch (square-root scale) · price in USDC per token
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
      <TipRow color={LAUNCH_COLOR.bonding_curve} value={fmtPrice(point.price)} label="curve price" />
      <TipRow color={LAUNCH_COLOR.fairground} value={fmtPrice(trace.clearingPrice)} label="Fairground, everyone" />
      <div className="mt-1 max-w-[240px] text-[12px] leading-snug text-muted">
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
