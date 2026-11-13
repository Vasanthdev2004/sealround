"use client";

import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Field, Segmented } from "@/components/ui/field";
import { KV } from "@/components/ui/stat";
import { tokenFull, usdcStr } from "@/lib/format";
import { bpsPct } from "@/lib/liquidity";
import { ChoiceCard, FormSection, Label, Note, SectionNotices, Why, radioKeys, type SectionProps } from "./form-kit";
import { ONE, POOL_FEE_PRESETS, SETTLE_TIMEOUT_MS, groupDigits, pctStr, windowLabel, type PoolFeePreset } from "./model";

const CHOICES = [false, true] as const;

/** A unit after a number: attached, one step quieter. */
const U = ({ children }: { children: React.ReactNode }) => (
  <span className="ml-1 text-label font-normal text-subtle">{children}</span>
);

/**
 * Section 7, shown only when the contract takes launch liquidity: a share of
 * the raise and the rest of the supply seed a pool on `dex` at the clearing
 * price when the sale settles.
 */
export function PoolSection({ draft, set, error, touch, derived, status, dex }: SectionProps & { dex: string }) {
  const feeId = useId();
  const on = draft.poolOn;
  const pool = derived.pool;
  const v = derived.values;
  const choose = (next: boolean) => set("poolOn", next);
  const share = pool && pool.shareBps !== null ? bpsPct(pool.shareBps) : "the share";
  const poolError = error("poolTokens");

  // The reserve a sell-out fills, in whole tokens (the creator field takes whole tokens).
  const sellOutWhole = pool && pool.sellOut !== null ? (pool.sellOut + ONE - 1n) / ONE : null;
  const room = v.total !== undefined && v.sale !== undefined ? v.total - v.sale : null;
  const canMatch =
    sellOutWhole !== null && sellOutWhole > 0n && room !== null && room >= sellOutWhole * ONE && pool?.reserve !== sellOutWhole * ONE;
  const matchReserve = () => {
    if (!canMatch || room === null || sellOutWhole === null) return;
    set("creatorAllocation", groupDigits(((room - sellOutWhole * ONE) / ONE).toString()));
    touch("creatorAllocation");
  };

  return (
    <FormSection
      id="pool"
      n={7}
      title="Launch pool"
      description="Optional. When the sale settles, part of the raise and reserved tokens open a Rhea pool at the clearing price."
      status={status}
    >
      <div
        role="radiogroup"
        aria-label="Launch pool"
        onKeyDown={radioKeys(CHOICES, on, choose)}
        className="grid gap-2 sm:grid-cols-2"
      >
        <ChoiceCard selected={!on} onSelect={() => choose(false)} title="No pool" tag="Default">
          The rest of the supply stays with you. Buyers find a market for the token on their own.
        </ChoiceCard>
        <ChoiceCard selected={on} onSelect={() => choose(true)} title="Seed a pool">
          The sale contract adds the liquidity and keeps the LP shares. It has no method to move them.
        </ChoiceCard>
      </div>

      {on && pool && (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Share of the raise"
              inputMode="decimal"
              value={draft.poolShare}
              suffix="%"
              onChange={(e) => set("poolShare", e.target.value)}
              onBlur={() => touch("poolShare")}
              error={error("poolShare")}
              hint="Up to 50 %."
            />
            <div className="flex flex-col gap-1.5">
              <Label id={feeId}>Pool fee</Label>
              <Segmented<PoolFeePreset>
                labelledBy={feeId}
                value={draft.poolFee}
                onChange={(next) => set("poolFee", next)}
                options={POOL_FEE_PRESETS.map((p) => ({ value: p.value, label: p.label }))}
              />
            </div>
          </div>

          <dl className="divide-y divide-line border-y border-line">
            <KV
              k="Tokens reserved"
              v={
                pool.reserve === null ? (
                  "–"
                ) : (
                  <>
                    {tokenFull(pool.reserve)}
                    {derived.shares && <U>{pctStr(derived.shares.lp)}</U>}
                  </>
                )
              }
            />
            <KV
              k="If every token sells"
              v={
                pool.atFloor && pool.atFloor.tokens > 0n ? (
                  <>
                    {tokenFull(pool.atFloor.tokens)}
                    <U>tokens</U>
                    <span className="text-subtle"> + </span>
                    {usdcStr(pool.atFloor.usdc, 6)}
                    <U>USDC at the floor</U>
                  </>
                ) : (
                  "–"
                )
              }
            />
            <KV k="Pool opens at" v="The clearing price" mono={false} />
            <KV
              k="Creator allocation"
              v={
                v.creator === undefined ? (
                  "–"
                ) : (
                  <>
                    {tokenFull(v.creator)}
                    {derived.shares && <U>{pctStr(derived.shares.creator)}</U>}
                  </>
                )
              }
            />
            <KV k="Exchange" v={<span className="[overflow-wrap:anywhere]">{dex}</span>} />
          </dl>

          {poolError && <Note tone="bad">{poolError}</Note>}

          {canMatch && sellOutWhole !== null && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <Button variant="tactile" size="sm" className="max-sm:h-10" onClick={matchReserve}>
                Reserve {tokenFull(sellOutWhole * ONE)}
              </Button>
              <span className="text-label text-subtle">Covers a sell-out. Changes the creator allocation.</span>
            </div>
          )}

          <SectionNotices notices={derived.notices} section="pool" />

          <Note>
            The pool gets {share} of the raise and buys tokens with it at the clearing price, so it opens at that price
            whatever it is. Reserved tokens it does not take are burned.
          </Note>
          <Why label="While the pool is being seeded">
            <p>
              No sale token leaves the contract until the pool is seeded. Buyers can claim their unspent USDC; you get
              the raise less the pool&apos;s share, and your allocation after.
            </p>
            <p>
              Anyone can seed the pool. If nobody has within {windowLabel(SETTLE_TIMEOUT_MS)} of settlement, anyone can
              abandon it: its USDC goes to you and its tokens are burned.
            </p>
          </Why>
        </>
      )}
    </FormSection>
  );
}
