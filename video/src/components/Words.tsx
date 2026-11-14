import React from "react";
import { useCurrentFrame } from "remotion";
import { prog, easeIn } from "../lib/anim";
import { T } from "../lib/theme";

// Word-by-word reveal. Wrap a word in *stars* to set it in blue.
// "\n" breaks the line. Each word lifts, sharpens and fades in, staggered.
export function Words({
  text,
  start = 0,
  stagger = 3,
  dur = 22,
  size = 96,
  weight = 600,
  color = T.ink,
  tracking = -0.04,
  lineHeight = 1.06,
  align = "center",
  exitAt,
  exitDur = 10,
  style,
}: {
  text: string;
  start?: number;
  stagger?: number;
  dur?: number;
  size?: number;
  weight?: number;
  color?: string;
  tracking?: number;
  lineHeight?: number;
  align?: "center" | "left";
  exitAt?: number;
  exitDur?: number;
  style?: React.CSSProperties;
}) {
  const frame = useCurrentFrame();
  const lines = text.split("\n");
  let k = 0;
  const out = exitAt === undefined ? 0 : prog(frame, exitAt, exitDur, easeIn);
  return (
    <div
      style={{
        fontFamily: T.sans,
        fontSize: size,
        fontWeight: weight,
        letterSpacing: `${tracking}em`,
        lineHeight,
        color,
        textAlign: align,
        opacity: 1 - out,
        filter: out ? `blur(${out * 10}px)` : undefined,
        transform: out ? `translateY(${-out * 14}px)` : undefined,
        ...style,
      }}
    >
      {lines.map((line, li) => (
        <div key={li} style={{ display: "block", whiteSpace: "nowrap" }}>
          {line.split(" ").map((w, wi) => {
            const i = k++;
            const t = prog(frame, start + i * stagger, dur);
            const accent = w.startsWith("*") && w.endsWith("*");
            const word = accent ? w.slice(1, -1) : w;
            return (
              <span
                key={wi}
                style={{
                  display: "inline-block",
                  opacity: t,
                  transform: `translateY(${(1 - t) * 0.32}em)`,
                  filter: `blur(${(1 - t) * 10}px)`,
                  color: accent ? T.blue : undefined,
                  marginRight: "0.24em",
                }}
              >
                {word}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}
