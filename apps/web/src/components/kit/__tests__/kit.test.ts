/**
 * The launch kit's pure parts: the posts and their length as X counts it,
 * the times in UTC and another zone, and the QR code, read back from the SVG
 * the page shows and decoded here without the library that drew it.
 */
import { describe, expect, it } from "vitest";
import { QR_MARGIN, qrMatrix, qrPath, qrSvg, svgDataUrl } from "../qr";
import { X_LIMIT, isUtcZone, kitPosts, localStamp, utcStamp, xPostLength, xWeight, type KitPostInput, type KitWhere } from "../kit-text";

/** Bids open 14 Nov 2026, 16:00 UTC, close 18:00 UTC. */
const START = Date.UTC(2026, 10, 14, 16, 0);
const END = Date.UTC(2026, 10, 14, 18, 0);
const BASE: KitPostInput = { ticker: "FAIRT", bidStart: START, bidEnd: END, tee: true, phase: "upcoming", where: "testnet" };

describe("X length", () => {
  it("counts Latin as one, CJK and emoji as two, and a link as 23 after a space", () => {
    expect(xWeight("Bids open")).toBe(9);
    expect(xWeight("’")).toBe(1);
    expect(xWeight("梅")).toBe(2);
    expect(xWeight("🚀")).toBe(2);
    expect(xPostLength("abc", null)).toBe(3);
    expect(xPostLength("abc", `https://app.example.com/sale/${"x".repeat(32)}`)).toBe(3 + 1 + 23);
  });
});

describe("kitPosts", () => {
  const where: KitWhere[] = ["simulated", "sandbox", "testnet", "mainnet"];
  const url = "https://app.sealround.xyz/sale/fair-test";

  it("gives three posts before the close and only the reveal after it", () => {
    expect(kitPosts(BASE).map((p) => p.id)).toEqual(["launch", "closing", "reveal"]);
    expect(kitPosts({ ...BASE, phase: "open" }).map((p) => p.id)).toEqual(["launch", "closing", "reveal"]);
    expect(kitPosts({ ...BASE, phase: "closed" }).map((p) => p.id)).toEqual(["reveal"]);
  });

  it("names the ticker and absolute UTC times, never a relative one", () => {
    const [launch, closing, reveal] = kitPosts(BASE);
    expect(launch.text).toBe(
      "$FAIRT launches as a sealed-bid sale. Bids open at 16:00 UTC on 14 Nov and close at 18:00 UTC on 14 Nov. " +
        "Nobody sees a bid until the close, and every winner pays one price, bots included. On NEAR testnet.",
    );
    expect(closing.text).toContain("sealed bids close at 18:00 UTC on 14 Nov");
    expect(closing.text).toContain("Bots can't snipe what they can't see.");
    expect(reveal.text).toContain("an enclave opens every sealed bid at once");
    for (const p of [...kitPosts(BASE), ...kitPosts({ ...BASE, phase: "open" }), ...kitPosts({ ...BASE, phase: "closed" })]) {
      expect(p.text).not.toMatch(/\bin \d|hours?\b|minutes?\b|soon\b/);
    }
  });

  it("says a simulated sale is simulated, and where a real one runs", () => {
    for (const p of kitPosts({ ...BASE, where: "simulated" })) expect(p.text).toMatch(/Simulated sale on Sealround\.$/);
    for (const p of kitPosts({ ...BASE, where: "testnet" })) expect(p.text).toMatch(/On NEAR testnet\.$/);
    for (const p of kitPosts({ ...BASE, where: "mainnet" })) expect(p.text).not.toMatch(/Simulated|testnet|sandbox/);
  });

  it("speaks of bidders revealing on a commit-reveal sale, not of an enclave", () => {
    for (const phase of ["upcoming", "closed"] as const) {
      const reveal = kitPosts({ ...BASE, tee: false, phase }).at(-1)!;
      expect(reveal.text).not.toMatch(/enclave/);
      expect(reveal.text).toMatch(/reveal/);
    }
  });

  it("fits one post with the link for the longest ticker, in every phase and place", () => {
    const tickers = ["A", "FAIRT", "ABCDEFGHIJKLMNOP", "梅梅梅梅梅梅梅梅梅梅梅梅梅梅梅梅"];
    for (const ticker of tickers)
      for (const w of where)
        for (const phase of ["upcoming", "open", "closed"] as const)
          for (const tee of [true, false])
            for (const p of kitPosts({ ...BASE, ticker, where: w, phase, tee })) {
              expect(xPostLength(p.text, url), `${p.id} ${ticker} ${w} ${phase}`).toBeLessThanOrEqual(X_LIMIT);
            }
  });

  it("keeps only letters and digits of a ticker", () => {
    expect(kitPosts({ ...BASE, ticker: "$NO SNIPE!" })[0].text).toMatch(/^\$NOSNIPE launches/);
  });
});

describe("times", () => {
  it("writes UTC with the weekday and year", () => {
    expect(utcStamp(END)).toBe("Sat, 14 Nov 2026, 18:00 UTC");
  });

  it("writes the same moment in another zone with its name", () => {
    const s = localStamp(END, { timeZone: "Asia/Kolkata", locale: "en-GB" });
    expect(s).toContain("23:30");
    expect(s).toMatch(/GMT\+5:30|IST/);
    expect(localStamp(END, { timeZone: "America/New_York", locale: "en-GB" })).toContain("13:00");
  });

  it("knows when the viewer's zone is UTC already", () => {
    expect(isUtcZone("UTC")).toBe(true);
    expect(isUtcZone("Etc/UTC")).toBe(true);
    expect(isUtcZone("Etc/GMT")).toBe(true);
    expect(isUtcZone("Europe/London")).toBe(false);
    expect(isUtcZone(undefined)).toBe(false);
  });
});

// ---------- QR: read the SVG back and decode it ----------

/** The modules the SVG path draws, read back from its `M<x> <y>h<len>v1h-<len>z` runs. */
function matrixFromSvg(svg: string): boolean[][] {
  const side = Number(/viewBox="0 0 (\d+) (\d+)"/.exec(svg)![1]);
  const n = side - 2 * QR_MARGIN;
  const m = Array.from({ length: n }, () => Array<boolean>(n).fill(false));
  const d = /<path d="([^"]*)"/.exec(svg)![1];
  let consumed = 0;
  for (const run of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-(\d+)z/g)) {
    expect(run[3]).toBe(run[4]);
    const [x, y, len] = [Number(run[1]) - QR_MARGIN, Number(run[2]) - QR_MARGIN, Number(run[3])];
    for (let i = 0; i < len; i++) m[y][x + i] = true;
    consumed += run[0].length;
  }
  expect(consumed).toBe(d.length);
  return m;
}

/** Alignment pattern centres (ISO/IEC 18004 Annex E), versions 1 to 10. */
const ALIGN: Record<number, number[]> = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};
/** Error correction level M: [blocks, codewords per block, data codewords per block], versions 1 to 10. */
const BLOCKS_M: Record<number, [number, number, number][]> = {
  1: [[1, 26, 16]], 2: [[1, 44, 28]], 3: [[1, 70, 44]], 4: [[2, 50, 32]], 5: [[2, 67, 43]], 6: [[4, 43, 27]],
  7: [[4, 49, 31]], 8: [[2, 60, 38], [2, 61, 39]], 9: [[3, 58, 36], [2, 59, 37]], 10: [[4, 69, 43], [1, 70, 44]],
};
const MASKS: ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r * c) % 3) + ((r + c) % 2)) % 2 === 0,
];

/**
 * A byte-mode QR code at level M decoded from its modules: the function
 * patterns skipped, the data read in the standard zigzag under each of the
 * eight masks, the blocks de-interleaved, and the one segment parsed. A mask
 * counts only if the segment ends in the standard terminator and pad bytes.
 * Returns every text that decodes (exactly one for a good code).
 */
function decodeQr(m: boolean[][]): string[] {
  const n = m.length;
  const v = (n - 17) / 4;
  const A = ALIGN[v];
  const blocks = BLOCKS_M[v].flatMap(([count, total, data]) => Array.from({ length: count }, () => ({ total, data })));
  const totalCw = blocks.reduce((s, b) => s + b.total, 0);
  const last = A[A.length - 1];
  const isFunction = (r: number, c: number) => {
    if ((r <= 8 && c <= 8) || (r <= 8 && c >= n - 8) || (r >= n - 8 && c <= 8) || r === 6 || c === 6) return true;
    for (const ar of A)
      for (const ac of A) {
        if ((ar === 6 && ac === 6) || (ar === 6 && ac === last) || (ar === last && ac === 6)) continue;
        if (Math.abs(r - ar) <= 2 && Math.abs(c - ac) <= 2) return true;
      }
    if (v >= 7 && ((r <= 5 && c >= n - 11 && c <= n - 9) || (c <= 5 && r >= n - 11 && r <= n - 9))) return true;
    return false;
  };

  const out: string[] = [];
  for (const mask of MASKS) {
    const bits: number[] = [];
    let up = true;
    for (let col = n - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      for (let k = 0; k < n; k++) {
        const r = up ? n - 1 - k : k;
        for (const c of [col, col - 1]) if (!isFunction(r, c)) bits.push(m[r][c] !== mask(r, c) ? 1 : 0);
      }
      up = !up;
    }
    // Every data module is used, leaving at most 7 remainder bits.
    expect(bits.length - totalCw * 8).toBeGreaterThanOrEqual(0);
    expect(bits.length - totalCw * 8).toBeLessThan(8);
    const cw = Array.from({ length: totalCw }, (_, i) => bits.slice(i * 8, i * 8 + 8).reduce((a, b) => (a << 1) | b, 0));
    const perBlock: number[][] = blocks.map(() => []);
    let idx = 0;
    for (let i = 0; i < Math.max(...blocks.map((b) => b.data)); i++)
      blocks.forEach((b, j) => {
        if (i < b.data) perBlock[j].push(cw[idx++]);
      });
    const data = perBlock.flat();
    const stream = data.flatMap((byte) => Array.from({ length: 8 }, (_, i) => (byte >> (7 - i)) & 1));
    let p = 0;
    const read = (k: number) => {
      let x = 0;
      for (let i = 0; i < k; i++) x = (x << 1) | (stream[p++] ?? 0);
      return x;
    };
    if (read(4) !== 0b0100) continue;
    const len = read(v < 10 ? 8 : 16);
    if (p + len * 8 > stream.length) continue;
    const bytes = Array.from({ length: len }, () => read(8));
    // The terminator (up to four zero bits), zeros to the byte, then 0xEC 0x11 0xEC ...
    const term = Math.min(4, stream.length - p);
    if (read(term) !== 0) continue;
    while (p % 8) if (read(1) !== 0) break;
    if (p % 8) continue;
    let ok = true;
    for (let i = 0; p < stream.length; i++) if (read(8) !== (i % 2 ? 0x11 : 0xec)) ok = false;
    if (ok) out.push(String.fromCharCode(...bytes));
  }
  return out;
}

describe("QR code", () => {
  const urls = [
    "http://localhost:3000/sale/fair-test",
    // The kit page's own QR in the browser check (its SVG was hashed there and here, and matched).
    "http://agent-s.localhost:3000/sale/kitt",
    "https://app.sealround.xyz/sale/abcdefghijklmnopqrstuvwxyz012345",
    "https://sealround-demo.vercel.app/sale/judge-run-12",
  ];

  it("decodes, from the SVG the page shows, to exactly the sale link", () => {
    for (const url of urls) {
      const svg = qrSvg(qrMatrix(url), { title: `QR code: ${url}` });
      expect(decodeQr(matrixFromSvg(svg))).toEqual([url]);
    }
    // The decoder is strict: one module flipped in the data area and the link no longer comes out.
    const m = qrMatrix(urls[0]);
    const n = m.length;
    m[n - 1][n - 1] = !m[n - 1][n - 1];
    expect(decodeQr(m)).not.toContain(urls[0]);
  });

  it("is dark on white with a four-module quiet zone, whatever the theme", () => {
    const m = qrMatrix(urls[0]);
    const svg = qrSvg(m);
    const side = m.length + 2 * QR_MARGIN;
    expect(svg).toContain(`viewBox="0 0 ${side} ${side}"`);
    expect(svg).toContain('fill="#ffffff"');
    expect(svg).toContain('fill="#000000"');
    expect(svg).toContain('shape-rendering="crispEdges"');
    // Nothing is drawn in the quiet zone.
    for (const run of qrPath(m).matchAll(/M(\d+) (\d+)h(\d+)/g)) {
      expect(Number(run[1])).toBeGreaterThanOrEqual(QR_MARGIN);
      expect(Number(run[2])).toBeGreaterThanOrEqual(QR_MARGIN);
      expect(Number(run[1]) + Number(run[3])).toBeLessThanOrEqual(QR_MARGIN + m.length);
    }
    expect(svgDataUrl(svg)).toMatch(/^data:image\/svg\+xml;charset=utf-8,%3Csvg/);
  });

  it("escapes the title and refuses text the byte encoder would garble", () => {
    expect(qrSvg(qrMatrix(urls[0]), { title: `a<b>&"c'` })).toContain("<title>a&lt;b&gt;&amp;&quot;c&apos;</title>");
    expect(() => qrMatrix("https://例え.jp/sale/x")).toThrow();
    expect(() => qrMatrix("")).toThrow();
  });
});
