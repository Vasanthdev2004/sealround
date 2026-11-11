import { HOW_SECTIONS, type HowSectionId } from "./sections";

/**
 * One numbered section of the reading column: the number, the title, one lead
 * sentence, then the content. Sections are separated by space, not rules, so a
 * ledger that ends a section never doubles a hairline with the next one.
 */
export function HowSection({
  id,
  title,
  lead,
  children,
}: {
  id: HowSectionId;
  title: React.ReactNode;
  lead?: React.ReactNode;
  children: React.ReactNode;
}) {
  const n = HOW_SECTIONS.findIndex((s) => s.id === id) + 1;
  return (
    // Below xl the sticky index bar sits under the top bar, so anchors stop further down.
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-[116px] xl:scroll-mt-24">
      <header className="mb-5 sm:mb-6">
        <div aria-hidden className="num text-label text-subtle">
          {String(n).padStart(2, "0")}
        </div>
        <h2 id={`${id}-title`} className="mt-2 text-h2 text-fg">
          {title}
        </h2>
        {lead && <p className="mt-2 max-w-[68ch] text-prose text-muted">{lead}</p>}
      </header>
      {children}
    </section>
  );
}
