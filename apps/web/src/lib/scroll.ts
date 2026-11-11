/**
 * Scroll helpers that honour prefers-reduced-motion. The global CSS rule that
 * stops animations does not reach scrollIntoView / scrollTo with
 * `behavior: "smooth"`, so every JS scroll goes through these.
 */

export function scrollBehavior(): ScrollBehavior {
  if (typeof window === "undefined" || !window.matchMedia) return "auto";
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

/** Scroll an element into view (top of the viewport by default). */
export function scrollToEl(el: Element | null | undefined, block: ScrollLogicalPosition = "start") {
  el?.scrollIntoView({ behavior: scrollBehavior(), block });
}

/** Scroll the window to the top. */
export function scrollToTop() {
  window.scrollTo({ top: 0, behavior: scrollBehavior() });
}

/**
 * Move focus to an element without a second scroll jump. Headings and other
 * non-interactive targets need tabIndex={-1}.
 */
export function focusEl(el: HTMLElement | null | undefined) {
  el?.focus({ preventScroll: true });
}
