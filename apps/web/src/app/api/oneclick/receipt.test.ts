import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getFundings } from "@/lib/funding";
import { canTrackFunding, originById, resumeLiveSwaps, startLiveSwap, submitDepositTx } from "@/lib/oneclick";
import { GET as config } from "./config/route";
import { POST as preview } from "./quote/route";
import { issueReceipt } from "./receipt";
import { NEAR_USDC_ASSET } from "./shared";
import { GET as status } from "./status/route";
import { POST as submit } from "./submit/route";
import { POST as swap } from "./swap/route";
import { GET as tokens } from "./tokens/route";

vi.mock("next/server", () => ({ connection: async () => {} }));

const ACCOUNT = "bidder.near";
const ADDRESS = `0x${"a".repeat(40)}`;
const REFUND = `0x${"b".repeat(40)}`;
const HASH = `0x${"c".repeat(64)}`;
const ORIGIN = originById("base-usdc");
const QUOTA = "https://quota.example.test";
const UPSTREAM = "https://1click.chaindefuser.com";
const SALE = "receipt-fixture";
const quoteInput = () => ({
  originAsset: ORIGIN.assetId,
  destinationAsset: NEAR_USDC_ASSET,
  amount: "25000000",
  recipient: ACCOUNT,
  recipientType: "DESTINATION_CHAIN",
  refundTo: REFUND,
  refundType: "ORIGIN_CHAIN",
  deadline: new Date(Date.now() + 1_200_000).toISOString(),
});

let quotaResult: number;
let upstreamCalls: string[];
let quotaCalls: number;
let statusRecipient: string;
let statusAddress: string;
let submitted: unknown;
let acknowledgeOnly: boolean;

function tracking(now?: number) {
  return issueReceipt({ address: ADDRESS, kind: "evm", recipient: ACCOUNT }, now);
}

function request(path: string, body?: object, token?: string) {
  return new Request(`http://localhost/api/oneclick/${path}`, {
    method: body ? "POST" : "GET",
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function fixtureFetch(input: string | URL | Request, init?: RequestInit) {
  const url = new URL(input instanceof Request ? input.url : input, "http://localhost");
  if (url.origin === QUOTA) {
    quotaCalls++;
    return Response.json({ result: quotaResult });
  }
  if (url.origin === "http://localhost") {
    const req = new Request(url, init);
    if (url.pathname.endsWith("/swap")) return swap(req);
    if (url.pathname.endsWith("/status")) return status(req);
    if (url.pathname.endsWith("/submit")) return submit(req);
  }
  if (url.origin !== UPSTREAM) throw new Error("Unexpected fixture request.");
  upstreamCalls.push(url.pathname);
  expect(new Headers(init?.headers).get("authorization")).toBe(
    process.env.ONECLICK_REDIS_URL ? "Bearer local-provider-fixture" : null,
  );
  if (url.pathname === "/v0/quote") {
    const body = JSON.parse(String(init?.body));
    return Response.json({
      correlationId: "local-quote",
      quoteRequest: body,
      quote: {
        depositAddress: body.dry ? undefined : ADDRESS,
        amountIn: body.amount,
        amountOut: "24990000",
        minAmountOut: "24740100",
        deadline: body.deadline,
      },
    });
  }
  if (url.pathname === "/v0/tokens") return Response.json([]);
  if (url.pathname === "/v0/deposit/submit") {
    submitted = JSON.parse(String(init?.body));
    if (acknowledgeOnly) return Response.json({ status: "KNOWN_DEPOSIT_TX" });
  }
  return Response.json({
    status: "SUCCESS",
    updatedAt: new Date().toISOString(),
    quoteResponse: { quote: { depositAddress: statusAddress }, quoteRequest: { recipient: statusRecipient, refundTo: REFUND } },
    swapDetails: {
      amountOut: "24950000",
      destinationChainTxHashes: [{ explorerUrl: "https://example.test/tx/fixture", amount: "private-extra" }],
      originChainTxHashes: [{ explorerUrl: "http://example.test/rejected" }],
      privateExtra: "hidden",
    },
  });
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_FAIRGROUND_CONTRACT", "sealround.near");
  vi.stubEnv("NEXT_PUBLIC_NEAR_NETWORK", "mainnet");
  vi.stubEnv("NEXT_PUBLIC_USDC_CONTRACT", undefined);
  vi.stubEnv("ONECLICK_REAL_SWAPS", "1");
  vi.stubEnv("ONECLICK_RECEIPT_SECRET", "f".repeat(64));
  vi.stubEnv("ONECLICK_REDIS_URL", QUOTA);
  vi.stubEnv("ONECLICK_REDIS_TOKEN", "local-redis-fixture");
  vi.stubEnv("ONECLICK_JWT", "local-provider-fixture");
  quotaResult = 0;
  quotaCalls = 0;
  upstreamCalls = [];
  statusRecipient = ACCOUNT;
  statusAddress = ADDRESS;
  submitted = undefined;
  acknowledgeOnly = false;
  vi.stubGlobal("fetch", vi.fn(fixtureFetch));
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
  });
  vi.stubGlobal("window", new EventTarget());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("issues tracking only on a validated live quote and returns the receipt's reduced status", async () => {
  const response = await swap(request("swap", quoteInput()));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const quote = await response.json();
  const reply = await status(request(`status?depositAddress=${ADDRESS}`, undefined, quote.tracking.token));
  expect(reply.status).toBe(200);
  expect(await reply.json()).toEqual({
    status: "SUCCESS", updatedAt: expect.any(Number), amountOut: "24950000", deliveryTxUrl: "https://example.test/tx/fixture",
  });
  expect(upstreamCalls).toEqual(["/v0/quote", "/v0/status"]);
  expect(quotaCalls).toBe(2);
});

it("refuses missing, altered, expired and wrong-address receipts before quota or provider calls", async () => {
  const valid = tracking().token;
  const expired = tracking(Date.now() - 31 * 86_400_000).token;
  const altered = `${valid[0] === "a" ? "b" : "a"}${valid.slice(1)}`;
  for (const token of [undefined, altered, expired]) {
    expect((await status(request(`status?depositAddress=${ADDRESS}`, undefined, token))).status).toBe(403);
    expect((await submit(request("submit", { depositAddress: ADDRESS, txHash: HASH }, token))).status).toBe(403);
  }
  expect((await status(request(`status?depositAddress=${REFUND}`, undefined, valid))).status).toBe(403);
  expect((await submit(request("submit", { depositAddress: REFUND, txHash: HASH }, valid))).status).toBe(403);
  expect(quotaCalls).toBe(0);
  expect(upstreamCalls).toEqual([]);
});

it.each(["recipient", "address"])("withholds an upstream status for a different %s", async (field) => {
  if (field === "recipient") statusRecipient = "other.near";
  else statusAddress = REFUND;
  const reply = await status(request(`status?depositAddress=${ADDRESS}`, undefined, tracking().token));
  expect(reply.status).toBe(502);
  expect(await reply.json()).toEqual({ message: "1Click could not confirm this deposit status." });
});

it("enforces the quota on every 1Click route before contacting the provider", async () => {
  quotaResult = 17;
  const receipt = tracking().token;
  const replies = await Promise.all([
    tokens(request("tokens")),
    preview(request("quote", quoteInput())),
    swap(request("swap", quoteInput())),
    status(request(`status?depositAddress=${ADDRESS}`, undefined, receipt)),
    submit(request("submit", { depositAddress: ADDRESS, txHash: HASH }, receipt)),
  ]);
  for (const res of replies) {
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("17");
  }
  expect(quotaCalls).toBe(5);
  expect(upstreamCalls).toEqual([]);
});

it("allows anonymous dry quotes with no Redis and keeps the provider key off those requests", async () => {
  vi.stubEnv("ONECLICK_REDIS_URL", undefined);
  vi.stubEnv("ONECLICK_REDIS_TOKEN", undefined);
  expect(await (await config()).json()).toEqual({ liveSwaps: false });
  expect((await swap(request("swap", quoteInput()))).status).toBe(403);
  expect((await preview(request("quote", quoteInput()))).status).toBe(200);
  expect(quotaCalls).toBe(0);
  expect(upstreamCalls).toEqual(["/v0/quote"]);
});

it("accepts an acknowledgement without displaying unverified status", async () => {
  acknowledgeOnly = true;
  const response = await submit(request("submit", { depositAddress: ADDRESS, txHash: HASH }, tracking().token));
  expect(response.status).toBe(204);
  expect(await response.text()).toBe("");
});

it("keeps the receipt in browser storage and tracks or submits only for that deposit", async () => {
  const args = { account: ACCOUNT, saleId: SALE, origin: ORIGIN, amountInBase: 25_000_000n, refundTo: REFUND };
  const first = await startLiveSwap(args);
  const saved = getFundings(ACCOUNT, SALE)[0];
  expect(saved.id).toBe(first.id);
  expect(canTrackFunding(saved)).toBe(true);
  await expect(submitDepositTx(saved, "not-a-hash")).rejects.toThrow();
  const done = await submitDepositTx(saved, HASH);
  expect(submitted).toEqual({ depositAddress: ADDRESS, txHash: HASH });
  expect(done).toMatchObject({ status: "SUCCESS", receivedUsdc: 24_950_000n });

  await startLiveSwap(args);
  const stop = resumeLiveSwaps(ACCOUNT);
  try {
    await vi.waitFor(() => expect(getFundings(ACCOUNT, SALE).map((row) => row.status)).toEqual(["SUCCESS", "SUCCESS"]));
  } finally {
    stop();
  }
});
