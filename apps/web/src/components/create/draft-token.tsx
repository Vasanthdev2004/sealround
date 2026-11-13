"use client";

import { TokenMark } from "@/components/ui/token-mark";
import { cn } from "@/lib/cn";
import { bytesStr, iconType, utf8Bytes } from "@/lib/token-icon";
import { draftIcon, type Draft } from "./model";

/** What the icon is, in a few words: "Generated mark, 512 bytes". */
export function iconSummary(draft: Draft): string {
  const icon = draftIcon(draft);
  if (!icon) return draft.iconMode === "upload" ? "No image chosen" : "None, the monogram stands in";
  const size = bytesStr(utf8Bytes(icon));
  if (draft.iconMode === "upload" && draft.iconUpload) {
    const type = iconType(icon);
    const name = type === "jpeg" ? "JPEG" : type === "webp" ? "WebP" : type === "png" ? "PNG" : "image";
    return `Uploaded, ${draft.iconUpload.size} px ${name}, ${size}`;
  }
  return `Generated mark, ${size}`;
}

/**
 * The token as it will be listed: its icon (or monogram), name and ticker.
 * With `detail`, one more line says what the icon is and that it goes into
 * the token's metadata (the review step).
 */
export function DraftToken({ draft, detail = false, className }: { draft: Draft; detail?: boolean; className?: string }) {
  const name = draft.name.trim();
  return (
    <div className={cn("flex min-w-0 items-center gap-3", className)}>
      <TokenMark symbol={draft.symbol || "?"} hue={draft.hue} icon={draftIcon(draft)} size={detail ? 44 : 36} alt="" />
      <div className="min-w-0">
        <div className={cn("truncate text-h3", name ? "text-fg" : "text-subtle")}>{name || "Untitled token"}</div>
        <div className="truncate text-label text-subtle">{draft.symbol ? `$${draft.symbol}` : "No symbol yet"}</div>
        {detail && (
          <div className="text-label text-subtle [overflow-wrap:anywhere]">
            Icon: {iconSummary(draft)}
            {draftIcon(draft) ? ". Wallets show it from the token's metadata." : "."}
          </div>
        )}
      </div>
    </div>
  );
}
