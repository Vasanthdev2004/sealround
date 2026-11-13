"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";
import { palette } from "@/lib/palette";
import { safeIconSrc } from "@/lib/token-icon";

/**
 * A token's face: its icon when the sale has one (the NEP-148 `icon` the
 * creator set, a data URL), otherwise the monogram on a quiet tint of its
 * hue, as `TokenAvatar` draws it. Both are the same square with the same
 * concentric radius, so a list mixing the two lines up.
 *
 * Only an image data URL is ever put in the <img> (`safeIconSrc`): no remote
 * URL, so showing a sale never tells a third party who looked. An icon that
 * fails to decode falls back to the monogram.
 */
export function TokenMark({
  symbol,
  hue,
  icon,
  size = 36,
  alt,
  className,
}: {
  symbol: string;
  hue: number;
  icon?: string | null;
  size?: number;
  /** The image's text alternative. Default "$SYMBOL icon". Pass "" where the name is right beside it. */
  alt?: string;
  className?: string;
}) {
  const src = safeIconSrc(icon);
  // The src that failed to decode, so a new icon gets its own try.
  const [failed, setFailed] = useState<string | null>(null);
  const radius = Math.max(4, Math.round(size * 0.28));
  const box = { width: size, height: size, borderRadius: radius };
  // The hairline sits over the image, like the monogram's ring.
  const frame =
    "relative inline-flex shrink-0 overflow-hidden after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:ring-1 after:ring-line after:ring-inset";

  if (src && failed !== src) {
    return (
      <span className={cn(frame, "bg-elev-2", className)} style={box}>
        {/* A data URL: next/image would only add a loader that cannot help it. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt ?? `$${symbol} icon`}
          width={size}
          height={size}
          decoding="async"
          draggable={false}
          onError={() => setFailed(src)}
          className="block size-full object-cover"
        />
      </span>
    );
  }

  const tint = palette(hue).ground;
  return (
    <span
      className={cn(frame, "items-center justify-center font-semibold tracking-[-0.02em] text-muted", className)}
      style={{
        ...box,
        fontSize: Math.max(9, Math.round(size * 0.36)),
        background: `color-mix(in srgb, ${tint} 6%, var(--bg-elev-2))`,
      }}
      aria-hidden
    >
      {symbol.slice(0, 2)}
    </span>
  );
}
