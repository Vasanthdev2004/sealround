import { fromB64, toB64 } from "../crypto";
import type { ChapterArtMime } from "./model";

export const MAX_ART_BYTES = 48 * 1024;
export const MAX_ART_SUBMISSIONS = 8;

export function isArtMime(value: unknown): value is ChapterArtMime {
  return value === "image/jpeg" || value === "image/png" || value === "image/webp";
}

export function decodeArt(imageBase64: string, mime: ChapterArtMime): Uint8Array {
  if (!imageBase64 || imageBase64.length > 4 * Math.ceil(MAX_ART_BYTES / 3)) {
    throw new Error("Artwork must fit within 48 KiB.");
  }
  const bytes = fromB64(imageBase64);
  if (bytes.length > MAX_ART_BYTES || toB64(bytes) !== imageBase64) throw new Error("Invalid artwork encoding.");
  const signature = (offset: number, expected: number[]) => expected.every((byte, i) => bytes[offset + i] === byte);
  const valid = mime === "image/jpeg" ? signature(0, [255, 216, 255])
    : mime === "image/png" ? signature(0, [137, 80, 78, 71, 13, 10, 26, 10])
    : mime === "image/webp" && signature(0, [82, 73, 70, 70]) && signature(8, [87, 69, 66, 80]);
  if (!valid) throw new Error("Artwork bytes must match the selected JPEG, PNG or WebP format.");
  return bytes;
}
