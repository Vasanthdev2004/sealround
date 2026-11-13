/**
 * An uploaded image as a token icon: cropped to a centred square, then shrunk
 * until its data URL fits the contract's 2,048 bytes (sale.rs `MAX_ICON_LEN`).
 *
 * The order of attempts is pure (`encodeAttempts`) and so is the loop that
 * walks it (`shrinkToFit`, given an encoder), so both are tested without a
 * browser. `iconFromFile` is the browser part: decode, crop, draw, encode.
 *
 * Why this order: at each size, PNG first (lossless, best for flat logos),
 * then JPEG for an opaque image, then WebP. PNG and JPEG also render on the
 * share card (next/og draws neither WebP nor GIF), so they win where they fit
 * at the same size. Smaller sizes come before lower quality, down to 32 px;
 * only then a last pass at low quality.
 */

import { MAX_ICON_BYTES, utf8Bytes } from "@/lib/token-icon";

export type IconFormat = "image/png" | "image/jpeg" | "image/webp";
export type EncodeAttempt = { size: number; type: IconFormat; quality?: number };

export const ICON_SIZES = [64, 56, 48, 40, 32] as const;
const JPEG_Q = [0.9, 0.8, 0.7, 0.6];
const WEBP_Q = [0.9, 0.8, 0.7, 0.6, 0.5];
const LAST_Q = [0.5, 0.4, 0.3];

/** Every encoding to try, best first. `opaque`: the image has no transparent pixel, so JPEG may be used. */
export function encodeAttempts(opaque: boolean): EncodeAttempt[] {
  const out: EncodeAttempt[] = [];
  for (const size of ICON_SIZES) {
    out.push({ size, type: "image/png" });
    if (opaque) for (const quality of JPEG_Q) out.push({ size, type: "image/jpeg", quality });
    for (const quality of WEBP_Q) out.push({ size, type: "image/webp", quality });
  }
  for (const size of [32, 24]) {
    if (size !== 32) out.push({ size, type: "image/png" });
    for (const quality of LAST_Q) {
      if (opaque) out.push({ size, type: "image/jpeg", quality });
      out.push({ size, type: "image/webp", quality });
    }
  }
  return out;
}

export type ShrinkResult =
  | { ok: true; dataUrl: string; size: number; type: IconFormat; quality?: number; bytes: number }
  | { ok: false; smallest: number | null };

/**
 * Walks the attempts and returns the first data URL that is an image of the
 * type asked for and fits. A browser that cannot encode a type (old Safari
 * and WebP) returns a PNG instead; that answer is skipped, since the PNG at
 * that size was already tried.
 */
export async function shrinkToFit(
  encode: (a: EncodeAttempt) => string | Promise<string>,
  opaque: boolean,
  max = MAX_ICON_BYTES,
): Promise<ShrinkResult> {
  let smallest: number | null = null;
  for (const a of encodeAttempts(opaque)) {
    const url = await encode(a);
    if (!url.startsWith(`data:${a.type};`) && !url.startsWith(`data:${a.type},`)) continue;
    const bytes = utf8Bytes(url);
    smallest = smallest === null ? bytes : Math.min(smallest, bytes);
    if (bytes <= max) return { ok: true, dataUrl: url, size: a.size, type: a.type, quality: a.quality, bytes };
  }
  return { ok: false, smallest };
}

/** Uploads larger than this are refused before decoding. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ACCEPT = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml", "image/avif"];
export const ACCEPT_ATTR = ACCEPT.join(",");

export type IconUpload = { dataUrl: string; size: number; type: IconFormat; bytes: number; name: string };

/** Decodes a file into something canvas can draw. */
async function decode(file: File): Promise<{ img: CanvasImageSource; w: number; h: number; done: () => void }> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    // An SVG without a size decodes as 0 x 0 in some browsers: give it a box.
    const w = img.naturalWidth || 256;
    const h = img.naturalHeight || 256;
    return { img, w, h, done: () => URL.revokeObjectURL(url) };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

/**
 * Crops the file to its centred square and shrinks it to fit. Throws an
 * Error with a sentence for the user when the file cannot be used.
 */
export async function iconFromFile(file: File): Promise<IconUpload> {
  if (!ACCEPT.includes(file.type)) throw new Error("Use a PNG, JPEG, WebP, GIF, AVIF or SVG image.");
  if (file.size > MAX_UPLOAD_BYTES) throw new Error("That file is over 10 MB. Pick a smaller image.");
  let src: Awaited<ReturnType<typeof decode>>;
  try {
    src = await decode(file);
  } catch {
    throw new Error("This browser could not read that image. Try a PNG or JPEG.");
  }
  try {
    // The centred square, drawn once at 256 px with smoothing, so each small size
    // is a modest step down from a clean source (one big jump would alias).
    const side = Math.min(src.w, src.h);
    const base = document.createElement("canvas");
    base.width = base.height = 256;
    const bctx = base.getContext("2d");
    if (!bctx) throw new Error("This browser cannot draw images here.");
    bctx.imageSmoothingEnabled = true;
    bctx.imageSmoothingQuality = "high";
    bctx.drawImage(src.img, (src.w - side) / 2, (src.h - side) / 2, side, side, 0, 0, 256, 256);
    const alpha = bctx.getImageData(0, 0, 256, 256).data;
    let opaque = true;
    for (let i = 3; i < alpha.length; i += 4) {
      if (alpha[i] < 255) {
        opaque = false;
        break;
      }
    }

    const out = document.createElement("canvas");
    const encode = (a: EncodeAttempt) => {
      out.width = out.height = a.size;
      const ctx = out.getContext("2d")!;
      ctx.clearRect(0, 0, a.size, a.size);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(base, 0, 0, 256, 256, 0, 0, a.size, a.size);
      return out.toDataURL(a.type, a.quality);
    };
    const r = await shrinkToFit(encode, opaque);
    if (!r.ok) {
      throw new Error(
        `This image does not fit in ${MAX_ICON_BYTES.toLocaleString("en-US")} bytes, even at 24 px. Try a simpler image with flat colours, or generate a mark.`,
      );
    }
    return { dataUrl: r.dataUrl, size: r.size, type: r.type, bytes: r.bytes, name: file.name };
  } finally {
    src.done();
  }
}
