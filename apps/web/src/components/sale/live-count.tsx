"use client";

import { useLayoutEffect, useRef } from "react";
import { useReducedMotionSafe } from "@/components/visual/use-reduced-motion";
import { cn } from "@/lib/cn";

const DURATION = 450;

/**
 * A live total that counts from its last value to a new one, so a bid landing
 * shows as movement. React renders the exact final text; while counting, the
 * frames rewrite that text node and the last frame puts the exact text back.
 *
 * It never counts on first render, under reduced motion, or in a hidden tab.
 * Browsers stop animation frames when a page is not painting, so the text
 * between frames is always the final one: a count only shows inside frames,
 * and a timer and the tab's visibility change finish a count that frames
 * stopped half way. Screen readers only ever get the final value.
 *
 * `value` is the number to count with (a float is fine); `text` is the exact
 * final text and `frame` formats the numbers in between.
 */
export function LiveCount({
  value,
  text,
  frame,
  className,
}: {
  value: number;
  text: string;
  frame: (v: number) => string;
  className?: string;
}) {
  const reduce = useReducedMotionSafe();
  const ref = useRef<HTMLSpanElement>(null);
  const last = useRef<number | null>(null);
  const frameRef = useRef(frame);

  useLayoutEffect(() => {
    frameRef.current = frame;
  });

  useLayoutEffect(() => {
    const node = ref.current?.firstChild;
    const from = last.current;
    last.current = value;
    if (!node) return;
    // A count cut short by a newer value may have left a frame behind: start from the exact text.
    node.nodeValue = text;
    if (from === null || from === value || reduce || document.hidden) return;

    let raf = 0;
    let done = false;
    const stop = () => {
      done = true;
      cancelAnimationFrame(raf);
    };
    const finish = () => {
      if (done) return;
      stop();
      node.nodeValue = text;
    };
    const start = performance.now();
    const tick = (t: number) => {
      const k = Math.max(0, Math.min(1, (t - start) / DURATION));
      if (k >= 1) return finish();
      const eased = 1 - Math.pow(1 - k, 3);
      node.nodeValue = frameRef.current(from + (value - from) * eased);
      raf = requestAnimationFrame(tick);
    };
    // The first frame writes the start value. Frames run before the paint, so
    // the final text never flashes; and where no frame comes (a page that is
    // not painting), the final text simply stays.
    raf = requestAnimationFrame(tick);
    const timer = window.setTimeout(finish, DURATION + 150);
    const onVisibility = () => {
      if (document.hidden) finish();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearTimeout(timer);
      // No write here: React has already put the next value's text in the node.
      stop();
    };
  }, [value, text, reduce]);

  return (
    <span className={cn("num", className)}>
      <span className="sr-only">{text}</span>
      {/* React owns this text node; a count only rewrites its nodeValue. */}
      <span ref={ref} aria-hidden>
        {text}
      </span>
    </span>
  );
}
