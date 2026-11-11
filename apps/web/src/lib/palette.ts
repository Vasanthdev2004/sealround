/**
 * A stable, in-gamut colour for a sale from its stored HSL hue, computed in
 * OKLCH so every hue comes out at a comparable strength. Used to tint a
 * token's monogram. Pure, so it gives the same value on the server and
 * the client.
 */

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

// ---------- OKLCH colour ----------

type Vec3 = [number, number, number];

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gam = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function rgb2lab(r0: number, g0: number, b0: number): Vec3 {
  const r = lin(r0);
  const g = lin(g0);
  const b = lin(b0);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function lab2lin(L: number, a: number, b: number): Vec3 {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = (v: Vec3) => v.every((x) => x >= -0.0005 && x <= 1.0005);
const hex = (v: Vec3) =>
  "#" + v.map((x) => Math.round(gam(clamp(x, 0, 1)) * 255).toString(16).padStart(2, "0")).join("");

/** oklch to #rrggbb, lowering chroma until the colour fits sRGB. */
function oklch(L: number, C: number, h: number): string {
  const hr = (h * Math.PI) / 180;
  for (let c = C; c > 0; c -= 0.002) {
    const v = lab2lin(L, c * Math.cos(hr), c * Math.sin(hr));
    if (inGamut(v)) return hex(v);
  }
  return hex(lab2lin(L, 0, 0));
}

function maxChroma(L: number, h: number): number {
  const hr = (h * Math.PI) / 180;
  let lo = 0;
  let hi = 0.4;
  for (let i = 0; i < 18; i++) {
    const c = (lo + hi) / 2;
    if (inGamut(lab2lin(L, c * Math.cos(hr), c * Math.sin(hr)))) lo = c;
    else hi = c;
  }
  return lo;
}

/** Lightness at which this hue reaches its most saturated sRGB colour (yellow about 0.95, blue about 0.45). */
function cuspL(h: number): number {
  let best = 0.7;
  let bc = 0;
  for (let L = 0.4; L <= 0.95; L += 0.01) {
    const c = maxChroma(L, h);
    if (c > bc) {
      bc = c;
      best = L;
    }
  }
  return best;
}

/** The app stores an HSL hue per sale; convert it to the OKLCH hue angle. */
function okHue(hslHue: number): number {
  const f = (n: number) => {
    const k = (n + hslHue / 30) % 12;
    return 0.5 - 0.5 * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  const [, a, b] = rgb2lab(f(0), f(8), f(4));
  return ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
}

export type HuePalette = {
  /** The bright ink, at the hue's chroma cusp. The sale's accent on its own page. */
  ground: string;
  /** The dark ink. Text on `ground`. */
  deep: string;
  /** The near-white ink. */
  paper: string;
};

const paletteCache = new Map<number, HuePalette>();

/** Three flat inks from one stored HSL hue. Cached: the cusp search is a few thousand float ops. */
export function palette(hue: number): HuePalette {
  const key = ((Math.round(hue) % 360) + 360) % 360;
  const hit = paletteCache.get(key);
  if (hit) return hit;
  const H = okHue(key);
  const p: HuePalette = {
    ground: oklch(clamp(cuspL(H) + 0.05, 0.66, 0.87), 0.22, H),
    deep: oklch(0.25, 0.07, H),
    paper: oklch(0.955, 0.025, H),
  };
  paletteCache.set(key, p);
  return p;
}
