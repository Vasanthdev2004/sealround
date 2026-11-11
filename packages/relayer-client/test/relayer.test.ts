import type { PolicyResponse, RelayResponse } from "@fairground/relayer/api";
import { describe, expect, it, vi } from "vitest";
import { RelayerError, createRelayerClient } from "../src/relayer";
import { FAIRGROUND, USDC } from "./helpers";

type Answer = Response | Error | (() => Response | Promise<Response>);

/** A fetch that answers from a script and records each request. */
function scriptedFetch(...answers: Answer[]) {
  const requests: Array<{ url: string; method: string; headers: Headers; body: string | undefined }> = [];
  const fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    requests.push({ url: String(input), method: init.method ?? "GET", headers: new Headers(init.headers), body: init.body as string | undefined });
    const answer = answers.shift();
    if (answer === undefined) throw new Error("unexpected request");
    if (answer instanceof Error) throw answer;
    return typeof answer === "function" ? answer() : answer;
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const relayed: RelayResponse = {
  tx_hash: "9Wq",
  status: "succeeded",
  outcome: { failures: [], events: [{ event: "bid_placed", data: { sale_id: "fairt" } }], relayer_cost: "748628379898100000001" },
};

const policy: PolicyResponse = {
  network: "sandbox",
  relayer_account_id: "relayer.test.near",
  fairground_contract: FAIRGROUND,
  fairground_methods: ["claim"],
  usdc_contracts: [USDC],
  bid_deposit: "1",
  max_actions: 2,
  max_gas: "300000000000000",
  min_blocks_left: 5,
  max_delegate_blocks: 1200,
  rate_limits: { relays_per_sender_per_hour: 30, requests_per_ip_per_hour: 120, storage_per_ip_per_day: 3, storage_per_account: 1 },
};

async function rejection(promise: Promise<unknown>): Promise<RelayerError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(RelayerError);
  return error as RelayerError;
}

describe("relay", () => {
  it("posts the delegate as JSON and returns the relayer's answer", async () => {
    const { fetch, requests } = scriptedFetch(json(200, relayed));
    const client = createRelayerClient({ url: "https://relayer.example/", fetch });
    await expect(client.relay("AAAA")).resolves.toEqual(relayed);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ url: "https://relayer.example/relay", method: "POST", body: '{"signed_delegate":"AAAA"}' });
    expect(requests[0]!.headers.get("content-type")).toBe("application/json");
  });

  it("resolves a 202 as pending", async () => {
    const pending = { tx_hash: "9Wq", status: "pending", outcome: null };
    const { fetch } = scriptedFetch(json(202, pending));
    await expect(createRelayerClient({ url: "/api/relayer", fetch }).relay("AAAA")).resolves.toEqual(pending);
  });

  it.each([
    [400, "wrong_deposit"],
    [409, "sender_busy"],
    [429, "rate_limited"],
    [503, "budget_exhausted"],
    [502, "relay_failed"],
  ] as const)("maps %i %s to a RelayerError that certainly sent nothing", async (status, reason) => {
    const { fetch } = scriptedFetch(json(status, { error: reason, request_id: "req-1" }, { "x-request-id": "req-1" }));
    const error = await rejection(createRelayerClient({ url: "https://r.example", fetch }).relay("AAAA"));
    expect(error).toMatchObject({ name: "RelayerError", reason, status, requestId: "req-1", maybeSubmitted: false });
    expect(error.message).not.toBe("");
  });

  it("treats internal_error as possibly submitted", async () => {
    const { fetch } = scriptedFetch(json(500, { error: "internal_error", request_id: "req-2" }));
    const error = await rejection(createRelayerClient({ url: "https://r.example", fetch }).relay("AAAA"));
    expect(error).toMatchObject({ reason: "internal_error", status: 500, requestId: "req-2", maybeSubmitted: true });
  });

  it.each([
    ["a proxy's HTML error page", new Response("<html>Bad Gateway</html>", { status: 502 })],
    ["a 200 without a tx hash", json(200, { status: "succeeded", outcome: null })],
    ["a 200 with an unknown status", json(200, { ...relayed, status: "done" })],
    ["a code this client does not know", json(400, { error: "brand_new_code", request_id: "x" })],
  ])("reads %s as bad_response, possibly submitted", async (_label, response) => {
    const { fetch } = scriptedFetch(response);
    const error = await rejection(createRelayerClient({ url: "https://r.example", fetch }).relay("AAAA"));
    expect(error).toMatchObject({ reason: "bad_response", maybeSubmitted: true });
  });

  it("reports a network failure, keeps its cause, and never retries a relay", async () => {
    const cause = new TypeError("fetch failed");
    const { fetch, requests } = scriptedFetch(cause, json(200, relayed));
    const error = await rejection(createRelayerClient({ url: "https://r.example", fetch }).relay("AAAA"));
    expect(error).toMatchObject({ reason: "network_error", status: null, requestId: null, maybeSubmitted: true, cause });
    expect(requests).toHaveLength(1);
  });

  it("gives up after timeoutMs", async () => {
    const hang = async (_input: RequestInfo | URL, init: RequestInit = {}) =>
      new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    const client = createRelayerClient({ url: "https://r.example", fetch: hang as typeof fetch, timeoutMs: 20 });
    const error = await rejection(client.relay("AAAA"));
    expect(error).toMatchObject({ reason: "timeout", status: null, maybeSubmitted: true });
  });
});

describe("sponsorStorage", () => {
  it("sends the account, and the token only when given", async () => {
    const { fetch, requests } = scriptedFetch(
      json(200, { status: "registered", token_id: USDC, tx_hash: "h" }),
      json(200, { status: "already_registered", token_id: "usdc2.test.near" }),
    );
    const client = createRelayerClient({ url: "https://r.example", fetch });
    await expect(client.sponsorStorage("dave.test.near")).resolves.toEqual({ status: "registered", token_id: USDC, tx_hash: "h" });
    await expect(client.sponsorStorage("dave.test.near", "usdc2.test.near")).resolves.toMatchObject({ status: "already_registered" });
    expect(requests.map((request) => [request.url, request.body])).toEqual([
      ["https://r.example/storage", '{"account_id":"dave.test.near"}'],
      ["https://r.example/storage", '{"account_id":"dave.test.near","token_id":"usdc2.test.near"}'],
    ]);
  });

  it("maps unknown_account", async () => {
    const { fetch } = scriptedFetch(json(400, { error: "unknown_account", request_id: "r" }));
    const error = await rejection(createRelayerClient({ url: "https://r.example", fetch }).sponsorStorage("ghost.test.near"));
    expect(error).toMatchObject({ reason: "unknown_account", maybeSubmitted: false });
  });
});

describe("getPolicy", () => {
  it("is a GET without a body", async () => {
    const { fetch, requests } = scriptedFetch(json(200, policy));
    await expect(createRelayerClient({ url: "https://r.example", fetch }).getPolicy()).resolves.toEqual(policy);
    expect(requests[0]).toMatchObject({ url: "https://r.example/policy", method: "GET", body: undefined });
  });

  it("retries network errors and 5xx answers, twice", async () => {
    const { fetch, requests } = scriptedFetch(new TypeError("fetch failed"), new Response("", { status: 503 }), json(200, policy));
    await expect(createRelayerClient({ url: "https://r.example", fetch }).getPolicy()).resolves.toEqual(policy);
    expect(requests).toHaveLength(3);

    const failing = scriptedFetch(new TypeError("a"), new TypeError("b"), new TypeError("c"), json(200, policy));
    const error = await rejection(createRelayerClient({ url: "https://r.example", fetch: failing.fetch }).getPolicy());
    expect(error.reason).toBe("network_error");
    expect(failing.requests).toHaveLength(3);
  });

  it("uses the global fetch, looked up when the request is made", async () => {
    const client = createRelayerClient({ url: "https://r.example" });
    const { fetch, requests } = scriptedFetch(json(200, policy));
    vi.stubGlobal("fetch", fetch);
    try {
      await expect(client.getPolicy()).resolves.toEqual(policy);
      expect(requests).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not retry a 4xx", async () => {
    const { fetch, requests } = scriptedFetch(json(429, { error: "rate_limited", request_id: "r" }), json(200, policy));
    expect((await rejection(createRelayerClient({ url: "https://r.example", fetch }).getPolicy())).reason).toBe("rate_limited");
    expect(requests).toHaveLength(1);
  });
});
