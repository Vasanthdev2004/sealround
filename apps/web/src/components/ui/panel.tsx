import { cn } from "@/lib/cn";

export type PanelVariant = "base" | "raised" | "feature" | "outline" | "inset";

const surface: Record<PanelVariant, string> = {
  base: "panel",
  raised: "panel bg-elev-2",
  feature: "panel",
  outline: "panel-outline",
  inset: "inset rounded-panel",
};

/** True when a class string already sets padding, so the default is skipped. */
const hasPadding = (cls?: string) => !!cls && /(^|\s)(?:[a-z]+:)*p[xytrbl]?-/.test(cls);

/**
 * The main surface. Optional header row with title, subtitle, icon and action.
 *
 * Variants (see UI-DIRECTION.md, "Surfaces"):
 * - `base` (default): ordinary content.
 * - `feature`: the ONE most important block on a page.
 * - `raised`: a lighter surface for nested or secondary blocks.
 * - `outline`: dashed hairline, no fill, for quiet asides.
 * - `inset`: recessed, for code, quotes and wells.
 *
 * Body padding is 20px (24px from sm). If `bodyClassName` sets any padding
 * (`p-0`, `px-5 py-2`...), the default is dropped so yours applies.
 */
export function Panel({
  title,
  subtitle,
  action,
  icon,
  className,
  bodyClassName,
  headerClassName,
  children,
  id,
  variant = "base",
  as: Tag = "section",
}: {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
  icon?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  headerClassName?: string;
  children: React.ReactNode;
  id?: string;
  variant?: PanelVariant;
  as?: "section" | "div" | "article" | "aside";
}) {
  return (
    <Tag id={id} className={cn(surface[variant], "overflow-hidden", className)}>
      {(title || action) && (
        <header
          className={cn(
            "flex items-start justify-between gap-4 border-b border-line px-5 py-3.5",
            headerClassName,
          )}
        >
          <div className="flex min-w-0 items-start gap-3">
            {icon && (
              <span aria-hidden className="mt-0.5 shrink-0 text-muted [&>svg]:size-4">
                {icon}
              </span>
            )}
            <div className="min-w-0">
              {title && <h2 className="text-h3 text-fg">{title}</h2>}
              {subtitle && <p className="mt-0.5 text-label text-subtle">{subtitle}</p>}
            </div>
          </div>
          {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
        </header>
      )}
      <div className={cn(!hasPadding(bodyClassName) && "p-5", bodyClassName)}>{children}</div>
    </Tag>
  );
}

/**
 * Page title block: optional eyebrow line, a display-face h1, a lead paragraph
 * (max ~62ch), actions on the right, and an optional `aside` (a visual or a
 * stat) that sits to the right on wide screens and below on phones.
 */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  aside,
  size = "md",
  className,
}: {
  /** One short plain line, sentence case. Not a label above every page. */
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  aside?: React.ReactNode;
  /** `lg` uses the display size for landing-style pages. */
  size?: "md" | "lg";
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-x-8 gap-y-5", className)}>
      <div className="min-w-0 max-w-[44rem] flex-1 basis-[28rem]">
        {eyebrow && (
          <div className="anim-fade mb-3 inline-flex items-center gap-2 text-label text-subtle">{eyebrow}</div>
        )}
        {/* Focusable (not tabbable), so a flow can move focus here after a step change. */}
        <h1
          tabIndex={-1}
          className={cn("anim-rise text-fg outline-none", size === "lg" ? "text-display" : "text-h1")}
        >
          {title}
        </h1>
        {description && (
          <p
            className="anim-rise mt-4 max-w-[58ch] text-lead text-muted"
            style={{ "--i": 1 } as React.CSSProperties}
          >
            {description}
          </p>
        )}
        {actions && (
          <div className="anim-rise mt-6 flex flex-wrap items-center gap-3" style={{ "--i": 2 } as React.CSSProperties}>
            {actions}
          </div>
        )}
      </div>
      {aside && <div className="anim-fade w-full shrink-0 sm:w-auto">{aside}</div>}
    </div>
  );
}

/**
 * Header for a section inside a page (between panels): h2, optional one-line
 * description underneath, and an action (link, count, filter) on the right.
 */
export function SectionHeader({
  title,
  description,
  action,
  id,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  id?: string;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-x-6 gap-y-2", className)}>
      <div className="min-w-0">
        <h2 id={id} className="text-h2 text-fg">
          {title}
        </h2>
        {description && <p className="mt-1 max-w-[62ch] text-small text-muted">{description}</p>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2 text-small text-muted">{action}</div>}
    </div>
  );
}

/**
 * Empty / placeholder state. Says what is missing and offers the next step.
 */
export function Empty({
  title,
  body,
  action,
  icon,
  size = "md",
  titleAs: Title = "div",
  className,
}: {
  title: React.ReactNode;
  body?: React.ReactNode;
  action?: React.ReactNode;
  /** An optional icon that reinforces the state. */
  icon?: React.ReactNode;
  /** `lg`: more space and a larger title for page-level states. */
  size?: "md" | "lg";
  /** Render the title as a heading, e.g. "h1" when the empty state is the page (not found). */
  titleAs?: "div" | "h1" | "h2" | "h3";
  className?: string;
}) {
  const lg = size === "lg";
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-panel border border-line px-6 text-center",
        lg ? "py-12" : "py-8",
        className,
      )}
    >
      {icon && (
        <span aria-hidden className="mb-1 text-muted [&>svg]:size-5">
          {icon}
        </span>
      )}
      <Title className={cn("text-fg", lg ? "text-h2" : "text-h3")}>{title}</Title>
      {body && <div className="max-w-sm text-small text-muted">{body}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

/** Hairline divider. */
export function Rule({ className }: { className?: string }) {
  return <hr className={cn("border-0 border-t border-line", className)} />;
}
