"use client";

import { Bookmark, BookmarkCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSavedSales } from "./saved-sales";

export function SaveSale({ id, name, compact = false }: { id: string; name: string; compact?: boolean }) {
  const { ids, toggle, error } = useSavedSales();
  const saved = ids.includes(id);
  const Icon = saved ? BookmarkCheck : Bookmark;
  return (
    <span className="relative z-10 inline-flex flex-col items-start">
      <Button
        size={compact ? "square" : "sm"}
        variant="ghost"
        type="button"
        aria-label={`${saved ? "Unsave" : "Save"} ${name}`}
        aria-pressed={saved}
        title={saved ? "Saved in this browser" : "Save in this browser"}
        onClick={() => toggle(id)}
      >
        <Icon className="size-4" aria-hidden />
        {!compact && (saved ? "Saved" : "Save sale")}
      </Button>
      {error && <span role="alert" className="max-w-56 text-label text-bad">{error}</span>}
    </span>
  );
}
