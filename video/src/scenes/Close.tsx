import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Words } from "../components/Words";
import { Shot } from "../components/Shot";
import { Logo } from "../components/Logo";
import { Center, Note } from "../components/Bits";
import { prog, easeIn } from "../lib/anim";
import { T } from "../lib/theme";

// 70-76 s. The judges' checklist.
export function Judges() {
  return (
    <AbsoluteFill>
      <div style={{ position: "absolute", left: 0, right: 0, top: 64, display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
        <Words text={"Check us in five minutes."} start={0} size={60} tracking={-0.035} />
        <Note text={"/judges runs every check in your browser. No wallet needed."} start={10} size={28} />
      </div>
      <Shot
        src="shots/judges.png"
        iw={2880}
        ih={1800}
        box={{ x: 320, y: 236, w: 1280, h: 800 }}
        start={6}
        cam={[
          { f: 0, cx: 0.5, cy: 0.5, s: 1 },
          { f: 50, cx: 0.5, cy: 0.5, s: 1 },
          { f: 130, cx: 0.5, cy: 0.5, s: 1.14 },
        ]}
        spots={[{ x: 0.096, y: 0.35, w: 0.82, h: 0.12, from: 120 }]}
      />
    </AbsoluteFill>
  );
}

// 76-80 s. Three lines on the beat, then push through.
export function Recap() {
  return (
    <Center y={-10}>
      <Words text={"Sealed bids."} start={0} size={118} stagger={3} dur={18} />
      <Words text={"One price."} start={30} size={118} stagger={3} dur={18} />
      <Words text={"*No* *bot* *edge.*"} start={60} size={118} stagger={4} dur={18} />
    </Center>
  );
}

// 80-88 s. Mark, line, where to look.
export function End() {
  const frame = useCurrentFrame();
  const fadeOut = prog(frame, 214, 26, easeIn);
  return (
    <AbsoluteFill style={{ opacity: 1 - fadeOut }}>
      <Center y={-70}>
        <Logo start={2} size={120} wordSize={140} />
        <div style={{ height: 40 }} />
        <Words text={"Bots can't snipe what they *can't* *see.*"} start={44} size={50} weight={500} tracking={-0.025} />
      </Center>
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 150, display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
        <Note text={"sealround-demo.vercel.app/judges"} start={84} size={32} color={T.ink} mono />
        <Note text={"github.com/Vasanthdev2004/sealround"} start={92} size={28} mono />
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 84, display: "flex", justifyContent: "center" }}>
        <Note text={"Built on NEAR  ·  OutLayer TEE  ·  Rhea"} start={110} size={24} />
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 40, display: "flex", justifyContent: "center" }}>
        <Note text={"Music: “Inspired” by Kevin MacLeod (incompetech.com), licensed under CC BY 4.0"} start={110} size={18} />
      </div>
    </AbsoluteFill>
  );
}
