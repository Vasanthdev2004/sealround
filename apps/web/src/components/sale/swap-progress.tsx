"use client";

import { ArrowDown, RotateCcw } from "lucide-react";
import { Tag } from "@/components/ui/badge";
import { CheckRow, type CheckState } from "@/components/ui/bits";
import { Button } from "@/components/ui/button";
import { dateTime, shortHash, usdcStr } from "@/lib/format";
import { ONECLICK_STATUS_TEXT, type FundingRecord, type OneClickStatus } from "@/lib/funding";
import { DEPOSIT_WINDOW_MS, SIM_PATH, isFinished } from "@/lib/oneclick";

const FAIL_END: OneClickStatus[] = ["REFUNDED", "FAILED", "INCOMPLETE_DEPOSIT"];
const FAIL_LEAD: Partial<Record<OneClickStatus, string>> = {
  REFUNDED: "Swap did not complete.",
  FAILED: "Swap failed.",
  INCOMPLETE_DEPOSIT: "Deposit was less than quoted.",
};

/** Every 1Click status of one funding swap, in order, with the outcome in plain words. */
export function SwapProgress({
  funding,
  canBid,
  onNewSwap,
}: {
  funding: FundingRecord;
  /** Sale open and this account has no bid yet. */
  canBid: boolean;
  onNewSwap: () => void;
}) {
  const failedEnd = FAIL_END.includes(funding.status);
  const path: OneClickStatus[] = failedEnd ? [...SIM_PATH.fail.slice(0, 3), funding.status] : SIM_PATH.ok;
  const cur = path.indexOf(funding.status);
  const done = isFinished(funding.status);

  const state = (i: number): CheckState => {
    if (i < cur) return "pass";
    if (i > cur) return "idle";
    if (!done) return "pending";
    return failedEnd ? "fail" : "pass";
  };

  const goBid = () => {
    const el = document.getElementById("bid");
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
    el?.querySelector("input")?.focus({ preventScroll: true });
  };

  return (
    <div className="space-y-4">
      <div className="inset p-4">
        <div className="flex items-center justify-between gap-2 text-[12px] text-subtle">
          <span>
            From {funding.originChain}
          </span>
          {funding.simulated && <Tag tone="warn">simulated</Tag>}
        </div>
        <div className="num mt-1 text-[18px] text-fg">
          {funding.amountIn} <span className="font-sans text-[12px] text-muted">{funding.originAsset}</span>
        </div>
        <ArrowDown className="my-1 size-3.5 text-subtle" strokeWidth={1.75} />
        <div className="num text-[18px] text-fg">
          {usdcStr(funding.amountOutUsdc)} <span className="font-sans text-[12px] text-muted">USDC on NEAR</span>
        </div>
        <div className="mt-3 border-t border-dashed border-line-dashed pt-3 text-[12px] leading-relaxed text-subtle">
          1Click deposit address{funding.simulated && " (simulated)"}:{" "}
          <span className="num text-muted" title={funding.depositAddress}>
            {shortHash(funding.depositAddress, 8)}
          </span>
          {!done && (
            <>
              <br />
              Send before <span className="num text-muted" suppressHydrationWarning>{dateTime(funding.createdAt + DEPOSIT_WINDOW_MS)}</span>.
            </>
          )}
        </div>
      </div>

      <div className="divide-y divide-line" aria-live="polite">
        {path.map((s, i) => (
          <CheckRow key={s} state={state(i)} label={ONECLICK_STATUS_TEXT[s]} detail={s} className="py-2" />
        ))}
      </div>

      {funding.status === "SUCCESS" && (
        <div className="rounded-card border border-ok/25 bg-ok-soft p-3.5">
          <p className="text-[13px] text-fg">
            <span className="num">{usdcStr(funding.amountOutUsdc)}</span> test USDC arrived in{" "}
            <span className="num">{funding.account}</span>.
          </p>
          {canBid ? (
            <Button variant="tactile" size="sm" onClick={goBid} className="mt-2.5 w-full">
              Place your sealed bid
            </Button>
          ) : (
            <p className="mt-1 text-[12.5px] text-muted">It stays in your account until you use it.</p>
          )}
        </div>
      )}
      {failedEnd && (
        <div className="rounded-card border border-bad/25 bg-bad-soft p-3.5 text-[13px] text-fg">
          {FAIL_LEAD[funding.status]}{" "}
          <span className="num">
            {funding.amountIn} {funding.originAsset}
          </span>{" "}
          goes back to <span className="num">{shortHash(funding.refundTo, 6)}</span> on {funding.originChain}. No USDC was
          credited.
        </div>
      )}

      {done && (
        <Button variant="ghost" size="sm" onClick={onNewSwap} icon={<RotateCcw className="size-3.5" />} className="w-full">
          New swap
        </Button>
      )}
    </div>
  );
}
