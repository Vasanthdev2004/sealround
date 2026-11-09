import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";
import { HOW_SECTIONS, sectionNumber, type HowSectionId } from "./sections";

/** One numbered section of /how. Dashed hairline above every section but the first. */
export function HowSection({
  id,
  title,
  lead,
  first,
  children,
}: {
  id: HowSectionId;
  title: React.ReactNode;
  lead?: React.ReactNode;
  first?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className={cn("scroll-mt-24", !first && "border-t border-dashed border-line-dashed pt-10")}
    >
      <header className="mb-5">
        <div className="num text-[12px] text-subtle">{sectionNumber(id)}</div>
        <h2 id={`${id}-title`} className="mt-1 font-display text-[19px] font-medium tracking-[-0.015em] text-fg">
          {title}
        </h2>
        {lead && <p className="mt-1.5 max-w-2xl text-[14px] leading-relaxed text-muted">{lead}</p>}
      </header>
      {children}
    </section>
  );
}

/** Collapsible table of contents for screens without the sticky rail. */
export function MobileToc({ className }: { className?: string }) {
  return (
    <details className={cn("group rounded-card border border-line bg-elev", className)}>
      <summary className="flex h-11 cursor-pointer list-none items-center justify-between px-4 text-[13px] font-medium text-fg [&::-webkit-details-marker]:hidden">
        On this page
        <ChevronDown className="size-4 text-subtle transition-transform group-open:rotate-180" strokeWidth={1.75} />
      </summary>
      <ol className="border-t border-dashed border-line-dashed px-2 py-2">
        {HOW_SECTIONS.map((s, i) => (
          <li key={s.id}>
            <a
              href={`#${s.id}`}
              className="flex h-9 items-center gap-3 rounded-lg px-2 text-[13px] text-muted hover:bg-hover hover:text-fg"
            >
              <span className="num w-5 text-[11.5px] text-subtle">{String(i + 1).padStart(2, "0")}</span>
              {s.label}
            </a>
          </li>
        ))}
      </ol>
    </details>
  );
}
