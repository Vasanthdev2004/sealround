/**
 * The countdown image: its address and limits, the phase, what the card says
 * in each phase (absolute UTC times, never relative ones), and the route's
 * fallbacks (always a PNG, never a 500).
 */
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chainFacts, countdownCard, parseCountdownQuery, simFacts, type CountdownViews } from "./card";
import { countdownImage } from "./image";
import { GET } from "./route";
import { countdownImagePath, countdownPhase, kitFileName, utcDate } from "./share";

/** Bids open 14 Nov 2026, 16:00 UTC, close 18:00 UTC. */
const START = Date.UTC(2026, 10, 14, 16, 0);
const END = Date.UTC(2026, 10, 14, 18, 0);
const NS = (ms: number) => (BigInt(ms) * 1_000_000n).toString();

const SALE: CountdownViews["sale"] = {
  status: "upcoming",
  token_name: "No Snipe Coin",
  token_symbol: "NOSNIPE",
  decimals: 18,
  sale_supply: (900_000n * 10n ** 18n).toString(),
  floor_price: "1000",
  bid_count: 54,
  bid_start: NS(START),
  bid_end: NS(END),
  reveal_mode: "Tee",
  icon: null,
};
const VIEWS = (sale: Partial<CountdownViews["sale"]> = {}): CountdownViews => ({ sale: { ...SALE, ...sale }, network: "testnet" });

const MOCK_Q = `sale=nosnipe&name=No+Snipe+Coin&ticker=NOSNIPE&start=${START}&end=${END}&floor=1000`;

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

describe("address", () => {
  it("names only the sale in NEAR mode, and carries the simulated sale's facts in mock mode", () => {
    expect(countdownImagePath({ saleId: "nosnipe" })).toBe("/api/og/countdown?sale=nosnipe");
    const path = countdownImagePath({
      saleId: "nosnipe",
      sim: { name: " No Snipe Coin ", ticker: "$NO-SNIPE", bidStart: START, bidEnd: END, floorPrice: 1000n },
    });
    expect(path).toBe(`/api/og/countdown?${MOCK_Q}`);
    const q = parseCountdownQuery(new URL(path, "http://x").searchParams, "mock");
    expect(q).toEqual({ saleId: "nosnipe", sim: { name: "No Snipe Coin", ticker: "NOSNIPE", bidStart: START, bidEnd: END, floorPrice: 1000n } });
  });

  it("reads only the sale in NEAR mode", () => {
    expect(parseCountdownQuery(new URLSearchParams(`${MOCK_Q}&x=1`), "near")).toEqual({ saleId: "nosnipe", sim: null });
  });

  it("refuses what it cannot draw honestly", () => {
    const bad = [
      "",
      "sale=Bad..Id",
      "sale=a&sale=b",
      `sale=${"a".repeat(200)}`,
      `sale=nosnipe&ticker=NOSNIPE&start=${START}`,
      `sale=nosnipe&ticker=NOSNIPE&start=${END}&end=${START}`,
      `sale=nosnipe&ticker=NO+SNIPE&start=${START}&end=${END}`,
      `sale=nosnipe&ticker=NOSNIPE&start=1&end=${END}`,
      `sale=nosnipe&ticker=NOSNIPE&start=${START}&end=${END}&name=${"n".repeat(121)}`,
    ];
    for (const s of bad) expect(parseCountdownQuery(new URLSearchParams(s), "mock"), s).toBeNull();
    expect(parseCountdownQuery(new URLSearchParams("sale=Bad..Id"), "near")).toBeNull();
  });

  it("drops a floor price that is not a plain positive number, and falls back to the ticker for a name", () => {
    const q = parseCountdownQuery(new URLSearchParams(`sale=nosnipe&ticker=NOSNIPE&start=${START}&end=${END}&floor=-5&name=%F0%9F%9A%80`), "mock");
    expect(q?.sim?.floorPrice).toBeNull();
    expect(q?.sim?.name).toBe("NOSNIPE");
  });

  it("names the download after the ticker", () => {
    expect(kitFileName("No Snipe!", "countdown", "png")).toBe("sealround-nosnipe-countdown.png");
    expect(kitFileName("梅", "qr", "svg")).toBe("sealround-token-qr.svg");
  });
});

describe("phase", () => {
  it("follows the clock before the close, and the status after it", () => {
    expect(countdownPhase("upcoming", START, END, START - 1)).toBe("upcoming");
    expect(countdownPhase("upcoming", START, END, START)).toBe("open");
    expect(countdownPhase("open", START, END, END - 1)).toBe("open");
    expect(countdownPhase("open", START, END, END)).toBe("closed");
    expect(countdownPhase(null, START, END, END + 1)).toBe("closed");
    expect(countdownPhase("clearing", START, END, START - 1)).toBe("closed");
    expect(countdownPhase("settled", START, END, START - 1)).toBe("final");
    expect(countdownPhase("failed", START, END, END + 1)).toBe("final");
  });
});

describe("the card", () => {
  it("before the open: when bids open in UTC with the day, and when they close", () => {
    const card = countdownCard(chainFacts(VIEWS()), "upcoming");
    expect(card.phase).toBe("Upcoming");
    expect(card.hero).toEqual({ label: "Bids open", value: "16:00 UTC", unit: "Sat, 14 Nov 2026" });
    expect(card.line).toBe("One price for everyone. Bots can't snipe what they can't see.");
    expect(card.stats).toEqual([
      { label: "Bids close", value: "18:00 UTC", unit: "14 Nov" },
      { label: "Floor price", value: "0.001", unit: "USDC" },
      { label: "For sale", value: "900K", unit: "NOSNIPE" },
    ]);
    expect(card.network).toBe("NEAR testnet");
  });

  it("while open: when sealed bids close, and the sealed bids so far", () => {
    const card = countdownCard(chainFacts(VIEWS({ status: "open" })), "open");
    expect(card.phase).toBe("Live");
    expect(card.tone).toBe("accent");
    expect(card.hero).toEqual({ label: "Sealed bids close", value: "18:00 UTC", unit: "Sat, 14 Nov 2026" });
    expect(card.stats.map((s) => s.label)).toEqual(["Bids opened", "Sealed bids", "Floor price"]);
  });

  it("after the close: that bidding closed and every bid opens at once", () => {
    const card = countdownCard(chainFacts(VIEWS({ status: "clearing" })), "closed");
    expect(card.hero?.label).toBe("Bidding closed");
    expect(card.line).toMatch(/opens at once/);
    expect(card.stats.length).toBeGreaterThanOrEqual(2);
  });

  it("never says a relative time", () => {
    for (const phase of ["upcoming", "open", "closed"] as const) {
      const card = countdownCard(chainFacts(VIEWS()), phase);
      const words = JSON.stringify(card);
      expect(words).not.toMatch(/\bin \d|\bago\b|hours?\b|minutes?\b/);
    }
  });

  it("draws a simulated sale from the address alone, labelled simulated, with no icon", () => {
    const q = parseCountdownQuery(new URLSearchParams(MOCK_Q), "mock")!;
    const card = countdownCard(simFacts(q.sim!), "open");
    expect(card.network).toBe("Simulated sale");
    expect(card.icon).toBeNull();
    expect(card.name).toBe("No Snipe Coin");
    expect(card.stats.map((s) => s.label)).toEqual(["Bids opened", "Price and amount", "Floor price"]);
    // No floor price: still two cells.
    const bare = countdownCard(simFacts({ ...q.sim!, floorPrice: null }), "closed");
    expect(bare.stats.length).toBeGreaterThanOrEqual(2);
  });

  it("formats the UTC day with the weekday and year", () => {
    expect(utcDate(END)).toBe("Sat, 14 Nov 2026");
  });
});

describe("countdownImage", () => {
  const mock = () => "mock" as const;
  const near = () => "near" as const;

  async function png(res: Response) {
    const b = new Uint8Array(await res.arrayBuffer());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(isPng(b)).toBe(true);
    expect(pngSize(b)).toEqual({ width: 1200, height: 630 });
    return b;
  }

  it("draws a mock countdown before the open and while open", async () => {
    for (const now of [START - 60_000, START + 60_000, END + 60_000]) {
      const res = await countdownImage(new URLSearchParams(MOCK_Q), { mode: mock, fonts: noFonts, now: () => now });
      await png(res);
      expect(res.headers.get("cache-control")).toContain("s-maxage=60");
    }
  });

  it("draws a NEAR countdown from the chain", async () => {
    const read = vi.fn(async () => VIEWS({ status: "open" }));
    await png(await countdownImage(new URLSearchParams("sale=nosnipe&name=Evil"), { mode: near, read, fonts: noFonts, now: () => START + 1 }));
    expect(read).toHaveBeenCalledWith("nosnipe");
  });

  it("serves the sale's own card once the sale is final", async () => {
    const saleCard = vi.fn(async () => new Response("sale card", { status: 200 }));
    for (const status of ["settled", "failed"] as const) {
      const res = await countdownImage(new URLSearchParams("sale=nosnipe"), {
        mode: near,
        read: async () => VIEWS({ status }),
        fonts: noFonts,
        saleCard,
        now: () => END + 1,
      });
      expect(await res.text()).toBe("sale card");
    }
    expect(saleCard).toHaveBeenCalledWith("nosnipe");
  });

  it("falls back to the generic card, never a 500", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cases: [string, Parameters<typeof countdownImage>[1]][] = [
      ["", { mode: mock }],
      ["sale=nosnipe", { mode: mock }],
      ["sale=Bad..Id&ticker=X&start=1&end=2", { mode: mock }],
      ["sale=nosnipe", { mode: near, read: async () => null }],
      ["sale=nosnipe", { mode: near, read: async () => Promise.reject(new Error("rpc down")) }],
      // A view in another shape: the card throws, the route does not.
      ["sale=nosnipe", { mode: near, read: async () => VIEWS({ floor_price: "cheap" }) }],
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
      const res = await countdownImage(new URLSearchParams(query), { fonts: noFonts, now: () => START, ...deps });
      await png(res);
      expect(res.headers.get("cache-control"), query).not.toContain("s-maxage");
    }
    warn.mockRestore();
  });

  it("still answers when the fonts fail or the token icon cannot be drawn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await png(await countdownImage(new URLSearchParams(MOCK_Q), { mode: mock, fonts: () => Promise.reject(new Error("offline")), now: () => START }));
    // PNG magic, then junk: the card can accept it, the renderer cannot decode it.
    const broken = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(24).fill(7)]).toString("base64")}`;
    await png(await countdownImage(new URLSearchParams("sale=nosnipe"), { mode: near, read: async () => VIEWS({ icon: broken }), fonts: noFonts, now: () => START }));
    warn.mockRestore();
  });

  it("answers the route's GET in mock mode", async () => {
    vi.stubEnv("NEXT_PUBLIC_FAIRGROUND_CONTRACT", "");
    await png(await GET(new NextRequest(`http://localhost/api/og/countdown?${MOCK_Q}`)));
    await png(await GET(new NextRequest("http://localhost/api/og/countdown?sale=%00")));
  });
});
