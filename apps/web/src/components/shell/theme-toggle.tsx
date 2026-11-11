"use client";

import { Moon, Sun } from "lucide-react";
import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { THEME_STORAGE_KEY } from "./theme-preference";

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

function readTheme() {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

const readServerTheme = () => "dark" as const;

export function ThemeToggle({ showLabel = false }: { showLabel?: boolean }) {
  const theme = useSyncExternalStore(subscribe, readTheme, readServerTheme);
  const next = theme === "light" ? "dark" : "light";
  const Icon = next === "light" ? Sun : Moon;
  const label = `Switch to ${next} mode`;

  function toggleTheme() {
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // The toggle still works for the current page if storage is unavailable.
    }
  }

  return (
    <Button
      type="button"
      size={showLabel ? "md" : "square"}
      variant="ghost"
      className={showLabel ? "min-h-11" : undefined}
      aria-label={label}
      title={label}
      onClick={toggleTheme}
      icon={<Icon className="size-4" strokeWidth={1.75} aria-hidden />}
    >
      {showLabel && (next === "light" ? "Light mode" : "Dark mode")}
    </Button>
  );
}
