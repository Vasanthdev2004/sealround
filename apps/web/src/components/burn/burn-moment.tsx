"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { ArrowUpRight, Flame } from "lucide-react";
import { xIntentUrl } from "@/components/result/share-text";
import { burnStateOf, share, shareStr, supplyLedger } from "@/components/result/supply";
import { tokenSharePath } from "@/components/token/figures";
import { useOrigin, XMark } from "@/components/token/share-token";
import { Tag } from "@/components/ui/badge";
import { TxLink } from "@/components/ui/bits";
import { ButtonLink } from "@/components/ui/button";
import { useReducedMotionSafe } from "@/components/visual/use-reduced-motion";
import { burnShareText } from "@/lib/burn-total";
import { getClient } from "@/lib/client";
import { isNearMode } from "@/lib/config";
import { accountUrl, networkName, shortAccount, tokenFull } from "@/lib/format";
import type { Sale, SaleResult } from "@/lib/types";

/** What a creator payout burned, once the views confirm it. */
export type BurnMomentData = {
  /** The whole launch burn, base units (with `partial`, part of it landed at an earlier payout). */
  amount: bigint;
  /** Minted at launch. */
  minted: bigint;
  /** The supply now: minted less the burn. */
  supplyAfter: bigint;
  /** An earlier payout may have burned part of `amount` (an abandoned pool added to the burn later). */
  partial: boolean;
  /** The payout transaction ("" when the client did not return one). */
  txHash: string;
};

/** Reads of the result after a payout, ms after it returns: the view may trail the transaction by a moment. */
const CONFIRM_AFTER_MS = [0, 1500, 4000];

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wraps the creator payout (claim_proceeds). When the payout was due to burn
 * tokens, it reads the result again until the views say the burn landed, then
 * sets `moment`. Nothing is shown from the click alone: a payout whose burn
 * the views do not confirm leaves no moment. The payout's own result and
 * errors pass through unchanged.
 */
export function useBurnCapture(sale: Sale, result: SaleResult | null | undefined) {
  const [moment, setMoment] = useState<BurnMomentData | null>(null);

  const confirm = async (txHash: string, partial: boolean) => {
    for (const ms of CONFIRM_AFTER_MS) {
      if (ms) await wait(ms);
      try {
        const fresh = await getClient().getResult(sale.id);
        if (fresh && burnStateOf(fresh) === "burned") {
          const l = supplyLedger(sale, fresh);
          setMoment({ amount: l.burn, minted: l.total, supplyAfter: l.after, partial, txHash });
          return;
        }
      } catch {
        // A failed read: try again, then give up quietly. The payout itself went through.
      }
    }
  };

  const capture = async <R extends { txHash: string }>(send: () => Promise<R>): Promise<R> => {
    const before = result ? burnStateOf(result) : null;
    const r = await send();
    if (before === "owed" || before === "partial") void confirm(r.txHash, before === "partial");
    return r;
  };

  return { moment, capture };
}

/**
 * The burn moment, shown in the sale's status panel after a creator payout
 * burned the tokens demand did not take: the amount, the supply now, the
 * supply bar losing its burned part, the transaction and a post for X. Focus
 * moves to it, since the payout button it replaces is gone. Reduced motion
 * shows the final bar at once.
 */
export function BurnMoment({ sale, moment: m }: { sale: Sale; moment: BurnMomentData }) {
  const c = sale.config;
  const d = c.decimals;
  const sym = c.tokenSymbol;
  const near = isNearMode();
  const reduce = useReducedMotionSafe();
  const origin = useOrigin();
  const head = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    head.current?.focus({ preventScroll: true });
  }, []);

  const where = near ? networkName() : "simulated";
  const url = origin ? `${origin}${tokenSharePath(sale, !near)}` : null;
  const href = xIntentUrl(burnShareText(sym, d, m.amount, m.supplyAfter, where), url);
  const tokenPage = near ? accountUrl(sale.tokenAccount) : "#";

  return (
    <div className="mt-6 border-t border-line pt-5">
      <div className="flex flex-wrap items-center gap-2 text-label text-subtle">
        <Flame className="size-4 text-muted" strokeWidth={1.75} aria-hidden />
        {m.partial ? "The rest of the burn landed" : "Burned by the creator payout"}
        {!near && <Tag title="Simulated transaction on the mock chain">simulated</Tag>}
      </div>
      <h3
        ref={head}
        tabIndex={-1}
        className="anim-rise num mt-2 flex flex-wrap items-baseline gap-x-2 text-num-lg text-fg outline-none"
      >
        <span className="min-w-0 [overflow-wrap:anywhere]">{tokenFull(m.amount, d)}</span>{" "}
        <span className="text-small font-normal tracking-normal text-muted">
          {sym} burned{m.partial && " in all"}
        </span>
      </h3>

      <SupplyLoss minted={m.minted} burned={m.amount} play={!reduce} />

      <p className="mt-4 text-small font-[510] text-fg">
        Gone for good. The supply is now{" "}
        <span className="num">
          {tokenFull(m.supplyAfter, d)} {sym}
        </span>
        .
      </p>
      <p className="mt-1 max-w-[62ch] text-small text-muted">
        {shareStr(share(m.amount, m.minted))} of the {tokenFull(m.minted, d)} minted at launch, burned because demand did
        not take them. The token has no mint method, so its supply can only fall from here.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-3">
        <ButtonLink href={href} external size="sm" variant="outline" icon={<XMark />}>
          Share on X
          <span className="sr-only"> (opens x.com in a new tab)</span>
        </ButtonLink>
        {m.txHash ? (
          <TxLink hash={m.txHash} prefix="payout tx" tag={false} />
        ) : (
          tokenPage !== "#" && (
            <a
              href={tokenPage}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-0.5 text-label text-muted underline decoration-line-strong underline-offset-2 hover:text-fg"
            >
              ft_burn on {shortAccount(sale.tokenAccount, 28)}
              <ArrowUpRight className="size-3" aria-hidden />
            </a>
          )
        )}
      </div>
    </div>
  );
}

/**
 * The supply at launch as one bar: what is left, then the burned part as an
 * empty slot. With motion, the burned part starts full and drains from its
 * far end toward what is left.
 */
function SupplyLoss({ minted, burned, play }: { minted: bigint; burned: bigint; play: boolean }) {
  const gone = share(burned, minted);
  return (
    <div aria-hidden className="mt-3 flex h-2 gap-0.5">
      <span className="rounded-full bg-muted" style={{ flexGrow: 1 - gone, flexBasis: 0 }} />
      <span
        className="relative min-w-[3px] overflow-hidden rounded-full bg-wash shadow-[inset_0_0_0_1px_var(--line-strong)]"
        style={{ flexGrow: gone, flexBasis: 0 }}
      >
        {play && (
          <motion.span
            className="absolute inset-0 origin-left rounded-full bg-muted"
            initial={{ scaleX: 1, opacity: 1 }}
            animate={{ scaleX: 0, opacity: 0.35 }}
            transition={{ delay: 0.35, duration: 1.2, ease: [0.23, 1, 0.32, 1] }}
          />
        )}
      </span>
    </div>
  );
}
