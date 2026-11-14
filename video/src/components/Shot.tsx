import React from "react";
import { Img, staticFile, useCurrentFrame } from "remotion";
import { prog, keys, easeOut, easeInOut } from "../lib/anim";
import { T } from "../lib/theme";

export type Cam = { f: number; cx: number; cy: number; s: number };
export type Spot = { x: number; y: number; w: number; h: number; from: number; to?: number };

// A real screen in a quiet frame. The camera moves by keyframes (centre as a
// fraction of the image, zoom relative to fit-width); a spotlight dims all but
// one region.
export function Shot({
  src,
  iw,
  ih,
  box,
  start = 0,
  cam = [{ f: 0, cx: 0.5, cy: 0.5, s: 1 }],
  spots = [],
  radius = 22,
  tilt = 10,
}: {
  src: string;
  iw: number;
  ih: number;
  box: { x: number; y: number; w: number; h: number };
  start?: number;
  cam?: Cam[];
  spots?: Spot[];
  radius?: number;
  tilt?: number;
}) {
  const frame = useCurrentFrame();
  const e = prog(frame, start, 30, easeOut);
  const k = (key: keyof Cam) => keys(frame, cam.map((c) => [c.f, c[key] as number] as [number, number]), easeInOut);
  const s = k("s");
  const imgW = box.w * s;
  const imgH = (imgW * ih) / iw;
  let tx = box.w / 2 - k("cx") * imgW;
  let ty = box.h / 2 - k("cy") * imgH;
  tx = Math.min(0, Math.max(box.w - imgW, tx));
  ty = Math.min(0, Math.max(box.h - imgH, ty));
  return (
    <div style={{ position: "absolute", left: box.x, top: box.y, width: box.w, height: box.h, perspective: 2400 }}>
      <div
        style={{
          width: "100%",
          height: "100%",
          borderRadius: radius,
          overflow: "hidden",
          position: "relative",
          background: "#0A0A0C",
          boxShadow: `0 0 0 1px ${T.hair}, 0 50px 140px rgba(0,0,0,0.65)`,
          opacity: e,
          transform: `translateY(${(1 - e) * 90}px) rotateX(${(1 - e) * tilt}deg) scale(${0.94 + 0.06 * e})`,
          filter: e < 1 ? `blur(${(1 - e) * 14}px)` : undefined,
        }}
      >
        <div style={{ position: "absolute", left: tx, top: ty, width: imgW, height: imgH }}>
          <Img src={staticFile(src)} style={{ width: imgW, height: imgH, display: "block" }} />
          {spots.map((sp, i) => {
            const on = prog(frame, sp.from, 18, easeOut) * (sp.to === undefined ? 1 : 1 - prog(frame, sp.to, 14, easeInOut));
            if (on <= 0) return null;
            return (
              <div
                key={i}
                style={{
                  position: "absolute",
                  left: sp.x * imgW,
                  top: sp.y * imgH,
                  width: sp.w * imgW,
                  height: sp.h * imgH,
                  borderRadius: 14,
                  boxShadow: `0 0 0 3px rgba(61,126,255,${0.9 * on}), 0 0 0 4000px rgba(5,5,6,${0.62 * on})`,
                }}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
