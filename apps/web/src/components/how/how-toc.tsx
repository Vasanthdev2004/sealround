"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { HOW_SECTIONS } from "./sections";

/** Line below the sticky bars at which a section counts as "current". */
const ACTIVE_LINE = 140;

/** The id of the section the reader is in, updated on scroll and resize. */
function useActiveSection(): string {
  const [active, setActive] = useState<string>(HOW_SECTIONS[0].id);

  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      let current: string = HOW_SECTIONS[0].id;
      for (const s of HOW_SECTIONS) {
        const el = document.getElementById(s.id);
        if (el && el.getBoundingClientRect().top <= ACTIVE_LINE) current = s.id;
      }
      const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
      if (atBottom) current = HOW_SECTIONS[HOW_SECTIONS.length - 1].id;
      setActive(current);
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    schedule();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return active;
}

/** Sticky in-page index for wide screens, with the current section marked. */
export function HowToc() {
  const active = useActiveSection();
  return (
    <nav aria-label="On this page">
      <div className="mb-3 text-label text-subtle">On this page</div>
      <ul className="flex flex-col border-l border-line">
        {HOW_SECTIONS.map((s) => {
          const on = s.id === active;
          return (
            <li key={s.id}>
              <a
                href={`#${s.id}`}
                aria-current={on ? "location" : undefined}
                className={cn(
                  "-ml-px block border-l py-1.5 pr-2 pl-3.5 text-small transition-colors duration-[120ms]",
                  on ? "border-accent font-[510] text-fg" : "border-transparent text-muted hover:text-fg",
                )}
              >
                {s.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * The same index as one scrolling row, for screens without room for the rail.
 * It sticks under the top bar and keeps the current section in view.
 */
export function HowTocBar({ className }: { className?: string }) {
  const active = useActiveSection();
  const scroller = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const list = scroller.current;
    const link = list?.querySelector<HTMLElement>('[aria-current="location"]');
    if (!list || !link) return;
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Scroll the row itself, never the page, so it cannot fight the reader's scrolling.
    list.scrollTo({ left: link.offsetLeft - 16, behavior: smooth ? "smooth" : "auto" });
  }, [active]);

  return (
    <nav aria-label="On this page" className={cn("bg-bg", className)}>
      {/* The rule under the row is an inset line on the scroller, so the current link's underline sits on it. */}
      <ul
        ref={scroller}
        className="relative flex overflow-x-auto px-4 shadow-[inset_0_-1px_0_var(--line)] [scrollbar-width:none] sm:px-6 lg:px-8 [&::-webkit-scrollbar]:hidden"
      >
        {HOW_SECTIONS.map((s, i) => {
          const on = s.id === active;
          return (
            <li key={s.id} className="shrink-0">
              <a
                href={`#${s.id}`}
                aria-current={on ? "location" : undefined}
                className={cn(
                  "flex h-11 items-center gap-1.5 border-b px-2.5 text-small whitespace-nowrap transition-colors duration-[120ms] focus-visible:outline-offset-[-2px]",
                  i === 0 && "-ml-2.5",
                  on ? "border-accent font-[510] text-fg" : "border-transparent text-muted hover:text-fg",
                )}
              >
                <span className="num text-label font-normal text-subtle">{i + 1}</span>
                {s.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
