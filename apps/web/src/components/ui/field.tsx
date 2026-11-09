"use client";

import { useId } from "react";
import { cn } from "@/lib/cn";

/** Labelled input with optional unit suffix, hint and error. */
export function Field({
  label,
  hint,
  error,
  suffix,
  className,
  inputClassName,
  ...input
}: React.InputHTMLAttributes<HTMLInputElement> & {
  label: React.ReactNode;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  suffix?: React.ReactNode;
  inputClassName?: string;
}) {
  const id = useId();
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-[12.5px] font-medium text-muted">
        {label}
      </label>
      <div
        className={cn(
          "inset flex h-10 items-center gap-2 px-3 transition-colors focus-within:border-accent/60",
          error && "border-bad/60",
        )}
      >
        <input
          id={id}
          className={cn(
            "num h-full min-w-0 flex-1 bg-transparent text-[14px] text-fg outline-none placeholder:text-subtle",
            inputClassName,
          )}
          aria-invalid={!!error}
          aria-describedby={hint || error ? `${id}-d` : undefined}
          {...input}
        />
        {suffix && <span className="shrink-0 text-[12.5px] text-subtle">{suffix}</span>}
      </div>
      {(error || hint) && (
        <p id={`${id}-d`} className={cn("text-[12px]", error ? "text-bad" : "text-subtle")}>
          {error || hint}
        </p>
      )}
    </div>
  );
}

/**
 * Pill choice row, like the category filter row. A radio group: one option is
 * always chosen, arrow keys move between options. The chosen pill is a raised
 * tactile button, not the blue primary, which stays for each page's main action.
 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
  label,
  labelledBy,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: React.ReactNode; count?: number }[];
  className?: string;
  /** Accessible name for the group, when no visible label is linked. */
  label?: string;
  /** id of a visible label for the group. */
  labelledBy?: string;
}) {
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step || options.length === 0) return;
    e.preventDefault();
    const i = Math.max(0, options.findIndex((o) => o.value === value));
    const next = (i + step + options.length) % options.length;
    onChange(options[next].value);
    e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  };

  return (
    <div
      className={cn("flex flex-wrap items-center gap-1", className)}
      role="radiogroup"
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      onKeyDown={onKeyDown}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium transition-colors",
              active ? "btn-tactile text-fg" : "text-muted ring-1 ring-line hover:bg-hover hover:text-fg",
            )}
          >
            {o.label}
            {o.count !== undefined && (
              <span className={cn("num text-[11px]", active ? "text-muted" : "text-subtle")}>{o.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
