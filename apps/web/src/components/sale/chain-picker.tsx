"use client";

import { ChainLogo } from "@/components/ui/chain-logo";
import { cn } from "@/lib/cn";
import { ORIGINS, type OriginId } from "@/lib/oneclick";

/**
 * "Pay with": one tile per origin chain, with its mark, its name and the asset
 * sent from it. Five across when the panel is wide enough, three across below
 * that. A radio group: arrow keys move the choice, Tab leaves the group.
 */
export function ChainPicker({
  value,
  onChange,
  disabled = false,
  labelledBy,
  className,
}: {
  value: OriginId;
  onChange: (id: OriginId) => void;
  disabled?: boolean;
  labelledBy?: string;
  className?: string;
}) {
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step =
      e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step || disabled) return;
    e.preventDefault();
    const i = Math.max(0, ORIGINS.findIndex((o) => o.id === value));
    const next = (i + step + ORIGINS.length) % ORIGINS.length;
    onChange(ORIGINS[next].id);
    e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  };

  return (
    <div className={cn("@container", className)}>
      <div
        role="radiogroup"
        aria-labelledby={labelledBy}
        aria-disabled={disabled || undefined}
        onKeyDown={onKeyDown}
        className="grid grid-cols-3 gap-1.5 @[19rem]:grid-cols-5 @[19rem]:gap-1"
      >
        {ORIGINS.map((o) => {
          const active = o.id === value;
          return (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={active}
              tabIndex={active ? 0 : -1}
              disabled={disabled && !active}
              onClick={() => onChange(o.id)}
              className={cn(
                "btn-press group flex min-w-0 flex-col items-center gap-1 rounded-[12px] px-0.5 pt-2.5 pb-2 transition-[background-color,box-shadow,color] duration-150 disabled:opacity-50",
                active
                  ? "bg-accent-soft text-fg shadow-[inset_0_0_0_1.5px_var(--accent)]"
                  : "bg-inset text-muted shadow-[inset_0_0_0_1px_var(--line)] hover:text-fg hover:shadow-[inset_0_0_0_1px_var(--line-hover)]",
              )}
            >
              <ChainLogo
                chain={o.blockchain}
                className={cn(
                  "size-6 transition-[filter,opacity] duration-150",
                  !active && "opacity-80 saturate-[.85] group-hover:opacity-100 group-hover:saturate-100",
                )}
              />
              <span className="max-w-full truncate text-[12px] leading-tight font-[510] tracking-[-0.01em]">{o.chain}</span>
              <span className={cn("num text-[11px] leading-none", active ? "text-accent-bright" : "text-subtle")}>
                {o.symbol}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
