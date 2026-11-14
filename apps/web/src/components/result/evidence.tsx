"use client";

import { Download } from "lucide-react";
import type { CheckState } from "@/components/ui/bits";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { fromB64 } from "@/lib/crypto";
import { shortHash } from "@/lib/format";
import type { AttestationFact } from "@/lib/types";
import type { ChainCheck } from "@/lib/verify/types";
import { CopyButton } from "./trade";

/** Hex of 40 or more characters reads as a hash. */
const isHash = (v: string) => /^[0-9a-f]{40,}$/i.test(v);

/** The short value stays readable, with the full hash available without a pointer. */
function Value({ value }: { value: string }) {
  if (!isHash(value)) return <span>{value}</span>;
  return <span title={value}>{shortHash(value, 6)}</span>;
}

/**
 * Values that must all be equal, on one mono line with = or ≠ between them.
 * It wraps on phones.
 */
export function Chain({ values, ok }: { values: { label: string; value: string }[]; ok: boolean }) {
  return (
    <div className="min-w-0">
      <p className="cipher flex flex-wrap items-baseline gap-x-2 [overflow-wrap:anywhere] [word-break:normal]">
        {values.map((v, i) => (
          <span key={`${v.label}-${i}`} className="contents">
            {i > 0 && (
              <span className={ok ? "text-ok" : "text-bad"} role="img" aria-label={ok ? "equals" : "does not equal"}>
                {ok ? "=" : "≠"}
              </span>
            )}
            <span>
              <span className="font-sans text-label text-subtle">{v.label}</span> <Value value={v.value} />
            </span>
          </span>
        ))}
      </p>
      <FullHashes values={values} />
    </div>
  );
}

/** One piece of a check's evidence: an equality chain, or a fact (red when it fails). */
export function Evidence({ item }: { item: AttestationFact }) {
  if (item.kind === "equal") return <Chain values={item.values} ok={item.ok} />;
  return (
    <div className="min-w-0">
      <p className={cn("cipher [overflow-wrap:anywhere] [word-break:normal]", !item.ok && "text-bad")}>
        <span className={cn("font-sans text-label", item.ok ? "text-subtle" : "text-bad")}>{item.label}</span>{" "}
        <Value value={item.value} />
      </p>
      <FullHashes values={[item]} />
    </div>
  );
}

function FullHashes({ values }: { values: { label: string; value: string }[] }) {
  const hashes = values.filter(({ value }) => isHash(value));
  if (!hashes.length) return null;
  return (
    <details className="mt-1 text-label text-muted">
      <summary className="w-fit cursor-pointer rounded-sm">
        Full {hashes.length === 1 ? "hash" : "hashes"}
        <span className="sr-only"> for {hashes.map(({ label }) => label).join(", ")}</span>
      </summary>
      <dl className="mt-1 space-y-1">
        {hashes.map(({ label, value }, i) => (
          <div key={`${label}-${i}`}>
            <dt>{label}</dt>
            <dd className="cipher [overflow-wrap:anywhere]">{value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

export function Note({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "subtle" | "bad" }) {
  return (
    <p className={cn("text-label", { muted: "text-muted", subtle: "text-subtle", bad: "text-bad" }[tone])}>
      {children}
    </p>
  );
}

/**
 * A contract or rule check's row state (lib/verify): pending until the
 * evidence is in, then pass or fail; "Not applicable" when it does not apply
 * to this sale, "Not run" when it could not run here.
 */
export function chainRowState(check: ChainCheck | null, ready: boolean): { state: CheckState; idle: string } {
  if (!ready) return { state: "pending", idle: "Not run" };
  if (!check) return { state: "idle", idle: "Not run" };
  if (!check.applies) return { state: "idle", idle: "Not applicable" };
  return { state: check.ok === true ? "pass" : check.ok === false ? "fail" : "idle", idle: "Not run" };
}

/** The evidence of a contract or rule check, or why it did not run. */
export function ChainEvidence({ check, error }: { check: ChainCheck | null; error?: string }) {
  if (!check) return <Note>{error ? "Not run: the evidence could not be fetched." : "Not run: this network gives nothing to check it against."}</Note>;
  if (!check.applies || check.items.length === 0) return <Note>{check.note ?? "Nothing to check."}</Note>;
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      {check.items.map((item, i) => (
        <Evidence key={i} item={item} />
      ))}
      {check.note && <Note tone={check.ok === false ? "bad" : "subtle"}>{check.note}</Note>}
    </div>
  );
}

/** Characters of the quote shown on the page; the whole quote is about 5 KB of base64. */
const QUOTE_SHOWN = 96;

/**
 * The start of a TDX quote, with the whole quote one click away: Copy puts the
 * base64 on the clipboard, Download saves the raw bytes for a quote verifier.
 */
export function QuoteExcerpt({ quote, label, fileName }: { quote: string; label: string; fileName: string }) {
  let bytes: Uint8Array | null = null;
  try {
    bytes = fromB64(quote);
  } catch {
    bytes = null;
  }
  const download = () => {
    const body = bytes ?? new TextEncoder().encode(quote);
    const url = URL.createObjectURL(new Blob([body as BlobPart], { type: "application/octet-stream" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="text-label text-subtle">
          {label}, <span className="num">{(bytes?.length ?? quote.length).toLocaleString("en-US")}</span> {bytes ? "bytes" : "characters"}
        </span>
        <span className="-mr-2 flex items-center">
          <CopyButton text={quote} what="TDX quote" />
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 px-2"
            onClick={download}
            aria-label="Download the TDX quote"
            icon={<Download className="size-3.5" aria-hidden />}
          >
            Download
          </Button>
        </span>
      </div>
      <p className="cipher mt-1 [overflow-wrap:anywhere]">
        {quote.length > QUOTE_SHOWN ? `${quote.slice(0, QUOTE_SHOWN)}…` : quote}
      </p>
    </div>
  );
}
