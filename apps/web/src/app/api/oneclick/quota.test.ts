import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkOneClickQuota, oneClickSharedQuotaConfigured } from "./quota";

const fetchStub = vi.fn<typeof fetch>();
let now = Date.UTC(2026, 10, 12);

function request(headers: HeadersInit = {}): Request {
  return new Request("http://localhost/api/oneclick/quote", { headers });
}

function enableRedis() {
  vi.stubEnv("ONECLICK_REDIS_URL", "https://redis.example");
  vi.stubEnv("ONECLICK_REDIS_TOKEN", "fixture-only");
}

beforeEach(() => {
  vi.stubEnv("ONECLICK_REDIS_URL", undefined);
  vi.stubEnv("ONECLICK_REDIS_TOKEN", undefined);
  vi.stubEnv("VERCEL", undefined);
  fetchStub.mockReset();
  vi.stubGlobal("fetch", fetchStub);
  vi.useFakeTimers({ toFake: ["Date"] });
  now += 60_000;
  vi.setSystemTime(now);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("1Click quota", () => {
  it("requires shared quotas for live calls and bounds anonymous previews locally", async () => {
    expect(oneClickSharedQuotaConfigured()).toBe(false);
    expect((await checkOneClickQuota(request(), { live: true }))?.status).toBe(503);
    for (let i = 0; i < 40; i++) {
      expect(await checkOneClickQuota(request())).toBeNull();
    }
    const limited = await checkOneClickQuota(request());
    expect(limited?.status).toBe(429);
    expect(limited?.headers.get("retry-after")).toBe("60");
    expect(limited?.headers.get("cache-control")).toBe("no-store");
    vi.setSystemTime(now + 60_000);
    expect(await checkOneClickQuota(request())).toBeNull();
    expect(fetchStub).not.toHaveBeenCalled();
    now += 60_000;
  });

  it.each([
    ["https://redis.example", undefined],
    [undefined, "fixture-only"],
    ["http://redis.example", "fixture-only"],
  ])("fails closed when Redis configuration is incomplete or unsafe", async (url, token) => {
    vi.stubEnv("ONECLICK_REDIS_URL", url);
    vi.stubEnv("ONECLICK_REDIS_TOKEN", token);
    expect(oneClickSharedQuotaConfigured()).toBe(false);
    expect((await checkOneClickQuota(request()))?.status).toBe(503);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("requests one atomic decision for the shared overall and Vercel client budgets", async () => {
    enableRedis();
    vi.stubEnv("VERCEL", "1");
    fetchStub.mockImplementation(async () => Response.json({ result: 0 }));
    expect(oneClickSharedQuotaConfigured()).toBe(true);
    await expect(checkOneClickQuota(request({ "x-vercel-forwarded-for": "203.0.113.4" }), { live: true })).resolves.toBeNull();
    const [endpoint, init] = fetchStub.mock.calls[0];
    expect(String(endpoint)).toBe("https://redis.example/");
    expect(init).toMatchObject({
      method: "POST",
      headers: { authorization: "Bearer fixture-only", "content-type": "application/json" },
      cache: "no-store",
      redirect: "error",
    });
    const command: unknown = JSON.parse(String(init?.body));
    expect(command).toEqual([
      "EVAL", expect.any(String), 2, "sealround:oneclick:quota:v1:global",
      expect.stringMatching(/^sealround:oneclick:quota:v1:client:[a-f0-9]{64}$/), 300, 40, 60,
    ]);
    expect(String(init?.body)).not.toContain("203.0.113.4");

    await checkOneClickQuota(request({ "x-vercel-forwarded-for": "203.0.113.5" }));
    const [, other] = fetchStub.mock.calls[1];
    expect(JSON.parse(String(other?.body))[4]).not.toEqual(JSON.parse(String(init?.body))[4]);
  });

  it("uses one bucket for untrusted forwarding headers", async () => {
    enableRedis();
    fetchStub.mockImplementation(async () => Response.json({ result: 0 }));
    await checkOneClickQuota(request({ "x-vercel-forwarded-for": "203.0.113.4", "x-forwarded-for": "203.0.113.5" }));
    await checkOneClickQuota(request({ "x-vercel-forwarded-for": "203.0.113.6", "x-forwarded-for": "203.0.113.7" }));
    vi.stubEnv("VERCEL", "1");
    await checkOneClickQuota(request({ "x-forwarded-for": "203.0.113.8" }));
    expect(new Set(fetchStub.mock.calls.map(([, init]) => init?.body)).size).toBe(1);
  });

  it("reports a shared denial with the store's retry interval", async () => {
    enableRedis();
    fetchStub.mockResolvedValue(Response.json({ result: 17 }));
    const limited = await checkOneClickQuota(request(), { live: true });
    expect(limited?.status).toBe(429);
    expect(limited?.headers.get("retry-after")).toBe("17");
    expect(await limited?.json()).toMatchObject({ code: "oneclick_rate_limited" });
  });

  it("refuses traffic when the shared store errors or returns an ambiguous result", async () => {
    enableRedis();
    fetchStub.mockRejectedValueOnce(new Error("fixture unavailable"));
    fetchStub.mockResolvedValueOnce(Response.json({ error: "fixture" }, { status: 500 }));
    fetchStub.mockResolvedValueOnce(Response.json({ result: null }));
    for (let i = 0; i < 3; i++) {
      const unavailable = await checkOneClickQuota(request());
      expect(unavailable?.status).toBe(503);
      expect(await unavailable?.json()).toMatchObject({ code: "oneclick_quota_unavailable" });
    }
  });
});
