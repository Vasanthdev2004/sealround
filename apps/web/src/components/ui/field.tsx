"use client";

import { useId } from "react";
import { motion } from "motion/react";
import { cn } from "@/lib/cn";

/**
 * Labelled input with optional unit suffix, hint and error. `labelAside` puts a
 * small action (for example "Match max spend") at the right of the label row.
 */
export function Field({
  label,
  labelAside,
  hint,
  error,
  suffix,
  className,
  inputClassName,
  ...input
}: React.InputHTMLAttributes<HTMLInputElement> & {
  label: React.ReactNode;
  labelAside?: React.ReactNode;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  suffix?: React.ReactNode;
  inputClassName?: string;
}) {
  const id = useId();
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {labelAside ? (
        <div className="flex min-h-6 items-center justify-between gap-3">
          <label htmlFor={id} className="text-label font-[510] text-muted">
            {label}
          </label>
          {labelAside}
        </div>
      ) : (
        <label htmlFor={id} className="text-label font-[510] text-muted">
          {label}
        </label>
      )}
      <div
        className={cn(
          "inset flex h-10 items-center gap-2 px-3 transition-[border-color,box-shadow] duration-150 ease-surface",
          // cn does not merge classes, so the error and normal borders never both apply.
          error
            ? "border-bad focus-within:shadow-[var(--elev-well),0_0_0_4px_var(--bad-soft)]"
            : "border-control hover:border-control-hover focus-within:border-accent focus-within:shadow-[var(--elev-well),0_0_0_4px_var(--accent-soft)] hover:focus-within:border-accent",
        )}
      >
        <input
          id={id}
          className={cn(
            "num h-full min-w-0 flex-1 bg-transparent text-[15px] text-fg outline-none placeholder:text-subtle",
            inputClassName,
          )}
          aria-invalid={!!error}
          aria-describedby={hint || error ? `${id}-d` : undefined}
          {...input}
        />
        {suffix && <span className="shrink-0 text-label text-subtle">{suffix}</span>}
      </div>
      {(error || hint) && (
        <p id={`${id}-d`} className={cn("text-label", error ? "text-bad" : "text-subtle")}>
          {error || hint}
        </p>
      )}
    </div>
  );
}

/**
 * Segmented control. A radio group in a recessed track: one option is always
 * chosen, arrow keys move between options, and a lit thumb slides to the
 * chosen one (a spring, dropped under reduced motion).
 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
  label,
  labelledBy,
  scroll = false,
  scrollClassName,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: React.ReactNode; count?: number }[];
  className?: string;
  /** Accessible name for the group, when no visible label is linked. */
  label?: string;
  /** id of a visible label for the group. */
  labelledBy?: string;
  /**
   * One horizontally scrolling row with faded edges on phones, wrapping from
   * `sm` (the home filter pattern). Bleed it to the container edge with
   * negative margins in `scrollClassName`, e.g. "-mx-5 px-5 sm:mx-0 sm:px-0".
   */
  scroll?: boolean;
  scrollClassName?: string;
}) {
  const thumbId = useId();
  if (scroll) {
    return (
      <div
        className={cn(
          "-my-2 overflow-x-auto py-2 [scrollbar-width:none] max-sm:[mask-image:linear-gradient(90deg,transparent,#000_14px,#000_calc(100%-28px),transparent)] sm:overflow-visible [&::-webkit-scrollbar]:hidden",
          scrollClassName,
        )}
      >
        <Segmented
          value={value}
          onChange={onChange}
          options={options}
          label={label}
          labelledBy={labelledBy}
          className={cn("max-sm:w-max max-sm:flex-nowrap", className)}
        />
      </div>
    );
  }
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
      className={cn(
        "inline-flex max-w-full flex-wrap items-center gap-0.5 rounded-full bg-inset p-[3px] shadow-[inset_0_0_0_1px_var(--line),var(--elev-well)]",
        className,
      )}
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
              "btn-press relative inline-flex h-[30px] items-center gap-1.5 rounded-full px-3 text-[13.5px] font-[510] max-sm:h-9 max-sm:px-3.5",
              active ? "text-fg" : "text-muted hover:text-fg",
            )}
          >
            {/* The lit thumb slides to the chosen option. */}
            {active && (
              <motion.span
                layoutId={thumbId}
                aria-hidden
                className="seg-thumb absolute inset-0 rounded-full"
                transition={{ type: "spring", stiffness: 520, damping: 38, mass: 0.8 }}
              />
            )}
            {/* z-[1] keeps every label above the thumb while it slides past. */}
            <span className="relative z-[1]">{o.label}</span>
            {o.count !== undefined && (
              <span className={cn("num relative z-[1] text-[12.5px] font-normal", active ? "text-muted" : "text-subtle")}>
                {o.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
