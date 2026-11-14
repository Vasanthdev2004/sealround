import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { prog, easeOut, easeIn } from "../lib/anim";
import { T } from "../lib/theme";

export const Center: React.FC<{ children: React.ReactNode; y?: number; style?: React.CSSProperties }> = ({ children, y = 0, style }) => (
  <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", transform: `translateY(${y}px)`, ...style }}>{children}</AbsoluteFill>
);

// Small grey caption line.
export function Note({ text, start = 0, size = 26, color = T.dim, align = "center", mono = false, style }: { text: string; start?: number; size?: number; color?: string; align?: "center" | "left"; mono?: boolean; style?: React.CSSProperties }) {
  const frame = useCurrentFrame();
  const t = prog(frame, start, 22, easeOut);
  return (
    <div
      style={{
        fontFamily: mono ? T.mono : T.sans,
        fontSize: size,
        fontWeight: mono ? 400 : 500,
        letterSpacing: mono ? "0em" : "-0.01em",
        color,
        textAlign: align,
        opacity: t,
        transform: `translateY(${(1 - t) * 12}px)`,
        filter: `blur(${(1 - t) * 6}px)`,
        whiteSpace: "pre",
        ...style,
      }}
    >
      {text}
    </div>
  );
}

// Count from a to b with an eased curve, formatted with separators.
export function Count({ from, to, start, dur, decimals = 0, style }: { from: number; to: number; start: number; dur: number; decimals?: number; style?: React.CSSProperties }) {
  const frame = useCurrentFrame();
  const t = prog(frame, start, dur, easeOut);
  const v = from + (to - from) * t;
  const s = v.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return <span style={{ fontVariantNumeric: "tabular-nums", ...style }}>{s}</span>;
}

// Scene wrapper: leaves with a fade, lift and blur over the last frames.
// zoom > 1 pushes through the camera instead.
export function Scene({ dur, out = 12, zoom = 1, children }: { dur: number; out?: number; zoom?: number; children: React.ReactNode }) {
  const frame = useCurrentFrame();
  const t = prog(frame, dur - out, out, easeIn);
  return (
    <AbsoluteFill
      style={{
        opacity: 1 - t,
        filter: t > 0 ? `blur(${t * (zoom > 1 ? 18 : 10)}px)` : undefined,
        transform: zoom > 1 ? `scale(${1 + (zoom - 1) * t})` : `translateY(${-t * 18}px)`,
      }}
    >
      {children}
    </AbsoluteFill>
  );
}

// Step label: "01" in mono blue and a word.
export function Step({ n, word, start = 0 }: { n: string; word: string; start?: number }) {
  const frame = useCurrentFrame();
  const t = prog(frame, start, 22, easeOut);
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 22, opacity: t, filter: `blur(${(1 - t) * 8}px)`, transform: `translateY(${(1 - t) * 16}px)` }}>
      <span style={{ fontFamily: T.mono, fontSize: 30, color: T.blue }}>{n}</span>
      <span style={{ fontFamily: T.sans, fontSize: 92, fontWeight: 600, letterSpacing: "-0.045em", color: T.ink }}>{word}</span>
    </div>
  );
}

export function useIn(start: number, dur = 20) {
  const frame = useCurrentFrame();
  return prog(frame, start, dur, easeOut);
}

export function useOut(start: number, dur = 12) {
  const frame = useCurrentFrame();
  return prog(frame, start, dur, easeIn);
}
