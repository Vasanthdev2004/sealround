"use client";

import { Tag } from "@/components/ui/badge";
import { CheckRow, type CheckState } from "@/components/ui/bits";
import { Button } from "@/components/ui/button";
import { KV } from "@/components/ui/stat";
import { dateTime, shortHash, usdcStr } from "@/lib/format";
import { ONECLICK_STATUS_TEXT, type FundingRecord, type OneClickStatus } from "@/lib/funding";
import { DEPOSIT_WINDOW_MS, SIM_PATH, isFinished } from "@/lib/oneclick";
import { focusEl, scrollToEl } from "@/lib/scroll";

const FAIL_END: OneClickStatus[] = ["REFUNDED", "FAILED", "INCOMPLETE_DEPOSIT"];
const FAIL_LEAD: Partial<Record<OneClickStatus, string>> = {
  REFUNDED: "Swap did not complete.",
  FAILED: "Swap failed.",
  INCOMPLETE_DEPOSIT: "Deposit was less than quoted.",
};

/**
 * One funding swap: what goes in and what comes out as a small ledger, every
 * 1Click status in order, and the outcome in plain words.
 */
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
    scrollToEl(el);
    focusEl(el?.querySelector("input"));
  };

  return (
    <div className="flex flex-col gap-4">
      <dl className="-mt-2 divide-y divide-line border-b border-line">
        <KV k={`From ${funding.originChain}`} v={`${funding.amountIn} ${funding.originAsset}`} />
        <KV k="To NEAR" v={`${usdcStr(funding.amountOutUsdc)} USDC`} />
        <KV
          k={
            <span className="inline-flex items-center gap-1.5">
              1Click address {funding.simulated && <Tag>simulated</Tag>}
            </span>
          }
          v={<span title={funding.depositAddress}>{shortHash(funding.depositAddress, 6)}</span>}
        />
        {!done && (
          <KV k="Send before" v={<span suppressHydrationWarning>{dateTime(funding.createdAt + DEPOSIT_WINDOW_MS)}</span>} />
        )}
      </dl>

      <div className="-my-1.5 divide-y divide-line" aria-live="polite">
        {path.map((s, i) => (
          <CheckRow key={s} state={state(i)} label={ONECLICK_STATUS_TEXT[s]} detail={s} className="py-2.5" />
        ))}
      </div>

      {funding.status === "SUCCESS" && (
        <div className="anim-rise border-t border-line pt-4">
          <p className="text-small text-muted [overflow-wrap:anywhere]">
            <span className="font-[510] text-ok">Arrived.</span>{" "}
            <span className="num text-fg">{usdcStr(funding.amountOutUsdc)}</span> test USDC is in{" "}
            <span className="num text-fg">{funding.account}</span>
            {canBid ? "." : ". It stays there until you use it."}
          </p>
          {canBid && (
            <Button onClick={goBid} className="mt-3 w-full max-sm:h-10">
              Place your sealed bid
            </Button>
          )}
        </div>
      )}
      {failedEnd && (
        <p className="anim-rise border-t border-line pt-4 text-small text-muted">
          <span className="font-[510] text-bad">{FAIL_LEAD[funding.status]}</span>{" "}
          <span className="num text-fg">
            {funding.amountIn} {funding.originAsset}
          </span>{" "}
          goes back to <span className="num text-fg">{shortHash(funding.refundTo, 6)}</span> on {funding.originChain}. No
          USDC was credited.
        </p>
      )}

      {done && (
        <Button variant="ghost" size="sm" onClick={onNewSwap} className="-ml-3 self-start max-sm:h-10">
          New swap
        </Button>
      )}
    </div>
  );
}
