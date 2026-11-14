import React from "react";
import { AbsoluteFill } from "remotion";
import { Logo } from "./components/Logo";
import { T } from "./lib/theme";

// README and social preview banner, 1280x640. A still: every element is in its final state.
export const BANNER = { width: 1280, height: 640 };

const bids = [0.0050, 0.0042, 0.0036, 0.0030, 0.0026, 0.0023, 0.0020, 0.0017, 0.0014, 0.0010];
const PRICE = 0.002;

function Chart() {
  const X0 = 770;
  const BASE = 470;
  const SCALE = 52000; // px per USDC
  const lineY = BASE - PRICE * SCALE;
  return (
    <>
      {bids.map((b, i) => {
        const win = b >= PRICE;
        const h = (win ? PRICE : b) * SCALE;
        const ghost = b * SCALE;
        return (
          <React.Fragment key={i}>
            {win && (
              <div
                style={{
                  position: "absolute",
                  left: X0 + i * 44,
                  top: BASE - ghost,
                  width: 28,
                  height: ghost - h,
                  borderRadius: "8px 8px 0 0",
                  boxShadow: `inset 0 0 0 1.5px ${T.faint}`,
                }}
              />
            )}
            <div
              style={{
                position: "absolute",
                left: X0 + i * 44,
                top: BASE - h,
                width: 28,
                height: h,
                borderRadius: win ? "0 0 3px 3px" : "8px 8px 3px 3px",
                background: win ? T.blueFill : T.ink,
                opacity: win ? 1 : 0.16,
              }}
            />
          </React.Fragment>
        );
      })}
      <div style={{ position: "absolute", left: X0 - 20, top: lineY - 1, width: 470, height: 2, background: T.blue }} />
      <div style={{ position: "absolute", left: X0 + 7 * 44 - 6, top: lineY - 34, width: 152, textAlign: "right", fontFamily: T.mono, fontSize: 20, color: T.blue }}>0.002 USDC</div>
      <div style={{ position: "absolute", left: X0, top: BASE + 1, width: 432, height: 1.5, background: T.faint }} />
      <div style={{ position: "absolute", left: X0, top: BASE + 16, fontFamily: T.sans, fontSize: 17, color: T.dim }}>7 winners pay the same price</div>
      <div style={{ position: "absolute", left: X0 + 7 * 44, top: BASE + 16, fontFamily: T.sans, fontSize: 17, color: T.dim }}>refunded</div>
    </>
  );
}

const Chip: React.FC<{ n: string; text: string }> = ({ n, text }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 16px", borderRadius: 999, boxShadow: `inset 0 0 0 1px ${T.hair}`, background: "rgba(255,255,255,0.03)" }}>
    <span style={{ fontFamily: T.mono, fontSize: 15, color: T.blue }}>{n}</span>
    <span style={{ fontFamily: T.sans, fontSize: 17, fontWeight: 500, color: T.ink }}>{text}</span>
  </div>
);

export function Banner() {
  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(ellipse 70% 80% at 72% 55%, rgba(0,82,255,0.20), rgba(0,82,255,0) 60%), radial-gradient(ellipse 60% 70% at 10% 0%, rgba(61,126,255,0.10), rgba(0,0,0,0) 60%), ${T.bg}`,
      }}
    >
      <div style={{ position: "absolute", left: 84, top: 92 }}>
        <Logo start={-200} size={56} wordSize={60} />
      </div>
      <div style={{ position: "absolute", left: 84, top: 206, width: 640 }}>
        <div style={{ fontFamily: T.sans, fontWeight: 700, fontSize: 58, lineHeight: 1.06, letterSpacing: "-0.04em", color: T.ink }}>
          Bots can't snipe
          <br />
          what they <span style={{ color: T.blue }}>can't see.</span>
        </div>
        <div style={{ marginTop: 26, fontFamily: T.sans, fontWeight: 500, fontSize: 22, lineHeight: 1.45, letterSpacing: "-0.01em", color: T.dim }}>
          Sealed-bid token launches on NEAR.
          <br />
          Every winner pays one clearing price.
        </div>
      </div>
      <div style={{ position: "absolute", left: 84, bottom: 74, display: "flex", gap: 12 }}>
        <Chip n="01" text="Sealed in your browser" />
        <Chip n="02" text="Opened in Intel TDX" />
        <Chip n="03" text="One price for all" />
      </div>
      <Chart />
    </AbsoluteFill>
  );
}
