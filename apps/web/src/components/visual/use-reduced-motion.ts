"use client";

import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void) {
  const media = window.matchMedia(QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

/**
 * prefers-reduced-motion, false during the server render and hydration and
 * the real value right after. motion's own useReducedMotion reads the media
 * query on the client's first render, so a server-rendered component that
 * renders differently under it fails to hydrate for reduced-motion users.
 */
export function useReducedMotionSafe(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
}
