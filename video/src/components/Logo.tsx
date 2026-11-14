import React from "react";
import { useCurrentFrame } from "remotion";
import { prog, easeOut } from "../lib/anim";
import { T } from "../lib/theme";

// The Sealround mark: two solid halves; the gap between them is the clearing line.
// The halves arrive from above and below and close on the line.
export function Logo({ start = 0, size = 120, word = true, wordSize = 132 }: { start?: number; size?: number; word?: boolean; wordSize?: number }) {
  const frame = useCurrentFrame();
  const t = prog(frame, start, 30, easeOut);
  const gap = (1 - t) * 0.9;
  const w = prog(frame, start + 10, 30, easeOut);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: size * 0.32 }}>
      <svg width={size} height={size} viewBox="0 0 20 20" style={{ overflow: "visible", filter: `blur(${(1 - t) * 8}px)`, opacity: t }}>
        <g transform={`translate(0 ${-gap * 6})`}>
          <path d="M3 9a8 7 0 0 1 16 0Z" fill={T.blue} />
        </g>
        <g transform={`translate(0 ${gap * 6})`}>
          <path d="M17 11a8 7 0 0 1-16 0Z" fill={T.blue} />
        </g>
      </svg>
      {word && (
        <div
          style={{
            fontFamily: T.sans,
            fontWeight: 600,
            fontSize: wordSize,
            letterSpacing: `${-0.03 - (1 - w) * 0.05}em`,
            color: T.ink,
            opacity: w,
            filter: `blur(${(1 - w) * 10}px)`,
            transform: `translateX(${(1 - w) * -24}px)`,
          }}
        >
          Sealround
        </div>
      )}
    </div>
  );
}
