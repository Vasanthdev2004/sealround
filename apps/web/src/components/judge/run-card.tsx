"use client";

import Link from "next/link";
import { ArrowRight, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SimulatedNote } from "@/components/ui/bits";
import { Rule } from "@/components/ui/panel";
import { KV } from "@/components/ui/stat";
import { JUDGE_WINDOW_SECONDS } from "./judge-store";

/** The idle-state call to action: what you need (nothing) and the one button. */
export function RunCard({ onRun, disabled }: { onRun: () => void; disabled?: boolean }) {
  return (
    <section className="panel">
      <div className="p-5 sm:p-6">
        <div className="text-[12px] text-subtle">One click. About 35 seconds.</div>
        <h2 className="mt-2 font-display text-[20px] leading-snug font-medium tracking-[-0.02em] text-fg">
          Bots and you pay the same price. Watch it happen.
        </h2>
        <p className="mt-2 text-[13.5px] leading-relaxed text-muted">
          This runs a whole sale in front of you. Every bid is sealed with real encryption and the clearing price
          comes from the real clearing code. You can add your own bid while the window is open.
        </p>

        <Button
          variant="primary"
          size="lg"
          className="mt-5 w-full"
          onClick={onRun}
          disabled={disabled}
          icon={<Play className="size-4" strokeWidth={1.75} fill="currentColor" />}
        >
          Run it
        </Button>

        <dl className="mt-4">
          <KV k="Wallet" v="Not needed" mono={false} />
          <KV k="Funds" v="Not needed" mono={false} />
          <KV k="Bidders" v="50 people, 3 sniper bots, 1 copycat" mono={false} />
          <KV k="Bid window" v={`${JUDGE_WINDOW_SECONDS} seconds`} />
          <KV k="Goal" v="Result in under 2:00" mono={false} />
        </dl>

        <SimulatedNote className="mt-3" />
        <Rule className="my-4" />
        <p className="text-[12.5px] leading-relaxed text-muted">
          Funding shows live dry quotes on any sale page.{" "}
          <Link
            href="/sale/fairt"
            className="inline-flex items-center gap-1 text-fg underline decoration-line-strong underline-offset-2 hover:decoration-fg"
          >
            Try it on Fair Test <ArrowRight className="size-3.5" strokeWidth={1.75} />
          </Link>
        </p>
      </div>
    </section>
  );
}
