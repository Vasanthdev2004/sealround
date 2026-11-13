/**
 * The "I'm in" share block: the link, the image and the post it builds from
 * a bid, and its markup rendered on its own. It must never carry the bid's
 * deposit, price or sealed payload, and it hides the account by default.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BidRecord } from "@/lib/types";
import { ImIn, imInShare } from "../im-in";

const REVEAL = Date.UTC(2026, 10, 14, 18, 0);

const SALE = {
  id: "nosnipe",
  config: { tokenName: "No Snipe Coin", tokenSymbol: "NOSNIPE", bidEnd: REVEAL },
};

/** A whole bid record, with the fields the block must not touch. */
const BID: BidRecord = {
  saleId: "nosnipe",
  index: 11,
  bidder: "alice.testnet",
  deposit: 777_777_777n,
  ciphertext: "c2VhbGVkLXBheWxvYWQtc2VjcmV0",
  placedAt: REVEAL - 3_600_000,
  txHash: "9xTxHash",
  claimed: false,
  claimTx: null,
};

const leaks = (s: string) => ["777", "777.77", BID.ciphertext, "9xTxHash", "max_price", "maxPrice"].filter((x) => s.includes(x));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("imInShare", () => {
  const origin = "https://app.sealround.xyz";

  it("builds a mock link that carries the simulated sale's facts, and a post that says it is simulated", () => {
    const s = imInShare({ sale: SALE, bid: BID }, { showAccount: false, near: false, where: "simulated", origin });
    expect(s.input.bidNumber).toBe(12);
    expect(s.url).toBe(`${origin}/sale/nosnipe?bid=12&name=No+Snipe+Coin&ticker=NOSNIPE&end=${REVEAL}`);
    expect(s.imageSrc).toBe(`/api/og/bid?sale=nosnipe&bid=12&name=No+Snipe+Coin&ticker=NOSNIPE&end=${REVEAL}`);
    expect(s.text).toBe(
      "I'm in. Sealed bid #12 in $NOSNIPE. Nobody can see my price, not even the bots. Reveal at 18:00 UTC on 14 Nov. Simulated sale on Sealround.",
    );
    expect(s.xHref).toBe(`https://x.com/intent/post?text=${encodeURIComponent(s.text)}&url=${encodeURIComponent(s.url!)}`);
    expect(s.fileName).toBe("sealround-nosnipe-bid-12.png");
  });

  it("builds a NEAR link with the bid number only, and the account when chosen", () => {
    const hidden = imInShare({ sale: SALE, bid: BID }, { showAccount: false, near: true, where: "testnet", origin });
    expect(hidden.url).toBe(`${origin}/sale/nosnipe?bid=12`);
    expect(hidden.imageSrc).toBe("/api/og/bid?sale=nosnipe&bid=12");
    expect(hidden.text).toMatch(/On NEAR testnet\.$/);
    expect(JSON.stringify(hidden)).not.toContain("alice");

    const shown = imInShare({ sale: SALE, bid: BID }, { showAccount: true, near: true, where: "mainnet", origin });
    expect(shown.url).toBe(`${origin}/sale/nosnipe?bid=12&by=alice.testnet`);
    expect(shown.imageSrc).toBe("/api/og/bid?sale=nosnipe&bid=12&by=alice.testnet");
    // The post never names the account, only the card does when chosen.
    expect(shown.text).not.toContain("alice");
  });

  it("has no link while the origin is unknown (server render), and the post still works", () => {
    const s = imInShare({ sale: SALE, bid: BID }, { showAccount: false, near: true, where: "mainnet", origin: "" });
    expect(s.url).toBeNull();
    expect(s.xHref).toBe(`https://x.com/intent/post?text=${encodeURIComponent(s.text)}`);
  });

  it("never carries the deposit, the sealed payload or the transaction", () => {
    for (const near of [true, false]) {
      for (const showAccount of [true, false]) {
        const s = imInShare({ sale: SALE, bid: BID }, { showAccount, near, where: near ? "testnet" : "simulated", origin });
        expect(leaks(JSON.stringify(s))).toEqual([]);
      }
    }
  });
});

describe("<ImIn> rendered on its own", () => {
  const render = () => renderToStaticMarkup(createElement(ImIn, { sale: SALE, bid: BID, className: "mt-5" }));

  it("shows the preview, the three actions and the account box, unticked", () => {
    vi.stubEnv("NEXT_PUBLIC_FAIRGROUND_CONTRACT", "");
    const html = render();
    expect(html).toContain("Show you’re in");
    expect(html).toContain('src="/api/og/bid?sale=nosnipe&amp;bid=12&amp;name=No+Snipe+Coin&amp;ticker=NOSNIPE&amp;end=');
    expect(html).toContain('alt="Your share card: I&#x27;m in. Sealed bid #12 in $NOSNIPE. Price and amount sealed until the reveal."');
    expect(html).toContain('href="https://x.com/intent/post?text=');
    expect(html).toContain('target="_blank"');
    expect(html).toContain("Share on X");
    expect(html).toContain("Copy link");
    expect(html).toContain("Download image");
    expect(html).toMatch(/<input[^>]*type="checkbox"(?![^>]*checked)[^>]*>/);
    expect(html).toContain("Show <span");
    expect(html).not.toContain("by=alice");
    // Mock mode says so.
    expect(html).toContain("Simulated sale. The card and the post say so.");
    expect(leaks(html)).toEqual([]);
  });

  it("drops the simulated note and the mock facts in NEAR mode", () => {
    vi.stubEnv("NEXT_PUBLIC_FAIRGROUND_CONTRACT", "fairground.testnet");
    vi.stubEnv("NEXT_PUBLIC_NEAR_NETWORK", "testnet");
    const html = render();
    expect(html).toContain('src="/api/og/bid?sale=nosnipe&amp;bid=12"');
    expect(html).not.toContain("Simulated sale.");
    expect(leaks(html)).toEqual([]);
  });
});
