import { Easing, interpolate } from "remotion";

// Entrances settle late and soft; exits leave quickly. Nothing is linear.
export const easeOut = Easing.bezier(0.16, 1, 0.3, 1);
export const easeIn = Easing.bezier(0.7, 0, 0.84, 0);
export const easeInOut = Easing.bezier(0.65, 0, 0.35, 1);

export const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

// 0 to 1 over [start, start + dur] with an easing.
export function prog(frame: number, start: number, dur: number, ease = easeOut) {
  return interpolate(frame, [start, start + dur], [0, 1], { ...clamp, easing: ease });
}

export function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

// Keyframed value: [[frame, value], ...], eased between keys.
export function keys(frame: number, k: [number, number][], ease = easeInOut) {
  if (frame <= k[0][0]) return k[0][1];
  for (let i = 1; i < k.length; i++) {
    if (frame <= k[i][0]) {
      const t = interpolate(frame, [k[i - 1][0], k[i][0]], [0, 1], { ...clamp, easing: ease });
      return lerp(k[i - 1][1], k[i][1], t);
    }
  }
  return k[k.length - 1][1];
}

// Rise in: opacity, a small lift and a focus pull from blur.
export function rise(frame: number, start: number, dur = 20, lift = 28, blur = 12) {
  const t = prog(frame, start, dur);
  return {
    opacity: t,
    transform: `translateY(${(1 - t) * lift}px)`,
    filter: `blur(${(1 - t) * blur}px)`,
  } as const;
}

// Leave: fade, slight lift and blur.
export function leave(frame: number, start: number, dur = 12, lift = -16, blur = 10) {
  const t = prog(frame, start, dur, easeIn);
  return { opacity: 1 - t, transform: `translateY(${t * lift}px)`, filter: `blur(${t * blur}px)` } as const;
}
