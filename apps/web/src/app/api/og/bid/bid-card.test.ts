/**
 * The "I'm in" bid card: the link's parameters and their limits, what the
 * card and the post say (never a price, an amount or a deposit), the chain
 * read, the image route's fallbacks and the sale page's `?bid=` metadata.
 */
import type { ResolvingMetadata } from "next";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SaleCardViews } from "@/lib/og/sale-data";
import type { SaleView } from "@/lib/near/views";
import {
  bidCardText,
  bidLine,
  chainBidCard,
  mockBidCard,
  parseBidCardQuery,
  parseBidNumber,
  readBidCardViews,
  type BidCardViews,
  type BidSaleView,
} from "./card";
import { bidImage } from "./image";
import { withBidCard } from "./metadata";
import { GET } from "./route";
import {
  bidCardQuery,
  bidImageFileName,
  bidImagePath,
  bidSharePath,
  bidShareText,
  revealText,
  tickerOf,
  utcDay,
  utcTime,
} from "./share";

/** 14 Nov 2026, 18:00 UTC. */
const REVEAL = Date.UTC(2026, 10, 14, 18, 0);
const NS = (ms: number) => (BigInt(ms) * 1_000_000n).toString();

const SALE: BidSaleView = {
  status: "open",
  token_name: "No Snipe Coin",
  token_symbol: "NOSNIPE",
  icon: null,
  bid_end: NS(REVEAL),
  bid_count: 54,
  // 1,234.56 USDC across all bids.
  total_deposits: "1234560000",
};

/** The bidder's own deposit and price: they must never reach the card, its link or its words. */
const SECRET_DEPOSIT = "777777777";
const SECRET_PRICE = "0.004242";

const VIEWS = (bid: BidCardViews["bid"] = { index: 11, bidder: "alice.testnet" }): BidCardViews => ({
  sale: SALE,
  bid,
  network: "testnet",
});

const isPng = (b: Uint8Array) => Buffer.from(b.slice(1, 4)).toString() === "PNG";
const pngSize = (b: Uint8Array) => {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { width: v.getUint32(16), height: v.getUint32(20) };
};
const noFonts = async () => undefined;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("share link and post", () => {
  it("puts only the bid number (and a chosen account) in a NEAR link", () => {
    const input = { saleId: "lantern", bidNumber: 12 };
    expect(bidCardQuery(input).toString()).toBe("bid=12");
    expect(bidCardQuery({ ...input, account: "alice.near" }).toString()).toBe("bid=12&by=alice.near");
    expect(bidSharePath(input)).toBe("/sale/lantern?bid=12");
    expect(bidImagePath(input)).toBe("/api/og/bid?sale=lantern&bid=12");
  });

  it("adds the simulated sale's name, ticker and reveal time in a mock link", () => {
    const input = {
      saleId: "nosnipe",
      bidNumber: 3,
      sim: { name: "  No Snipe Coin, the very long edition name  ", ticker: "$NO-SNIPE", revealAt: REVEAL },
    };
    const q = bidCardQuery(input);
    expect([...q.keys()]).toEqual(["bid", "name", "ticker", "end"]);
    expect(q.get("name")).toBe("No Snipe Coin, the very long editi");
    expect(q.get("ticker")).toBe("NOSNIPE");
    expect(q.get("end")).toBe(String(REVEAL));
    expect(bidCardQuery({ ...input, sim: { ...input.sim, revealAt: null } }).has("end")).toBe(false);
  });

  it("never names a price, an amount or a deposit", () => {
    const keys = [...bidCardQuery({ saleId: "x1", bidNumber: 1, account: "a.near", sim: { name: "N", ticker: "T", revealAt: REVEAL } }).keys()];
    expect(keys.every((k) => ["bid", "by", "name", "ticker", "end"].includes(k))).toBe(true);
  });

  it("writes the post in plain words, with where the sale runs", () => {
    const o = { ticker: "NOSNIPE", bidNumber: 12, revealAt: REVEAL };
    expect(bidShareText({ ...o, where: "mainnet" })).toBe(
      "I'm in. Sealed bid #12 in $NOSNIPE. Nobody can see my price, not even the bots. Reveal at 18:00 UTC on 14 Nov.",
    );
    expect(bidShareText({ ...o, where: "testnet" })).toMatch(/Reveal at 18:00 UTC on 14 Nov\. On NEAR testnet\.$/);
    expect(bidShareText({ ...o, where: "simulated" })).toMatch(/Simulated sale on Sealround\.$/);
    expect(bidShareText({ ...o, ticker: "$no snipe!", where: "mainnet" })).toContain("in $nosnipe.");
  });

  it("formats the reveal in UTC, the ticker and the file name", () => {
    expect(utcTime(REVEAL)).toBe("18:00 UTC");
    expect(utcDay(REVEAL)).toBe("14 Nov");
    expect(revealText(Date.UTC(2026, 0, 2, 0, 5))).toBe("00:05 UTC on 2 Jan");
    expect(tickerOf("$N0-SNIPE🚀")).toBe("N0SNIPE");
    expect(tickerOf("ABCDEFGHIJKLMNOPQRST")).toBe("ABCDEFGHIJKLMNOP");
    expect(tickerOf("🚀")).toBe("TOKEN");
    expect(bidImageFileName("NoSnipe", 12)).toBe("sealround-nosnipe-bid-12.png");
    expect(bidImageFileName("Ωmega", 1)).toBe("sealround-mega-bid-1.png");
  });
});

describe("parseBidCardQuery", () => {
  const p = (s: string) => new URLSearchParams(s);

  it("reads bid and by in NEAR mode and ignores the mock fields", () => {
    expect(parseBidCardQuery("lantern", p("bid=12&name=Evil&ticker=EVIL&end=1"), "near")).toEqual({
      saleId: "lantern",
      bidNumber: 12,
      by: null,
      sim: null,
    });
    expect(parseBidCardQuery("lantern", p("bid=12&by=alice.near"), "near")?.by).toBe("alice.near");
  });

  it("drops an account that is not a NEAR account id", () => {
    for (const by of ["Alice.near", "a..b", "-a.near", "a", "x".repeat(65), "<b>.near", "alice.near/x"]) {
      expect(parseBidCardQuery("lantern", p(`bid=1&by=${encodeURIComponent(by)}`), "near")?.by).toBeNull();
    }
  });

  it("refuses a bid number that is not 1 to 10,000 written plainly", () => {
    for (const bid of ["0", "-1", "1.5", "abc", "10001", "012", "1e3", " 1", "", "99999"]) {
      expect(parseBidNumber(bid)).toBeNull();
      expect(parseBidCardQuery("lantern", p(`bid=${encodeURIComponent(bid)}`), "near")).toBeNull();
    }
    expect(parseBidNumber("10000")).toBe(10_000);
    expect(parseBidCardQuery("lantern", p(""), "near")).toBeNull();
  });

  it("refuses a sale id the contract cannot have, a repeated parameter and an over-long one", () => {
    for (const id of ["", "Lantern", "a..b", "x/../y", "a".repeat(33), "%2e"]) {
      expect(parseBidCardQuery(id, p("bid=1&ticker=X"), "mock")).toBeNull();
    }
    expect(parseBidCardQuery("lantern", p("bid=1&bid=2"), "near")).toBeNull();
    expect(parseBidCardQuery("lantern", p(`bid=1&by=${"a".repeat(121)}`), "near")).toBeNull();
    expect(parseBidCardQuery("lantern", p(`bid=1&ticker=X&name=${"a".repeat(121)}`), "mock")).toBeNull();
    expect(parseBidCardQuery("lantern", { bid: ["1", "2"] }, "near")).toBeNull();
  });

  it("needs a plain ticker in mock mode and cleans the name", () => {
    expect(parseBidCardQuery("nosnipe", p("bid=12"), "mock")).toBeNull();
    for (const t of ["<script>", "NO SNIPE", "ABCDEFGHIJKLMNOPQ", "🚀"]) {
      expect(parseBidCardQuery("nosnipe", p(`bid=1&ticker=${encodeURIComponent(t)}`), "mock")).toBeNull();
    }
    const q = parseBidCardQuery(
      "nosnipe",
      { bid: "12", ticker: "$NOSNIPE", name: "🐸 No <b>Snipe</b>\u0000 Coin, the extremely long edition", end: String(REVEAL) },
      "mock",
    );
    expect(q).toEqual({
      saleId: "nosnipe",
      bidNumber: 12,
      by: null,
      sim: { name: "No bSnipe/b Coin, the extremely l…", ticker: "NOSNIPE", revealAt: REVEAL },
    });
    expect(parseBidCardQuery("nosnipe", p("bid=1&ticker=NS"), "mock")?.sim).toEqual({ name: "NS", ticker: "NS", revealAt: null });
    for (const end of ["1", "abc", "99999999999999999", String(Date.UTC(2101, 0, 1))]) {
      expect(parseBidCardQuery("nosnipe", p(`bid=1&ticker=NS&end=${end}`), "mock")?.sim?.revealAt).toBeNull();
    }
  });
});

describe("the card's content", () => {
  const q = { saleId: "nosnipe", bidNumber: 12, by: null, sim: null };

  it("says I'm in, the bid number, the reveal and the sale's public totals", () => {
    const card = chainBidCard({ ...VIEWS(), bid: { index: 11, bidder: "alice.testnet" } }, q);
    expect(card).toMatchObject({
      name: "No Snipe Coin",
      symbol: "NOSNIPE",
      monogram: "NO",
      icon: null,
      phase: "Live",
      tone: "accent",
      hero: null,
      outcome: "I'm in.",
      line: "Sealed bid #12 in $NOSNIPE",
      lineAccent: true,
      note: "Price and amount sealed until the reveal.",
      network: "NEAR testnet",
    });
    expect(card.stats).toEqual([
      { label: "Reveal", value: "18:00 UTC", unit: "14 Nov" },
      { label: "Sealed bids", value: "54" },
      { label: "Deposits", value: "1,234.56", unit: "USDC" },
    ]);
  });

  it("leaves out the deposit total while it would say too much about each bid", () => {
    for (const n of [1, 2]) {
      const card = chainBidCard({ sale: { ...SALE, bid_count: n, total_deposits: SECRET_DEPOSIT }, bid: { index: 0, bidder: "a.near" }, network: "testnet" }, { ...q, bidNumber: 1 });
      expect(card.stats.map((s) => s.label)).toEqual(["Reveal", "Sealed bids"]);
      expect(JSON.stringify(card)).not.toContain("777");
    }
  });

  it("shows the account only when the link asks and it is the bid's own bidder", () => {
    const views = { ...VIEWS(), bid: { index: 11, bidder: "alice.testnet" } };
    expect(chainBidCard(views, { ...q, by: "alice.testnet" }).line).toBe("Sealed bid #12 in $NOSNIPE by alice.testnet");
    const spoof = chainBidCard(views, { ...q, by: "vitalik.near" });
    expect(spoof.line).toBe("Sealed bid #12 in $NOSNIPE");
    expect(JSON.stringify(spoof)).not.toContain("vitalik");
    expect(JSON.stringify(chainBidCard(views, q))).not.toContain("alice");
    expect(bidLine(3, "X", "a".repeat(58) + ".testnet")).toBe(`Sealed bid #3 in $X by ${"a".repeat(15)}….testnet`);
  });

  it("says where the sale went after the close, never a price", () => {
    const views = (status: SaleView["status"]) => ({ sale: { ...SALE, status }, bid: { index: 0, bidder: "a.near" }, network: "testnet" as const });
    expect(chainBidCard(views("closed"), q)).toMatchObject({ phase: "Clearing", note: "Bidding closed. Every bid opens at once." });
    expect(chainBidCard(views("settled"), q)).toMatchObject({ phase: "Settled", tone: "ok", note: "Revealed. Every winner paid one clearing price." });
    expect(chainBidCard(views("failed"), q)).toMatchObject({ phase: "Refunding", tone: "warn" });
    expect(chainBidCard(views("settled"), q).line).toBe("Sealed bid #1 in $NOSNIPE");
  });

  it("draws the contract's PNG or JPEG icon, never a remote URL", () => {
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const at = (icon: string | null) => chainBidCard({ sale: { ...SALE, icon }, bid: { index: 0, bidder: "a.near" }, network: "testnet" }, q).icon;
    expect(at(png)).toEqual({ kind: "image", src: png });
    expect(at("https://evil.example/x.png")).toBeNull();
    expect(at("data:image/svg+xml,<svg onload='x'/>")).toBeNull();
  });

  it("draws a simulated sale from the link alone, labelled as simulated", () => {
    const card = mockBidCard({ saleId: "nosnipe", bidNumber: 7, by: "you.testnet", sim: { name: "No Snipe Coin", ticker: "NOSNIPE", revealAt: REVEAL } });
    expect(card).toMatchObject({ icon: null, phase: "Sealed", outcome: "I'm in.", line: "Sealed bid #7 in $NOSNIPE by you.testnet", network: "Simulated sale" });
    expect(card.stats).toEqual([
      { label: "Reveal", value: "18:00 UTC", unit: "14 Nov" },
      { label: "Price", value: "Sealed" },
      { label: "Amount", value: "Sealed" },
    ]);
    const noTime = mockBidCard({ saleId: "nosnipe", bidNumber: 7, by: null, sim: { name: "N", ticker: "N", revealAt: null } });
    expect(noTime.stats.map((s) => s.label)).toEqual(["Price", "Amount"]);
  });

  it("titles and describes the preview", () => {
    expect(bidCardText({ ticker: "NOSNIPE", bidNumber: 12, revealAt: REVEAL, simulated: false })).toEqual({
      title: "I'm in. Sealed bid #12 in $NOSNIPE",
      description:
        "Price and amount stay sealed until the reveal at 18:00 UTC on 14 Nov. Every winner pays one clearing price, bots included.",
      alt: "I'm in: sealed bid #12 in $NOSNIPE on Sealround. Price and amount stay sealed until the reveal.",
    });
    expect(bidCardText({ ticker: "N", bidNumber: 1, revealAt: null, simulated: true }).description).toBe(
      "Price and amount stay sealed until the reveal. Every winner pays one clearing price, bots included. Simulated sale on Sealround.",
    );
  });

  it("never carries the bidder's price or deposit", () => {
    const all = JSON.stringify([
      chainBidCard({ ...VIEWS(), bid: { index: 11, bidder: "alice.testnet" } }, { ...q, by: "alice.testnet" }),
      mockBidCard({ saleId: "n", bidNumber: 1, by: null, sim: { name: "N", ticker: "N", revealAt: REVEAL } }),
      bidCardText({ ticker: "NOSNIPE", bidNumber: 12, revealAt: REVEAL, simulated: true }),
    ]);
    expect(all).not.toContain(SECRET_PRICE);
    expect(all).not.toContain("777");
    expect(all).not.toMatch(/max price|max spend/i);
  });
});

describe("readBidCardViews", () => {
  const target = { rpcUrl: "http://127.0.0.1:3030", contractId: "fairground.testnet", network: "testnet" as const };
  const bytes = (value: unknown) => Array.from(new TextEncoder().encode(JSON.stringify(value)));

  function node(answers: { get_sale?: unknown; get_bids?: unknown }, fail: string[] = []) {
    const calls: { method: string; args: Record<string, unknown> }[] = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const method = body.params.method_name as keyof typeof answers;
      calls.push({ method, args: JSON.parse(Buffer.from(body.params.args_base64, "base64").toString()) });
      if (fail.includes(method)) return new Response("busy", { status: 503 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { result: bytes(answers[method] ?? null) } }));
    }) as typeof fetch;
    return { fetchImpl, calls };
  }

  const BID = { index: 11, bidder: "alice.testnet", deposit: SECRET_DEPOSIT, payload: "AAAA", placed_at: "1", revealed: false, claimed: false };

  it("reads get_sale and only the one bid, from its index", async () => {
    const { fetchImpl, calls } = node({ get_sale: SALE, get_bids: [BID] });
    const views = await readBidCardViews("nosnipe", 12, target, { fetch: fetchImpl });
    expect(views).toEqual({ sale: SALE, bid: { index: 11, bidder: "alice.testnet" }, network: "testnet" });
    expect(calls.find((c) => c.method === "get_bids")?.args).toEqual({ sale_id: "nosnipe", from_index: 11, limit: 1 });
    // The bid's deposit is read from the node but not kept.
    expect(JSON.stringify(views)).not.toContain(SECRET_DEPOSIT);
  });

  it("says the sale has no such bid when get_bids does not list it", async () => {
    for (const bids of [[], [{ ...BID, index: 3 }], [{ ...BID, bidder: 7 }], { nope: 1 }]) {
      expect((await readBidCardViews("nosnipe", 12, target, { fetch: node({ get_sale: SALE, get_bids: bids }).fetchImpl }))?.bid).toBeNull();
    }
    expect((await readBidCardViews("nosnipe", 12, target, { fetch: node({ get_sale: SALE, get_bids: [BID] }, ["get_bids"]).fetchImpl }))?.bid).toBeNull();
  });

  it("returns null for an unknown or malformed sale, a failed node, or input it should not send", async () => {
    expect(await readBidCardViews("nosnipe", 12, target, { fetch: node({ get_sale: null, get_bids: [BID] }).fetchImpl })).toBeNull();
    expect(await readBidCardViews("nosnipe", 12, target, { fetch: node({ get_sale: { ...SALE, bid_end: 5 }, get_bids: [BID] }).fetchImpl })).toBeNull();
    expect(await readBidCardViews("nosnipe", 12, target, { fetch: node({ get_sale: SALE }, ["get_sale"]).fetchImpl })).toBeNull();
    const never = vi.fn() as unknown as typeof fetch;
    expect(await readBidCardViews("Bad..Id", 1, target, { fetch: never })).toBeNull();
    expect(await readBidCardViews("nosnipe", 0, target, { fetch: never })).toBeNull();
    expect(await readBidCardViews("nosnipe", 10_001, target, { fetch: never })).toBeNull();
    expect(never).not.toHaveBeenCalled();
  });
});

describe("bidImage", () => {
  const mock = () => "mock" as const;
  const near = () => "near" as const;
  const MOCK_Q = `sale=nosnipe&bid=12&name=No+Snipe+Coin&ticker=NOSNIPE&end=${REVEAL}`;

  async function png(res: Response) {
    const b = new Uint8Array(await res.arrayBuffer());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(isPng(b)).toBe(true);
    expect(pngSize(b)).toEqual({ width: 1200, height: 630 });
    return b;
  }

  it("draws a mock bid card from the link, kept by a CDN for a day", async () => {
    const res = await bidImage(new URLSearchParams(MOCK_Q), { mode: mock, fonts: noFonts });
    await png(res);
    expect(res.headers.get("cache-control")).toContain("s-maxage=86400");
  });

  it("draws a NEAR bid card from the chain, kept for five minutes", async () => {
    const read = vi.fn(async () => VIEWS());
    const res = await bidImage(new URLSearchParams("sale=nosnipe&bid=12&by=alice.testnet&name=Evil"), { mode: near, read, fonts: noFonts });
    await png(res);
    expect(res.headers.get("cache-control")).toContain("s-maxage=300");
    expect(read).toHaveBeenCalledWith("nosnipe", 12);
  });

  it("serves the sale's own card when the sale has no bid at that number", async () => {
    const saleCard = vi.fn(async () => new Response("sale card", { status: 200 }));
    const res = await bidImage(new URLSearchParams("sale=nosnipe&bid=99"), { mode: near, read: async () => VIEWS(null), fonts: noFonts, saleCard });
    expect(await res.text()).toBe("sale card");
    expect(saleCard).toHaveBeenCalledWith("nosnipe");
  });

  it("falls back to the generic card, never a 500", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cases: [string, Parameters<typeof bidImage>[1]][] = [
      ["", { mode: mock }],
      ["sale=nosnipe&bid=12", { mode: mock }],
      ["sale=nosnipe&bid=0&ticker=X", { mode: mock }],
      ["sale=Bad..Id&bid=1&ticker=X", { mode: mock }],
      ["sale=a&sale=b&bid=1&ticker=X", { mode: mock }],
      [`sale=${"a".repeat(200)}&bid=1&ticker=X`, { mode: mock }],
      ["sale=nosnipe&bid=12", { mode: near, read: async () => null }],
      ["sale=nosnipe&bid=12", { mode: near, read: async () => Promise.reject(new Error("rpc down")) }],
      // A view in another shape: the card throws, the route does not.
      ["sale=nosnipe&bid=12", { mode: near, read: async () => ({ ...VIEWS(), sale: { ...SALE, total_deposits: "lots" } }) }],
      [
        MOCK_Q,
        {
          mode: () => {
            throw new Error("NEXT_PUBLIC_NEAR_NETWORK is not valid");
          },
        },
      ],
    ];
    for (const [query, deps] of cases) {
      const res = await bidImage(new URLSearchParams(query), { fonts: noFonts, ...deps });
      await png(res);
      expect(res.headers.get("cache-control")).not.toContain("s-maxage");
    }
    warn.mockRestore();
  });

  it("still answers when the fonts fail or the token icon cannot be drawn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await png(await bidImage(new URLSearchParams(MOCK_Q), { mode: mock, fonts: () => Promise.reject(new Error("offline")) }));
    // PNG magic, then junk: the card can accept it, the renderer cannot decode it.
    const broken = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(24).fill(7)]).toString("base64")}`;
    const read = async () => ({ ...VIEWS(), sale: { ...SALE, icon: broken } });
    await png(await bidImage(new URLSearchParams("sale=nosnipe&bid=12"), { mode: near, read, fonts: noFonts }));
    warn.mockRestore();
  });

  it("answers the route's GET in mock mode", async () => {
    vi.stubEnv("NEXT_PUBLIC_FAIRGROUND_CONTRACT", "");
    await png(await GET(new NextRequest(`http://localhost/api/og/bid?${MOCK_Q}`)));
    await png(await GET(new NextRequest("http://localhost/api/og/bid?sale=%00&bid=-1")));
  });
});

describe("withBidCard (the sale page's metadata)", () => {
  const BASE = { title: "Sale", description: "Place a sealed bid. Everyone pays one clearing price." };
  const parent = Promise.resolve({ openGraph: { siteName: "Sealround", locale: "en_US" } }) as unknown as ResolvingMetadata;
  const args = (search: Record<string, string | string[] | undefined>, id = "nosnipe") => ({
    params: Promise.resolve({ id }),
    searchParams: Promise.resolve(search),
    parent,
  });
  const chain = (bid_count: number): SaleCardViews =>
    ({ sale: { ...SALE, bid_count } as unknown as SaleView, result: null, network: "testnet" });

  it("leaves the metadata as it is without a bid, or with one that does not check out", async () => {
    const read = vi.fn(async () => chain(20));
    expect(await withBidCard(BASE, args({}), { mode: () => "mock", read })).toBe(BASE);
    expect(await withBidCard(BASE, args({ ref: "x" }), { mode: () => "near", read })).toBe(BASE);
    for (const search of [{ bid: "abc" }, { bid: "0" }, { bid: ["1", "2"] }, { bid: "1", by: "x".repeat(200) }]) {
      expect(await withBidCard(BASE, args(search), { mode: () => "near", read })).toBe(BASE);
    }
    // Mock: a link without its ticker cannot be drawn.
    expect(await withBidCard(BASE, args({ bid: "12" }), { mode: () => "mock", read })).toBe(BASE);
    // NEAR: a bid the sale does not have yet, or a sale that cannot be read.
    expect(await withBidCard(BASE, args({ bid: "21" }), { mode: () => "near", read })).toBe(BASE);
    expect(await withBidCard(BASE, args({ bid: "1" }), { mode: () => "near", read: async () => null })).toBe(BASE);
  });

  it("points og:image and twitter:image at the NEAR bid card", async () => {
    const meta = await withBidCard(BASE, args({ bid: "12", by: "alice.testnet", ticker: "EVIL" }), {
      mode: () => "near",
      read: async () => chain(20),
    });
    const image = {
      url: "/api/og/bid?sale=nosnipe&bid=12&by=alice.testnet",
      width: 1200,
      height: 630,
      alt: "I'm in: sealed bid #12 in $NOSNIPE on Sealround. Price and amount stay sealed until the reveal.",
      type: "image/png",
    };
    expect(meta).toEqual({
      ...BASE,
      openGraph: {
        type: "website",
        siteName: "Sealround",
        locale: "en_US",
        title: "I'm in. Sealed bid #12 in $NOSNIPE",
        description:
          "Price and amount stay sealed until the reveal at 18:00 UTC on 14 Nov. Every winner pays one clearing price, bots included.",
        images: [image],
      },
      twitter: {
        card: "summary_large_image",
        title: "I'm in. Sealed bid #12 in $NOSNIPE",
        description:
          "Price and amount stay sealed until the reveal at 18:00 UTC on 14 Nov. Every winner pays one clearing price, bots included.",
        images: [image],
      },
    });
  });

  it("carries a mock link's checked facts to the image, and says the sale is simulated", async () => {
    const meta = await withBidCard(BASE, args({ bid: "12", name: "No Snipe Coin 🚀", ticker: "$NOSNIPE", end: String(REVEAL) }), {
      mode: () => "mock",
    });
    const og = meta.openGraph as { images: { url: string }[]; description: string };
    expect(og.images[0].url).toBe(`/api/og/bid?sale=nosnipe&bid=12&name=No+Snipe+Coin&ticker=NOSNIPE&end=${REVEAL}`);
    expect(og.description).toMatch(/Simulated sale on Sealround\.$/);
    expect(meta.title).toBe("Sale");
  });
});
