/**
 * Inter for the share cards. `next/og` reads only TTF, OTF and WOFF, and the
 * repo has no Inter in that form (next/font ships WOFF2), so the TTF files are
 * fetched from Google Fonts once per server process and kept in memory.
 *
 * Offline, or when Google is slow, this resolves to `undefined` and the cards
 * render in `next/og`'s bundled Geist instead: a card is always served. A
 * failure is retried at most once a minute.
 */

export type OgFont = { name: string; data: ArrayBuffer; weight: 400 | 500 | 600; style: "normal" };

const WEIGHTS = [400, 500, 600] as const;
const CSS_URL = `https://fonts.googleapis.com/css2?family=Inter:wght@${WEIGHTS.join(";")}`;
// Google serves TTF to user agents it does not know as WOFF2-capable; this is the one next/og uses itself.
const TTF_UA =
  "Mozilla/5.0 (Macintosh; U; Intel Mac OS X 10_6_8; de-at) AppleWebKit/533.21.1 (KHTML, like Gecko) Version/5.0.5 Safari/533.21.1";
const RETRY_AFTER_MS = 60_000;

/**
 * The TTF/OTF URL for each weight in a Google Fonts stylesheet. Prefers the
 * block marked `latin` when the sheet is split by script.
 */
export function parseFontCss(css: string): Map<number, string> {
  const out = new Map<number, { url: string; latin: boolean }>();
  const block = /(?:\/\*\s*([\w-]+)\s*\*\/\s*)?@font-face\s*\{([^}]*)\}/g;
  for (const m of css.matchAll(block)) {
    const body = m[2];
    const weight = Number(/font-weight:\s*(\d+)/.exec(body)?.[1]);
    const url = /src:\s*url\(([^)]+)\)\s*format\(['"](?:truetype|opentype)['"]\)/.exec(body)?.[1];
    if (!weight || !url) continue;
    const latin = m[1] === "latin";
    const seen = out.get(weight);
    if (!seen || (latin && !seen.latin)) out.set(weight, { url: url.replace(/^['"]|['"]$/g, ""), latin });
  }
  return new Map([...out].map(([w, v]) => [w, v.url]));
}

export async function fetchInter(opts: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<OgFont[]> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 4_000);
  const res = await fetchImpl(CSS_URL, { headers: { "user-agent": TTF_UA }, signal });
  if (!res.ok) throw new Error(`Google Fonts CSS: HTTP ${res.status}`);
  const urls = parseFontCss(await res.text());
  return Promise.all(
    WEIGHTS.map(async (weight) => {
      const url = urls.get(weight);
      if (!url) throw new Error(`Google Fonts CSS has no TTF for Inter ${weight}`);
      const file = await fetchImpl(url, { signal });
      if (!file.ok) throw new Error(`Inter ${weight}: HTTP ${file.status}`);
      return { name: "Inter", data: await file.arrayBuffer(), weight, style: "normal" as const };
    }),
  );
}

let loaded: OgFont[] | null = null;
let pending: Promise<OgFont[] | undefined> | null = null;
let failedAt = 0;

/** Inter at 400, 500 and 600, or `undefined` (use next/og's default font). Never throws. */
export function loadOgFonts(): Promise<OgFont[] | undefined> {
  if (loaded) return Promise.resolve(loaded);
  if (pending) return pending;
  if (failedAt && Date.now() - failedAt < RETRY_AFTER_MS) return Promise.resolve(undefined);
  pending = fetchInter()
    .then((fonts) => {
      loaded = fonts;
      return fonts;
    })
    .catch((e: unknown) => {
      failedAt = Date.now();
      console.warn(`[og] Inter unavailable, share cards use the default font: ${e instanceof Error ? e.message : e}`);
      return undefined;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}
