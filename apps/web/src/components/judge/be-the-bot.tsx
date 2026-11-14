"use client";

import { useState } from "react";
import { formatTokens, formatUsdc } from "@fairground/clearing";
import { Tag } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BOT_REPLAY, compareBotEntry } from "./bot-comparison";

type Replay = ReturnType<typeof compareBotEntry>;

export function BeTheBot() {
  const [result, setResult] = useState<Replay | null>(null);

  return (
    <section id="be-the-bot" className="panel scroll-mt-20 overflow-hidden" aria-labelledby="be-the-bot-title">
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4 p-5 sm:p-8">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 id="be-the-bot-title" className="text-h2 text-fg">Be the bot</h2>
            <Tag>Simulated</Tag>
          </div>
          <p className="mt-2 max-w-[54ch] text-small text-muted">
            Enter at the open, before {BOT_REPLAY.humans} people arrive. Both launches use the same buyers, budgets and timing.
          </p>
        </div>
        <Button type="button" size="lg" variant={result ? "outline" : "primary"} className="max-sm:w-full"
          onClick={() => setResult(result ? null : compareBotEntry())}>
          {result ? "Reset replay" : "Snipe at the open"}
        </Button>
      </div>
      <p className="sr-only" aria-live="polite">
        {result && `Replay complete. Bonding curve profit ${formatUsdc(result.curve.profit)} USDC. Sealround profit ${formatUsdc(result.sealround.profit)} USDC.`}
      </p>
      {result && (
        <div>
          <p className="border-y border-line px-5 py-3 text-label text-muted sm:px-8">
            You entered both launches at <strong className="num font-[510] text-fg">{result.at}s</strong>. In this replay, here’s what happened after the crowd arrived.
          </p>
          <div className="grid divide-y divide-line sm:grid-cols-2 sm:divide-x sm:divide-y-0">
            <ResultColumn title="Bonding curve" description="You bought first, then sold into later demand."
              result={result.curve} decimals={result.decimals} priceLabel="Average buy price" />
            <ResultColumn title="Sealround"
              description={`Every winner paid the clearing price of ${formatUsdc(result.clearingPrice)} USDC per token.`}
              result={result.sealround} decimals={result.decimals} priceLabel="Price paid" />
          </div>
        </div>
      )}
    </section>
  );
}

function ResultColumn({ title, description, result, decimals, priceLabel }: {
  title: string;
  description: string;
  result: Replay["curve"];
  decimals: number;
  priceLabel: string;
}) {
  const rows = [
    [priceLabel, result.price === null ? "No fill" : `${formatUsdc(result.price)} USDC / token`],
    ["Spent", `${formatUsdc(result.spent)} USDC`],
    ["Tokens resold", formatTokens(result.sold, decimals, 6)],
    ["Resale proceeds", `${formatUsdc(result.proceeds)} USDC`],
  ];
  return (
    <div className="min-w-0 p-5 sm:p-8">
      <h3 className="text-h3 text-fg">{title}</h3>
      <p className="mt-1 text-small text-muted sm:min-h-[2lh]">{description}</p>
      <dl className="mt-4 divide-y divide-line border-y border-line">
        <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-3">
          <dt className="text-small text-muted">Realized profit</dt>
          <dd className="num break-words text-num-md text-fg">{formatUsdc(result.profit)} USDC</dd>
        </div>
        {rows.map(([label, value]) => (
          <div key={label} className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-2.5">
            <dt className="text-label text-muted">{label}</dt>
            <dd className="num break-words text-small text-fg">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
