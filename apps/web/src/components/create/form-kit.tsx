"use client";

import { useId } from "react";
import { ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { sectionDomId, type Derived, type Draft, type FieldKey, type Notice, type SectionId } from "./model";
import type { SectionStatus } from "./progress";

/** What every section needs from the page. */
export type SectionProps = {
  draft: Draft;
  set: <K extends keyof Draft>(key: K, value: Draft[K]) => void;
  /** The error to show for a field right now, if any. */
  error: (key: FieldKey) => string | undefined;
  touch: (key: FieldKey) => void;
  derived: Derived;
  /** Where this section stands, for the header badge. */
  status?: SectionStatus;
};

/**
 * One block of the form: a hairline, a title row, at most one line under it,
 * then the fields. The six numbered sections pass `n` and `status`; the
 * fixed-rules block at the end passes neither.
 */
export function FormSection({
  id,
  n,
  title,
  description,
  status,
  children,
}: {
  id: SectionId | "fixed";
  n?: number;
  title: string;
  description?: React.ReactNode;
  status?: SectionStatus;
  children: React.ReactNode;
}) {
  const domId = id === "fixed" ? "create-fixed" : sectionDomId(id);
  return (
    <section id={domId} aria-labelledby={`${domId}-h`} className="scroll-mt-[72px] border-t border-line pt-6">
      <header className="mb-5">
        <div className="flex items-baseline gap-3">
          {n !== undefined && (
            <span aria-hidden className="num text-label text-subtle">
              {n}
            </span>
          )}
          <h2 id={`${domId}-h`} className="min-w-0 flex-1 text-h2 text-fg">
            {title}
          </h2>
          {status && <SectionState status={status} />}
        </div>
        {description && <p className="mt-1 max-w-[62ch] text-small text-muted">{description}</p>}
      </header>
      <div className="flex flex-col gap-5">{children}</div>
    </section>
  );
}

/** "Ready", "To do" or "Fix 2" at the right of a section title: a dot and a word. */
function SectionState({ status }: { status: SectionStatus }) {
  if (status.state === "fix") {
    return (
      <Badge plain dot tone="bad" className="shrink-0">
        Fix {status.count}
      </Badge>
    );
  }
  return (
    <Badge plain dot tone={status.state === "ready" ? "ok" : "neutral"} className="shrink-0">
      {status.state === "ready" ? "Ready" : "To do"}
    </Badge>
  );
}

/** Label for a group of chips or cards, matching Field's. */
export function Label({ children, htmlFor, id }: { children: React.ReactNode; htmlFor?: string; id?: string }) {
  const cls = "text-label font-[510] text-muted";
  return htmlFor ? (
    <label htmlFor={htmlFor} id={id} className={cls}>
      {children}
    </label>
  ) : (
    <div id={id} className={cls}>
      {children}
    </div>
  );
}

/** Multi-line text input styled like Field. */
export function TextArea({
  label,
  hint,
  error,
  counter,
  ...rest
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label: React.ReactNode;
  hint?: React.ReactNode;
  error?: string;
  counter?: React.ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <Label htmlFor={id}>{label}</Label>
        {counter && <span className="num text-label text-subtle">{counter}</span>}
      </div>
      <textarea
        id={id}
        rows={2}
        aria-invalid={!!error}
        aria-describedby={hint || error ? `${id}-d` : undefined}
        className={cn(
          "inset min-h-[72px] resize-y border-control px-3 py-2.5 text-body text-fg outline-none transition-[border-color,box-shadow] duration-[120ms] ease-surface placeholder:text-subtle hover:border-control-hover focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)] hover:focus:border-accent",
          error && "border-bad",
        )}
        {...rest}
      />
      {(error || hint) && (
        <p id={`${id}-d`} className={cn("text-label", error ? "text-bad" : "text-subtle")}>
          {error || hint}
        </p>
      )}
    </div>
  );
}

/** A chip label for a length that only makes sense on testnet: the length, then the word, quiet. */
export function PresetLabel({ preset }: { preset: { label: string; testnet?: boolean } }) {
  if (!preset.testnet) return preset.label;
  return (
    <>
      {preset.label}
      <span className="font-normal text-subtle">testnet</span>
    </>
  );
}

/**
 * Arrow keys for a hand-laid radio group (the mode cards, the colour discs):
 * the choice and the focus move together, as they do in Segmented.
 */
export function radioKeys<T>(values: readonly T[], value: T, onChange: (v: T) => void) {
  return (e: React.KeyboardEvent<HTMLElement>) => {
    const step =
      e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step || values.length === 0) return;
    e.preventDefault();
    const next = (Math.max(0, values.indexOf(value)) + step + values.length) % values.length;
    onChange(values[next]);
    e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
  };
}

/**
 * A choice that needs a line of explanation: a hairline card with a radio
 * mark. The selected choice uses an accent border and a faint wash.
 * Wrap a set of these in a role="radiogroup" with `radioKeys`.
 */
export function ChoiceCard({
  selected,
  onSelect,
  title,
  tag,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  title: React.ReactNode;
  /** One quiet word at the right: "Default", "Fallback". */
  tag?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      tabIndex={selected ? 0 : -1}
      onClick={onSelect}
      className={cn(
        "flex w-full flex-col items-start gap-1.5 rounded-tile border p-4 text-left transition-[background-color,border-color] duration-[120ms] ease-surface",
        selected ? "border-accent/40 bg-accent-soft" : "border-line hover:bg-wash",
      )}
    >
      <span className="flex w-full items-center gap-2.5">
        <span
          aria-hidden
          className={cn(
            "flex size-4 shrink-0 items-center justify-center rounded-full border",
            selected ? "border-accent" : "border-line-strong",
          )}
        >
          {selected && <span className="size-2 rounded-full bg-accent" />}
        </span>
        <span className="text-h3 text-fg">{title}</span>
        {tag && <span className="ml-auto text-label whitespace-nowrap text-subtle">{tag}</span>}
      </span>
      <span className="pl-[26px] text-small text-muted">{children}</span>
    </button>
  );
}

const NOTE_DOT = { warn: "bg-warn", bad: "bg-bad" } as const;

/**
 * One plain line of advice. A warning or a blocker gets a state dot; a
 * neutral note is just the line. No box.
 */
export function Note({
  tone = "neutral",
  children,
  className,
}: {
  tone?: Notice["tone"];
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      role={tone === "bad" ? "alert" : undefined}
      className={cn("flex items-start gap-2 text-small", tone === "bad" ? "text-fg" : "text-muted", className)}
    >
      {tone !== "neutral" && (
        <span aria-hidden className={cn("mt-[7px] size-1.5 shrink-0 rounded-full", NOTE_DOT[tone])} />
      )}
      <div className="min-w-0 max-w-[68ch]">{children}</div>
    </div>
  );
}

/** Notices for one section. */
export function SectionNotices({ notices, section }: { notices: Notice[]; section: SectionId }) {
  const mine = notices.filter((n) => n.section === section);
  if (!mine.length) return null;
  return (
    <div className="flex flex-col gap-2">
      {mine.map((n) => (
        <Note key={n.id} tone={n.tone}>
          {n.text}
        </Note>
      ))}
    </div>
  );
}

/** The reasoning behind a rule, folded away: a text link that opens a short paragraph. */
export function Why({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <details className="group">
      <summary className="inline-flex min-h-10 cursor-pointer list-none items-center gap-1 rounded-sm text-small text-muted underline decoration-line-strong underline-offset-4 transition-colors duration-[120ms] hover:text-fg sm:min-h-8 [&::-webkit-details-marker]:hidden">
        {label}
        <ChevronDown
          aria-hidden
          className="size-4 shrink-0 transition-transform duration-[120ms] group-open:rotate-180"
          strokeWidth={1.75}
        />
      </summary>
      <div className="mt-1.5 flex max-w-[68ch] flex-col gap-2 text-small text-muted">{children}</div>
    </details>
  );
}
