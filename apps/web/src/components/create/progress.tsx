"use client";

import { ArrowRight, Check, Loader2 } from "lucide-react";
import { Progress } from "@/components/ui/stat";
import { cn } from "@/lib/cn";
import { scrollToEl } from "@/lib/scroll";
import { FIELD_ORDER, SECTION_OF, sectionDomId, type Derived, type FieldKey, type SectionId } from "./model";

/**
 * The sections, in form order. The launch pool comes last so that hiding it
 * (a contract without launch liquidity) never renumbers the others.
 */
export const SECTIONS: { id: SectionId; n: number; label: string }[] = [
  { id: "token", n: 1, label: "Token" },
  { id: "allocation", n: 2, label: "Allocation" },
  { id: "price", n: 3, label: "Price" },
  { id: "window", n: 4, label: "Bid window" },
  { id: "limits", n: 5, label: "Limits" },
  { id: "mode", n: 6, label: "Bid privacy" },
  { id: "pool", n: 7, label: "Launch pool" },
];

/**
 * `ready`: nothing to fix. `todo`: something is missing but the user has not
 * been told yet (untouched fields). `fix`: errors are on screen.
 */
export type SectionStatus = { state: "ready" | "todo" | "fix"; count: number };
/** Every section's status; `pool` only when the section shows. */
export type SectionStatuses = Record<Exclude<SectionId, "pool">, SectionStatus> & { pool?: SectionStatus };

/** Where each section stands. `shown(k)` says whether field k's error is on screen. */
export function sectionStatuses(derived: Derived, shown: (k: FieldKey) => boolean): SectionStatuses {
  const out = {} as Record<SectionId, SectionStatus>;
  for (const s of SECTIONS) {
    if (s.id !== "pool" || derived.poolAvailable) out[s.id] = { state: "ready", count: 0 };
  }
  for (const k of FIELD_ORDER) {
    if (!derived.errors[k]) continue;
    const st = out[SECTION_OF[k]];
    if (!st) continue;
    st.count += 1;
    if (shown(k)) st.state = "fix";
    else if (st.state === "ready") st.state = "todo";
  }
  // A sale that can never succeed is a price problem even when every field parses.
  if (derived.insights.impossible && out.price.state === "ready") out.price = { state: "fix", count: 1 };
  return out;
}

const goTo = (id: SectionId) => (e: React.MouseEvent<HTMLAnchorElement>) => {
  const el = document.getElementById(sectionDomId(id));
  if (!el) return;
  e.preventDefault();
  scrollToEl(el);
};

/**
 * The summary card's progress line: how many of the sections shown are ready,
 * a 4px bar, and a link to the first one that is not.
 */
export function SectionProgress({ statuses, className }: { statuses: SectionStatuses; className?: string }) {
  const all = statuses as Partial<Record<SectionId, SectionStatus>>;
  const shown = SECTIONS.flatMap((s) => {
    const status = all[s.id];
    return status ? [{ ...s, status }] : [];
  });
  const ready = shown.filter((s) => s.status.state === "ready").length;
  const next = shown.find((s) => s.status.state !== "ready");
  return (
    <nav aria-label="Sections" className={cn("min-w-0", className)}>
      <div className="flex min-h-6 items-center justify-between gap-3">
        <span className="text-label text-muted" aria-live="polite">
          <span className="num text-fg">{ready}</span> of {shown.length} ready
        </span>
        {next && (
          <a
            href={`#${sectionDomId(next.id)}`}
            onClick={goTo(next.id)}
            className={cn(
              "-my-2 inline-flex min-h-10 items-center gap-1 rounded-sm text-label transition-colors duration-[120ms] hover:text-fg",
              next.status.state === "fix" ? "text-bad" : "text-muted",
            )}
          >
            {next.status.state === "fix" ? "Fix" : "Next"}: {next.label}
            <ArrowRight className="size-3.5" strokeWidth={1.75} aria-hidden />
          </a>
        )}
      </div>
      <Progress value={ready} max={shown.length} label="Sections ready" className="mt-2" />
    </nav>
  );
}

const STEPS = ["Set the rules", "Review", "Create"] as const;

/**
 * Where the creator is: a flat list of the three steps. `at` is the index of
 * the current step (3 once the sale exists); `busy` spins the current one
 * while its transaction is out.
 */
export function CreateSteps({ at, busy = false }: { at: 0 | 1 | 2 | 3; busy?: boolean }) {
  return (
    <ol aria-label="Steps" className="flex flex-wrap items-center gap-x-5 gap-y-1">
      {STEPS.map((label, i) => {
        const state = i < at ? "done" : i === at ? "current" : "upcoming";
        return (
          <li
            key={label}
            aria-current={state === "current" ? "step" : undefined}
            className="flex min-h-6 items-center gap-2 text-label"
          >
            <span aria-hidden className="flex w-3.5 justify-center">
              {state === "done" ? (
                <Check className="size-3.5 text-ok" strokeWidth={2.5} />
              ) : state === "current" && busy ? (
                <Loader2 className="size-3.5 animate-spin text-muted" />
              ) : (
                <span className={cn("num", state === "current" ? "text-fg" : "text-subtle")}>{i + 1}</span>
              )}
            </span>
            <span
              className={cn(
                state === "current" ? "font-[510] text-fg" : state === "done" ? "text-muted" : "text-subtle",
              )}
            >
              {label}
            </span>
            <span className="sr-only">
              {state === "done" ? ", done" : state === "current" ? (busy ? ", in progress" : ", current step") : ""}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
