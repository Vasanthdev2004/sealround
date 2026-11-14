import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Words } from "../components/Words";
import { Center, Count, Note } from "../components/Bits";
import { prog, easeOut, easeInOut, rise } from "../lib/anim";
import { T, BEAT } from "../lib/theme";

// 0-4 s. The race, and a timer running under it.
export function Cold() {
  const frame = useCurrentFrame();
  const run = prog(frame, 0, 118, easeInOut);
  const ticks = Math.floor(frame / BEAT) + 1;
  return (
    <AbsoluteFill>
      <Center y={-30}>
        <Words text={"Every token launch"} start={6} size={112} />
        <Words text={"is a race."} start={62} size={112} />
      </Center>
      <div style={{ position: "absolute", left: 460, top: 860, width: 1000, height: 2, background: T.faint }}>
        <div style={{ width: `${run * 100}%`, height: 2, background: T.ink, opacity: 0.85 }} />
        {Array.from({ length: Math.min(ticks, 9) }).map((_, i) => (
          <div key={i} style={{ position: "absolute", left: `${(i / 8) * 100}%`, top: -7, width: 2, height: 16, background: T.dim, opacity: prog(frame, i * BEAT, 8) }} />
        ))}
      </div>
    </AbsoluteFill>
  );
}

// 4-8 s. Bonding curve: bots buy at the bottom, people at the top.
export function Curve() {
  const frame = useCurrentFrame();
  const X0 = 920;
  const Y0 = 200;
  const W = 820;
  const H = 620;
  const p = (x: number) => 0.06 + 0.9 * Math.pow(x, 2.1);
  const pt = (x: number) => [X0 + x * W, Y0 + H - p(x) * H] as const;
  const path = Array.from({ length: 81 }, (_, i) => {
    const [x, y] = pt(i / 80);
    return `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ");
  const draw = prog(frame, 0, 52, easeInOut);
  const bots = [0.02, 0.04, 0.06, 0.08, 0.1];
  const people = [0.42, 0.5, 0.58, 0.66, 0.74, 0.82, 0.9];
  const last = pt(0.9);
  const ring = prog(frame, 84, 26, easeOut);
  return (
    <AbsoluteFill>
      <div style={{ position: "absolute", left: 150, top: 330 }}>
        <Words text={"Bots buy first."} start={6} size={84} align="left" />
        <Words text={"You pay more."} start={60} size={84} align="left" />
        <Note text={"The median person paid 2.61× the bots' price."} start={82} size={34} align="left" style={{ marginTop: 34 }} />
      </div>
      <svg width={1920} height={1080} style={{ position: "absolute" }}>
        <line x1={X0} y1={Y0 + H} x2={X0 + W} y2={Y0 + H} stroke={T.faint} strokeWidth={2} />
        <line x1={X0} y1={Y0} x2={X0} y2={Y0 + H} stroke={T.faint} strokeWidth={2} />
        <path d={path} fill="none" stroke={T.ink} strokeOpacity={0.5} strokeWidth={3} pathLength={1} strokeDasharray={1} strokeDashoffset={1 - draw} />
        {bots.map((x, i) => {
          const [cx, cy] = pt(x);
          const t = prog(frame, 10 + i * 3, 16);
          return <circle key={i} cx={cx} cy={cy - 4} r={12 * t} fill={T.dim} />;
        })}
        {people.map((x, i) => {
          const [cx, cy] = pt(x);
          const t = prog(frame, 56 + i * 4, 16);
          return <circle key={i} cx={cx} cy={cy} r={12 * t} fill={T.ink} />;
        })}
        <circle cx={last[0]} cy={last[1]} r={12 + ring * 26} fill="none" stroke={T.ink} strokeOpacity={0.6 * (1 - ring)} strokeWidth={2} />
      </svg>
      <div style={{ position: "absolute", left: X0 + 40, top: Y0 + H - 110, opacity: prog(frame, 22, 18) }}>
        <span style={{ fontFamily: T.sans, fontSize: 26, color: T.dim, fontWeight: 500 }}>bots, at second 0</span>
      </div>
      <div style={{ position: "absolute", left: X0 + 0.6 * W + 24, top: pt(0.6)[1] + 26, opacity: prog(frame, 70, 18) }}>
        <span style={{ fontFamily: T.sans, fontSize: 26, color: T.ink, fontWeight: 500 }}>people, later</span>
      </div>
      <div style={{ position: "absolute", left: X0, top: Y0 + H + 22, display: "flex", width: W, justifyContent: "space-between", opacity: prog(frame, 8, 18) }}>
        <span style={{ fontFamily: T.sans, fontSize: 22, color: T.dim }}>launch</span>
        <span style={{ fontFamily: T.sans, fontSize: 22, color: T.dim }}>price rises with every buy</span>
      </div>
      <div style={{ position: "absolute", left: 150, bottom: 70 }}>
        <Note text={"Bonding curve in the Sealround Bot Arena: 60 simulated runs, 200 people, 5 sniper bots."} start={30} size={22} align="left" />
      </div>
    </AbsoluteFill>
  );
}

// 8-12 s. What that is worth to the bots.
export function Profit() {
  return (
    <AbsoluteFill>
      <Center y={-20}>
        <Note text={"What 5 sniper bots made per launch, on average"} start={0} size={36} />
        <div style={{ display: "flex", alignItems: "baseline", gap: 28, marginTop: 10 }}>
          <div style={{ fontFamily: T.sans, fontWeight: 700, fontSize: 280, letterSpacing: "-0.055em", color: T.ink, lineHeight: 1, ...rise(useCurrentFrame(), 0, 22, 30, 14) }}>
            <Count from={0} to={1269} start={6} dur={62} />
          </div>
          <Note text={"USDC"} start={18} size={72} color={T.dim} />
        </div>
      </Center>
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 70 }}>
        <Note text={"Bonding curve, Sealround Bot Arena simulation, averages over 60 runs."} start={30} size={22} />
      </div>
    </AbsoluteFill>
  );
}

// 12-14 s. The question, then the camera pushes through it.
export function Question() {
  return (
    <Center y={-10}>
      <Words text={"What if bots"} start={0} size={110} stagger={4} dur={16} />
      <Words text={"couldn't *see* the bids?"} start={12} size={110} stagger={4} dur={16} />
    </Center>
  );
}
