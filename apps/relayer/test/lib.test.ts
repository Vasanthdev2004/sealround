import { KeyPair } from "near-api-js";
import { describe, expect, it } from "vitest";
import type { Chain } from "../src/chain.ts";
import { createRelayer, forwardedClient, loadConfig } from "../src/lib.ts";

describe("forwardedClient", () => {
  it.each([
    ["the address a single trusted proxy appended", "203.0.113.5", 1, "203.0.113.5"],
    ["the right-most entry, not what the client wrote before it", "1.2.3.4, 10.0.0.7, 203.0.113.5", 1, "203.0.113.5"],
    ["the entry before the second of two trusted proxies", "1.2.3.4, 203.0.113.5, 10.0.0.2", 2, "203.0.113.5"],
    ["an IPv6 entry", "1.2.3.4,2001:db8::1", 1, "2001:db8::1"],
  ])("reads %s", (_label, header, hops, client) => {
    expect(forwardedClient(header, hops)).toBe(client);
  });

  it.each([
    ["no header", undefined, 1],
    ["fewer entries than trusted proxies", "203.0.113.5", 2],
    ["an entry that is not an IP address", "1.2.3.4, unknown", 1],
    ["an address with a port", "1.2.3.4, 203.0.113.5:4711", 1],
  ])("reads no address from %s", (_label, header, hops) => {
    expect(forwardedClient(header, hops)).toBeUndefined();
  });
});

describe("createRelayer behind a proxy", () => {
  it("rate-limits by the address the proxy appended, whatever the client puts in front of it", async () => {
    const config = loadConfig({
      NETWORK: "sandbox",
      NEAR_RPC_URL: "http://127.0.0.1:1",
      RELAYER_ACCOUNT_ID: "relayer.test.near",
      RELAYER_PRIVATE_KEY: KeyPair.fromRandom("ed25519").toString(),
      FAIRGROUND_CONTRACT: "fairground.test.near",
      USDC_CONTRACTS: "usdc.test.near",
      CLIENT_IP_HEADER: "x-forwarded-for",
      REQUESTS_PER_IP_PER_HOUR: "3",
    });
    const app = createRelayer(config, { chain: {} as Chain, log: () => {} });
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      const res = await app.request("/relay", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `10.9.${i}.1, 198.51.100.200` },
        body: JSON.stringify({ signed_delegate: "AAAA" }),
      });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([400, 400, 400, 429, 429]);
  });
});
