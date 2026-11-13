export const THEME_STORAGE_KEY = "sealround-theme";

/** The theme to show: the saved choice, else the device's. Same rule as the bootstrap below. Browser only. */
export function resolveTheme(): "light" | "dark" {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    // No storage: follow the device.
  }
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

// Runs before the page paints so a saved preference also works on a direct load.
export const THEME_BOOTSTRAP = `(() => {
  const root = document.documentElement;
  const device = window.matchMedia("(prefers-color-scheme: light)");
  const key = ${JSON.stringify(THEME_STORAGE_KEY)};

  function syncTheme() {
    let saved;
    try { saved = localStorage.getItem(key); } catch { return; }
    root.dataset.theme = saved === "light" || saved === "dark"
      ? saved
      : device.matches ? "light" : "dark";
  }

  root.dataset.theme = device.matches ? "light" : "dark";
  syncTheme();
  device.addEventListener("change", syncTheme);
  window.addEventListener("storage", (event) => {
    if (event.key === key || event.key === null) syncTheme();
  });
})();`;
