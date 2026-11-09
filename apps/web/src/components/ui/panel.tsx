import { cn } from "@/lib/cn";

/** The main surface. Optional header row with title, subtitle and action. */
export function Panel({
  title,
  subtitle,
  action,
  icon,
  className,
  bodyClassName,
  children,
  id,
}: {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
  icon?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  children: React.ReactNode;
  id?: string;
}) {
  return (
    <section id={id} className={cn("panel overflow-hidden", className)}>
      {(title || action) && (
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-3.5">
          <div className="flex min-w-0 items-start gap-2.5">
            {icon && <span className="mt-0.5 text-muted [&>svg]:size-4">{icon}</span>}
            <div className="min-w-0">
              {title && <h2 className="text-[14px] font-medium tracking-[-0.01em] text-fg">{title}</h2>}
              {subtitle && <p className="mt-0.5 text-[12.5px] text-muted">{subtitle}</p>}
            </div>
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </header>
      )}
      <div className={cn("p-5", bodyClassName)}>{children}</div>
    </section>
  );
}

/** Page title block, matching the quiet centered/left headline style. */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  className,
}: {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-4", className)}>
      <div className="min-w-0 max-w-2xl">
        {eyebrow && <div className="mb-2 text-[12px] font-medium text-subtle">{eyebrow}</div>}
        <h1 className="font-display text-[22px] leading-[1.2] font-medium tracking-[-0.02em] text-fg sm:text-[26px]">
          {title}
        </h1>
        {description && <p className="mt-2 text-[14px] leading-relaxed text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Empty / placeholder state over the diagonal hatch. */
export function Empty({
  title,
  body,
  action,
  className,
}: {
  title: React.ReactNode;
  body?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "hatch flex flex-col items-center justify-center gap-2 rounded-panel border border-dashed border-line-dashed px-6 py-12 text-center",
        className,
      )}
    >
      <div className="text-[14px] font-medium text-fg">{title}</div>
      {body && <div className="max-w-sm text-[13px] text-muted">{body}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** Dashed hairline divider. */
export function Rule({ className }: { className?: string }) {
  return <hr className={cn("rule-dashed border-0 border-t", className)} />;
}
