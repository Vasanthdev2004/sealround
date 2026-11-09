"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { HOW_SECTIONS } from "./sections";

/** Line below the sticky top bar at which a section counts as "current". */
const ACTIVE_LINE = 140;

/** Sticky in-page table of contents with the current section highlighted. */
export function HowToc() {
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

  return (
    <nav aria-label="On this page">
      <div className="mb-3 text-[12px] text-subtle">On this page</div>
      <ol className="flex flex-col border-l border-line">
        {HOW_SECTIONS.map((s, i) => {
          const on = s.id === active;
          return (
            <li key={s.id}>
              <a
                href={`#${s.id}`}
                aria-current={on ? "location" : undefined}
                className={cn(
                  "-ml-px flex items-baseline gap-2.5 border-l py-1.5 pl-3.5 text-[13px] transition-colors",
                  on ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg",
                )}
              >
                <span className={cn("num text-[11px]", on ? "text-accent" : "text-subtle")}>
                  {String(i + 1).padStart(2, "0")}
                </span>
                {s.label}
              </a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
