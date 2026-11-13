/**
 * Token icons. The contract's rule (sale.rs `create_sale`): `icon` is optional,
 * a `data:` URL of at most 2,048 bytes; the sale's token gets it in its NEP-148
 * metadata, so wallets show it. This file holds that rule, the small SVG marks
 * the create form generates, and what the app is willing to put in an <img>.
 *
 * Pure: no DOM, no canvas. Shrinking an uploaded image to fit is in
 * components/create/icon-image.ts.
 */

import { palette } from "./palette";

/** sale.rs `MAX_ICON_LEN`, in bytes (Rust `String::len`). */
export const MAX_ICON_BYTES = 2048;

/** UTF-8 length, the way the contract counts it. */
export const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

/** "1,734 bytes". */
export const bytesStr = (n: number): string => `${n.toLocaleString("en-US")} bytes`;

/**
 * The contract's check, as a sentence: null when create_sale takes the icon.
 * No icon (null, undefined or "") is fine: the field is optional.
 */
export function iconError(icon: string | null | undefined): string | null {
  if (!icon) return null;
  if (!icon.startsWith("data:")) return "The icon must be a data: URL.";
  const n = utf8Bytes(icon);
  if (n > MAX_ICON_BYTES) return `The icon is ${bytesStr(n)}. The contract takes at most ${bytesStr(MAX_ICON_BYTES)}.`;
  return null;
}

/**
 * The icon when it is safe to show in an <img>: an image data URL (never a
 * remote URL, which would leak the viewer's address, and never another data
 * type) within the contract's size. Null otherwise; the caller then shows
 * the monogram. An SVG in an <img> runs no script and loads nothing.
 */
export function safeIconSrc(icon: string | null | undefined): string | null {
  if (!icon || !icon.startsWith("data:image/")) return null;
  if (icon.length > MAX_ICON_BYTES * 2 || utf8Bytes(icon) > MAX_ICON_BYTES) return null;
  // Control characters have no place in a URL; a well-formed data URL never has them.
  if (/[\u0000-\u001f\u007f]/.test(icon)) return null;
  return icon;
}

/** The image type of a data URL ("png", "webp", "svg+xml"), or null. */
export function iconType(icon: string | null | undefined): string | null {
  const m = icon ? /^data:image\/([a-z0-9.+-]+)[;,]/i.exec(icon) : null;
  return m ? m[1].toLowerCase() : null;
}

// ---------- generated marks ----------

/** Quick picks for a mark. Single code points, so they render everywhere a recent emoji font exists. */
export const MARK_EMOJI = ["🐸", "🐶", "🐱", "🦊", "🐳", "🚀", "🌙", "🔥", "💎", "🍄"] as const;

const LETTERS = /^[A-Z0-9]{1,3}$/;
const PICTO = /\p{Extended_Pictographic}/u;

function graphemes(s: string): number {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    return [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(s)].length;
  }
  return [...s].length;
}

/**
 * What a mark shows: 1 to 3 letters or digits (upper-cased), or one emoji.
 * Null when the text is neither.
 */
export function markText(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const up = s.toUpperCase();
  if (LETTERS.test(up)) return up;
  if (PICTO.test(s) && s.length <= 16 && graphemes(s) === 1) return s;
  return null;
}

/** True for a mark's emoji (as opposed to letters). */
export const isEmojiMark = (text: string): boolean => PICTO.test(text);

/** The default mark text for a ticker: its first two characters, like the monogram. */
export const tickerMark = (symbol: string): string => symbol.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 2) || "?";

const FONT = "Inter,system-ui,Helvetica,Arial,sans-serif";
const SVG_HEAD = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>";

const escapeXml = (s: string) =>
  s.replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&apos;", '"': "&quot;" })[c]!);

/** Letter size in the 64-unit box, by how many letters. */
const markFontSize = (text: string) => (isEmojiMark(text) ? 38 : [34, 34, 28, 21][Math.min(3, [...text].length)]);

/** The mark's SVG: the hue's bright ink as a full square, the text in its dark ink. */
export function markSvg(text: string, hue: number): string {
  const p = palette(hue);
  return (
    SVG_HEAD +
    `<rect width='64' height='64' fill='${p.ground}'/>` +
    `<text x='32' y='33' text-anchor='middle' dominant-baseline='central' font-family='${FONT}' ` +
    `font-size='${markFontSize(text)}' font-weight='700' fill='${p.deep}'>${escapeXml(text)}</text></svg>`
  );
}

/**
 * A generated mark as a data URL: a tiny SVG (letters or one emoji on a
 * colour from the app's palette), URL-encoded. About 500 bytes, well under
 * the contract's limit. Null when `text` is not a valid mark.
 */
export function markIcon(text: string, hue: number): string | null {
  const t = markText(text);
  return t === null ? null : `data:image/svg+xml,${encodeURIComponent(markSvg(t, hue))}`;
}

const MARK_RE = new RegExp(
  "^" +
    SVG_HEAD.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&") +
    "<rect width='64' height='64' fill='(#[0-9a-f]{6})'/>" +
    "<text [^>]*fill='(#[0-9a-f]{6})'>([^<]{1,40})</text></svg>$",
);

/**
 * A mark this app generated, read back: its colours and text. Null for any
 * other icon. The share card draws such a mark itself, since its renderer
 * has no font inside an SVG image.
 */
export function parseMark(icon: string | null | undefined): { bg: string; fg: string; text: string } | null {
  if (!icon?.startsWith("data:image/svg+xml,")) return null;
  let svg: string;
  try {
    svg = decodeURIComponent(icon.slice("data:image/svg+xml,".length));
  } catch {
    return null;
  }
  const m = MARK_RE.exec(svg);
  if (!m) return null;
  const text = m[3].replace(/&(amp|lt|gt|apos|quot);/g, (_, e: string) => ({ amp: "&", lt: "<", gt: ">", apos: "'", quot: '"' })[e]!);
  return markText(text) === null ? null : { bg: m[1], fg: m[2], text };
}

// ---------- raster icons ----------

const RASTER_RE = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

function b64Bytes(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((x, i) => b[at + i] === x);

/**
 * A base64 PNG, JPEG, GIF or WebP whose bytes are the type it claims (the
 * file's magic number), or null. The share card only draws these.
 */
export function rasterIcon(icon: string | null | undefined): { type: string; bytes: Uint8Array } | null {
  const m = icon ? RASTER_RE.exec(icon) : null;
  if (!m) return null;
  const bytes = b64Bytes(m[2]);
  if (!bytes || bytes.length < 16) return null;
  const ok =
    m[1] === "png"
      ? startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      : m[1] === "jpeg"
        ? startsWith(bytes, [0xff, 0xd8, 0xff])
        : m[1] === "gif"
          ? startsWith(bytes, [0x47, 0x49, 0x46, 0x38])
          : startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8);
  return ok ? { type: m[1], bytes } : null;
}
