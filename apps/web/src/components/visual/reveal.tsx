"use client";

import { motion, useReducedMotion } from "motion/react";

const TAGS = {
  div: motion.div,
  section: motion.section,
  li: motion.li,
  span: motion.span,
  article: motion.article,
} as const;

/**
 * Fade + short rise when the element scrolls into view (or on mount with
 * `onMount`). 400 ms ease-out, 8 px, once. Use for below-the-fold sections
 * and for lists that load from the client (cards, rows, checks): pass `index`
 * for a 50 ms stagger.
 *
 * Content above the fold that is rendered on the server should use the CSS
 * class `anim-rise` instead: it plays without waiting for hydration.
 *
 * Reduced motion: renders in place, no animation.
 */
export function Reveal({
  as = "div",
  index = 0,
  delay = 0,
  y = 8,
  onMount = false,
  amount = 0.15,
  className,
  style,
  children,
  id,
}: {
  as?: keyof typeof TAGS;
  /** Position in a list, for stagger (50 ms each, capped at 8). */
  index?: number;
  /** Extra delay in seconds. */
  delay?: number;
  /** Rise distance in px. */
  y?: number;
  /** Animate on mount instead of on entering the viewport. */
  onMount?: boolean;
  /** Fraction of the element that must be visible to trigger. */
  amount?: number;
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
  id?: string;
}) {
  const reduce = useReducedMotion();
  const Tag = TAGS[as] as typeof motion.div;
  const transition = { duration: 0.4, ease: [0.22, 1, 0.36, 1] as const, delay: delay + Math.min(index, 8) * 0.05 };
  const hidden = { opacity: 0, y };
  const shown = { opacity: 1, y: 0 };

  if (reduce) {
    return (
      <Tag className={className} style={style} id={id}>
        {children}
      </Tag>
    );
  }
  return onMount ? (
    <Tag className={className} style={style} id={id} initial={hidden} animate={shown} transition={transition}>
      {children}
    </Tag>
  ) : (
    <Tag
      className={className}
      style={style}
      id={id}
      initial={hidden}
      whileInView={shown}
      viewport={{ once: true, amount }}
      transition={transition}
    >
      {children}
    </Tag>
  );
}
