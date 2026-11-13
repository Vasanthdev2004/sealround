/**
 * The sale link as a QR code, made in the browser with qrcode-generator
 * (MIT). Error correction level M, the smallest version that fits. The SVG
 * is dark modules on white with a four-module quiet zone, whatever the
 * page's theme, because scanners read that most reliably; the page shows the
 * same SVG it lets the creator download.
 */

import qrcode from "qrcode-generator";

/** Modules of light border on every side (the QR standard's quiet zone). */
export const QR_MARGIN = 4;

/** The code's modules, row by row: true is dark. */
export function qrMatrix(text: string): boolean[][] {
  // The default encoder takes each character as one byte, so only ASCII goes in; a URL from new URL() is ASCII.
  if (!/^[\x20-\x7e]+$/.test(text)) throw new Error("QR text must be printable ASCII");
  const qr = qrcode(0, "M");
  qr.addData(text, "Byte");
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}

/**
 * One path for the dark modules: each horizontal run as a rectangle,
 * `M<x> <y>h<len>v1h-<len>z`, in module units, offset by the quiet zone.
 */
export function qrPath(m: boolean[][], margin = QR_MARGIN): string {
  const parts: string[] = [];
  m.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x++;
        continue;
      }
      let len = 1;
      while (x + len < row.length && row[x + len]) len++;
      parts.push(`M${x + margin} ${y + margin}h${len}v1h-${len}z`);
      x += len;
    }
  });
  return parts.join("");
}

/**
 * A standalone SVG file: white square, black modules, crisp edges, `size` px
 * wide when shown at its own size. The two colours belong to the file (a
 * scanner needs dark on light), not to the page's theme.
 */
export function qrSvg(m: boolean[][], o: { size?: number; title?: string } = {}): string {
  const side = m.length + 2 * QR_MARGIN;
  const size = o.size ?? side * 8;
  const title = o.title ? `<title>${escapeXml(o.title)}</title>` : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" width="${size}" height="${size}" shape-rendering="crispEdges">` +
    title +
    `<rect width="${side}" height="${side}" fill="#ffffff"/>` +
    `<path d="${qrPath(m)}" fill="#000000"/>` +
    `</svg>`
  );
}

/** The SVG as a data URL for an <img>. */
export const svgDataUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
}
