"use client";

import { useMemo, useState } from "react";
import { useReducedMotion } from "motion/react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Rectangle,
  Tooltip,
  XAxis,
  YAxis,
  type BarShapeProps,
  type TooltipContentProps,
} from "recharts";
import { Panel } from "@/components/ui/panel";
import { TipCard, TipRow } from "@/components/visual/chart-bits";
import { shortAccount, tokenStr, usdcStr } from "@/lib/format";
import type { Sale } from "@/lib/types";
import { isBot, isYou, pct, pctStr, rolesKnown, toFloat, type ResultFill } from "./compute";
import { FairScorecard } from "./scorecard";

/*
 * Series colours are the viz tokens: people the neutral at half
 * strength, bots the violet, and "you" the accent with a direct label (accent
 * and violet are too close for protan readers to tell apart by colour alone).
 */
const COLOR = { person: "var(--viz-people)", bot: "var(--viz-bot)", you: "var(--viz-fairground)" } as const;
const OPACITY = { person: 0.5, bot: 1, you: 1 } as const;
/**
 * Legend words. "People" and "Bots" only where the fills carry demo labels
 * (rolesKnown); a real contract stores no roles, so there every other winner
 * is just a bidder.
 */
const NAME = { person: "People", bot: "Bots", you: "You" } as const;
const NAME_NO_ROLES = { ...NAME, person: "Bidders" } as const;
type Kind = keyof typeof COLOR;

type Datum = {
  key: string;
  bidder: string;
  tokens: number;
  label: string;
  spent: string;
  share: string;
  kind: Kind;
};

/**
 * Tokens received by each winner, largest first (the fills table above is its
 * text equivalent), then the fair-launch scorecard: this sale against the Bot
 * Arena's simulated launches.
 */
export function Distribution({ sale, fills, account }: { sale: Sale; fills: ResultFill[]; account: string | null }) {
  const c = sale.config;
  const reduce = useReducedMotion();
  // The bars grow once, on first paint. Later data (a claim, a wallet switch)
  // redraws them in place instead of replaying the animation.
  const [grown, setGrown] = useState(false);
  const winners = useMemo(() => fills.filter((f) => f.tokens > 0n), [fills]);

  const data = useMemo<Datum[]>(
    () =>
      [...winners]
        .sort((a, b) => (b.tokens > a.tokens ? 1 : b.tokens < a.tokens ? -1 : a.index - b.index))
        .map((f) => ({
          key: `${f.index}`,
          bidder: f.bidder,
          tokens: toFloat(f.tokens, c.decimals),
          label: tokenStr(f.tokens, c.decimals),
          spent: usdcStr(f.spent),
          share: pctStr(pct(f.tokens, c.saleSupply)),
          kind: isYou(f, account) ? "you" : isBot(f) ? "bot" : "person",
        })),
    [winners, account, c.decimals, c.saleSupply],
  );

  if (winners.length === 0) {
    return (
      <Panel title="Who got the tokens">
        <p className="text-small text-muted">Nobody. Nothing was sold in this sale, and deposits go back to the bidders.</p>
      </Panel>
    );
  }

  const kinds = new Set(data.map((d) => d.kind));
  const names = rolesKnown(fills) ? NAME : NAME_NO_ROLES;

  return (
    <Panel
      title="Who got the tokens"
      subtitle={`${winners.length} ${winners.length === 1 ? "winner" : "winners"}, largest fill first. A bigger bar is a bigger budget, never a better price; deposits were capped at ${usdcStr(c.maxDepositPerAccount)} USDC.`}
    >
      <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-label text-muted" aria-label="Legend">
        {(["person", "bot", "you"] as const)
          .filter((k) => kinds.has(k))
          .map((k) => (
            <li key={k} className="inline-flex items-center gap-1.5">
              <span
                className="size-1.5 rounded-full"
                style={{ background: COLOR[k], opacity: OPACITY[k] }}
                aria-hidden
              />
              {names[k]}
            </li>
          ))}
      </ul>

      <div
        className="mt-3 h-[240px] w-full"
        role="img"
        aria-label={`Bar chart of tokens received by ${winners.length} winners. The fills table lists every value.`}
      >
        <BarChart
          responsive
          data={data}
          margin={{ top: 18, right: 0, bottom: 0, left: 0 }}
          barCategoryGap={data.length > 40 ? 1 : "18%"}
          style={{ width: "100%", height: "100%" }}
        >
          <CartesianGrid vertical={false} stroke="var(--viz-grid)" />
          <XAxis dataKey="key" hide />
          <YAxis
            width={44}
            tickLine={false}
            axisLine={false}
            tickCount={4}
            tick={{ fill: "var(--viz-axis)", fontSize: 12 }}
            tickFormatter={(v: number) => compact(v)}
          />
          <Tooltip cursor={false} content={(p) => <Tip {...p} sym={c.tokenSymbol} />} isAnimationActive={false} />
          <Bar
            dataKey="tokens"
            maxBarSize={24}
            isAnimationActive={!reduce && !grown}
            animationDuration={450}
            animationEasing="ease-out"
            onAnimationEnd={() => setGrown(true)}
            shape={(p: BarShapeProps) => <BarShape {...p} />}
          />
        </BarChart>
      </div>

      <FairScorecard fills={fills} decimals={c.decimals} className="mt-5 border-t border-line pt-4" />
    </Panel>
  );
}

function BarShape(p: BarShapeProps) {
  const d = p.payload as Datum | undefined;
  const kind = d?.kind ?? "person";
  const r = Math.min(2, p.width / 2);
  return (
    <g>
      <Rectangle
        x={p.x}
        y={p.y}
        width={p.width}
        height={p.height}
        radius={[r, r, 0, 0]}
        fill={COLOR[kind]}
        fillOpacity={p.isActive ? 1 : OPACITY[kind]}
      />
      {kind === "you" && (
        <text x={p.x + p.width / 2} y={p.y - 6} textAnchor="middle" fontSize={12} fill="var(--fg)">
          you
        </text>
      )}
    </g>
  );
}

function Tip({ active, payload, sym }: TooltipContentProps & { sym: string }) {
  const d = payload?.[0]?.payload as Datum | undefined;
  if (!active || !d) return null;
  return (
    <TipCard title={shortAccount(d.bidder, 26)}>
      <TipRow color={COLOR[d.kind]} value={`${d.label} ${sym}`} label={`${d.share} of supply`} />
      <div className="num text-label text-muted">for {d.spent} USDC</div>
    </TipCard>
  );
}

function compact(v: number): string {
  if (v >= 1e6) return `${+(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${+(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}K`;
  return `${Math.round(v)}`;
}
