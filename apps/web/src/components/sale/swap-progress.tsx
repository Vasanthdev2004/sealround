"use client";

import { useEffect, useRef, useState } from "react";
import { Tag } from "@/components/ui/badge";
import { CheckRow, type CheckState } from "@/components/ui/bits";
import { Button } from "@/components/ui/button";
import { KV } from "@/components/ui/stat";
import { dateTime, shortHash, usdcStr } from "@/lib/format";
import { ONECLICK_STATUS_TEXT, type FundingRecord, type OneClickStatus } from "@/lib/funding";
import { useNow } from "@/lib/hooks";
import { DEPOSIT_WINDOW_MS, SIM_PATH, canTrackFunding, isFinished, isTerminal } from "@/lib/oneclick";
import { focusEl, scrollToEl } from "@/lib/scroll";

const FAIL_END: OneClickStatus[] = ["REFUNDED", "FAILED", "INCOMPLETE_DEPOSIT"];
const FAIL_LEAD: Partial<Record<OneClickStatus, string>> = {
  REFUNDED: "Swap did not complete.",
  FAILED: "Swap failed.",
  INCOMPLETE_DEPOSIT: "Deposit was less than quoted.",
};

type SwapProgressProps = {
  funding: FundingRecord;
  /** Sale open and this account has no bid yet. */
  canBid: boolean;
  liveDepositsEnabled: boolean;
  focusOnOpen?: boolean;
  onNewSwap: () => void;
};

function goBid() {
  const el = document.getElementById("bid");
  scrollToEl(el);
  focusEl(el?.querySelector("input"));
}

export function SwapProgress(props: SwapProgressProps) {
  return props.funding.simulated ? <SimulatedSwapProgress {...props} /> : <LiveSwapProgress {...props} />;
}

function SimulatedSwapProgress({ funding, canBid, onNewSwap }: SwapProgressProps) {
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

function DepositAddress({ address, expiresAt }: { address: string; expiresAt: number }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");

  async function copy() {
    if (Date.now() >= expiresAt) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <span className="text-label font-[510] text-muted">1Click deposit address</span>
      <code className="num select-all break-all text-small text-fg">{address}</code>
      <Button size="sm" className="self-start max-sm:h-10" onClick={() => void copy()}>
        Copy deposit address
      </Button>
      {copyState !== "idle" && (
        <p className="text-label text-muted" role="status">
          {copyState === "copied" ? "Address copied." : "Select the address to copy it manually."}
        </p>
      )}
    </div>
  );
}

const LIVE_STATUS_TEXT: Record<OneClickStatus, string> = {
  ...ONECLICK_STATUS_TEXT,
  INCOMPLETE_DEPOSIT: "1Click detected a deposit below the quoted amount.",
  FAILED: "1Click reported a swap failure.",
};

function LiveSwapProgress({ funding, canBid, liveDepositsEnabled, focusOnOpen, onNewSwap }: SwapProgressProps) {
  const now = useNow();
  const statusRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focusOnOpen) focusEl(statusRef.current);
  }, [focusOnOpen]);

  const pending = funding.status === "PENDING_DEPOSIT";
  const expiresAt = funding.depositExpiresAt;
  const expired = pending && expiresAt !== undefined && now >= expiresAt;
  const done = isTerminal(funding.status);
  const canTrack = canTrackFunding(funding, now);
  const canDeposit = liveDepositsEnabled && canTrack && pending && expiresAt !== undefined && !expired && !funding.statusCheckFailed;
  const canRequestNew = liveDepositsEnabled && (expired || (pending && !canTrack));
  const succeeded = funding.status === "SUCCESS";
  const refunded = funding.status === "REFUNDED";
  const failed = funding.status === "FAILED";
  const incomplete = funding.status === "INCOMPLETE_DEPOSIT";
  const showRefundDetails = refunded || failed || incomplete;
  const links = [
    ["Deposit transaction", funding.originTxUrl],
    ["Delivery transaction", funding.destinationTxUrl],
  ].filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "");
  const statusText = expired
    ? "Deposit window expired."
    : pending && !canDeposit
      ? "Deposit instructions are unavailable."
      : LIVE_STATUS_TEXT[funding.status];

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div ref={statusRef} tabIndex={-1} className="text-small text-fg" role="status">
        {statusText}
      </div>
      {!done && !canTrack ? (
        <p className="text-small text-muted" role="status">
          This receipt can no longer track the swap. If you already sent funds, keep the transaction and quote reference for 1Click support.
        </p>
      ) : funding.statusCheckFailed && (
        <p className="text-small text-warn" role="status">1Click status is temporarily unavailable. This page will retry.</p>
      )}

      <dl className="divide-y divide-line border-y border-line">
        <KV k={canDeposit ? `Send on ${funding.originChain}` : `Quoted input on ${funding.originChain}`} v={`${funding.amountIn} ${funding.originAsset}`} />
        {funding.confidentiality === "basic" && <KV k="Funding route" v="Confidential through 1Click" />}
        {succeeded ? (
          <KV
            k="Delivered"
            v={funding.receivedUsdc === undefined ? "Amount unavailable" : `${usdcStr(funding.receivedUsdc, 6)} USDC`}
          />
        ) : !showRefundDetails && (
          <KV k="Expected on NEAR" v={`${usdcStr(funding.amountOutUsdc, 6)} USDC`} />
        )}
        {canDeposit && funding.minAmountOutUsdc !== undefined && (
          <KV k="Minimum on NEAR" v={`${usdcStr(funding.minAmountOutUsdc, 6)} USDC`} />
        )}
        {canDeposit && (
          <KV k="Send before" v={<span suppressHydrationWarning>{dateTime(expiresAt)}</span>} />
        )}
        {(canDeposit || succeeded) && <KV k="NEAR account" v={<span className="break-all">{funding.account}</span>} />}
        {(canDeposit || showRefundDetails) && (
          <KV k={`Refund address on ${funding.originChain}`} v={<span className="break-all">{funding.refundTo}</span>} />
        )}
        {refunded && funding.refundedAmount !== undefined && (
          <KV k="Refunded" v={`${funding.refundedAmount} ${funding.originAsset}`} />
        )}
        {!canDeposit && <KV k="1Click address" v={<span title={funding.depositAddress}>{shortHash(funding.depositAddress, 6)}</span>} />}
      </dl>

      {canDeposit && (
        <>
          <DepositAddress key={funding.id} address={funding.depositAddress} expiresAt={expiresAt} />
          <p className="text-small text-muted">
            Send the exact amount in {funding.originAsset} on {funding.originChain}. After sending, follow the status here.
          </p>
        </>
      )}
      {expired && (
        <p className="text-small text-muted">
          {liveDepositsEnabled && "Get a new quote if you haven’t sent funds. "}
          If you already sent funds, keep this receipt while 1Click checks the deposit.
        </p>
      )}
      {incomplete && (
        <p className="text-small text-muted">Follow the refund status here and keep your deposit transaction for reference.</p>
      )}
      {failed && <p className="text-small text-muted">A refund is unconfirmed. Keep your deposit transaction and quote reference for 1Click support.</p>}
      {showRefundDetails && funding.refundReason && <p className="text-small text-muted">{funding.refundReason}</p>}
      {(failed || incomplete || (!done && !canTrack)) && funding.correlationId && (
        <p className="break-all text-label text-subtle">Quote reference <span className="num text-muted">{funding.correlationId}</span></p>
      )}
      {links.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {links.map(([label, url]) => (
            <a key={label} href={url} target="_blank" rel="noreferrer" className="text-label text-muted underline decoration-line-strong underline-offset-2 hover:text-fg">
              {label}
            </a>
          ))}
        </div>
      )}
      {succeeded && canBid && (
        <Button onClick={goBid} className="w-full max-sm:h-10">Place your sealed bid</Button>
      )}
      {(done || canRequestNew) && (
        <Button variant="ghost" size="sm" onClick={onNewSwap} className="-ml-3 self-start max-sm:h-10">
          {canRequestNew ? "Get a new quote" : "New swap"}
        </Button>
      )}
    </div>
  );
}
