import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { POST as preview } from "./quote/route";
import { NEAR_USDC_ASSET } from "./shared";
import { POST as deposit } from "./swap/route";

vi.mock("./quota", () => ({
  oneClickSharedQuotaConfigured: () => true,
  checkOneClickQuota: async () => null,
}));

const upstream = vi.fn<typeof fetch>();

function terms() {
  return {
    swapType: "EXACT_INPUT",
    depositType: "ORIGIN_CHAIN",
    originAsset: "nep141:eth.omft.near",
    destinationAsset: NEAR_USDC_ASSET,
    amount: "1000000000000000",
    recipient: "bidder.near",
    recipientType: "DESTINATION_CHAIN",
    refundTo: `0x${"1".repeat(40)}`,
    refundType: "ORIGIN_CHAIN",
    deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
    confidentiality: "basic",
  };
}

function request(body: Record<string, unknown>) {
  return new Request("http://localhost/api/oneclick", { method: "POST", body: JSON.stringify(body) });
}

beforeEach(() => {
  upstream.mockReset();
  vi.stubGlobal("fetch", upstream);
  vi.stubEnv("ONECLICK_REAL_SWAPS", "1");
  vi.stubEnv("ONECLICK_RECEIPT_SECRET", "a".repeat(64));
  vi.stubEnv("NEXT_PUBLIC_FAIRGROUND_CONTRACT", "sealround.near");
  vi.stubEnv("NEXT_PUBLIC_NEAR_NETWORK", "mainnet");
  vi.stubEnv("NEXT_PUBLIC_USDC_CONTRACT", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("forwards the selected mode on both mainnet quote routes without issuing a live preview", async () => {
  upstream.mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    return Response.json({
      quoteRequest: body,
      quote: {
        amountIn: body.amount, amountOut: "1000000", minAmountOut: "990000", deadline: body.deadline,
        ...(body.dry ? {} : { depositAddress: `0x${"2".repeat(40)}` }),
      },
    });
  });
  expect((await preview(request({ ...terms(), dry: false }))).status).toBe(200);
  expect((await deposit(request(terms()))).status).toBe(200);
  expect(upstream.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
    expect.objectContaining({ dry: true, confidentiality: "basic" }),
    expect.objectContaining({ dry: false, confidentiality: "basic", depositMode: "SIMPLE" }),
  ]);
});

it.each([undefined, "public"])("rejects a quote when 1Click echoes %s instead of basic", async (confidentiality) => {
  const body = terms();
  upstream.mockImplementation(async (_url, init) => Response.json({
    quoteRequest: { ...JSON.parse(String(init?.body)), confidentiality },
    quote: {
      depositAddress: `0x${"2".repeat(40)}`, amountIn: body.amount, amountOut: "1000000",
      minAmountOut: "990000", deadline: body.deadline,
    },
  }));
  for (const route of [preview, deposit]) {
    const response = await route(request(body));
    expect(response.status).toBe(502);
    expect(await response.json()).not.toHaveProperty("quote");
  }
});

it("keeps testnet on ordinary dry quotes even when the live switch is set", async () => {
  vi.stubEnv("NEXT_PUBLIC_FAIRGROUND_CONTRACT", "sealround.testnet");
  vi.stubEnv("NEXT_PUBLIC_NEAR_NETWORK", "testnet");
  expect((await preview(request(terms()))).status).toBe(403);
  expect((await deposit(request(terms()))).status).toBe(403);
  expect(upstream).not.toHaveBeenCalled();

  upstream.mockResolvedValueOnce(Response.json({ quote: { amountOut: "1000000" } }));
  expect((await preview(request({ ...terms(), confidentiality: undefined }))).status).toBe(200);
  expect(JSON.parse(String(upstream.mock.calls[0][1]?.body))).toMatchObject({ dry: true });
});
