import Link from "next/link";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";

type Variant = "tactile" | "primary" | "ghost" | "danger" | "outline";
/** `square` is a 44px icon-only button (menu, close); give it an aria-label. */
type Size = "sm" | "md" | "lg" | "square";

const base =
  "inline-flex items-center justify-center gap-2 font-[510] whitespace-nowrap select-none [&_svg]:shrink-0";

const variants: Record<Variant, string> = {
  tactile: "btn-tactile text-fg",
  primary: "btn-primary",
  danger: "btn-danger",
  ghost:
    "rounded-btn text-muted transition-[color,background-color] duration-[120ms] ease-surface hover:bg-wash hover:text-fg active:bg-wash-strong",
  outline:
    "rounded-btn text-fg shadow-[inset_0_0_0_1px_var(--line-strong)] transition-[background-color,box-shadow] duration-[120ms] ease-surface hover:bg-wash hover:shadow-[inset_0_0_0_1px_var(--line-hover)] active:bg-wash-strong",
};

const sizes: Record<Size, string> = {
  sm: "h-8 px-3 text-[13px]",
  md: "h-9 px-3.5 text-[14px]",
  lg: "h-11 px-5 text-[15px]",
  square: "size-11 shrink-0 [&_svg]:size-4",
};

/** All native button props (including `ref`, a plain prop in React 19). */
export type ButtonProps = React.ComponentProps<"button"> & {
  variant?: Variant;
  size?: Size;
  /** Shows a spinner in place of the icon, keeps the label, sets aria-busy and disables. */
  loading?: boolean;
  icon?: React.ReactNode;
};

/**
 * A flat button with 8px corners. Use one blue `primary` per decision area.
 * `tactile` is the default secondary. `danger` marks an irreversible action.
 */
export function Button({
  variant = "tactile",
  size = "md",
  loading,
  icon,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={cn(base, variants[variant], sizes[size], className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Loader2 className={cn("animate-spin", size === "lg" ? "size-[18px]" : size === "sm" ? "size-3.5" : "size-4")} aria-hidden /> : icon}
      {children}
    </button>
  );
}

export function ButtonLink({
  href,
  variant = "tactile",
  size = "md",
  icon,
  className,
  children,
  external,
}: {
  href: string;
  variant?: Variant;
  size?: Size;
  icon?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
  external?: boolean;
}) {
  const cls = cn(base, variants[variant], sizes[size], className);
  if (external) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={cls}>
        {icon}
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={cls}>
      {icon}
      {children}
    </Link>
  );
}
