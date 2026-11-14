import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Words } from "../components/Words";
import { Shot } from "../components/Shot";
import { Center, Count, Note } from "../components/Bits";
import { prog, easeOut, easeInOut, easeIn, lerp, rise } from "../lib/anim";
import { T } from "../lib/theme";
import verifyText from "../verify-swarm";

const WIN = { x: 320, y: 236, w: 1280, h: 800 };
const SHOT = { iw: 2880, ih: 1800 };

const Head: React.FC<{ text: string; note?: string; start?: number; size?: number }> = ({ text, note, start = 0, size = 60 }) => (
  <div style={{ position: "absolute", left: 0, right: 0, top: note ? 64 : 84, display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
    <Words text={text} start={start} size={size} tracking={-0.035} />
    {note && <Note text={note} start={start + 10} size={26} mono />}
  </div>
);

// 30-32 s.
export function Testnet() {
  return (
    <Center y={-20}>
      <Words text={"Live on *NEAR* testnet."} start={0} size={112} stagger={4} />
      <div style={{ height: 30 }} />
      <Note text={"sealround.itzbeast.testnet   ·   access keys: 0"} start={14} size={30} mono />
    </Center>
  );
}

// 32-38 s. The swarm sale page.
export function Sale() {
  return (
    <AbsoluteFill>
      <Head text={"20 bidders. 6 sniper bots. One sale."} note={"swarm-11141341 · created after the contract's last key was deleted"} />
      <Shot
        src="shots/sale.png"
        {...SHOT}
        box={WIN}
        start={6}
        cam={[
          { f: 0, cx: 0.5, cy: 0.5, s: 1 },
          { f: 40, cx: 0.5, cy: 0.5, s: 1 },
          { f: 100, cx: 0.33, cy: 0.3, s: 1.55 },
        ]}
        spots={[{ x: 0.085, y: 0.262, w: 0.47, h: 0.1, from: 104 }]}
      />
    </AbsoluteFill>
  );
}

// 38-42 s. The fairness timeline from the result page.
export function Timing() {
  return (
    <AbsoluteFill>
      <Head text={"A bot bid *3.1 s* after open."} start={0} size={56} />
      <div style={{ position: "absolute", left: 0, right: 0, top: 160, display: "flex", justifyContent: "center" }}>
        <Words text={"The last bid came *8.3 s* before close."} start={30} size={56} tracking={-0.035} />
      </div>
      <Shot
        src="shots/r-timeline.png"
        {...SHOT}
        box={{ x: 320, y: 280, w: 1280, h: 760 }}
        start={4}
        cam={[
          { f: 0, cx: 0.5, cy: 0.38, s: 1.08 },
          { f: 110, cx: 0.5, cy: 0.38, s: 1.14 },
        ]}
        spots={[{ x: 0.082, y: 0.205, w: 0.836, h: 0.43, from: 50 }]}
      />
    </AbsoluteFill>
  );
}

// 42-48 s. The price, then the result page.
export function Reveal() {
  const frame = useCurrentFrame();
  const big = prog(frame, 0, 26, easeOut);
  const away = prog(frame, 92, 14, easeIn);
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ opacity: 1 - away, filter: away ? `blur(${away * 12}px)` : undefined }}>
        <Center y={-40}>
          <div
            style={{
              fontFamily: T.sans,
              fontWeight: 700,
              fontSize: 330,
              letterSpacing: "-0.06em",
              color: T.blue,
              lineHeight: 1,
              opacity: big,
              transform: `scale(${1.18 - 0.18 * big})`,
              filter: `blur(${(1 - big) * 22}px)`,
            }}
          >
            0.002
          </div>
          <Note text={"USDC per token"} start={10} size={44} />
          <div style={{ height: 40 }} />
          <Words text={"Both paid it. So did all 17 winners."} start={34} size={58} tracking={-0.03} />
        </Center>
      </AbsoluteFill>
      {frame >= 96 && (
        <AbsoluteFill>
          <Shot
            src="shots/result.png"
            {...SHOT}
            box={{ x: 260, y: 140, w: 1400, h: 875 }}
            start={96}
            cam={[
              { f: 96, cx: 0.5, cy: 0.5, s: 1 },
              { f: 150, cx: 0.36, cy: 0.42, s: 1.35 },
            ]}
            spots={[{ x: 0.104, y: 0.488, w: 0.38, h: 0.075, from: 138 }]}
          />
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
}

// 48-52 s. Fills: the bots' rows.
export function Winners() {
  return (
    <AbsoluteFill>
      <Head text={"No discount for being first."} note={"7 USDC bought 3,500 SWARM. 0.002 each, like everyone."} />
      <Shot
        src="shots/r-fills.png"
        {...SHOT}
        box={WIN}
        start={4}
        cam={[
          { f: 0, cx: 0.5, cy: 0.42, s: 1.12 },
          { f: 110, cx: 0.5, cy: 0.42, s: 1.18 },
        ]}
        spots={[{ x: 0.093, y: 0.27, w: 0.818, h: 0.295, from: 40 }]}
      />
    </AbsoluteFill>
  );
}

// 52-56 s. Launch pool at the clearing price.
export function Pool() {
  return (
    <AbsoluteFill>
      <Head text={"Trading opens at the same price."} note={"Rhea pool #2981 · LP shares held by the keyless contract"} />
      <Shot
        src="shots/r-pool.png"
        {...SHOT}
        box={WIN}
        start={4}
        cam={[
          { f: 0, cx: 0.5, cy: 0.42, s: 1.12 },
          { f: 110, cx: 0.62, cy: 0.38, s: 1.4 },
        ]}
        spots={[{ x: 0.505, y: 0.27, w: 0.405, h: 0.165, from: 46 }]}
      />
    </AbsoluteFill>
  );
}

// 56-62 s. Ember: supply falls to what demand took.
export function Burn() {
  const frame = useCurrentFrame();
  const t = prog(frame, 26, 84, easeInOut);
  const left = lerp(1, 304400 / 722000, t);
  const tag = prog(frame, 96, 20, easeOut);
  return (
    <AbsoluteFill>
      <div style={{ position: "absolute", left: 0, right: 0, top: 120, display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
        <Words text={"Not enough demand? The rest burns."} start={0} size={60} tracking={-0.035} />
        <Note text={"ember-11141303 · settled at the floor, after the lock"} start={10} size={26} mono />
      </div>
      <Center y={40}>
        <Note text={"EMBER supply"} start={8} size={34} />
        <div style={{ fontFamily: T.sans, fontWeight: 700, fontSize: 210, letterSpacing: "-0.055em", color: T.ink, lineHeight: 1.05, ...rise(frame, 4, 24, 30, 14) }}>
          <Count from={722000} to={304400} start={26} dur={84} />
        </div>
        <div style={{ width: 1100, height: 14, borderRadius: 7, background: T.faint, marginTop: 34, position: "relative", overflow: "hidden", opacity: prog(frame, 10, 20) }}>
          <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${left * 100}%`, borderRadius: 7, background: T.blueFill }} />
        </div>
        <div style={{ width: 1100, display: "flex", justifyContent: "space-between", marginTop: 20, opacity: tag, transform: `translateY(${(1 - tag) * 10}px)` }}>
          <span style={{ fontFamily: T.sans, fontSize: 28, color: T.ink, fontWeight: 500 }}>304,400 left, 58% less</span>
          <span style={{ fontFamily: T.sans, fontSize: 28, color: T.dim, fontWeight: 500 }}>417,600 burned at the creator payout</span>
        </div>
      </Center>
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 90, display: "flex", justifyContent: "center" }}>
        <Words text={"Demand sets the supply."} start={120} size={56} tracking={-0.03} />
      </div>
    </AbsoluteFill>
  );
}

// The real verify-sale output, cut to the check titles.
function verifyLines() {
  const out: { text: string; kind: "head" | "pass" | "done" | "dim" }[] = [];
  for (const raw of (verifyText as string).split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (line.startsWith("Sale key run")) out.push({ text: "", kind: "dim" }, { text: "Sale key run · attestation #99432", kind: "head" });
    else if (line.startsWith("Clearing run")) out.push({ text: "", kind: "dim" }, { text: "Clearing run · attestation #99643", kind: "head" });
    else if (line.startsWith("Contract and rules")) out.push({ text: "", kind: "dim" }, { text: "Contract and rules", kind: "head" });
    else if (line.startsWith("Bid set:")) out.push({ text: "[PASS] 20 of 20 bids in the frozen bid set", kind: "pass" });
    else if (/^\s+\[PASS\]/.test(line)) out.push({ text: line.trim(), kind: "pass" });
    else if (line.startsWith("Every check passed")) out.push({ text: "", kind: "dim" }, { text: "Every check passed.", kind: "done" });
  }
  return out;
}

// 62-70 s. verify-sale in a terminal, then the count.
export function Verify() {
  const frame = useCurrentFrame();
  const cmd = "pnpm --filter web verify-sale --contract sealround.itzbeast.testnet --sale swarm-11141341";
  const typed = Math.floor(cmd.length * prog(frame, 4, 30, easeInOut));
  const lines = verifyLines();
  const shown = Math.max(0, Math.min(lines.length, Math.floor((frame - 40) / 3.2)));
  const LH = 40;
  const VISIBLE = 15;
  const scroll = Math.max(0, shown - VISIBLE) * LH;
  const term = prog(frame, 0, 26, easeOut);
  const shrink = prog(frame, 150, 30, easeInOut);
  return (
    <AbsoluteFill>
      <div
        style={{
          position: "absolute",
          left: 260,
          top: lerp(150, 110, shrink),
          width: 1400,
          height: 760,
          borderRadius: 22,
          background: "#0A0A0C",
          boxShadow: `0 0 0 1px ${T.hair}, 0 50px 140px rgba(0,0,0,0.65)`,
          overflow: "hidden",
          opacity: term * (1 - 0.86 * shrink),
          transform: `translateY(${(1 - term) * 70}px) scale(${1 - 0.06 * shrink})`,
          filter: `blur(${(1 - term) * 12 + shrink * 6}px)`,
        }}
      >
        <div style={{ height: 52, display: "flex", alignItems: "center", gap: 10, padding: "0 22px", borderBottom: `1px solid ${T.hair}` }}>
          {[0, 1, 2].map((i) => (
            <div key={i} style={{ width: 13, height: 13, borderRadius: 7, background: "rgba(245,245,247,0.16)" }} />
          ))}
          <span style={{ marginLeft: 16, fontFamily: T.mono, fontSize: 18, color: T.dim }}>read-only · no key · testnet RPC</span>
        </div>
        <div style={{ padding: "26px 36px", fontFamily: T.mono, fontSize: 25, lineHeight: `${LH}px` }}>
          <div style={{ color: T.ink, whiteSpace: "nowrap" }}>
            <span style={{ color: T.blue }}>$ </span>
            {cmd.slice(0, typed)}
            <span style={{ opacity: frame < 40 && Math.floor(frame / 8) % 2 === 0 ? 1 : 0 }}>▍</span>
          </div>
          <div style={{ height: 600, overflow: "hidden", marginTop: 12 }}>
            <div style={{ transform: `translateY(${-scroll}px)` }}>
              {lines.slice(0, shown).map((l, i) => (
                <div key={i} style={{ whiteSpace: "nowrap", color: l.kind === "head" ? T.ink : l.kind === "done" ? T.blue : T.dim, fontWeight: l.kind === "head" || l.kind === "done" ? 500 : 400 , height: LH }}>
                  {l.kind === "pass" ? (
                    <>
                      <span style={{ color: T.blue }}>{"  [PASS] "}</span>
                      {l.text.replace(/^\[PASS\]\s*/, "")}
                    </>
                  ) : (
                    l.text
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      {frame >= 156 && (
        <Center y={-10}>
          <div style={{ fontFamily: T.sans, fontWeight: 700, fontSize: 200, letterSpacing: "-0.055em", color: T.ink, lineHeight: 1, ...fade(frame, 158) }}>
            24<span style={{ color: T.dim }}> / </span>24
          </div>
          <div style={{ height: 22 }} />
          <Words text={"checks pass. *Anyone* can run them."} start={166} size={56} tracking={-0.03} />
          <div style={{ height: 26 }} />
          <Note text={"Intel signature chain: 8 of 8 enclave runs PROVEN by outlayer-verify"} start={186} size={26} mono />
        </Center>
      )}
    </AbsoluteFill>
  );
}

function fade(frame: number, start: number) {
  const t = prog(frame, start, 24, easeOut);
  return { opacity: t, transform: `scale(${1.08 - 0.08 * t})`, filter: `blur(${(1 - t) * 14}px)` } as const;
}
