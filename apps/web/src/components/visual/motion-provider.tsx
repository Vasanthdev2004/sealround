"use client";

import { MotionConfig } from "motion/react";

/**
 * App-wide motion defaults. `reducedMotion="user"` makes every motion
 * component drop transform and layout animation when the OS asks for reduced
 * motion, so nothing slides or scales for those users even if a component
 * forgets to check. Default transition: 240 ms ease-out.
 */
export function MotionProvider({ children }: { children: React.ReactNode }) {
  return (
    <MotionConfig reducedMotion="user" transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}>
      {children}
    </MotionConfig>
  );
}
