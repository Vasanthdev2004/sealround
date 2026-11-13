"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { cn } from "@/lib/cn";
import { APP_URL, appHref } from "@/lib/site";

export type CopyState = "idle" | "copied" | "failed";

/** Copy to the clipboard, with "copied" for 2.5 s, or "failed" and the text to copy by hand. */
export function useCopy() {
  const [state, setState] = useState<CopyState>("idle");
  const [text, setText] = useState("");
  useEffect(() => {
    if (state !== "copied") return;
    const t = window.setTimeout(() => setState("idle"), 2500);
    return () => window.clearTimeout(t);
  }, [state]);
  const copy = async (value: string) => {
    setText(value);
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      // No clipboard here (an insecure origin, a denied permission): show the text to copy by hand.
      setState("failed");
    }
  };
  return { state, text, copy };
}

/** The live line under a Copy button: read out on success, shown with the text when the clipboard fails. */
export function CopyStatus({ state, text, done, className }: { state: CopyState; text: string; done: string; className?: string }) {
  return (
    <p role="status" className={cn("text-label text-subtle", state !== "failed" && "sr-only", className)}>
      {state === "copied" ? (
        done
      ) : state === "failed" ? (
        <>
          Copy this by hand: <span className="text-muted [overflow-wrap:anywhere] whitespace-pre-wrap select-all">{text}</span>
        </>
      ) : (
        ""
      )}
    </p>
  );
}

/** Saves a same-origin address or a blob under a file name. */
export function saveAs(href: string | Blob, fileName: string) {
  const url = typeof href === "string" ? href : URL.createObjectURL(href);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (typeof href !== "string") window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const noSubscribe = () => () => {};

/**
 * The sale page's address, absolute: the app host when one is set, else
 * this page's origin. Null while rendering on the server.
 */
export function useSaleUrl(saleId: string): string | null {
  const origin = useSyncExternalStore(
    noSubscribe,
    () => APP_URL || window.location.origin,
    () => APP_URL,
  );
  if (!origin) return null;
  return new URL(appHref(`/sale/${encodeURIComponent(saleId)}`), origin).toString();
}

/** The X logo, drawn in the text colour. */
export function XMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="size-3.5" fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" />
    </svg>
  );
}
