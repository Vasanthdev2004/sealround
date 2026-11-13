/**
 * The winner card: the link's parameters and their limits, what the card and
 * the post say (tokens won and the clearing price, never a max price, a
 * deposit or a refund), the chain read, the image route's fallbacks and the
 * result page's `?win=` metadata.
 */
import type { ResolvingMetadata } from "next";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chainWinCard,
  mockWinCard,
  parseWinCardQuery,
  readWinCardViews,
  winCardText,
  winLine,
  winnerViews,
  winnersNote,
  type WinCardViews,
  type WinSaleView,
  type WinnerViews,
} from "./card";
import { winImage } from "./image";
import { withWinCard } from "./metadata";
import { GET } from "./route";
import {
  tokenAmount,
  winCardQuery,
  winImageFileName,
  winImagePath,
  winSharePath,
  winShareText,
  type WinSim,
} from "./share";

const E18 = 10n ** 18n;

const SALE: WinSaleView = {
  status: "settled",
  token_name: "No Snipe Coin",
  token_symbol: "NOSNIPE",
  decimals: 18,
  icon: null,
  bid_count: 54,
};

/** 12,500 tokens at 0.0016 USDC each (1,600 base units of USDC per whole token). */
const FILL = { index: 11, bidder: "alice.testnet", tokens: (12_500n * E18).toString() };
const RESULT = { clearing_price: "1600", n_winners: 41 };

/** The winner's own deposit, refund and max price: they must never reach the card, its link or its words. */
const SECRET_DEPOSIT = "777777777";
const SECRET_REFUND = "555555555";
const SECRET_PRICE = "4242";

const VIEWS = (o: Partial<WinCardViews> = {}): WinCardViews => ({
  sale: SALE,
  result: RESULT,
  fill: FILL,
  network: "testnet",
  ...o,
});
const WINNER = (o: Partial<WinCardViews> = {}) => winnerViews(VIEWS(o)) as WinnerViews;

const SIM: WinSim = {
  name: "No Snipe Coin",
  ticker: "NOSNIPE",
  decimals: 18,
  tokens: 12_500n * E18,
  price: 1600n,
  winners: 41,
  bids: 54,
};
const MOCK_Q = `sale=nosnipe&${winCardQuery({ saleId: "nosnipe", bidNumber: 12, sim: SIM })}`;

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
    expect(winCardQuery(input).toString()).toBe("win=12");
    expect(winCardQuery({ ...input, account: "alice.near" }).toString()).toBe("win=12&by=alice.near");
    expect(winSharePath(input)).toBe("/sale/lantern/result?win=12");
    expect(winImagePath(input)).toBe("/api/og/win?sale=lantern&win=12");
  });

  it("adds the simulated sale's facts in a mock link", () => {
    const q = winCardQuery({ saleId: "nosnipe", bidNumber: 3, sim: { ...SIM, name: "  No Snipe Coin, the very long edition name  ", ticker: "$NO-SNIPE" } });
    expect([...q.keys()]).toEqual(["win", "name", "ticker", "got", "dec", "price", "winners", "bids"]);
    expect(q.get("name")).toBe("No Snipe Coin, the very long editi");
    expect(q.get("ticker")).toBe("NOSNIPE");
    expect(q.get("got")).toBe((12_500n * E18).toString());
    expect(q.get("dec")).toBe("18");
    expect(q.get("price")).toBe("1600");
    expect([q.get("winners"), q.get("bids")]).toEqual(["41", "54"]);
  });

  it("never names a max price, a deposit or a refund", () => {
    const keys = [...winCardQuery({ saleId: "x1", bidNumber: 1, account: "a.near", sim: SIM }).keys()];
    expect(keys.every((k) => ["win", "by", "name", "ticker", "got", "dec", "price", "winners", "bids"].includes(k))).toBe(true);
  });

  it("writes the post in plain words, with where the sale ran", () => {
    const o = { ticker: "NOSNIPE", tokens: 12_500n * E18, decimals: 18, price: 1600n, winners: 41 };
    expect(winShareText({ ...o, where: "mainnet" })).toBe(
      "I got 12.5K $NOSNIPE at 0.0016 USDC each in a sealed-bid sale. No bot paid less: all 41 winners paid the same price.",
    );
    expect(winShareText({ ...o, where: "testnet" })).toMatch(/same price\. On NEAR testnet\.$/);
    expect(winShareText({ ...o, where: "simulated" })).toMatch(/Simulated sale on Sealround\.$/);
    expect(winShareText({ ...o, winners: 1, where: "sandbox" })).toBe(
      "I got 12.5K $NOSNIPE at 0.0016 USDC each in a sealed-bid sale. No bot paid less: I was the only winner. On a local NEAR sandbox.",
    );
    expect(winShareText({ ...o, ticker: "$no snipe!🚀", where: "mainnet" })).toContain("12.5K $nosnipe at");
  });

  it("formats amounts for any decimals, and the file name", () => {
    expect(tokenAmount(12_500n * E18, 18)).toBe("12.5K");
    expect(tokenAmount(842_310_000n, 6)).toBe("842.31");
    expect(tokenAmount(12_500n, 0)).toBe("12.5K");
    expect(tokenAmount(25n, 1)).toBe("2.5");
    expect(tokenAmount(3_000_000n * 10n ** 24n, 24)).toBe("3M");
    expect(winImageFileName("NoSnipe", 12)).toBe("sealround-nosnipe-win-12.png");
    expect(winImageFileName("🚀", 1)).toBe("sealround-token-win-1.png");
  });
});

describe("parseWinCardQuery", () => {
  const p = (s: string) => new URLSearchParams(s);

  it("reads win and by in NEAR mode and ignores the mock fields", () => {
    expect(parseWinCardQuery("lantern", p("win=12&ticker=EVIL&got=1&price=1"), "near")).toEqual({
      saleId: "lantern",
      bidNumber: 12,
      by: null,
      sim: null,
    });
    expect(parseWinCardQuery("lantern", p("win=12&by=alice.near"), "near")?.by).toBe("alice.near");
  });

  it("drops an account that is not a NEAR account id", () => {
    for (const by of ["Alice.near", "a..b", "-a.near", "a", "x".repeat(65), "<b>.near", "alice.near/x"]) {
      expect(parseWinCardQuery("lantern", p(`win=1&by=${encodeURIComponent(by)}`), "near")?.by).toBeNull();
    }
  });

  it("refuses a bad bid number, a bad sale id, a repeated or an over-long parameter", () => {
    for (const win of ["0", "-1", "1.5", "abc", "10001", "012", "", " 1"]) {
      expect(parseWinCardQuery("lantern", p(`win=${encodeURIComponent(win)}`), "near")).toBeNull();
    }
    expect(parseWinCardQuery("lantern", p(""), "near")).toBeNull();
    for (const id of ["", "Lantern", "a..b", "x/../y", "a".repeat(33)]) {
      expect(parseWinCardQuery(id, p(MOCK_Q), "mock")).toBeNull();
    }
    expect(parseWinCardQuery("lantern", p("win=1&win=2"), "near")).toBeNull();
    expect(parseWinCardQuery("lantern", { win: ["1", "2"] }, "near")).toBeNull();
    expect(parseWinCardQuery("lantern", p(`win=1&by=${"a".repeat(121)}`), "near")).toBeNull();
    expect(parseWinCardQuery("nosnipe", p(`${MOCK_Q}&name=${"a".repeat(121)}`), "mock")).toBeNull();
  });

  it("reads a whole mock link back to the same facts", () => {
    expect(parseWinCardQuery("nosnipe", p(MOCK_Q), "mock")).toEqual({ saleId: "nosnipe", bidNumber: 12, by: null, sim: SIM });
  });

  it("needs every mock fact, each plain and in range, and agreeing with the others", () => {
    const without = (key: string) => {
      const q = p(MOCK_Q);
      q.delete(key);
      return q;
    };
    for (const key of ["ticker", "got", "dec", "price", "winners", "bids"]) {
      expect(parseWinCardQuery("nosnipe", without(key), "mock"), key).toBeNull();
    }
    const bad: [string, string][] = [
      ["ticker", "<script>"],
      ["ticker", "NO SNIPE"],
      ["ticker", "🚀"],
      ["got", "0"],
      ["got", "-5"],
      ["got", "1e21"],
      ["got", "0123"],
      ["got", "9".repeat(40)],
      ["price", "0"],
      ["price", "0.0016"],
      ["dec", "25"],
      ["dec", "-1"],
      ["dec", "x"],
      ["winners", "0"],
      ["winners", "55"],
      ["bids", "11"],
    ];
    for (const [key, value] of bad) {
      const q = p(MOCK_Q);
      q.set(key, value);
      expect(parseWinCardQuery("nosnipe", q, "mock"), `${key}=${value}`).toBeNull();
    }
  });

  it("cleans a mock name: no emoji, no markup, cut to the card's length", () => {
    const q = p(MOCK_Q);
    q.set("name", "🐸 No <b>Snipe</b>\u0000 Coin, the extremely long edition");
    expect(parseWinCardQuery("nosnipe", q, "mock")?.sim?.name).toBe("No bSnipe/b Coin, the extremely l…");
    q.delete("name");
    expect(parseWinCardQuery("nosnipe", q, "mock")?.sim?.name).toBe("NOSNIPE");
  });
});

describe("who counts as a winner", () => {
  it("needs a settled sale, its result and a fill with tokens", () => {
    expect(winnerViews(VIEWS())).not.toBeNull();
    expect(winnerViews(null)).toBeNull();
    for (const status of ["open", "closed", "revealing", "failed", "setup"] as const) {
      expect(winnerViews(VIEWS({ sale: { ...SALE, status } })), status).toBeNull();
    }
    expect(winnerViews(VIEWS({ result: null }))).toBeNull();
    expect(winnerViews(VIEWS({ fill: null }))).toBeNull();
    // A refunded or void bid.
    expect(winnerViews(VIEWS({ fill: { ...FILL, tokens: "0" } }))).toBeNull();
    expect(winnerViews(VIEWS({ result: { ...RESULT, clearing_price: "0" } }))).toBeNull();
    expect(winnerViews(VIEWS({ result: { ...RESULT, n_winners: 0 } }))).toBeNull();
    expect(winnerViews(VIEWS({ sale: { ...SALE, bid_count: 11 } }))).toBeNull();
  });
});

describe("the card's content", () => {
  const q = { saleId: "nosnipe", bidNumber: 12, by: null, sim: null };

  it("says no bot paid less, what the winner got and that every winner paid one price", () => {
    const card = chainWinCard(WINNER(), q);
    expect(card).toMatchObject({
      name: "No Snipe Coin",
      symbol: "NOSNIPE",
      monogram: "NO",
      icon: null,
      phase: "Settled",
      tone: "ok",
      hero: null,
      outcome: "No bot paid less.",
      line: "I got 12.5K $NOSNIPE at 0.0016 USDC each.",
      lineAccent: true,
      note: "One price for all 41 winners of this sale.",
      network: "NEAR testnet",
    });
    expect(card.stats).toEqual([
      { label: "Clearing price", value: "0.0016", unit: "USDC" },
      { label: "Winners", value: "41" },
      { label: "Bids", value: "54" },
    ]);
  });

  it("shows the account only when the link asks and it is the fill's own bidder", () => {
    expect(chainWinCard(WINNER(), { ...q, by: "alice.testnet" }).line).toBe("alice.testnet got 12.5K $NOSNIPE at 0.0016 USDC each.");
    const spoof = chainWinCard(WINNER(), { ...q, by: "vitalik.near" });
    expect(spoof.line).toBe("I got 12.5K $NOSNIPE at 0.0016 USDC each.");
    expect(JSON.stringify(spoof)).not.toContain("vitalik");
    expect(JSON.stringify(chainWinCard(WINNER(), q))).not.toContain("alice");
    expect(winLine({ tokens: 1n, decimals: 0, ticker: "X", price: 1n, by: "a".repeat(58) + ".testnet" })).toBe(
      `${"a".repeat(15)}….testnet got 1 $X at 0.000001 USDC each.`,
    );
  });

  it("names a sole winner plainly", () => {
    expect(winnersNote(1)).toBe("The only winning bid in this sale.");
    expect(winnersNote(1234)).toBe("One price for all 1,234 winners of this sale.");
    expect(chainWinCard(WINNER({ result: { ...RESULT, n_winners: 1 } }), q).note).toBe("The only winning bid in this sale.");
  });

  it("cuts long names and drops emoji from the chain's text", () => {
    const card = chainWinCard(
      WINNER({ sale: { ...SALE, token_name: "🐸 Frog Frog Frog Frog Frog Frog Frog Frog Frog", token_symbol: "FROG🐸ABCDEFGHIJKLMNOPQ" } }),
      q,
    );
    expect(card.name).toBe("Frog Frog Frog Frog Frog Frog Fro…");
    expect([...card.symbol].length).toBeLessThanOrEqual(16);
    expect(JSON.stringify(card)).not.toMatch(/\p{Extended_Pictographic}/u);
    const blank = chainWinCard(WINNER({ sale: { ...SALE, token_name: "🐸", token_symbol: "🐸" } }), q);
    expect([blank.name, blank.symbol]).toEqual(["Unnamed token", "TOKEN"]);
  });

  it("draws the contract's PNG icon, never a remote URL or an SVG", () => {
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const at = (icon: string | null) => chainWinCard(WINNER({ sale: { ...SALE, icon } }), q).icon;
    expect(at(png)).toEqual({ kind: "image", src: png });
    expect(at("https://evil.example/x.png")).toBeNull();
    expect(at("data:image/svg+xml,<svg onload='x'/>")).toBeNull();
  });

  it("draws a simulated sale from the link alone, labelled as simulated", () => {
    const card = mockWinCard({ saleId: "nosnipe", bidNumber: 12, by: "you.testnet", sim: SIM });
    expect(card).toMatchObject({
      icon: null,
      phase: "Settled",
      outcome: "No bot paid less.",
      line: "you.testnet got 12.5K $NOSNIPE at 0.0016 USDC each.",
      note: "One price for all 41 winners of this sale.",
      network: "Simulated sale",
    });
    expect(card.stats.map((s) => s.value)).toEqual(["0.0016", "41", "54"]);
  });

  it("titles and describes the preview", () => {
    const o = { ticker: "NOSNIPE", tokens: 12_500n * E18, decimals: 18, price: 1600n, winners: 41 };
    expect(winCardText({ ...o, simulated: false })).toEqual({
      title: "I got 12.5K $NOSNIPE at 0.0016 USDC each",
      description: "No bot paid less. All 41 winners of this sealed-bid sale paid one clearing price.",
      alt: "Winner card: 12.5K $NOSNIPE at 0.0016 USDC each on Sealround. No bot paid less.",
    });
    expect(winCardText({ ...o, winners: 1, simulated: true }).description).toBe(
      "No bot paid less. The only winner of this sealed-bid sale paid one clearing price. Simulated sale on Sealround.",
    );
  });

  it("never carries the winner's deposit, refund or max price", () => {
    const all = JSON.stringify([
      chainWinCard(WINNER(), { ...q, by: "alice.testnet" }),
      mockWinCard({ saleId: "n", bidNumber: 1, by: null, sim: SIM }),
      winCardText({ ...SIM, simulated: true }),
    ]);
    for (const secret of [SECRET_DEPOSIT, SECRET_REFUND, SECRET_PRICE, "777", "555"]) expect(all).not.toContain(secret);
    expect(all).not.toMatch(/max price|max spend|deposit|refund/i);
  });
});

describe("readWinCardViews", () => {
  const target = { rpcUrl: "http://127.0.0.1:3030", contractId: "fairground.testnet", network: "testnet" as const };
  const bytes = (value: unknown) => Array.from(new TextEncoder().encode(JSON.stringify(value)));
  const FULL_FILL = { ...FILL, spent: "20000000", refund: SECRET_REFUND, penalty: "0" };
  const FULL_SALE = { ...SALE, total_deposits: SECRET_DEPOSIT, max_price: SECRET_PRICE };
  const FULL_RESULT = { ...RESULT, sale_id: "nosnipe", status: "settled", total_sold: "1", total_raised: "1" };

  function node(answers: { get_sale?: unknown; get_result?: unknown; get_fills?: unknown }, opts: { fail?: string[]; hang?: boolean } = {}) {
    const calls: { method: string; args: Record<string, unknown> }[] = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const method = body.params.method_name as keyof typeof answers;
      calls.push({ method, args: JSON.parse(Buffer.from(body.params.args_base64, "base64").toString()) });
      if (opts.hang) {
        // A node that never answers: only the timeout ends the call.
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      }
      if (opts.fail?.includes(method)) return new Response("busy", { status: 503 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { result: bytes(answers[method] ?? null) } }));
    }) as typeof fetch;
    return { fetchImpl, calls };
  }

  it("reads get_sale, get_result and only the one fill, from its index, and keeps no money but the tokens", async () => {
    const { fetchImpl, calls } = node({ get_sale: FULL_SALE, get_result: FULL_RESULT, get_fills: [FULL_FILL] });
    const views = await readWinCardViews("nosnipe", 12, target, { fetch: fetchImpl });
    expect(views?.fill).toEqual(FILL);
    expect(views?.result).toEqual(RESULT);
    expect(winnerViews(views)).not.toBeNull();
    expect(calls.find((c) => c.method === "get_fills")?.args).toEqual({ sale_id: "nosnipe", from_index: 11, limit: 1 });
    const kept = JSON.stringify({ result: views?.result, fill: views?.fill });
    expect(kept).not.toContain(SECRET_REFUND);
    expect(kept).not.toContain("20000000");
  });

  it("has no fill before the sale is final, or when get_fills does not list that bid", async () => {
    for (const fills of [[], [{ ...FULL_FILL, index: 3 }], [{ ...FULL_FILL, bidder: 7 }], [{ ...FULL_FILL, tokens: 5 }], { nope: 1 }]) {
      const views = await readWinCardViews("nosnipe", 12, target, { fetch: node({ get_sale: FULL_SALE, get_result: FULL_RESULT, get_fills: fills }).fetchImpl });
      expect(views?.fill).toBeNull();
      expect(winnerViews(views)).toBeNull();
    }
    const failed = await readWinCardViews("nosnipe", 12, target, {
      fetch: node({ get_sale: FULL_SALE, get_result: FULL_RESULT, get_fills: [FULL_FILL] }, { fail: ["get_fills", "get_result"] }).fetchImpl,
    });
    expect(failed).toMatchObject({ result: null, fill: null });
  });

  it("returns null for an unknown or malformed sale, a failed or silent node, or input it should not send", async () => {
    expect(await readWinCardViews("nosnipe", 12, target, { fetch: node({ get_sale: null }).fetchImpl })).toBeNull();
    expect(await readWinCardViews("nosnipe", 12, target, { fetch: node({ get_sale: { ...SALE, decimals: 30 } }).fetchImpl })).toBeNull();
    expect(await readWinCardViews("nosnipe", 12, target, { fetch: node({ get_sale: SALE }, { fail: ["get_sale"] }).fetchImpl })).toBeNull();
    expect(await readWinCardViews("nosnipe", 12, target, { fetch: node({}, { hang: true }).fetchImpl, timeoutMs: 50 })).toBeNull();
    const never = vi.fn() as unknown as typeof fetch;
    expect(await readWinCardViews("Bad..Id", 1, target, { fetch: never })).toBeNull();
    expect(await readWinCardViews("nosnipe", 0, target, { fetch: never })).toBeNull();
    expect(never).not.toHaveBeenCalled();
  });
});

describe("winImage", () => {
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

  it("draws a mock winner card from the link, kept by a CDN for a day", async () => {
    const res = await winImage(new URLSearchParams(MOCK_Q), { mode: mock, fonts: noFonts });
    await png(res);
    expect(res.headers.get("cache-control")).toContain("s-maxage=86400");
  });

  it("draws a NEAR winner card from the chain", async () => {
    const read = vi.fn(async () => VIEWS());
    const res = await winImage(new URLSearchParams("sale=nosnipe&win=12&by=alice.testnet&ticker=EVIL"), { mode: near, read, fonts: noFonts });
    await png(res);
    expect(res.headers.get("cache-control")).toContain("s-maxage");
    expect(read).toHaveBeenCalledWith("nosnipe", 12);
  });

  it("draws long names, an account and a long ticker without failing", async () => {
    const q = new URLSearchParams(
      `sale=nosnipe&${winCardQuery({
        saleId: "nosnipe",
        bidNumber: 9999,
        account: `${"a".repeat(56)}.testnet`,
        sim: { ...SIM, name: "The Extremely Long Token Name Of All Long Names", ticker: "ABCDEFGHIJKLMNOP", tokens: 999_999_999n * E18, price: 1n, winners: 9999, bids: 9999 },
      })}`,
    );
    await png(await winImage(q, { mode: mock, fonts: noFonts }));
  });

  it("falls back to the generic card, never a 500", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cases: [string, Parameters<typeof winImage>[1]][] = [
      ["", { mode: mock }],
      ["sale=nosnipe&win=12", { mode: mock }],
      [MOCK_Q.replace("win=12", "win=0"), { mode: mock }],
      [MOCK_Q.replace("sale=nosnipe", "sale=Bad..Id"), { mode: mock }],
      [`sale=a&${MOCK_Q}`, { mode: mock }],
      [MOCK_Q.replace("sale=nosnipe", `sale=${"a".repeat(200)}`), { mode: mock }],
      // Unknown sale, RPC error or timeout.
      ["sale=nosnipe&win=12", { mode: near, read: async () => null }],
      ["sale=nosnipe&win=12", { mode: near, read: async () => Promise.reject(new Error("rpc down")) }],
      // Not settled, failed, a refunded bid, no such bid.
      ["sale=nosnipe&win=12", { mode: near, read: async () => VIEWS({ sale: { ...SALE, status: "open" } }) }],
      ["sale=nosnipe&win=12", { mode: near, read: async () => VIEWS({ sale: { ...SALE, status: "failed" } }) }],
      ["sale=nosnipe&win=12", { mode: near, read: async () => VIEWS({ fill: { ...FILL, tokens: "0" } }) }],
      ["sale=nosnipe&win=12", { mode: near, read: async () => VIEWS({ fill: null }) }],
      // A view in another shape: the card throws, the route does not.
      ["sale=nosnipe&win=12", { mode: near, read: async () => VIEWS({ fill: { ...FILL, tokens: "lots" } }) }],
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
      const res = await winImage(new URLSearchParams(query), { fonts: noFonts, ...deps });
      await png(res);
      expect(res.headers.get("cache-control"), query).not.toContain("s-maxage");
    }
    warn.mockRestore();
  });

  it("still answers when the fonts fail or the token icon cannot be drawn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await png(await winImage(new URLSearchParams(MOCK_Q), { mode: mock, fonts: () => Promise.reject(new Error("offline")) }));
    // PNG magic, then junk: the card can accept it, the renderer cannot decode it.
    const broken = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(24).fill(7)]).toString("base64")}`;
    const res = await winImage(new URLSearchParams("sale=nosnipe&win=12"), { mode: near, read: async () => VIEWS({ sale: { ...SALE, icon: broken } }), fonts: noFonts });
    await png(res);
    expect(res.headers.get("cache-control")).toContain("s-maxage");
    warn.mockRestore();
  });

  it("answers the route's GET in mock mode", async () => {
    vi.stubEnv("NEXT_PUBLIC_FAIRGROUND_CONTRACT", "");
    await png(await GET(new NextRequest(`http://localhost/api/og/win?${MOCK_Q}`)));
    await png(await GET(new NextRequest("http://localhost/api/og/win?sale=%00&win=-1")));
  });
});

describe("withWinCard (the result page's metadata)", () => {
  const BASE = { title: "Result", description: "Clearing price, every fill, your tokens and refund, and the checks behind them." };
  const parent = Promise.resolve({ openGraph: { siteName: "Sealround", locale: "en_US" } }) as unknown as ResolvingMetadata;
  const args = (search: Record<string, string | string[] | undefined>, id = "nosnipe") => ({
    params: Promise.resolve({ id }),
    searchParams: Promise.resolve(search),
    parent,
  });
  const mockSearch = () => Object.fromEntries(new URLSearchParams(MOCK_Q.replace("sale=nosnipe&", "")));

  it("leaves the metadata as it is without win, or with one that does not check out", async () => {
    const read = vi.fn(async () => VIEWS());
    expect(await withWinCard(BASE, args({}), { mode: () => "mock", read })).toBe(BASE);
    expect(await withWinCard(BASE, args({ bid: "12" }), { mode: () => "near", read })).toBe(BASE);
    for (const search of [{ win: "abc" }, { win: "0" }, { win: ["1", "2"] }, { win: "1", by: "x".repeat(200) }]) {
      expect(await withWinCard(BASE, args(search), { mode: () => "near", read })).toBe(BASE);
    }
    // Mock: a link without the sale's facts cannot be drawn.
    expect(await withWinCard(BASE, args({ win: "12", ticker: "X" }), { mode: () => "mock", read })).toBe(BASE);
    // NEAR: a sale that cannot be read, has not settled, did not clear, or a bid that won nothing.
    for (const views of [
      null,
      VIEWS({ sale: { ...SALE, status: "closed" } }),
      VIEWS({ sale: { ...SALE, status: "failed" } }),
      VIEWS({ fill: { ...FILL, tokens: "0" } }),
    ]) {
      expect(await withWinCard(BASE, args({ win: "12" }), { mode: () => "near", read: async () => views })).toBe(BASE);
    }
  });

  it("points og:image and twitter:image at the NEAR winner card", async () => {
    const meta = await withWinCard(BASE, args({ win: "12", by: "alice.testnet", ticker: "EVIL" }), { mode: () => "near", read: async () => VIEWS() });
    const image = {
      url: "/api/og/win?sale=nosnipe&win=12&by=alice.testnet",
      width: 1200,
      height: 630,
      alt: "Winner card: 12.5K $NOSNIPE at 0.0016 USDC each on Sealround. No bot paid less.",
      type: "image/png",
    };
    const title = "I got 12.5K $NOSNIPE at 0.0016 USDC each";
    const description = "No bot paid less. All 41 winners of this sealed-bid sale paid one clearing price.";
    expect(meta).toEqual({
      ...BASE,
      openGraph: { type: "website", siteName: "Sealround", locale: "en_US", title, description, images: [image] },
      twitter: { card: "summary_large_image", title, description, images: [image] },
    });
  });

  it("carries a mock link's checked facts to the image, and says the sale is simulated", async () => {
    const meta = await withWinCard(BASE, args({ ...mockSearch(), name: "No Snipe Coin 🚀" }), { mode: () => "mock" });
    const og = meta.openGraph as { images: { url: string }[]; description: string; title: string };
    expect(og.images[0].url).toBe(`/api/og/win?${MOCK_Q}`);
    expect(og.title).toBe("I got 12.5K $NOSNIPE at 0.0016 USDC each");
    expect(og.description).toMatch(/Simulated sale on Sealround\.$/);
    expect(meta.title).toBe("Result");
  });
});
