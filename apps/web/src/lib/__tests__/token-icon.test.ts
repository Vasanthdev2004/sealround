/**
 * Token icons: the contract's rule (a data: URL of at most 2,048 bytes), the
 * generated marks, the upload shrink loop, what the UI agrees to show, the
 * view and create-args mapping, both clients' checks before anything is
 * signed, the create form, and the share card.
 */
import { describe, expect, it, vi } from "vitest";
import { encodeAttempts, shrinkToFit, type EncodeAttempt } from "@/components/create/icon-image";
import { DEFAULT_DRAFT, buildMeta, derive, draftIcon, type Draft } from "@/components/create/model";
import { tradeTarget } from "@/components/sale-common/sale-header";
import { FairgroundError } from "../client/errors";
import { MockClient, USDC_TOKEN } from "../client/mock";
import { NearClient } from "../client/near";
import type { NearConfig } from "../config";
import type { NearRpc } from "../near/rpc";
import { staticSigners } from "../near/signers";
import { createSaleParams, saleFromView, type SaleView } from "../near/views";
import { cardIcon, saleCard } from "../og/sale-card";
import { saleImage } from "../og/sale-image";
import { palette } from "../palette";
import {
  MARK_EMOJI,
  MAX_ICON_BYTES,
  iconError,
  iconType,
  markIcon,
  markSvg,
  markText,
  parseMark,
  rasterIcon,
  safeIconSrc,
  tickerMark,
  utf8Bytes,
} from "../token-icon";
import type { LiquidityState, SaleConfig } from "../types";

const TOKEN = 10n ** 18n;
const USDC = 1_000_000n;

/** A 1 x 1 red PNG, the smallest real image. */
const PNG_1PX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

const pad = (prefix: string, total: number) => prefix + "a".repeat(total - prefix.length);

describe("the contract's icon rule", () => {
  it("takes no icon, or a data: URL of at most 2,048 bytes", () => {
    expect(iconError(null)).toBeNull();
    expect(iconError(undefined)).toBeNull();
    expect(iconError("")).toBeNull();
    expect(iconError(PNG_1PX)).toBeNull();
    expect(iconError(pad("data:", MAX_ICON_BYTES))).toBeNull();
    expect(iconError(pad("data:", MAX_ICON_BYTES + 1))).toMatch(/2,049 bytes.*at most 2,048/);
    expect(iconError("https://example.com/i.png")).toMatch(/data: URL/);
    expect(iconError("DATA:image/png;base64,AAAA")).toMatch(/data: URL/);
  });

  it("counts bytes the way the contract does, not characters", () => {
    // 2,044 UTF-16 units, but the emoji (2 of them) is 4 bytes in UTF-8: 2,046 bytes.
    const icon = pad("data:🐸", 2044);
    expect(icon.length).toBe(2044);
    expect(utf8Bytes(icon)).toBe(2046);
    expect(iconError(icon + "ab")).toBeNull();
    expect(iconError(icon + "abc")).toMatch(/2,049 bytes/);
  });
});

describe("what the UI shows in an <img>", () => {
  it("only image data URLs within the limit", () => {
    expect(safeIconSrc(PNG_1PX)).toBe(PNG_1PX);
    expect(safeIconSrc(markIcon("AB", 214))).toMatch(/^data:image\/svg\+xml,/);
    for (const bad of [
      null,
      undefined,
      "",
      "https://evil.example/pixel.png",
      "//evil.example/p.png",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "data:application/octet-stream;base64,AAAA",
      " data:image/png;base64,AAAA",
      "data:image/png;base64,AA\nAA",
      pad("data:image/png;base64,", MAX_ICON_BYTES + 1),
    ]) {
      expect(safeIconSrc(bad)).toBeNull();
    }
  });

  it("names the image type", () => {
    expect(iconType(PNG_1PX)).toBe("png");
    expect(iconType(markIcon("🐸", 6))).toBe("svg+xml");
    expect(iconType("data:,x")).toBeNull();
  });

  it("checks a raster icon's bytes against the type it claims", () => {
    expect(rasterIcon(PNG_1PX)?.type).toBe("png");
    expect(rasterIcon(PNG_1PX.replace("image/png", "image/jpeg"))).toBeNull();
    expect(rasterIcon("data:image/png;base64,not base64!")).toBeNull();
    expect(rasterIcon(markIcon("AB", 1))).toBeNull();
  });
});

describe("generated marks", () => {
  it("take 1 to 3 letters or digits (upper-cased) or one emoji", () => {
    expect(markText("ab")).toBe("AB");
    expect(markText(" 7 ")).toBe("7");
    expect(markText("NIG")).toBe("NIG");
    expect(markText("🐸")).toBe("🐸");
    expect(markText("⚖️")).toBe("⚖️");
    expect(markText("👩‍🚀")).toBe("👩‍🚀");
    for (const bad of ["", "   ", "ABCD", "A B", "<>", "🐸🐸", "a🐸", "&"]) expect(markText(bad)).toBeNull();
    expect(tickerMark("NIGHT")).toBe("NI");
    expect(tickerMark("")).toBe("?");
  });

  it("are a small URL-encoded SVG, well under the limit, that decodes to the mark", () => {
    for (const text of ["A", "AB", "ABC", ...MARK_EMOJI, "👩‍🚀"]) {
      const icon = markIcon(text, 214)!;
      expect(icon.startsWith("data:image/svg+xml,")).toBe(true);
      // Every character is URL-safe: no raw <, >, # or space.
      expect(icon).toMatch(/^data:image\/svg\+xml,[A-Za-z0-9%\-_.!~*'()]+$/);
      expect(utf8Bytes(icon)).toBeLessThan(700);
      expect(iconError(icon)).toBeNull();
      const svg = decodeURIComponent(icon.slice("data:image/svg+xml,".length));
      expect(svg).toBe(markSvg(markText(text)!, 214));
      expect(svg).toContain(`>${markText(text)}</text>`);
      expect(parseMark(icon)).toEqual({ bg: palette(214).ground, fg: palette(214).deep, text: markText(text) });
    }
    expect(markIcon("ABCD", 1)).toBeNull();
    expect(parseMark(PNG_1PX)).toBeNull();
    expect(parseMark("data:image/svg+xml,%3Csvg%3E%3C%2Fsvg%3E")).toBeNull();
    expect(parseMark("data:image/svg+xml,%E0%A4%A")).toBeNull();
  });

  it("change colour with the hue", () => {
    expect(markIcon("AB", 214)).not.toBe(markIcon("AB", 6));
    expect(parseMark(markIcon("AB", 6))?.bg).toBe(palette(6).ground);
  });
});

describe("shrinking an upload to fit", () => {
  /** A fake encoder: bytes grow with the pixel count and the quality, like a real one. */
  const fake =
    (bytesPerPixel: Partial<Record<EncodeAttempt["type"], number>>, unsupported: EncodeAttempt["type"][] = []) =>
    (a: EncodeAttempt) => {
      const type = unsupported.includes(a.type) ? "image/png" : a.type;
      const per = bytesPerPixel[type] ?? 1;
      const n = Math.round(a.size * a.size * per * (a.quality ?? 1));
      return `data:${type};base64,${"A".repeat(Math.ceil(n / 3) * 4)}`;
    };

  it("tries every size from 64 px down to 32 px before low quality, PNG first at each size", () => {
    const opaque = encodeAttempts(true);
    expect(opaque[0]).toEqual({ size: 64, type: "image/png" });
    expect(opaque[1]).toEqual({ size: 64, type: "image/jpeg", quality: 0.9 });
    const sizes = opaque.map((a) => a.size);
    expect(sizes.indexOf(32)).toBeGreaterThan(sizes.lastIndexOf(40));
    expect(opaque.filter((a) => a.quality !== undefined && a.quality < 0.5).every((a) => a.size <= 32)).toBe(true);
    // An image with transparent pixels never becomes a JPEG.
    expect(encodeAttempts(false).some((a) => a.type === "image/jpeg")).toBe(false);
  });

  it("returns the first data URL that fits: an image, at most 2,048 bytes", async () => {
    // A flat logo: PNG fits at 64 px.
    const flat = await shrinkToFit(fake({ "image/png": 0.3 }), false);
    expect(flat).toMatchObject({ ok: true, size: 64, type: "image/png" });
    // A photo with transparency: PNG is too big everywhere, WebP fits at 56 px (at 64 px even its lowest first-pass quality does not).
    const photo = await shrinkToFit(fake({ "image/png": 4, "image/webp": 0.9, "image/jpeg": 1.2 }), false);
    expect(photo).toMatchObject({ ok: true, type: "image/webp", size: 56 });
    for (const r of [flat, photo]) {
      if (!r.ok) throw new Error("expected a fit");
      expect(r.dataUrl.startsWith("data:image/")).toBe(true);
      expect(utf8Bytes(r.dataUrl)).toBeLessThanOrEqual(MAX_ICON_BYTES);
      expect(r.bytes).toBe(utf8Bytes(r.dataUrl));
    }
  });

  it("skips a type the browser cannot encode (it answers with a PNG)", async () => {
    const r = await shrinkToFit(fake({ "image/png": 4, "image/jpeg": 0.6 }, ["image/webp"]), true);
    expect(r).toMatchObject({ ok: true, type: "image/jpeg" });
    if (r.ok) expect(r.dataUrl.startsWith("data:image/jpeg;")).toBe(true);
  });

  it("says when nothing fits, with the smallest it got", async () => {
    const r = await shrinkToFit(fake({ "image/png": 50, "image/webp": 50, "image/jpeg": 50 }), true);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.smallest).toBeGreaterThan(MAX_ICON_BYTES);
  });
});

describe("view and create-args mapping", () => {
  const view = (over: Partial<SaleView>): SaleView =>
    ({
      sale_id: "frog",
      status: "open",
      creator: "maker.test.near",
      token: "frog.fairground.test.near",
      quote_token: "usdc.test.near",
      token_name: "Frog",
      token_symbol: "FROG",
      decimals: 18,
      icon: null,
      description: null,
      website: null,
      total_supply: (1_000_000n * TOKEN).toString(),
      sale_supply: (100_000n * TOKEN).toString(),
      creator_allocation: (900_000n * TOKEN).toString(),
      floor_price: "1000",
      max_price: null,
      min_raise: "0",
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
      sealer_code_hash: "ab",
      sealer_pubkey: null,
      token_setup: "done",
      sealer_key_setup: "done",
      created_at: "1",
      closed_at: null,
      bid_count: 0,
      total_deposits: "0",
      bid_set_hash: "",
      ...over,
    }) as SaleView;

  it("maps get_sale's icon into the sale's meta", () => {
    expect(saleFromView(view({ icon: PNG_1PX })).meta.icon).toBe(PNG_1PX);
    expect(saleFromView(view({ icon: null })).meta.icon).toBeNull();
    expect(saleFromView(view({ icon: undefined as unknown as null })).meta.icon).toBeNull();
  });

  it("sends the icon in create_sale's params only when there is one", () => {
    const config = saleFromView(view({})).config;
    const icon = markIcon("🐸", 142)!;
    expect(createSaleParams("frog", config, { description: "", hue: 1, icon })).toMatchObject({ icon });
    expect("icon" in createSaleParams("frog", config, { description: "", hue: 1 })).toBe(false);
    expect("icon" in createSaleParams("frog", config, { description: "", hue: 1, icon: null })).toBe(false);
  });
});

function saleConfig(over: Partial<SaleConfig> = {}): SaleConfig {
  const now = Date.now();
  return {
    tokenName: "Frog",
    tokenSymbol: "FROG",
    decimals: 18,
    totalSupply: 1_000_000n * TOKEN,
    saleSupply: 100_000n * TOKEN,
    creatorAllocation: 100_000n * TOKEN,
    lpReserve: 800_000n * TOKEN,
    floorPrice: 1000n,
    maxPrice: null,
    minRaise: USDC,
    bidStart: now,
    bidEnd: now + 60_000,
    minDeposit: USDC,
    maxDepositPerAccount: 10n * USDC,
    revealMode: "tee",
    unsoldRule: "burn",
    settleTimeoutMs: 2 * 3_600_000,
    quoteToken: USDC_TOKEN,
    ...over,
  };
}

async function failure(p: Promise<unknown>): Promise<FairgroundError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof FairgroundError) return e;
    throw e;
  }
  throw new Error("expected a rejection");
}

describe("the clients check the icon before anything is signed", () => {
  it("mock: keeps a valid icon, refuses one the contract would refuse", async () => {
    const client = new MockClient();
    const icon = markIcon("🐸", 142)!;
    const sale = await client.createSale("alice.testnet", saleConfig({ tokenSymbol: "FROG" }), { description: "", hue: 142, icon });
    expect(sale.meta.icon).toBe(icon);
    expect((await client.getSale(sale.id))?.meta.icon).toBe(icon);

    const big = pad("data:image/png;base64,", MAX_ICON_BYTES + 1);
    const refused = await failure(client.createSale("alice.testnet", saleConfig({ tokenSymbol: "BIG" }), { description: "", hue: 1, icon: big }));
    expect(refused).toMatchObject({ code: "invalid" });
    expect(refused.message).toMatch(/at most 2,048 bytes/);
    expect(await failure(client.getCreateCost("alice.testnet", saleConfig({ tokenSymbol: "URL" }), { description: "", hue: 1, icon: "https://x.io/i.png" }))).toMatchObject({ code: "invalid" });
  });

  it("mock: demo sales and the judge-mode sale carry a generated mark", async () => {
    const client = new MockClient();
    const sales = await client.listSales();
    expect(sales.length).toBeGreaterThan(0);
    for (const s of sales) {
      expect(parseMark(s.meta.icon)).not.toBeNull();
      expect(iconError(s.meta.icon)).toBeNull();
    }
    expect(parseMark(sales.find((s) => s.id === "lantern")?.meta.icon)?.text).toBe("🏮");
  });

  it("NEAR: refuses a bad icon before reading the chain or asking a wallet", async () => {
    const view = vi.fn(async () => {
      throw new Error("no view expected");
    });
    const headTimeMs = vi.fn(async () => Date.now());
    const sendTransaction = vi.fn();
    const config: NearConfig = {
      network: "sandbox",
      rpcUrl: "http://127.0.0.1:3050",
      contractId: "fairground.test.near",
      usdcContract: "usdc.test.near",
      relayerUrl: null,
      devAccounts: [],
      expectedCodeHash: "ab".repeat(32),
      explorerUrl: null,
    } as unknown as NearConfig;
    const client = new NearClient(config, {
      rpc: { view, headTimeMs } as unknown as NearRpc,
      relayer: null,
      signers: staticSigners({ "alice.test.near": { signsDelegates: false, signDelegate: vi.fn(), sendTransaction } }),
      cacheMs: 0,
      waitMs: 10,
      pollMs: 10,
    });
    const big = pad("data:image/png;base64,", MAX_ICON_BYTES + 1);
    for (const icon of [big, "https://x.io/i.png"]) {
      const e = await failure(client.createSale("alice.test.near", saleConfig(), { description: "", hue: 1, icon }));
      expect(e.code).toBe("invalid");
      await failure(client.getCreateCost("alice.test.near", saleConfig(), { description: "", hue: 1, icon }));
    }
    expect(view).not.toHaveBeenCalled();
    expect(headTimeMs).not.toHaveBeenCalled();
    expect(sendTransaction).not.toHaveBeenCalled();
  });
});

describe("the create form", () => {
  const draft = (over: Partial<Draft> = {}): Draft => ({ ...DEFAULT_DRAFT, name: "Frog", symbol: "FROG", ...over });

  it("generates the ticker's mark by default, on the chosen colour", () => {
    const d = draft({ hue: 142 });
    expect(draftIcon(d)).toBe(markIcon("FR", 142));
    expect(buildMeta(d).icon).toBe(markIcon("FR", 142));
    expect(derive(d, new Set(), null).errors.icon).toBeUndefined();
    expect(draftIcon(draft({ mark: "🐸" }))).toBe(markIcon("🐸", DEFAULT_DRAFT.hue));
  });

  it("sends no icon when none is chosen", () => {
    expect(draftIcon(draft({ iconMode: "none" }))).toBeNull();
    expect("icon" in buildMeta(draft({ iconMode: "none" }))).toBe(false);
  });

  it("flags a mark that is not 1 to 3 letters or one emoji, at once", () => {
    const e = derive(draft({ mark: "FROGS" }), new Set(), null).errors.icon;
    expect(e).toMatchObject({ live: true });
    expect(e?.msg).toMatch(/1 to 3 letters/);
    expect(derive(draft({ mark: "FROGS" }), new Set(), null).ready).toBeNull();
  });

  it("asks for an image in upload mode, and takes one that fits", () => {
    expect(derive(draft({ iconMode: "upload" }), new Set(), null).errors.icon?.msg).toMatch(/Choose an image/);
    const up = { dataUrl: PNG_1PX, size: 64, type: "image/png" as const, bytes: utf8Bytes(PNG_1PX), name: "frog.png" };
    const d = draft({ iconMode: "upload", iconUpload: up });
    expect(derive(d, new Set(), null).errors.icon).toBeUndefined();
    expect(buildMeta(d).icon).toBe(PNG_1PX);
    const big = { ...up, dataUrl: pad("data:image/png;base64,", 3000) };
    expect(derive(draft({ iconMode: "upload", iconUpload: big }), new Set(), null).errors.icon?.msg).toMatch(/at most 2,048/);
  });
});

describe("the share card", () => {
  it("draws PNG and JPEG icons, redraws generated marks, and falls back to the monogram otherwise", () => {
    expect(cardIcon(PNG_1PX, "FR")).toEqual({ kind: "image", src: PNG_1PX });
    expect(cardIcon(markIcon("ab", 214), "FR")).toEqual({ kind: "mark", bg: palette(214).ground, fg: palette(214).deep, text: "AB" });
    // No emoji font in the renderer: the monogram on the mark's colour.
    expect(cardIcon(markIcon("🐸", 142), "FR")).toMatchObject({ kind: "mark", text: "FR" });
    expect(cardIcon("data:image/webp;base64,UklGRhYAAABXRUJQVlA4", "FR")).toBeNull();
    expect(cardIcon("data:image/svg+xml,%3Csvg%3E%3C%2Fsvg%3E", "FR")).toBeNull();
    expect(cardIcon(null, "FR")).toBeNull();
    expect(cardIcon(42, "FR")).toBeNull();
  });
});

describe("the share card image", () => {
  const sale = {
    sale_id: "frog",
    status: "open",
    token_name: "Frog",
    token_symbol: "FROG",
    decimals: 18,
    sale_supply: (100_000n * TOKEN).toString(),
    floor_price: "1000",
    min_raise: "50000000",
    bid_count: 3,
    reveal_mode: "Tee",
  } as SaleView;
  const isPng = (b: Uint8Array) => Buffer.from(b.slice(1, 4)).toString() === "PNG";
  const draw = async (icon: string | null) => {
    const res = await saleImage("frog", { read: async () => ({ sale: { ...sale, icon }, result: null, network: "testnet" }), fonts: async () => undefined });
    expect(res.status).toBe(200);
    // The sale's own card (cached by a CDN), not the generic fallback.
    expect(res.headers.get("cache-control")).toContain("s-maxage");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(isPng(bytes)).toBe(true);
    return Buffer.from(bytes).toString("base64");
  };

  it("draws the sale's card with an image icon, a letter mark, an emoji mark or none", async () => {
    const none = await draw(null);
    const png = await draw(PNG_1PX);
    const letters = await draw(markIcon("FR", 142));
    const emoji = await draw(markIcon("🐸", 142));
    expect(png).not.toBe(none);
    expect(letters).not.toBe(none);
    expect(emoji).not.toBe(none);
    expect(saleCard({ ...sale, icon: markIcon("FR", 142) }, null, "testnet").icon?.kind).toBe("mark");
  });
});

describe("where a launched token trades (sale header)", () => {
  const pool = (over: Partial<LiquidityState> = {}): LiquidityState => ({
    stage: "seeded",
    nextStep: null,
    inFlight: null,
    dex: "ref-finance-101.testnet",
    poolId: 812,
    usdc: 1n,
    tokens: 1n,
    shares: 1n,
    usdcOnDex: 0n,
    tokensOnDex: 0n,
    failures: 0,
    deadline: null,
    ...over,
  });

  it("links a seeded pool on Rhea, in the app of the pool's network", () => {
    expect(tradeTarget("settled", pool(), false)).toEqual({ kind: "link", url: "https://testnet.rhea.finance/pool/812", label: "Trade on Rhea" });
    expect(tradeTarget("settled", pool({ dex: "v2.ref-finance.near", poolId: 5 }), false)).toMatchObject({ url: "https://app.rhea.finance/pool/5" });
  });

  it("never links a simulated pool to the real Rhea app", () => {
    expect(tradeTarget("settled", pool(), true)).toEqual({ kind: "simulated" });
    expect(tradeTarget("settled", pool({ simulated: true }), false)).toEqual({ kind: "simulated" });
  });

  it("shows nothing before the pool is seeded or the sale settled", () => {
    for (const stage of ["waiting", "seeding", "skipped", "cancelled", "abandoned"] as const) {
      expect(tradeTarget("settled", pool({ stage }), false)).toBeNull();
    }
    expect(tradeTarget("clearing", pool(), false)).toBeNull();
    expect(tradeTarget("settled", null, false)).toBeNull();
  });
});
