/**
 * Share cards: the metadata origin, the Inter loader, the mapping from the
 * contract's views to a card and a page title, the server-side read with its
 * fallbacks, and the sale image route's fallback to the generic card.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResultView, SaleView } from "../near/views";
import { fetchInter, loadOgFonts, parseFontCss } from "./fonts";
import { cardText, heroFontSize, saleCard, saleMeta } from "./sale-card";
import { isPlausibleSaleId, readSaleViews } from "./sale-data";
import { saleImage } from "./sale-image";
import { siteUrl } from "./site-url";

const E18 = 10n ** 18n;

const SALE: SaleView = {
  sale_id: "lantern",
  status: "settled",
  creator: "alice.testnet",
  token: "lantern.fairground.testnet",
  quote_token: "usdc.fakes.testnet",
  token_name: "Lantern Network",
  token_symbol: "LNTN",
  decimals: 18,
  icon: null,
  description: null,
  website: null,
  total_supply: (1_000_000n * E18).toString(),
  sale_supply: (100_000n * E18).toString(),
  creator_allocation: (900_000n * E18).toString(),
  floor_price: "1000",
  max_price: null,
  min_raise: "50000000",
  bid_start: "1",
  bid_end: "2",
  min_deposit: "1000000",
  max_deposit_per_account: "10000000",
  max_bids: 100,
  reveal_mode: "Tee",
  reveal_window: null,
  reveal_end: null,
  settle_timeout: "1",
  refund_mode_at: null,
  unsold_rule: "Burn",
  sealer_code_hash: "f8408a87",
  sealer_pubkey: null,
  token_setup: "done",
  sealer_key_setup: "done",
  created_at: "1",
  closed_at: "2",
  bid_count: 54,
  total_deposits: "300000000",
  bid_set_hash: "",
};

const RESULT: ResultView = {
  sale_id: "lantern",
  status: "settled",
  fail_reason: null,
  clearing_price: "1956",
  total_sold: (82_400n * E18).toString(),
  total_raised: "161174400",
  unsold: (17_600n * E18).toString(),
  n_valid: 52,
  n_invalid: 2,
  n_winners: 40,
  failed_checks: [],
  failed_checks_total: 0,
  result_sha256: null,
  input_sha256: null,
  clear_requests: 1,
  clear_attempts: 1,
  total_penalties: "0",
  proceeds: { raise_paid: false, allocation_paid: false, unsold_burned: true, reserve_returned: false },
};

const isPng = (b: Uint8Array) => Buffer.from(b.slice(1, 4)).toString() === "PNG";
const pngSize = (b: Uint8Array) => {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { width: v.getUint32(16), height: v.getUint32(20) };
};

describe("siteUrl", () => {
  it("uses NEXT_PUBLIC_APP_URL first", () => {
    expect(siteUrl({ NEXT_PUBLIC_APP_URL: "https://app.sealround.xyz/", VERCEL_URL: "x.vercel.app" }).href).toBe(
      "https://app.sealround.xyz/",
    );
  });

  it("falls back to the production domain on Vercel production, the branch URL on a preview", () => {
    const vercel = { VERCEL_PROJECT_PRODUCTION_URL: "sealround-demo.vercel.app", VERCEL_BRANCH_URL: "b.vercel.app", VERCEL_URL: "d.vercel.app" };
    expect(siteUrl({ ...vercel, VERCEL_ENV: "production" }).origin).toBe("https://sealround-demo.vercel.app");
    expect(siteUrl({ ...vercel, VERCEL_ENV: "preview" }).origin).toBe("https://b.vercel.app");
    expect(siteUrl({ VERCEL_ENV: "preview", VERCEL_URL: "d.vercel.app" }).origin).toBe("https://d.vercel.app");
  });

  it("ends at localhost, and ignores an unusable app URL", () => {
    expect(siteUrl({}).origin).toBe("http://localhost:3000");
    expect(siteUrl({ PORT: "4123" }).origin).toBe("http://localhost:4123");
    expect(siteUrl({ NEXT_PUBLIC_APP_URL: "ftp://nope", PORT: "x" }).origin).toBe("http://localhost:3000");
  });
});

describe("Inter for the cards", () => {
  const CSS = `/* cyrillic */
@font-face { font-family: 'Inter'; font-weight: 400; src: url(https://fonts.gstatic.com/cyr-400.ttf) format('truetype'); }
/* latin */
@font-face { font-family: 'Inter'; font-weight: 400; src: url(https://fonts.gstatic.com/lat-400.ttf) format('truetype'); }
@font-face { font-family: 'Inter'; font-weight: 500; src: url(https://fonts.gstatic.com/500.ttf) format('truetype'); }
@font-face { font-family: 'Inter'; font-weight: 600; src: url(https://fonts.gstatic.com/600.woff2) format('woff2'); }
@font-face { font-family: 'Inter'; font-weight: 600; src: url(https://fonts.gstatic.com/600.ttf) format('truetype'); }`;

  it("reads one TTF per weight, preferring the latin block and skipping WOFF2", () => {
    expect(Object.fromEntries(parseFontCss(CSS))).toEqual({
      400: "https://fonts.gstatic.com/lat-400.ttf",
      500: "https://fonts.gstatic.com/500.ttf",
      600: "https://fonts.gstatic.com/600.ttf",
    });
  });

  it("fetches the stylesheet and the three files", async () => {
    const seen: string[] = [];
    const fake = (async (url: string) => {
      seen.push(String(url));
      return String(url).includes("googleapis") ? new Response(CSS) : new Response(new Uint8Array([1, 2, 3]));
    }) as typeof fetch;
    const fonts = await fetchInter({ fetch: fake });
    expect(fonts.map((f) => [f.name, f.weight, f.data.byteLength])).toEqual([
      ["Inter", 400, 3],
      ["Inter", 500, 3],
      ["Inter", 600, 3],
    ]);
    expect(seen[0]).toContain("family=Inter:wght@400;500;600");
  });

  it("fails on a stylesheet without TTF, and offline loadOgFonts resolves to the default font", async () => {
    const woff2Only = (async () => new Response("@font-face { font-weight: 400; src: url(a.woff2) format('woff2'); }")) as unknown as typeof fetch;
    await expect(fetchInter({ fetch: woff2Only })).rejects.toThrow(/no TTF/);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("fetch failed")));
    await expect(loadOgFonts()).resolves.toBeUndefined();
    // A failure is remembered for a minute: no second request.
    const calls = vi.fn(() => Promise.reject(new TypeError("fetch failed")));
    vi.stubGlobal("fetch", calls);
    await expect(loadOgFonts()).resolves.toBeUndefined();
    expect(calls).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
});

describe("saleCard", () => {
  it("shows a settled sale's clearing price, sold, burned and bidders", () => {
    const card = saleCard(SALE, RESULT, "testnet");
    expect(card).toMatchObject({
      name: "Lantern Network",
      symbol: "LNTN",
      monogram: "LN",
      phase: "Settled",
      tone: "ok",
      hero: { label: "Clearing price", value: "0.001956", unit: "USDC per LNTN" },
      outcome: null,
      line: "Everyone paid the same price.",
      lineAccent: true,
      network: "NEAR testnet",
    });
    expect(card.stats).toEqual([
      { label: "Sold", value: "82.4K", unit: "LNTN" },
      { label: "Burned", value: "17.6K", unit: "LNTN" },
      { label: "Bidders", value: "54" },
    ]);
  });

  it("says the unsold tokens are still to burn until claim_proceeds burns them", () => {
    const card = saleCard(SALE, { ...RESULT, proceeds: { ...RESULT.proceeds, unsold_burned: false } }, "testnet");
    expect(card.stats[1].label).toBe("Unsold, to burn");
    const soldOut = saleCard(SALE, { ...RESULT, unsold: "0", proceeds: { ...RESULT.proceeds, unsold_burned: false } }, "testnet");
    expect(soldOut.stats[1]).toEqual({ label: "Burned", value: "0", unit: "LNTN" });
  });

  it("keeps a settled sale without its result to what get_sale says", () => {
    const card = saleCard(SALE, null, "testnet");
    expect(card.hero).toBeNull();
    expect(card.outcome).toBe("Settled");
    expect(card.stats.map((s) => s.label)).toEqual(["For sale", "Bidders"]);
  });

  it("shows a failed sale's reason and the refund", () => {
    const failed = { ...SALE, status: "failed" as const };
    const card = saleCard(failed, { ...RESULT, fail_reason: "below_min_raise" }, "testnet");
    expect(card).toMatchObject({
      phase: "Refunding",
      tone: "warn",
      hero: null,
      outcome: "Did not clear",
      line: "Bids stayed below the minimum raise.",
      note: "Every valid bid gets its whole deposit back.",
    });
    expect(card.stats).toEqual([
      { label: "For sale", value: "100K", unit: "LNTN" },
      { label: "Bidders", value: "54" },
      { label: "Min raise", value: "50", unit: "USDC" },
    ]);
    expect(saleCard(failed, null, "testnet").line).toBe("No tokens were sold.");
  });

  it("shows the floor and the sealed bid count before settlement", () => {
    const open = saleCard({ ...SALE, status: "open", bid_count: 17 }, RESULT, "mainnet");
    expect(open).toMatchObject({
      phase: "Live",
      tone: "accent",
      hero: { label: "Floor price", value: "0.001", unit: "USDC per LNTN" },
      line: "Bids stay sealed until close. Everyone pays one clearing price.",
      network: "NEAR mainnet",
    });
    expect(open.stats).toEqual([
      { label: "For sale", value: "100K", unit: "LNTN" },
      { label: "Sealed bids", value: "17" },
      { label: "Min raise", value: "50", unit: "USDC" },
    ]);
    expect(saleCard({ ...SALE, status: "setup" }, null, "testnet")).toMatchObject({ phase: "Upcoming", tone: "neutral" });
    expect(saleCard({ ...SALE, status: "closed" }, null, "testnet").phase).toBe("Clearing");
    expect(saleCard({ ...SALE, status: "clearing" }, null, "testnet").line).toMatch(/attested enclave/);
    expect(saleCard({ ...SALE, status: "revealing", reveal_mode: "CommitReveal" }, null, "testnet").line).toMatch(
      /Bidders reveal their bids/,
    );
  });

  it("drops emoji and control characters and cuts long names", () => {
    expect(cardText("  Frog\u0000 🐸 Coin\n v2 ", 40)).toBe("Frog Coin v2");
    expect(cardText("abcdefghij", 6)).toBe("abcde…");
    const card = saleCard({ ...SALE, token_name: "A".repeat(64), token_symbol: "🚀" }, RESULT, "testnet");
    expect([...card.name]).toHaveLength(34);
    expect(card.name.endsWith("…")).toBe(true);
    expect(card.symbol).toBe("TOKEN");
  });

  it("sizes the big number so it fits beside its unit", () => {
    expect(heroFontSize("0.001956", "USDC per LNTN")).toBe(112);
    expect(heroFontSize("123,456.789123", "USDC per SUPERLONGSYMBOL1")).toBeLessThan(80);
    expect(heroFontSize("1".repeat(40), "USDC per X")).toBe(56);
  });
});

describe("saleMeta", () => {
  it("titles the sale and the result page by token, and describes the outcome", () => {
    const settled = saleCard(SALE, RESULT, "testnet");
    expect(saleMeta(settled, "sale")).toEqual({
      title: "Lantern Network (LNTN)",
      description: "Lantern Network (LNTN) settled at 0.001956 USDC per LNTN. 54 bidders, everyone paid the same price.",
    });
    expect(saleMeta(settled, "result").title).toBe("Lantern Network (LNTN) result");
    expect(saleMeta(saleCard({ ...SALE, bid_count: 1 }, RESULT, "testnet"), "sale").description).toContain("1 bidder,");

    const open = saleCard({ ...SALE, status: "open" }, null, "testnet");
    expect(saleMeta(open, "sale").description).toBe(
      "Lantern Network (LNTN): a sealed-bid sale of 100K LNTN on NEAR testnet. Bids stay sealed until close. Everyone pays one clearing price.",
    );

    const failed = saleCard({ ...SALE, status: "failed" }, { ...RESULT, fail_reason: "no_bids" }, "testnet");
    expect(saleMeta(failed, "result").description).toBe(
      "Lantern Network (LNTN) did not clear. No bids came in. Every valid bid gets its whole deposit back.",
    );
  });
});

describe("readSaleViews", () => {
  const target = { rpcUrl: "http://127.0.0.1:3030", contractId: "fairground.testnet", network: "testnet" as const };
  const bytes = (value: unknown) => Array.from(new TextEncoder().encode(JSON.stringify(value)));

  /** A node that answers get_sale and get_result from `views`, or with `fail` for the named method. */
  function node(views: { get_sale?: unknown; get_result?: unknown }, fail: string[] = []) {
    const methods: string[] = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const method = body.params.method_name as keyof typeof views;
      methods.push(method);
      if (fail.includes(method)) return new Response("busy", { status: 503 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { result: bytes(views[method] ?? null) } }));
    }) as typeof fetch;
    return { fetchImpl, methods };
  }

  it("reads get_sale and get_result for a sale id", async () => {
    const { fetchImpl, methods } = node({ get_sale: SALE, get_result: RESULT });
    const views = await readSaleViews("lantern", target, { fetch: fetchImpl });
    expect(views).toEqual({ sale: SALE, result: RESULT, network: "testnet" });
    expect(methods.sort()).toEqual(["get_result", "get_sale"]);
  });

  it("keeps the sale when only get_result fails or is malformed", async () => {
    expect((await readSaleViews("lantern", target, { fetch: node({ get_sale: SALE }, ["get_result"]).fetchImpl }))?.result).toBeNull();
    const odd = node({ get_sale: SALE, get_result: { clearing_price: 12 } });
    expect((await readSaleViews("lantern", target, { fetch: odd.fetchImpl }))?.result).toBeNull();
  });

  it("returns null for an unknown sale, a failed or malformed get_sale, or an id the contract cannot have", async () => {
    expect(await readSaleViews("nope", target, { fetch: node({ get_sale: null }).fetchImpl })).toBeNull();
    expect(await readSaleViews("lantern", target, { fetch: node({ get_sale: SALE }, ["get_sale"]).fetchImpl })).toBeNull();
    expect(await readSaleViews("lantern", target, { fetch: node({ get_sale: { ...SALE, sale_supply: 5 } }).fetchImpl })).toBeNull();
    const never = vi.fn() as unknown as typeof fetch;
    for (const id of ["", "Lantern", "a".repeat(33), "-lead", "a..b", "x/../y", "%2e"]) {
      expect(await readSaleViews(id, target, { fetch: never })).toBeNull();
    }
    expect(never).not.toHaveBeenCalled();
    expect(isPlausibleSaleId("judge-run-3")).toBe(true);
    expect(isPlausibleSaleId("smoke-11120830")).toBe(true);
  });

  it("returns null when the node is unreachable", async () => {
    const views = await readSaleViews("lantern", { ...target, rpcUrl: "http://127.0.0.1:9" }, { timeoutMs: 2_000 });
    expect(views).toBeNull();
  });

  it("gives up on a node that does not answer within the timeout", async () => {
    const hang = ((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as typeof fetch;
    const started = Date.now();
    expect(await readSaleViews("lantern", target, { fetch: hang, timeoutMs: 80 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("saleImage", () => {
  const noFonts = async () => undefined;

  it("draws a sale's card as a 1200 x 630 PNG with a short CDN cache", async () => {
    const res = await saleImage("lantern", { read: async () => ({ sale: SALE, result: RESULT, network: "testnet" }), fonts: noFonts });
    const png = new Uint8Array(await res.arrayBuffer());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("s-maxage=300");
    expect(isPng(png)).toBe(true);
    expect(pngSize(png)).toEqual({ width: 1200, height: 630 });
  });

  it("falls back to the generic card when the sale cannot be read or drawn", async () => {
    const cases = [
      async () => null,
      async () => {
        throw new Error("rpc down");
      },
      // A view that passes the reader's checks in another shape: the card throws, the route does not.
      async () => ({ sale: { ...SALE, sale_supply: "lots" }, result: null, network: "testnet" as const }),
    ];
    for (const read of cases) {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const res = await saleImage("lantern", { read, fonts: noFonts });
      const png = new Uint8Array(await res.arrayBuffer());
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).not.toContain("s-maxage");
      expect(isPng(png)).toBe(true);
      expect(pngSize(png)).toEqual({ width: 1200, height: 630 });
      warn.mockRestore();
    }
  });

  it("falls back to the generic card when the RPC node is unreachable", async () => {
    const read = (id: string) =>
      readSaleViews(id, { rpcUrl: "http://127.0.0.1:9", contractId: "fairground.testnet", network: "testnet" }, { timeoutMs: 2_000 });
    const res = await saleImage("lantern", { read, fonts: noFonts });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).not.toContain("s-maxage");
    expect(isPng(new Uint8Array(await res.arrayBuffer()))).toBe(true);
  });
});
