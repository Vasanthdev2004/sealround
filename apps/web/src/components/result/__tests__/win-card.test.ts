/**
 * The winner card's share block: the link, the image and the post it builds
 * from a winning fill, and its markup rendered on its own. It must never
 * carry the fill's deposit, spend or refund, hides the account by default,
 * and shows nothing to a bid that won no tokens or on a failed sale.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WinCard, isWinner, winShare, type WinCardProps } from "../win-card";

const E18 = 10n ** 18n;

const SALE: WinCardProps["sale"] = {
  id: "nosnipe",
  isJudgeSale: false,
  bidCount: 3,
  config: { tokenName: "No Snipe Coin", tokenSymbol: "NOSNIPE", decimals: 18 },
};

/** A whole fill, with the fields the block must not touch. */
const FILL = {
  index: 1,
  bidder: "alice.testnet",
  deposit: 777_777_777n,
  tokens: 12_500n * E18,
  spent: 20_000_000n,
  refund: 555_555_555n,
  valid: true,
  penalty: 0n,
  claimed: false,
  claimTx: null,
};

const RESULT: WinCardProps["result"] = {
  status: "settled",
  clearingPrice: 1600n,
  fills: [
    { ...FILL, index: 0, bidder: "bot.testnet" },
    FILL,
    { ...FILL, index: 2, bidder: "late.testnet", tokens: 0n },
  ],
};

const leaks = (s: string) => ["777", "555", "20000000", "20.0", "deposit=", "refund=", "spent="].filter((x) => s.includes(x));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isWinner", () => {
  it("is a valid fill with tokens in a settled sale", () => {
    expect(isWinner(RESULT, FILL)).toBe(true);
    expect(isWinner(RESULT, null)).toBe(false);
    expect(isWinner(RESULT, { ...FILL, tokens: 0n })).toBe(false);
    expect(isWinner(RESULT, { ...FILL, valid: false })).toBe(false);
    expect(isWinner({ status: "failed" }, FILL)).toBe(false);
  });
});

describe("winShare", () => {
  const origin = "https://app.sealround.xyz";

  it("builds a mock link that carries the simulated sale's facts, and a post that says it is simulated", () => {
    const s = winShare({ sale: SALE, result: RESULT, fill: FILL }, { showAccount: false, near: false, where: "simulated", origin });
    const q = `win=2&name=No+Snipe+Coin&ticker=NOSNIPE&got=${12_500n * E18}&dec=18&price=1600&winners=2&bids=3`;
    expect(s.url).toBe(`${origin}/sale/nosnipe/result?${q}`);
    expect(s.imageSrc).toBe(`/api/og/win?sale=nosnipe&${q}`);
    expect(s.text).toBe(
      "I got 12.5K $NOSNIPE at 0.0016 USDC each in a sealed-bid sale. No bot paid less: all 2 winners paid the same price. Simulated sale on Sealround.",
    );
    expect(s.xHref).toBe(`https://x.com/intent/post?text=${encodeURIComponent(s.text)}&url=${encodeURIComponent(s.url!)}`);
    expect(s.fileName).toBe("sealround-nosnipe-win-2.png");
    expect(leaks(JSON.stringify({ ...s, input: null }) + s.url + s.imageSrc)).toEqual([]);
  });

  it("builds a NEAR link with the bid number only, and the account when chosen", () => {
    const hidden = winShare({ sale: SALE, result: RESULT, fill: FILL }, { showAccount: false, near: true, where: "testnet", origin });
    expect(hidden.url).toBe(`${origin}/sale/nosnipe/result?win=2`);
    expect(hidden.imageSrc).toBe("/api/og/win?sale=nosnipe&win=2");
    expect(hidden.text).toMatch(/On NEAR testnet\.$/);
    expect(JSON.stringify(hidden)).not.toContain("alice");

    const shown = winShare({ sale: SALE, result: RESULT, fill: FILL }, { showAccount: true, near: true, where: "mainnet", origin });
    expect(shown.url).toBe(`${origin}/sale/nosnipe/result?win=2&by=alice.testnet`);
    // The post never names the account; the card does, when chosen.
    expect(shown.text).not.toContain("alice");
  });

  it("links a judge sale to the judge page, and the card still carries its facts", () => {
    const judge = { ...SALE, id: "judge-3", isJudgeSale: true };
    const s = winShare({ sale: judge, result: RESULT, fill: FILL }, { showAccount: false, near: false, where: "simulated", origin });
    expect(s.url).toBe(`${origin}/judge`);
    expect(s.xHref).toContain(encodeURIComponent(`${origin}/judge`));
    expect(s.imageSrc).toMatch(/^\/api\/og\/win\?sale=judge-3&win=2&name=/);
  });

  it("has no link before the origin is known", () => {
    const s = winShare({ sale: SALE, result: RESULT, fill: FILL }, { showAccount: false, near: false, where: "simulated", origin: "" });
    expect(s.url).toBeNull();
    expect(s.xHref).not.toContain("&url=");
  });
});

describe("WinCard markup", () => {
  const render = (props: Partial<WinCardProps> = {}) =>
    renderToStaticMarkup(createElement(WinCard, { sale: SALE, result: RESULT, fill: FILL, ...props }));

  it("hides the account by default and links the card, X and the download", () => {
    vi.stubEnv("NEXT_PUBLIC_FAIRGROUND_CONTRACT", "");
    const html = render();
    expect(html).toContain("Share your win");
    expect(html).toContain("/api/og/win?sale=nosnipe&amp;win=2&amp;name=No+Snipe+Coin");
    expect(html).toContain("https://x.com/intent/post?text=");
    expect(html).toMatch(/<input[^>]*type="checkbox"(?![^>]*checked)/);
    expect(html).toContain("Simulated sale");
    expect(html).not.toContain("by=alice");
    expect(leaks(html)).toEqual([]);
  });

  it("renders nothing for a refunded or void bid, or a failed sale", () => {
    vi.stubEnv("NEXT_PUBLIC_FAIRGROUND_CONTRACT", "");
    expect(render({ fill: { ...FILL, tokens: 0n } })).toBe("");
    expect(render({ fill: { ...FILL, valid: false } })).toBe("");
    expect(render({ result: { ...RESULT, status: "failed" } })).toBe("");
  });
});
