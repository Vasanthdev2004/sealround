"use client";

import { Bar, BarChart, CartesianGrid, Rectangle, Tooltip, XAxis, YAxis, type BarShapeProps, type TooltipContentProps } from "recharts";
import { Empty, Panel } from "@/components/ui/panel";
import { shortAccount, tokenStr, usdcStr } from "@/lib/format";
import type { Sale } from "@/lib/types";
import { gini, isBot, isYou, pct, pctStr, toFloat, topShare, type ResultFill } from "./compute";

/*
 * Highlight scheme, validated against the panel surface (#17171a):
 * people are the recessive neutral (--fg-subtle, 3.4:1), bots carry the
 * --bot hue (CVD-safe against the neutral), and "you" is the accent with a
 * direct label, because accent vs bot is too close for protan readers.
 * Hex values mirror the tokens in globals.css (SVG fills cannot read vars reliably).
 */
const COLOR = { person: "#85858c", bot: "#c084fc", you: "#2b85ff" } as const;
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

/** Tokens received by each winner, largest first. Bots in the bot colour. */
export function Distribution({ sale, fills, account }: { sale: Sale; fills: ResultFill[]; account: string | null }) {
  const c = sale.config;
  const winners = fills.filter((f) => f.tokens > 0n);
  const sold = winners.reduce((a, f) => a + f.tokens, 0n);

  if (winners.length === 0) {
    return (
      <Panel title="Who got the tokens" className="h-full">
        <Empty title="No tokens were distributed" body="Nothing was sold in this sale. Every deposit is refunded in full." />
      </Panel>
    );
  }

  const data: Datum[] = [...winners]
    .sort((a, b) => (b.tokens > a.tokens ? 1 : b.tokens < a.tokens ? -1 : a.index - b.index))
    .map((f) => ({
      key: `${f.index}`,
      bidder: f.bidder,
      tokens: toFloat(f.tokens, c.decimals),
      label: tokenStr(f.tokens, c.decimals),
      spent: usdcStr(f.spent),
      share: pctStr(pct(f.tokens, c.saleSupply)),
      kind: isYou(f, account) ? "you" : isBot(f) ? "bot" : "person",
    }));

  const g = gini(winners.map((f) => toFloat(f.tokens, c.decimals)));
  const top10 = topShare(winners, 10, sold);
  const kinds = new Set(data.map((d) => d.kind));
  const nothing = fills.length - winners.length;

  return (
    <Panel
      title="Who got the tokens"
      subtitle={`${winners.length} winners, largest fill first.${nothing > 0 ? ` ${nothing} bids got nothing and are refunded.` : ""}`}
      className="h-full"
    >
      <dl className="grid grid-cols-3 gap-3">
        <Mini k="Top 10 share" v={pctStr(top10)} hint="of tokens sold" />
        <Mini k="Gini" v={g.toFixed(2)} hint="0 = even, 1 = one holder" />
        <Mini k="Deposit cap" v={usdcStr(c.maxDepositPerAccount)} hint="USDC per account" />
      </dl>

      <ul className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted" aria-label="Legend">
        {(["person", "bot", "you"] as const)
          .filter((k) => kinds.has(k))
          .map((k) => (
            <li key={k} className="inline-flex items-center gap-1.5">
              <span className="size-2.5 rounded-[3px]" style={{ background: COLOR[k] }} aria-hidden />
              {k === "person" ? "People" : k === "bot" ? "Bots" : "You"}
            </li>
          ))}
      </ul>

      <div className="mt-2 h-[240px] w-full font-mono" role="img" aria-label={`Bar chart of tokens received by ${winners.length} winners. The fills table lists every value.`}>
        <BarChart
          responsive
          data={data}
          margin={{ top: 18, right: 0, bottom: 0, left: 0 }}
          barCategoryGap={data.length > 40 ? 1 : "18%"}
          style={{ width: "100%", height: "100%" }}
        >
          <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.06)" />
          <XAxis dataKey="key" hide />
          <YAxis
            width={44}
            tickLine={false}
            axisLine={false}
            tickCount={4}
            tick={{ fill: "#85858c", fontSize: 11 }}
            tickFormatter={(v: number) => compact(v)}
          />
          <Tooltip cursor={{ fill: "rgba(255,255,255,0.04)" }} content={(p) => <Tip {...p} sym={c.tokenSymbol} />} isAnimationActive={false} />
          <Bar dataKey="tokens" maxBarSize={24} isAnimationActive={false} shape={(p: BarShapeProps) => <BarShape {...p} />} />
        </BarChart>
      </div>
      <p className="mt-2 text-[11.5px] text-subtle">
        Every winner paid the same price per token. Bigger bars mean a bigger budget, never a faster bot.
      </p>
    </Panel>
  );
}

function BarShape(p: BarShapeProps) {
  const d = p.payload as Datum | undefined;
  const kind = d?.kind ?? "person";
  return (
    <g>
      <Rectangle
        x={p.x}
        y={p.y}
        width={p.width}
        height={p.height}
        radius={[Math.min(4, p.width / 2), Math.min(4, p.width / 2), 0, 0]}
        fill={COLOR[kind]}
        fillOpacity={p.isActive ? 1 : 0.88}
      />
      {kind === "you" && (
        <text x={p.x + p.width / 2} y={p.y - 6} textAnchor="middle" fontSize={11} fill="#fafafa" className="font-sans">
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
    <div className="panel px-3 py-2 font-sans shadow-xl shadow-black/50">
      <div className="num text-[14px] text-fg">
        {d.label} <span className="font-sans text-[11.5px] text-muted">{sym}</span>
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 text-[12px] text-muted">
        <span className="h-0.5 w-3 rounded-full" style={{ background: COLOR[d.kind] }} aria-hidden />
        <span className="num">{shortAccount(d.bidder, 26)}</span>
      </div>
      <div className="num mt-0.5 text-[11.5px] text-subtle">
        {d.spent} USDC · {d.share} of supply
      </div>
    </div>
  );
}

function Mini({ k, v, hint }: { k: string; v: string; hint: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11.5px] text-subtle">{k}</dt>
      <dd className="num mt-0.5 text-[17px] text-fg">{v}</dd>
      <div className="truncate text-[11px] text-subtle">{hint}</div>
    </div>
  );
}

function compact(v: number): string {
  if (v >= 1e6) return `${+(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${+(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}K`;
  return `${Math.round(v)}`;
}
