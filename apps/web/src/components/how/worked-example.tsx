"use client";

import { useMemo, useState } from "react";
import { Plus, X } from "lucide-react";
import { formatUnits, type ClearingResult } from "@fairground/clearing";
import { Badge, Tag } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Segmented } from "@/components/ui/field";
import { Stat, StatRow } from "@/components/ui/stat";
import { cn } from "@/lib/cn";
import { priceStr } from "@/lib/format";
import { DemandChart } from "./demand-chart";
import {
  DECIMALS,
  MAX_ROWS,
  PRESET_ORDER,
  PRESETS,
  outcomeOf,
  presetRows,
  runExample,
  type ExampleRun,
  type PresetId,
  type Row,
} from "./example-model";

const tok = (v: bigint) => formatUnits(v, DECIMALS, 2);
const usdc6 = (v: bigint) => formatUnits(v, 6, 6);

function multiple(price: bigint, floor: bigint): string {
  const x = Number((price * 100n) / floor) / 100;
  return x.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export function WorkedExample() {
  const [preset, setPreset] = useState<PresetId | "custom">("tie");
  const [supply, setSupply] = useState(PRESETS.tie.supply);
  const [floor, setFloor] = useState(PRESETS.tie.floor);
  const [rows, setRows] = useState<Row[]>(() => presetRows("tie"));
  const [nextKey, setNextKey] = useState(100);

  const run = useMemo(() => runExample(supply, floor, rows), [supply, floor, rows]);

  const load = (id: PresetId | "custom") => {
    if (id === "custom") return;
    setPreset(id);
    setSupply(PRESETS[id].supply);
    setFloor(PRESETS[id].floor);
    setRows(presetRows(id));
  };
  const edit = (key: number, field: "bidder" | "price" | "spend", value: string) => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, [field]: value } : r)));
    setPreset("custom");
  };
  const remove = (key: number) => {
    setRows((rs) => rs.filter((r) => r.key !== key));
    setPreset("custom");
  };
  const add = () => {
    setRows((rs) => [...rs, { key: nextKey, bidder: `bidder${rs.length + 1}.testnet`, price: floor || "0.001", spend: "5" }]);
    setNextKey((k) => k + 1);
    setPreset("custom");
  };

  return (
    <div className="overflow-hidden rounded-panel border border-line bg-elev">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-dashed border-line-dashed px-4 py-3.5 sm:px-5">
        <Segmented
          value={preset}
          onChange={load}
          label="Example"
          options={PRESET_ORDER.map((id) => ({ value: id, label: PRESETS[id].label }))}
        />
        {preset === "custom" && <Tag>edited</Tag>}
      </div>

      <div className="flex flex-col gap-5 p-4 sm:p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Tokens for sale (S)"
            value={supply}
            onChange={(e) => {
              setSupply(e.target.value);
              setPreset("custom");
            }}
            inputMode="decimal"
            suffix="tokens"
            error={run.supplyError}
          />
          <Field
            label="Floor price (F)"
            value={floor}
            onChange={(e) => {
              setFloor(e.target.value);
              setPreset("custom");
            }}
            inputMode="decimal"
            suffix="USDC / token"
            error={run.floorError}
          />
        </div>

        <BidTable rows={rows} run={run} onEdit={edit} onRemove={remove} />

        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button size="sm" onClick={add} disabled={rows.length >= MAX_ROWS} icon={<Plus className="size-3.5" />}>
            Add bid
          </Button>
          <p className="max-w-md text-[12px] leading-snug text-subtle">
            In a real sale nobody sees these prices; only the enclave does. Here you type them to watch the rule work.
            Each deposit equals its max spend.
          </p>
        </div>
      </div>

      <div className="border-t border-dashed border-line-dashed p-4 sm:p-5">
        <Results run={run} />
      </div>
    </div>
  );
}

function CellInput({
  value,
  onChange,
  label,
  error,
  mono = true,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  error: string | null;
  mono?: boolean;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={label}
      aria-invalid={!!error}
      title={error ?? undefined}
      inputMode={mono ? "decimal" : "text"}
      spellCheck={false}
      className={cn(
        "h-8 w-full min-w-0 rounded-lg border bg-inset px-2 text-[13px] text-fg outline-none transition-colors focus:border-accent/60",
        error ? "border-bad/60" : "border-line",
        mono && "num",
      )}
    />
  );
}

function BidTable({
  rows,
  run,
  onEdit,
  onRemove,
}: {
  rows: Row[];
  run: ExampleRun;
  onEdit: (key: number, field: "bidder" | "price" | "spend", v: string) => void;
  onRemove: (key: number) => void;
}) {
  const r = run.result;
  return (
    <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <table className="w-full min-w-[780px] border-separate border-spacing-0 text-left text-[13px]">
        <thead>
          <tr className="text-[12px] text-subtle">
            <th className="pb-2 font-normal">Bidder</th>
            <th className="w-[118px] pb-2 pl-2 font-normal">Max price</th>
            <th className="w-[96px] pb-2 pl-2 font-normal">Max spend</th>
            <th className="pb-2 pl-3 text-right font-normal">Tokens</th>
            <th className="pb-2 pl-3 text-right font-normal">Spent</th>
            <th className="pb-2 pl-3 text-right font-normal">Refund</th>
            <th className="pb-2 pl-4 font-normal">Outcome</th>
            <th className="w-8 pb-2" aria-label="Remove" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => {
            const p = run.rows[idx];
            const fill = r && p.bidIndex !== null ? r.fills[p.bidIndex] : null;
            const outcome = r && p.bidIndex !== null && p.maxPrice !== null ? outcomeOf(r, p.bidIndex, p.maxPrice) : null;
            const rowError = p.bidderError ?? p.priceError ?? p.spendError;
            return (
              <tr key={row.key} className="[&>td]:border-t [&>td]:border-dashed [&>td]:border-line-dashed [&>td]:py-2">
                <td className="min-w-[150px]">
                  <CellInput
                    value={row.bidder}
                    onChange={(v) => onEdit(row.key, "bidder", v)}
                    label={`Bidder ${idx + 1}`}
                    error={p.bidderError}
                    mono={false}
                  />
                </td>
                <td className="pl-2">
                  <CellInput
                    value={row.price}
                    onChange={(v) => onEdit(row.key, "price", v)}
                    label={`Max price, bid ${idx + 1}, USDC per token`}
                    error={p.priceError}
                  />
                </td>
                <td className="pl-2">
                  <CellInput
                    value={row.spend}
                    onChange={(v) => onEdit(row.key, "spend", v)}
                    label={`Max spend, bid ${idx + 1}, USDC`}
                    error={p.spendError}
                  />
                </td>
                <td className="num pl-3 text-right text-fg">{fill ? tok(fill.tokens) : "–"}</td>
                <td className="num pl-3 text-right text-fg">{fill ? usdc6(fill.spent) : "–"}</td>
                <td className="num pl-3 text-right text-muted">{fill ? usdc6(fill.refund) : "–"}</td>
                <td className="pl-4">
                  {rowError ? (
                    <span className="text-[12px] text-bad">{rowError}</span>
                  ) : outcome ? (
                    <Badge tone={outcome.tone}>{outcome.label}</Badge>
                  ) : (
                    <span className="text-subtle">–</span>
                  )}
                </td>
                <td className="pl-1 text-right">
                  <button
                    onClick={() => onRemove(row.key)}
                    disabled={rows.length <= 1}
                    aria-label={`Remove bid ${idx + 1}`}
                    className="inline-flex size-7 items-center justify-center rounded-lg text-subtle transition-colors hover:bg-hover hover:text-fg"
                  >
                    <X className="size-3.5" strokeWidth={1.75} />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-2 text-[11.5px] text-subtle">Prices in USDC per token, spend and refunds in USDC.</p>
    </div>
  );
}

function Results({ run }: { run: ExampleRun }) {
  const r = run.result;
  if (!r || run.supply === null || run.floor === null) {
    const why = run.supplyError || run.floorError ? "Fix the supply and floor above to run the clearing." : "Add at least one complete bid to run the clearing.";
    return <p className="text-[13px] text-bad">{why}</p>;
  }

  const atFloor = r.clearingPrice === run.floor;
  // Valid bids only: invalid ones count as zero and are not part of demand.
  const curveBids = run.bids.filter((_, i) => r.fills[i].valid).map((b) => ({ maxPrice: b.maxPrice!, maxSpend: b.maxSpend! }));

  return (
    <div className="flex flex-col gap-5">
      <StatRow>
        <Stat
          label={
            <>
              Clearing price P<sup>*</sup>
            </>
          }
          value={priceStr(r.clearingPrice)}
          unit="USDC"
          hint={atFloor ? "equals the floor" : `${multiple(r.clearingPrice, run.floor)}× floor`}
        />
        <Stat label="Tokens sold" value={tok(r.totalSold)} hint={`of ${tok(run.supply)}`} />
        <Stat label="Raised" value={formatUnits(r.totalRaised, 6, 2)} unit="USDC" hint={`${r.nValid} valid of ${r.fills.length} bids`} />
        <Stat label="Unsold, burned" value={tok(r.unsold)} hint={r.oversubscribed ? "oversubscribed" : "undersubscribed"} />
      </StatRow>

      {r.status === "failed" ? (
        <p className="text-[13px] text-bad">No valid bids, so the sale fails and every deposit is refunded in full.</p>
      ) : (
        <Insight run={run} result={r} />
      )}

      <div className={cn(r.status === "failed" && "hidden")}>
        <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-[13px] font-medium text-fg">Demand at each price</h3>
          <span className="text-[11.5px] text-subtle">D(P), tokens · price on a log scale</span>
        </div>
        <DemandChart
          bids={curveBids}
          floor={run.floor}
          supply={run.supply}
          clearingPrice={r.clearingPrice}
          decimals={DECIMALS}
        />
        <p className="mt-1 text-[11.5px] leading-snug text-subtle">
          The line is how many tokens the bids could buy at each price. It drops wherever a bid’s max price is passed.
          P<sup>*</sup> is the last price where it still reaches the supply.
        </p>
      </div>
    </div>
  );
}

/** One plain sentence about the most interesting thing in this result. */
function Insight({ run, result: r }: { run: ExampleRun; result: ClearingResult }) {
  const filled = r.fills
    .map((f, i) => ({ f, b: run.bids[i] }))
    .filter(({ f }) => f.valid && f.tokens > 0n);
  const top = filled.reduce<(typeof filled)[number] | null>(
    (m, x) => (!m || x.b.maxPrice! > m.b.maxPrice! ? x : m),
    null,
  );
  const ties = r.oversubscribed ? filled.filter(({ b }) => b.maxPrice === r.clearingPrice) : [];

  let text: React.ReactNode = null;
  if (top && top.b.maxPrice! >= r.clearingPrice * 5n) {
    text = (
      <>
        <span className="num text-fg">{top.b.bidder}</span> would have paid up to{" "}
        <span className="num text-fg">{priceStr(top.b.maxPrice!)}</span> USDC per token,{" "}
        <span className="num text-fg">{multiple(top.b.maxPrice!, r.clearingPrice)}×</span> the clearing price. It pays{" "}
        <span className="num text-fg">{priceStr(r.clearingPrice)}</span>, the same as every other winner. Bidding high
        early bought it nothing on price.
      </>
    );
  } else if (!r.oversubscribed) {
    text = (
      <>
        Demand at the floor is below the supply, so everyone fills in full at the floor and{" "}
        <span className="num text-fg">{tok(r.unsold)}</span> unsold tokens are burned.
      </>
    );
  } else if (ties.length > 0) {
    const left = ties.reduce((a, t) => a + t.f.tokens, 0n);
    text = (
      <>
        {ties.length === 1 ? "One bid sits" : `${ties.length} bids sit`} exactly at P<sup>*</sup>. After the bids above
        it fill in full, {ties.length === 1 ? "it gets" : "they share"} the{" "}
        <span className="num text-fg">{tok(left)}</span> tokens left
        {ties.length > 1 && (
          <>
            , pro rata:{" "}
            {ties.map((t, k) => (
              <span key={t.f.index}>
                {k > 0 && (k === ties.length - 1 ? " and " : ", ")}
                <span className="num text-fg">{t.b.bidder}</span> <span className="num text-fg">{tok(t.f.tokens)}</span>
              </span>
            ))}
          </>
        )}
        .
      </>
    );
  } else {
    text = (
      <>
        Every bid above P<sup>*</sup> fills in full at the same price.
      </>
    );
  }

  return (
    <p className="rounded-tile border border-accent/25 bg-accent-soft px-3.5 py-2.5 text-[13px] leading-relaxed text-muted">
      {text}
    </p>
  );
}
