"use client";

import { useEffect, useState } from "react";
import { CalendarPlus, Check, Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { appHref } from "@/lib/site";
import type { Sale } from "@/lib/types";
import { icsFileName, revealIcs } from "./ics";

/** The sale page's address, absolute: the app host when one is set, else this one. */
export function watchUrl(saleId: string): string {
  return new URL(appHref(`/sale/${encodeURIComponent(saleId)}`), window.location.origin).toString();
}

/**
 * Two quiet actions next to the countdown before the close: a calendar file
 * for the reveal (made here, in the browser) and the sale's link to share.
 */
export function RevealReminder({ sale, className }: { sale: Sale; className?: string }) {
  const c = sale.config;
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const [failedUrl, setFailedUrl] = useState("");

  useEffect(() => {
    if (copied !== "copied") return;
    const t = window.setTimeout(() => setCopied("idle"), 2500);
    return () => window.clearTimeout(t);
  }, [copied]);

  const addToCalendar = () => {
    const url = watchUrl(sale.id);
    const ics = revealIcs({
      saleId: sale.id,
      tokenName: c.tokenName,
      tokenSymbol: c.tokenSymbol,
      at: c.bidEnd,
      url,
      now: Date.now(),
      host: new URL(url).host,
      commit: c.revealMode === "commit_reveal",
    });
    const href = URL.createObjectURL(new Blob([ics], { type: "text/calendar;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = href;
    a.download = icsFileName(sale.id);
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(href), 1000);
  };

  const copy = async () => {
    const url = watchUrl(sale.id);
    try {
      await navigator.clipboard.writeText(url);
      setCopied("copied");
    } catch {
      // No clipboard here (an insecure origin, a denied permission): show the link to copy by hand.
      setFailedUrl(url);
      setCopied("failed");
    }
  };

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <div className="-ml-2 flex flex-wrap items-center gap-x-1 gap-y-1">
        <Button
          variant="ghost"
          size="sm"
          className="max-sm:h-10"
          icon={<CalendarPlus className="size-3.5" />}
          onClick={addToCalendar}
        >
          Add the reveal to your calendar
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="max-sm:h-10"
          icon={copied === "copied" ? <Check className="size-3.5 text-ok" /> : <Link2 className="size-3.5" />}
          onClick={() => void copy()}
        >
          {copied === "copied" ? "Link copied" : "Copy watch link"}
        </Button>
      </div>
      <p role="status" className={cn("text-label text-subtle", copied !== "failed" && "sr-only")}>
        {copied === "copied" ? (
          "Watch link copied."
        ) : copied === "failed" ? (
          <>
            Copy this link: <span className="num text-muted [overflow-wrap:anywhere] select-all">{failedUrl}</span>
          </>
        ) : (
          ""
        )}
      </p>
    </div>
  );
}
