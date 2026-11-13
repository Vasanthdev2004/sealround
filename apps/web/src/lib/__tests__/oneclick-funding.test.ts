import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as config } from "@/app/api/oneclick/config/route";
import { GET as status } from "@/app/api/oneclick/status/route";
import { POST as swap } from "@/app/api/oneclick/swap/route";
import { getFundings, type OneClickStatus } from "@/lib/funding";
import { fetchLiveSwapsEnabled, originById, REAL_POLL_MS, resumeLiveSwaps, startLiveSwap } from "@/lib/oneclick";

vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("@/app/api/oneclick/quota", () => ({
  oneClickSharedQuotaConfigured: () => true,
  checkOneClickQuota: async () => null,
}));

const ACCOUNT = "bidder.near";
const SALE = "test-sale";
const REFUND = `0x${"2".repeat(40)}`;
const DEPOSIT = `0x${"3".repeat(40)}`;
const ORIGIN = originById("base-usdc");
const EPOCH = Date.parse("2026-11-11T12:00:00Z");
const args = { account: ACCOUNT, saleId: SALE, origin: ORIGIN, amountInBase: 25_000_000n, refundTo: REFUND };

let observedStatus: OneClickStatus;
let statusCode: number;
let statusCalls: number;
let quoteRecipient: string;
let inactiveAt: number;
let quote: Record<string, unknown>;
let cleanup: (() => void) | undefined;

function current() {
  return getFundings(ACCOUNT, SALE)[0];
}

async function mockFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : input, "http://localhost");
  if (url.origin === "http://localhost") {
    const request = new Request(url, init);
    if (url.pathname === "/api/oneclick/config") return config();
    if (url.pathname === "/api/oneclick/swap") return swap(request);
    if (url.pathname === "/api/oneclick/status") return status(request);
  }
  if (url.origin === "https://1click.chaindefuser.com" && url.pathname === "/v0/quote") {
    const request = JSON.parse(String(init?.body));
    expect(request).toMatchObject({ dry: false, recipient: ACCOUNT, refundTo: REFUND, amount: "25000000" });
    quote = {
      correlationId: "local-fixture",
      signature: "local-signature",
      quoteRequest: { ...request, recipient: quoteRecipient },
      quote: {
        depositAddress: DEPOSIT,
        amountIn: request.amount,
        amountOut: "24990000",
        minAmountOut: "24740100",
        deadline: request.deadline,
        timeWhenInactive: new Date(inactiveAt).toISOString(),
      },
    };
    return Response.json(quote);
  }
  if (url.origin === "https://1click.chaindefuser.com" && url.pathname === "/v0/status") {
    statusCalls++;
    expect(url.searchParams.get("depositAddress")).toBe(DEPOSIT);
    if (statusCode !== 200) return Response.json({ message: "Fixture unavailable" }, { status: statusCode });
    return Response.json({
      status: observedStatus,
      updatedAt: new Date(Date.now()).toISOString(),
      quoteResponse: quote,
      swapDetails: observedStatus === "SUCCESS"
        ? { amountOut: "24950000", destinationChainTxHashes: [{ explorerUrl: "https://nearblocks.io/txns/fixture" }] }
        : observedStatus === "REFUNDED" ? { refundedAmountFormatted: "12.5", refundReason: "PARTIAL_DEPOSIT" } : {},
    });
  }
  throw new Error(`Unexpected request: ${url.origin}${url.pathname}`);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(EPOCH);
  vi.stubEnv("NEXT_PUBLIC_FAIRGROUND_CONTRACT", "sealround.near");
  vi.stubEnv("NEXT_PUBLIC_NEAR_NETWORK", "mainnet");
  vi.stubEnv("NEXT_PUBLIC_USDC_CONTRACT", undefined);
  vi.stubEnv("ONECLICK_REAL_SWAPS", "1");
  vi.stubEnv("ONECLICK_RECEIPT_SECRET", "a".repeat(64));
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
  });
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("fetch", vi.fn(mockFetch));
  observedStatus = "PENDING_DEPOSIT";
  statusCode = 200;
  statusCalls = 0;
  quoteRecipient = ACCOUNT;
  inactiveAt = EPOCH + 600_000;
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("1Click funding against local route fixtures", () => {
  it("discovers the server switch, saves exact terms, and resumes to actual delivery", async () => {
    vi.stubEnv("ONECLICK_REAL_SWAPS", undefined);
    expect(await fetchLiveSwapsEnabled()).toBe(false);
    vi.stubEnv("ONECLICK_REAL_SWAPS", "1");
    expect(await fetchLiveSwapsEnabled()).toBe(true);

    cleanup = resumeLiveSwaps(ACCOUNT);
    observedStatus = "KNOWN_DEPOSIT_TX";
    const receipt = await startLiveSwap(args);
    expect(receipt).toMatchObject({
      amountIn: "25",
      amountOutUsdc: 24_990_000n,
      minAmountOutUsdc: 24_740_100n,
      depositAddress: DEPOSIT,
      depositExpiresAt: inactiveAt,
      simulated: false,
    });
    await vi.waitFor(() => expect(current()?.status).toBe("KNOWN_DEPOSIT_TX"));
    cleanup();

    observedStatus = "SUCCESS";
    cleanup = resumeLiveSwaps(ACCOUNT);
    await vi.waitFor(() => expect(current()).toMatchObject({
      id: receipt.id,
      status: "SUCCESS",
      amountOutUsdc: 24_990_000n,
      receivedUsdc: 24_950_000n,
      destinationTxUrl: "https://nearblocks.io/txns/fixture",
    }));
  });

  it("retries unavailable status checks and waits for a short deposit's confirmed refund", async () => {
    await startLiveSwap(args);
    statusCode = 503;
    cleanup = resumeLiveSwaps(ACCOUNT);
    await vi.waitFor(() => expect(current()).toMatchObject({ status: "PENDING_DEPOSIT", statusCheckFailed: true }));

    statusCode = 200;
    observedStatus = "INCOMPLETE_DEPOSIT";
    await vi.advanceTimersByTimeAsync(2 * REAL_POLL_MS);
    await vi.waitFor(() => expect(current()).toMatchObject({ status: "INCOMPLETE_DEPOSIT", statusCheckFailed: false }));

    observedStatus = "REFUNDED";
    await vi.advanceTimersByTimeAsync(REAL_POLL_MS);
    await vi.waitFor(() => expect(current()).toMatchObject({ status: "REFUNDED", refundedAmount: "12.5" }));
    const callsAtRefund = statusCalls;
    await vi.advanceTimersByTimeAsync(2 * REAL_POLL_MS);
    expect(statusCalls).toBe(callsAtRefund);
  });

  it("leaves no payable receipt for a mismatched or expired quote", async () => {
    quoteRecipient = "other.near";
    await expect(startLiveSwap(args)).rejects.toThrow(/does not match/i);
    quoteRecipient = ACCOUNT;
    inactiveAt = EPOCH - 1;
    await expect(startLiveSwap(args)).rejects.toThrow(/deadline has passed/i);
    expect(current()).toBeUndefined();
  });
});
