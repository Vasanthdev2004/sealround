"use client";

import { useMemo, useState } from "react";
import { X } from "lucide-react";
import { formatUnits, type ClearingResult } from "@fairground/clearing";
import { Badge } from "@/components/ui/badge";
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
    <div className="panel overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line px-4 py-3 sm:px-5">
        <span className="text-label text-subtle" id="how-example-presets">
          Start from
        </span>
        <Segmented
          value={preset}
          onChange={load}
          labelledBy="how-example-presets"
          scroll
          scrollClassName="-mx-4 px-4 max-sm:basis-full sm:mx-0 sm:px-0"
          options={PRESET_ORDER.map((id) => ({ value: id, label: PRESETS[id].label }))}
        />
        {preset === "custom" && <span className="ml-auto text-label text-subtle">Custom bids</span>}
      </div>

      <div className="flex flex-col">
        <div className="grid gap-4 p-4 sm:grid-cols-2 sm:p-5">
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

        <BidCards rows={rows} run={run} onEdit={edit} onRemove={remove} />
        <BidTable rows={rows} run={run} onEdit={edit} onRemove={remove} />

        <div className="flex flex-wrap items-center gap-x-5 gap-y-3 border-t border-line px-4 py-3.5 sm:px-5">
          <Button className="max-sm:h-11" onClick={add} disabled={rows.length >= MAX_ROWS}>
            Add bid
          </Button>
          <p className="max-w-[58ch] flex-1 basis-64 text-small text-muted">
            In a real sale only the enclave sees these prices. Prices are in USDC per token, and each deposit equals
            its max spend.
          </p>
        </div>
      </div>

      <div className="border-t border-line" aria-live="polite">
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
      // 16px below lg, so a phone does not zoom the page when the input takes focus.
      className={cn(
        "inset h-10 w-full min-w-0 border-control px-2.5 text-prose text-fg outline-none transition-[border-color,box-shadow] duration-[120ms] ease-surface hover:border-control-hover focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)] hover:focus:border-accent lg:h-8 lg:text-small",
        error && "border-bad",
        mono && "num lg:text-right",
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
    <div className="hidden overflow-x-auto border-t border-line lg:block">
      <table className="data-table min-w-[760px] [&_tbody_tr:hover]:bg-transparent">
        <caption className="sr-only">Bids and their results. Prices in USDC per token, spend and refunds in USDC.</caption>
        <thead>
          <tr>
            <th scope="col" className="pl-5">
              Bidder
            </th>
            <th scope="col" className="w-[120px] pr-6 text-right">
              Max price
            </th>
            <th scope="col" className="w-[104px] pr-6 text-right">
              Max spend
            </th>
            <th scope="col" className="text-right">
              Tokens
            </th>
            <th scope="col" className="text-right">
              Spent
            </th>
            <th scope="col" className="text-right">
              Refund
            </th>
            <th scope="col">Outcome</th>
            <th scope="col" className="w-12 pr-3 pl-0">
              <span className="sr-only">Remove</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => {
            const p = run.rows[idx];
            const fill = r && p.bidIndex !== null ? r.fills[p.bidIndex] : null;
            const outcome = r && p.bidIndex !== null && p.maxPrice !== null ? outcomeOf(r, p.bidIndex, p.maxPrice) : null;
            const rowError = p.bidderError ?? p.priceError ?? p.spendError;
            return (
              <tr key={row.key}>
                <td className="min-w-[150px] pl-5">
                  <CellInput
                    value={row.bidder}
                    onChange={(v) => onEdit(row.key, "bidder", v)}
                    label={`Bidder ${idx + 1}`}
                    error={p.bidderError}
                    mono={false}
                  />
                </td>
                <td>
                  <CellInput
                    value={row.price}
                    onChange={(v) => onEdit(row.key, "price", v)}
                    label={`Max price, bid ${idx + 1}, USDC per token`}
                    error={p.priceError}
                  />
                </td>
                <td>
                  <CellInput
                    value={row.spend}
                    onChange={(v) => onEdit(row.key, "spend", v)}
                    label={`Max spend, bid ${idx + 1}, USDC`}
                    error={p.spendError}
                  />
                </td>
                <td className="num text-right text-fg">{fill ? tok(fill.tokens) : "–"}</td>
                <td className="num text-right text-fg">{fill ? usdc6(fill.spent) : "–"}</td>
                <td className="num text-right text-fg">{fill ? usdc6(fill.refund) : "–"}</td>
                <td>
                  {rowError ? (
                    <span className="text-label text-bad">{rowError}</span>
                  ) : outcome ? (
                    <Badge tone={outcome.tone} dot plain>
                      {outcome.label}
                    </Badge>
                  ) : (
                    <span className="text-subtle">–</span>
                  )}
                </td>
                <td className="pr-3 pl-0 text-right">
                  <RemoveButton index={idx} disabled={rows.length <= 1} onClick={() => onRemove(row.key)} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Icon-only ghost button. 32px in the table, 44px on the phone cards. */
function RemoveButton({ index, disabled, onClick }: { index: number; disabled: boolean; onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="w-8 shrink-0 px-0 max-lg:h-11 max-lg:w-11"
      onClick={onClick}
      disabled={disabled}
      aria-label={`Remove bid ${index + 1}`}
      icon={<X className="size-4" strokeWidth={1.75} aria-hidden />}
    />
  );
}

function Results({ run }: { run: ExampleRun }) {
  const r = run.result;
  if (!r || run.supply === null || run.floor === null) {
    const why = run.supplyError || run.floorError ? "Fix the supply and floor above to run the clearing." : "Add at least one complete bid to run the clearing.";
    return <p className="p-4 text-body text-bad sm:p-5">{why}</p>;
  }

  const atFloor = r.clearingPrice === run.floor;
  // Valid bids only: invalid ones count as zero and are not part of demand.
  const curveBids = run.bids.filter((_, i) => r.fills[i].valid).map((b) => ({ maxPrice: b.maxPrice!, maxSpend: b.maxSpend! }));

  return (
    <div className="flex flex-col">
      <StatRow flush className="px-4 sm:px-5">
        <Stat
          label="Clearing price (P*)"
          value={priceStr(r.clearingPrice)}
          unit="USDC"
          tone="accent"
          hint={atFloor ? "equals the floor" : `${multiple(r.clearingPrice, run.floor)}× floor`}
        />
        <Stat label="Tokens sold" value={tok(r.totalSold)} hint={`of ${tok(run.supply)}`} />
        <Stat label="Raised" value={formatUnits(r.totalRaised, 6, 2)} unit="USDC" hint={`${r.nValid} valid of ${r.fills.length} bids`} />
        <Stat label="Unsold, burned" value={tok(r.unsold)} hint={r.oversubscribed ? "oversubscribed" : "undersubscribed"} />
      </StatRow>

      <div className="border-t border-line p-4 sm:p-5">
        {r.status === "failed" ? (
          <p className="text-body text-bad">
            No valid bids, so the sale fails. Every deposit is refunded, less the 1 % a void bid loses.
          </p>
        ) : (
          <Insight run={run} result={r} />
        )}
      </div>

      <div className={cn("border-t border-line p-4 sm:p-5", r.status === "failed" && "hidden")}>
        <h3 className="text-h3 text-fg">Demand at each price</h3>
        <p className="mt-1 max-w-[68ch] text-small text-muted">
          The tokens the bids could buy at each price, on a log scale. The line drops wherever a bid’s max price is
          passed, and P* is the last price where it still reaches the supply.
        </p>
        <div className="mt-2">
          <DemandChart
            bids={curveBids}
            floor={run.floor}
            supply={run.supply}
            clearingPrice={r.clearingPrice}
            decimals={DECIMALS}
          />
        </div>
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
        {ties.length === 1 ? "One bid sits" : `${ties.length} bids sit`} exactly at P*. After the bids above
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
        Every bid above P* fills in full at the same price.
      </>
    );
  }

  return (
    <p className="max-w-[68ch] text-body text-muted">{text}</p>
  );
}

/** Phones: one card per bid, the same inputs and results as a table row. */
function BidCards({
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
    <div className="border-t border-line px-4 sm:px-5 lg:hidden">
      <ol className="divide-y divide-line">
        {rows.map((row, idx) => {
          const p = run.rows[idx];
          const fill = r && p.bidIndex !== null ? r.fills[p.bidIndex] : null;
          const outcome = r && p.bidIndex !== null && p.maxPrice !== null ? outcomeOf(r, p.bidIndex, p.maxPrice) : null;
          const rowError = p.bidderError ?? p.priceError ?? p.spendError;
          return (
            <li key={row.key} className="py-4">
              <div className="flex items-center gap-2">
                <CellInput
                  value={row.bidder}
                  onChange={(v) => onEdit(row.key, "bidder", v)}
                  label={`Bidder ${idx + 1}`}
                  error={p.bidderError}
                  mono={false}
                />
                <RemoveButton index={idx} disabled={rows.length <= 1} onClick={() => onRemove(row.key)} />
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <div className="flex flex-col gap-1">
                  <span className="text-label text-subtle" aria-hidden>
                    Max price
                  </span>
                  <CellInput
                    value={row.price}
                    onChange={(v) => onEdit(row.key, "price", v)}
                    label={`Max price, bid ${idx + 1}, USDC per token`}
                    error={p.priceError}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-label text-subtle" aria-hidden>
                    Max spend
                  </span>
                  <CellInput
                    value={row.spend}
                    onChange={(v) => onEdit(row.key, "spend", v)}
                    label={`Max spend, bid ${idx + 1}, USDC`}
                    error={p.spendError}
                  />
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                <dl className="flex flex-wrap gap-x-3 gap-y-1 text-label">
                  <div className="flex gap-1">
                    <dt className="text-subtle">Tokens</dt>
                    <dd className="num text-fg">{fill ? tok(fill.tokens) : "–"}</dd>
                  </div>
                  <div className="flex gap-1">
                    <dt className="text-subtle">Spent</dt>
                    <dd className="num text-fg">{fill ? usdc6(fill.spent) : "–"}</dd>
                  </div>
                  <div className="flex gap-1">
                    <dt className="text-subtle">Refund</dt>
                    <dd className="num text-fg">{fill ? usdc6(fill.refund) : "–"}</dd>
                  </div>
                </dl>
                {rowError ? (
                  <span className="text-label text-bad">{rowError}</span>
                ) : outcome ? (
                  <Badge tone={outcome.tone} dot plain>
                    {outcome.label}
                  </Badge>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
