import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion";
import timeline from "./timeline.json";
import { Scene } from "./components/Bits";
import { T, BAR } from "./lib/theme";
import { Cold, Curve, Profit, Question } from "./scenes/Problem";
import { Title, Seal, Open, Price } from "./scenes/Product";
import { Testnet, Sale, Timing, Reveal, Winners, Pool, Burn, Verify } from "./scenes/Proof";
import { Judges, Recap, End } from "./scenes/Close";

// How each scene leaves. Each one clears the frame by its last downbeat, so the
// next arrives on a clean canvas (no double exposure). overlap: frames it may stay.
// zoom > 1: the camera pushes through it into a hit on the next downbeat.
const SCENES: Record<string, { C: React.FC; overlap?: number; zoom?: number; out?: number }> = {
  cold: { C: Cold },
  curve: { C: Curve },
  profit: { C: Profit },
  question: { C: Question, overlap: 0, zoom: 1.7, out: 14 },
  title: { C: Title },
  seal: { C: Seal },
  open: { C: Open },
  price: { C: Price },
  testnet: { C: Testnet },
  sale: { C: Sale },
  timing: { C: Timing, overlap: 0, out: 8 },
  reveal: { C: Reveal },
  winners: { C: Winners },
  pool: { C: Pool },
  burn: { C: Burn, overlap: 0, zoom: 1.35, out: 16 },
  verify: { C: Verify },
  judges: { C: Judges },
  recap: { C: Recap, overlap: 0, zoom: 1.7, out: 14 },
  end: { C: End, overlap: 0, out: 1 },
};

export const LAUNCH_FRAMES = timeline.bars * BAR;

export function Launch() {
  return (
    <AbsoluteFill style={{ background: T.bg }}>
      <AbsoluteFill style={{ background: "radial-gradient(ellipse 70% 60% at 50% 45%, #0D0E12 0%, #050506 70%)" }} />
      {timeline.scenes.map((s) => {
        const cfg = SCENES[s.id];
        const overlap = cfg.overlap ?? 0;
        const len = s.bars * BAR;
        const out = cfg.out ?? 11;
        return (
          <Sequence key={s.id} from={s.start * BAR} durationInFrames={len + overlap} name={s.id}>
            <Scene dur={len + overlap} out={out} zoom={cfg.zoom}>
              <cfg.C />
            </Scene>
          </Sequence>
        );
      })}
      {/* "Inspired" by Kevin MacLeod (incompetech.com), CC BY 4.0. Credited on the end card. */}
      <Audio src={staticFile("audio/music.wav")} />
    </AbsoluteFill>
  );
}
