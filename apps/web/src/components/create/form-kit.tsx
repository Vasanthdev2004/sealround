"use client";

import { useId } from "react";
import { CircleExclamationPoint, Info, Lock, TriangleExclamationPoint } from "lucide-react";
import { Panel } from "@/components/ui/panel";
import { cn } from "@/lib/cn";
import { sectionDomId, type Derived, type Draft, type FieldKey, type Notice, type SectionId } from "./model";

/** What every section needs from the page. */
export type SectionProps = {
  draft: Draft;
  set: <K extends keyof Draft>(key: K, value: Draft[K]) => void;
  /** The error to show for a field right now, if any. */
  error: (key: FieldKey) => string | undefined;
  touch: (key: FieldKey) => void;
  derived: Derived;
};

/** One numbered section of the wizard. */
export function FormSection({
  id,
  n,
  title,
  description,
  children,
}: {
  id: SectionId;
  n: number;
  title: string;
  description: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Panel
      id={sectionDomId(id)}
      className="scroll-mt-20"
      title={
        <span className="flex items-baseline gap-2.5">
          <span className="num text-[12px] text-subtle">{String(n).padStart(2, "0")}</span>
          {title}
        </span>
      }
      subtitle={description}
      bodyClassName="flex flex-col gap-4"
    >
      {children}
    </Panel>
  );
}

/** Small field label, matching Field's. */
export function Label({ children, htmlFor, id }: { children: React.ReactNode; htmlFor?: string; id?: string }) {
  const cls = "text-[12.5px] font-medium text-muted";
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
        {counter && <span className="num text-[11.5px] text-subtle">{counter}</span>}
      </div>
      <textarea
        id={id}
        rows={3}
        aria-invalid={!!error}
        aria-describedby={hint || error ? `${id}-d` : undefined}
        className={cn(
          "inset min-h-[84px] resize-y px-3 py-2.5 text-[14px] leading-relaxed text-fg outline-none transition-colors placeholder:text-subtle focus:border-accent/60",
          error && "border-bad/60",
        )}
        {...rest}
      />
      {(error || hint) && (
        <p id={`${id}-d`} className={cn("text-[12px]", error ? "text-bad" : "text-subtle")}>
          {error || hint}
        </p>
      )}
    </div>
  );
}

/** Tactile on/off switch. */
export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full ring-1 transition-colors",
        checked ? "bg-accent ring-accent-strong" : "bg-inset ring-line-strong",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-4 rounded-full transition-transform duration-150",
          checked ? "translate-x-[19px]" : "translate-x-[3px]",
        )}
        style={{
          background: "linear-gradient(#ffffff, #d4d4da)",
          boxShadow: "0 1px 2px rgba(0,0,0,.45), inset 0 -1px 1px rgba(0,0,0,.12)",
        }}
      />
    </button>
  );
}

/** Radio card. Wrap a set of these in a role="radiogroup". */
export function ChoiceCard({
  selected,
  onSelect,
  title,
  tag,
  disabled,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  title: React.ReactNode;
  tag?: React.ReactNode;
  /** Shown for context but not selectable. */
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onSelect}
      className={cn(
        "tile flex w-full flex-col items-start gap-1.5 p-4 text-left transition-colors",
        selected ? "bg-accent-soft ring-1 ring-accent/60" : !disabled && "hover:bg-hover",
      )}
    >
      <span className="flex w-full items-center gap-2.5">
        <span
          aria-hidden
          className={cn(
            "flex size-4 shrink-0 items-center justify-center rounded-full ring-1",
            selected ? "bg-accent ring-accent-strong" : "bg-inset ring-line-strong",
          )}
        >
          {selected && <span className="size-1.5 rounded-full bg-white" />}
        </span>
        <span className="text-[13.5px] font-medium text-fg">{title}</span>
        {tag && <span className="ml-auto">{tag}</span>}
      </span>
      <span className="pl-[26px] text-[12.5px] leading-relaxed text-muted">{children}</span>
    </button>
  );
}

const NOTE_TONE = {
  warn: { box: "bg-warn-soft ring-warn/20", icon: "text-warn", Icon: TriangleExclamationPoint },
  bad: { box: "bg-bad-soft ring-bad/25", icon: "text-bad", Icon: CircleExclamationPoint },
  neutral: { box: "bg-hover ring-line", icon: "text-subtle", Icon: Info },
} as const;

/** Inline plain-words note. */
export function Note({
  tone = "neutral",
  children,
  className,
}: {
  tone?: Notice["tone"];
  children: React.ReactNode;
  className?: string;
}) {
  const t = NOTE_TONE[tone];
  return (
    <div
      role={tone === "bad" ? "alert" : undefined}
      className={cn("flex items-start gap-2.5 rounded-tile px-3 py-2.5 ring-1", t.box, className)}
    >
      <t.Icon className={cn("mt-px size-4 shrink-0", t.icon)} strokeWidth={1.75} aria-hidden />
      <div className="min-w-0 text-[12.5px] leading-snug text-fg/90">{children}</div>
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

/** A rule that is fixed for every sale: shown, not editable. */
export function LockedRow({ label, value, detail }: { label: string; value: React.ReactNode; detail: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-3">
      <Lock className="mt-0.5 size-4 shrink-0 text-subtle" strokeWidth={1.75} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <span className="text-[13px] text-fg">{label}</span>
          <span className="num text-[13px] text-fg">{value}</span>
        </div>
        <p className="mt-0.5 text-[12px] leading-snug text-subtle">{detail}</p>
      </div>
    </div>
  );
}
