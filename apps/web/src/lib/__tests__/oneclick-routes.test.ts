import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getConfig } from "@/app/api/oneclick/config/route";
import { POST as postQuote } from "@/app/api/oneclick/quote/route";
import { issueReceipt } from "@/app/api/oneclick/receipt";
import { NEAR_USDC_ASSET, NEAR_USDC_CONTRACT } from "@/app/api/oneclick/shared";
import { GET as getStatus } from "@/app/api/oneclick/status/route";
import { POST as postSubmit } from "@/app/api/oneclick/submit/route";
import { POST as postSwap } from "@/app/api/oneclick/swap/route";

vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("@/app/api/oneclick/quota", () => ({
  oneClickSharedQuotaConfigured: () => true,
  checkOneClickQuota: async () => null,
}));

const BASE_USDC = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const DEPOSIT = `0x${"1".repeat(40)}`;
const REFUND = `0x${"2".repeat(40)}`;
const TX_HASH = `0x${"3".repeat(64)}`;
const UPSTREAM = "https://1click.chaindefuser.com/v0";
const fetchStub = vi.fn<typeof fetch>();

function post(path: string, body: unknown, token?: string): Request {
  return new Request(`http://localhost/api/oneclick/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

function status(depositAddress: string): Request {
  const url = new URL("http://localhost/api/oneclick/status");
  url.searchParams.set("depositAddress", depositAddress);
  return new Request(url);
}

const tracking = () => issueReceipt({ address: DEPOSIT, recipient: "recipient.near", kind: "evm" }).token;

function quoteTerms() {
  return {
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: BASE_USDC,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: NEAR_USDC_ASSET,
    amount: "25000000",
    refundTo: REFUND,
    refundType: "ORIGIN_CHAIN",
    recipient: "recipient.near",
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
  };
}

function mockQuote(terms: ReturnType<typeof quoteTerms>) {
  return {
    correlationId: "fixture",
    signature: "fixture-signature",
    quoteRequest: { ...terms, dry: false, depositMode: "SIMPLE" },
    quote: {
      depositAddress: DEPOSIT,
      amountIn: terms.amount,
      amountOut: "24990000",
      minAmountOut: "24740100",
      deadline: terms.deadline,
    },
  };
}

function enableMainnet() {
  vi.stubEnv("ONECLICK_REAL_SWAPS", "1");
  vi.stubEnv("ONECLICK_RECEIPT_SECRET", "a".repeat(64));
  vi.stubEnv("NEXT_PUBLIC_FAIRGROUND_CONTRACT", "sealround.near");
  vi.stubEnv("NEXT_PUBLIC_NEAR_NETWORK", "mainnet");
}

beforeEach(() => {
  fetchStub.mockReset();
  vi.stubGlobal("fetch", fetchStub);
  for (const name of [
    "ONECLICK_REAL_SWAPS", "ONECLICK_JWT", "ONECLICK_RECEIPT_SECRET", "NEXT_PUBLIC_FAIRGROUND_CONTRACT", "NEXT_PUBLIC_NEAR_NETWORK",
    "NEXT_PUBLIC_NEAR_RPC_URL", "NEXT_PUBLIC_USDC_CONTRACT", "NEXT_PUBLIC_RELAYER_URL", "NEXT_PUBLIC_SEALER_CODE_HASH",
  ]) vi.stubEnv(name, undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("1Click proxy", () => {
  it("defaults to off without issuing an upstream request", async () => {
    const config = await getConfig();
    expect(config.headers.get("cache-control")).toBe("no-store");
    expect(await config.json()).toEqual({ liveSwaps: false });
    expect((await postSwap(post("swap", quoteTerms()))).status).toBe(403);
    expect((await getStatus(status(DEPOSIT))).status).toBe(403);
    expect((await postSubmit(post("submit", { depositAddress: DEPOSIT, txHash: TX_HASH }))).status).toBe(403);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("requires both a mainnet deployment and Circle USDC when the server flag is set", async () => {
    enableMainnet();
    expect(await (await getConfig()).json()).toEqual({ liveSwaps: true });
    vi.stubEnv("NEXT_PUBLIC_USDC_CONTRACT", "other.near");
    expect(await (await getConfig()).json()).toEqual({ liveSwaps: false });
    expect((await postSwap(post("swap", quoteTerms()))).status).toBe(403);
    vi.stubEnv("NEXT_PUBLIC_USDC_CONTRACT", NEAR_USDC_CONTRACT);
    vi.stubEnv("NEXT_PUBLIC_NEAR_NETWORK", "sandbox");
    expect(await (await getConfig()).json()).toEqual({ liveSwaps: false });
    vi.stubEnv("NEXT_PUBLIC_FAIRGROUND_CONTRACT", undefined);
    vi.stubEnv("NEXT_PUBLIC_NEAR_NETWORK", "mainnet");
    expect(await (await getConfig()).json()).toEqual({ liveSwaps: false });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("always requests a dry quote on the preview route", async () => {
    enableMainnet();
    fetchStub.mockResolvedValue(Response.json({ quote: { amountOut: "24990000" } }));
    const response = await postQuote(post("quote", { ...quoteTerms(), dry: false, appFees: [{ fee: 999 }] }));
    expect(response.status).toBe(200);
    const [url, request] = fetchStub.mock.calls[0];
    expect(url).toBe(`${UPSTREAM}/quote`);
    expect(JSON.parse(String(request?.body))).toEqual({ ...quoteTerms(), deadline: expect.any(String), dry: true });
  });

  it("issues a live origin-chain deposit quote and keeps authentication on the server", async () => {
    enableMainnet();
    vi.stubEnv("ONECLICK_JWT", "local-fixture-token");
    const terms = quoteTerms();
    const fixture = mockQuote(terms);
    fetchStub.mockResolvedValue(Response.json(fixture));
    const response = await postSwap(post("swap", { ...terms, dry: true, depositMode: "MEMO", jwt: "ignore" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("authorization")).toBeNull();
    expect(await response.json()).toMatchObject({ ...fixture, tracking: { token: expect.any(String), expiresAt: expect.any(Number) } });
    const [url, request] = fetchStub.mock.calls[0];
    expect(url).toBe(`${UPSTREAM}/quote`);
    expect(new Headers(request?.headers).get("authorization")).toBe("Bearer local-fixture-token");
    expect(JSON.parse(String(request?.body))).toEqual({ ...terms, dry: false, depositMode: "SIMPLE" });
  });

  it.each([
    ["a different destination", { destinationAsset: "nep141:another.near" }],
    ["an unknown source token", { originAsset: "nep141:wrap.near" }],
    ["a testnet recipient", { recipient: "recipient.testnet" }],
    ["a refund on the wrong chain", { refundTo: "recipient.near" }],
    ["an intent deposit", { depositType: "INTENTS" }],
    ["an exact-output swap", { swapType: "EXACT_OUTPUT" }],
    ["an expired request", { deadline: "2001-01-01T00:00:00.000Z" }],
  ])("rejects %s before contacting 1Click", async (_reason, terms) => {
    enableMainnet();
    expect((await postSwap(post("swap", { ...quoteTerms(), ...terms }))).status).toBe(400);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("discards a returned deposit address when the quote changes the refund destination", async () => {
    enableMainnet();
    const terms = quoteTerms();
    const fixture = mockQuote({ ...terms, refundTo: DEPOSIT });
    fetchStub.mockResolvedValue(Response.json(fixture));
    const response = await postSwap(post("swap", terms));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: "quote_mismatch" });
  });

  it("polls the upstream deposit without caching status or forwarding other query fields", async () => {
    enableMainnet();
    const updatedAt = new Date().toISOString();
    const fixture = {
      status: "SUCCESS", updatedAt, quoteResponse: mockQuote(quoteTerms()), swapDetails: { amountOut: "24990000" },
    };
    fetchStub.mockResolvedValue(Response.json(fixture));
    const response = await getStatus(new Request(`${status(DEPOSIT).url}&depositMemo=ignore&jwt=ignore`, {
      headers: { authorization: `Bearer ${tracking()}` },
    }));
    expect(await response.json()).toEqual({ status: "SUCCESS", updatedAt: Date.parse(updatedAt), amountOut: "24990000" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    const [url, request] = fetchStub.mock.calls[0];
    expect(String(url)).toBe(`${UPSTREAM}/status?depositAddress=${DEPOSIT}`);
    expect(request?.cache).toBe("no-store");
  });

  it("rejects malformed deposits and transaction hashes before contacting 1Click", async () => {
    enableMainnet();
    expect((await getStatus(status("https://elsewhere.invalid/"))).status).toBe(403);
    const request = post("submit", { depositAddress: DEPOSIT, txHash: "not-a-transaction" }, tracking());
    expect((await postSubmit(request)).status).toBe(400);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("forwards an optional transaction hash for a supported deposit", async () => {
    enableMainnet();
    fetchStub.mockResolvedValue(Response.json({ status: "KNOWN_DEPOSIT_TX" }));
    const terms = { depositAddress: DEPOSIT, txHash: TX_HASH };
    const response = await postSubmit(post("submit", { ...terms, nearSenderAccount: "ignore" }, tracking()));
    expect(response.status).toBe(204);
    const [url, request] = fetchStub.mock.calls[0];
    expect(url).toBe(`${UPSTREAM}/deposit/submit`);
    expect(JSON.parse(String(request?.body))).toEqual(terms);
  });
});
