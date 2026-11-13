"use client";

import { useLayoutEffect } from "react";
import { THEME_BOOTSTRAP, resolveTheme } from "./theme-preference";

/**
 * The theme bootstrap, inline in `<head>`, so the saved or device theme is on
 * `<html>` before the first paint (Next.js guide "Preventing flash before
 * hydration").
 *
 * The server renders it as `text/javascript`, so it runs while the HTML is
 * parsed. On the client it renders as `text/plain`: a script that React
 * creates on the client never runs, and React warns in development when it
 * creates one (after an error makes it render the document again).
 * `suppressHydrationWarning` covers the type differing at hydration.
 *
 * When React renders the document again, it also resets `<html>` to the
 * attributes it manages, which drops `data-theme`. The layout effect puts it
 * back before paint; otherwise it does nothing.
 */
export function ThemeScript() {
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (!root.dataset.theme) root.dataset.theme = resolveTheme();
  }, []);

  return (
    <script
      type={typeof window === "undefined" ? "text/javascript" : "text/plain"}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }}
    />
  );
}
