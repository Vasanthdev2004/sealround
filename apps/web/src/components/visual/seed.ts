/**
 * Deterministic pseudo-randomness for generative visuals. Same seed, same
 * picture, on the server and in every browser, so nothing shifts on hydration.
 * Never feed bid prices in here: visuals are decoration, not data.
 */

/**
 * The hue a sale is drawn in. Violet (250-310) is reserved for bots, so a sale
 * seeded there is drawn in rose instead (330-344), keeping purple bars and
 * ticks unambiguous next to sale art.
 */
export function saleHue(h: number): number {
  const x = ((Math.round(h) % 360) + 360) % 360;
  return x >= 250 && x <= 310 ? 330 + Math.round(((x - 250) / 60) * 14) : x;
}

/** FNV-1a 32-bit hash of a string. */
export function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32: a tiny seeded PRNG returning floats in [0, 1). */
export function rng(seed: string | number): () => number {
  let a = typeof seed === "number" ? seed >>> 0 : hash32(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HEX = "0123456789abcdef";

/** Hex-looking "ciphertext" of length n, derived from the seed. */
export function cipherText(seed: string, n: number): string {
  const r = rng(`cipher:${seed}`);
  let out = "";
  for (let i = 0; i < n; i++) out += HEX[Math.floor(r() * 16)];
  return out;
}

/** A React useId value made safe for SVG `url(#id)` references. */
export const svgId = (id: string) => `v${id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
