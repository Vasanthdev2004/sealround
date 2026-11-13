import { cn } from "@/lib/cn";
import { shortHash } from "@/lib/format";
import type { AttestationFact } from "@/lib/types";

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
