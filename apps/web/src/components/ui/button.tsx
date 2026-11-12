import Link from "next/link";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";

type Variant = "tactile" | "primary" | "ghost" | "danger" | "outline";
/** `square` is a 44px icon-only button (menu, close); give it an aria-label. */
type Size = "sm" | "md" | "lg" | "square";

const base =
  "inline-flex items-center justify-center gap-2 font-[510] whitespace-nowrap select-none [&_svg]:shrink-0";

/* Paint and press live in globals.css (`.btn-lit`, `.btn-press`). */
const variants: Record<Variant, string> = {
  tactile: "btn-lit btn-tactile",
  primary: "btn-lit btn-primary",
  danger: "btn-lit btn-danger",
  ghost: "btn-press text-muted hover:bg-wash hover:text-fg active:bg-wash-strong",
  outline:
    "btn-press text-fg shadow-[inset_0_0_0_1px_var(--line-strong)] hover:bg-wash hover:shadow-[inset_0_0_0_1px_var(--line-hover)] active:bg-wash-strong",
};

/* Radius grows with height so the curve reads the same at every size. */
const sizes: Record<Size, string> = {
  sm: "h-8 rounded-[8px] px-3 text-[13px]",
  md: "h-9 rounded-btn px-3.5 text-[14px]",
  lg: "h-11 rounded-[12px] px-5 text-[15px]",
  square: "size-11 shrink-0 rounded-[12px] [&_svg]:size-4",
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
 * A lit button: gradient body and edge, sinks on press and springs back.
 * Use one blue `primary` per decision area. `tactile` is the default
 * secondary. `danger` marks an irreversible action. `ghost` and `outline`
 * are flat but share the press.
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
