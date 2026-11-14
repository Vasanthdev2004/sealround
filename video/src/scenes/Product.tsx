import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Words } from "../components/Words";
import { Logo } from "../components/Logo";
import { Center, Note, Step } from "../components/Bits";
import { prog, easeOut, easeInOut, lerp } from "../lib/anim";
import { T } from "../lib/theme";

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function scramble(text: string, amount: number, seed: number, frame: number) {
  // Characters flip to ciphertext from left to right as amount goes 0 to 1.
  const tick = Math.floor(frame / 2);
  return text
    .split("")
    .map((c, i) => {
      if (c === " ") return amount > 0.2 ? B64[(i * 7 + seed + tick) % 64] : c;
      const edge = i / text.length;
      if (edge > amount) return c;
      return B64[(i * 31 + seed * 17 + tick * 13 + c.charCodeAt(0)) % 64];
    })
    .join("");
}

// 14-18 s. The mark closes on the clearing line; the line under it.
export function Title() {
  return (
    <Center y={-30}>
      <Logo start={2} size={132} wordSize={156} />
      <div style={{ height: 48 }} />
      <Words text={"Bots can't snipe what they *can't* *see.*"} start={58} size={56} weight={500} color={T.ink} tracking={-0.025} stagger={3} />
    </Center>
  );
}

const Left: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ position: "absolute", left: 150, top: 0, bottom: 0, display: "flex", flexDirection: "column", justifyContent: "center", width: 700 }}>{children}</div>
);

// 18-22 s. A bid becomes ciphertext in the browser.
export function Seal() {
  const frame = useCurrentFrame();
  const amt = prog(frame, 32, 34, easeInOut);
  const sealed = prog(frame, 60, 16, easeOut);
  const rows: [string, string][] = [
    ["Max price", "0.004 USDC"],
    ["Budget", "10 USDC"],
    ["Bidder", "ana.testnet"],
  ];
  const card = (k: number, dx: number, dy: number, op: number) => (
    <div
      key={k}
      style={{
        position: "absolute",
        left: 1040 + dx,
        top: 330 + dy,
        width: 620,
        height: 380,
        borderRadius: 28,
        background: `rgb(${lerp(18, 6, sealed)},${lerp(18, 16, sealed)},${lerp(22, 42, sealed)})`,
        boxShadow: `0 0 0 ${lerp(1, 2, sealed)}px ${sealed > 0.5 ? T.blue : T.hair}, 0 40px 120px rgba(0,0,0,0.6)`,
        padding: "44px 48px",
        opacity: op,
        boxSizing: "border-box",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 34 }}>
        <span style={{ fontFamily: T.sans, fontSize: 28, fontWeight: 600, color: T.ink }}>Your bid</span>
        <span style={{ fontFamily: T.sans, fontSize: 22, fontWeight: 600, color: T.blue, opacity: sealed, padding: "6px 14px", borderRadius: 999, boxShadow: `0 0 0 1px ${T.blue}` }}>Sealed</span>
      </div>
      {k === 0 && rows.map(([k2, v], i) => (
        <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "18px 0", borderTop: `1px solid ${T.hair}` }}>
          <span style={{ fontFamily: T.sans, fontSize: 28, color: T.dim }}>{k2}</span>
          <span style={{ fontFamily: T.mono, fontSize: 30, color: T.ink }}>{scramble(v, amt, i + k * 5, frame)}</span>
        </div>
      ))}
    </div>
  );
  const enter = prog(frame, 6, 26, easeOut);
  return (
    <AbsoluteFill>
      <Left>
        <Step n="01" word="Seal" start={0} />
        <div style={{ height: 30 }} />
        <Note text={"Your bid is encrypted in your browser."} start={12} size={38} color={T.ink} align="left" />
        <Note text={"Its size says nothing about the amount."} start={24} size={38} align="left" style={{ marginTop: 10 }} />
      </Left>
      <div style={{ opacity: enter, transform: `translateY(${(1 - enter) * 60}px)`, filter: `blur(${(1 - enter) * 10}px)` }}>
        {[3, 2, 1].map((k) => {
          const t = prog(frame, 70 + (3 - k) * 6, 22, easeOut);
          return card(k, k * 26 * t, -k * 26 * t, t * (0.55 - k * 0.14));
        })}
        {card(0, 0, 0, 1)}
      </div>
    </AbsoluteFill>
  );
}

// 22-26 s. Sealed boxes go into the enclave; opened values come out.
export function Open() {
  const frame = useCurrentFrame();
  const CX = 1330;
  const CY = 540;
  const chipIn = prog(frame, 0, 24, easeOut);
  const lit = prog(frame, 50, 12, easeOut) * (1 - 0.6 * prog(frame, 70, 30, easeInOut));
  const prices = ["0.004", "0.0025", "0.002", "0.003", "0.0015", "0.002", "0.005", "0.001"];
  return (
    <AbsoluteFill>
      <Left>
        <Step n="02" word="Open" start={0} />
        <div style={{ height: 30 }} />
        <Note text={"After the close, an attested enclave"} start={12} size={38} color={T.ink} align="left" />
        <Note text={"opens every bid at once."} start={18} size={38} color={T.ink} align="left" style={{ marginTop: 6 }} />
        <Note text={"Nobody sees a bid before that. Not even us."} start={30} size={34} align="left" style={{ marginTop: 22 }} />
      </Left>
      {prices.map((_, i) => {
        const t = prog(frame, 8 + i * 4, 36, easeInOut);
        const y0 = 250 + i * 76;
        const x = lerp(890, CX - 35, t);
        const y = lerp(y0, CY - 22, t);
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: x,
              top: y,
              width: 70,
              height: 44,
              borderRadius: 10,
              background: "rgba(0,40,120,0.35)",
              boxShadow: `0 0 0 1.5px ${T.blue}`,
              opacity: prog(frame, i * 3, 12) * (1 - prog(frame, 40 + i * 4, 8)),
              fontFamily: T.mono,
              fontSize: 16,
              color: T.blue,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {B64.slice((i * 9) % 56, ((i * 9) % 56) + 4)}
          </div>
        );
      })}
      <div
        style={{
          position: "absolute",
          left: CX - 140,
          top: CY - 140,
          width: 280,
          height: 280,
          borderRadius: 48,
          background: "#0B0B0E",
          boxShadow: `0 0 0 2px ${lit > 0.05 ? `rgba(61,126,255,${0.4 + 0.6 * lit})` : T.hair}, 0 0 ${80 * lit}px rgba(0,82,255,${0.35 * lit}), 0 40px 120px rgba(0,0,0,0.6)`,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 14,
          opacity: chipIn,
          transform: `scale(${0.9 + 0.1 * chipIn + 0.03 * lit})`,
        }}
      >
        <span style={{ fontFamily: T.mono, fontSize: 64, fontWeight: 500, color: T.ink }}>TEE</span>
        <span style={{ fontFamily: T.sans, fontSize: 22, color: T.dim }}>Intel TDX · OutLayer</span>
      </div>
      {prices.map((p, i) => {
        const t = prog(frame, 58 + i * 4, 18, easeOut);
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: 1560 + (1 - t) * -60,
              top: 250 + i * 76,
              fontFamily: T.mono,
              fontSize: 32,
              color: T.ink,
              opacity: t,
              filter: `blur(${(1 - t) * 6}px)`,
            }}
          >
            {p}
          </div>
        );
      })}
    </AbsoluteFill>
  );
}

// 26-30 s. Bars of max prices; the clearing line comes down and every winner pays it.
export function Price() {
  const frame = useCurrentFrame();
  const bids = [0.005, 0.0042, 0.0036, 0.003, 0.0026, 0.0023, 0.002, 0.0017, 0.0014, 0.001];
  const X0 = 960;
  const BASE = 860;
  const SCALE = 120000; // px per USDC
  const lineY = lerp(BASE - 0.0058 * SCALE, BASE - 0.002 * SCALE, prog(frame, 14, 34, easeInOut));
  const clip = prog(frame, 50, 22, easeInOut);
  return (
    <AbsoluteFill>
      <Left>
        <Step n="03" word="One price" start={0} />
        <div style={{ height: 30 }} />
        <Note text={"Every winner pays the same"} start={12} size={38} color={T.ink} align="left" />
        <Note text={"clearing price. Early or late."} start={18} size={38} color={T.ink} align="left" style={{ marginTop: 6 }} />
        <Note text={"Bids under it get their deposit back."} start={30} size={34} align="left" style={{ marginTop: 22 }} />
      </Left>
      {bids.map((b, i) => {
        const t = prog(frame, 2 + i * 2, 22, easeOut);
        const full = b * SCALE;
        const win = b >= 0.002;
        const h = win ? lerp(full, 0.002 * SCALE, clip) : full;
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: X0 + i * 78,
              top: BASE - h * t,
              width: 52,
              height: h * t,
              borderRadius: "10px 10px 3px 3px",
              background: win ? (clip > 0.5 ? T.blueFill : T.ink) : T.ink,
              opacity: win ? 1 : lerp(1, 0.18, clip),
            }}
          />
        );
      })}
      <div style={{ position: "absolute", left: X0 - 30, top: lineY - 1, width: 830, height: 2, background: T.blue, opacity: prog(frame, 10, 12) }} />
      <div style={{ position: "absolute", left: X0 + 820, top: lineY - 24, fontFamily: T.mono, fontSize: 34, color: T.blue, opacity: prog(frame, 44, 16) }}>0.002</div>
      <div style={{ position: "absolute", left: X0, top: BASE + 20, width: 760, height: 2, background: T.faint }} />
      <div style={{ position: "absolute", left: X0, top: BASE + 34, fontFamily: T.sans, fontSize: 24, color: T.dim, opacity: prog(frame, 66, 16) }}>7 winners, one price</div>
      <div style={{ position: "absolute", left: X0 + 7 * 78, top: BASE + 34, fontFamily: T.sans, fontSize: 24, color: T.dim, opacity: prog(frame, 70, 16) }}>refunded</div>
    </AbsoluteFill>
  );
}
