import { KeyPair, teraToGas } from "near-api-js";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, parseNear } from "../src/config.ts";

const secret = KeyPair.fromRandom("ed25519").toString();
const env = (overrides: Record<string, string | undefined> = {}) => ({
  NETWORK: "testnet",
  NEAR_RPC_URL: "https://rpc.testnet.near.org",
  RELAYER_ACCOUNT_ID: "fairground-relayer.testnet",
  RELAYER_PRIVATE_KEY: secret,
  FAIRGROUND_CONTRACT: "fairground.testnet",
  USDC_CONTRACTS: "usdc.fakes.testnet, 3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af",
  ...overrides,
});

function problemsOf(overrides: Record<string, string | undefined>): string {
  try {
    loadConfig(env(overrides));
  } catch (error) {
    if (error instanceof ConfigError) return error.message;
    throw error;
  }
  throw new Error("expected a ConfigError");
}

describe("loadConfig", () => {
  it("reads a minimal environment with defaults", () => {
    const config = loadConfig(env());
    expect(config.network).toBe("testnet");
    expect(config.policy.usdcContracts).toEqual([
      "usdc.fakes.testnet",
      "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af",
    ]);
    expect(config.policy.maxGas).toBe(teraToGas(150));
    expect(config.policy.maxDelegateBlocks).toBe(1200n);
    expect(config.limits.dailyBudget).toBe(5n * 10n ** 24n);
    expect(config.limits.storageBudget).toBe(5n * 10n ** 23n);
    expect(config.relayerKey.getPublicKey().toString()).toBe(KeyPair.fromString(secret as `ed25519:${string}`).getPublicKey().toString());
    expect(config.corsOrigins).toEqual([]);
    expect(config.clientIpHeader).toBeUndefined();
    expect(config.trustedProxyHops).toBe(1);
    expect(config.relayWaitMs).toBe(15_000);
    expect(config.port).toBe(8787);
  });

  it("allows up to 300 TGas when asked", () => {
    expect(loadConfig(env({ MAX_GAS_TGAS: "300" })).policy.maxGas).toBe(teraToGas(300));
  });

  it("reports every problem at once", () => {
    const message = problemsOf({ NETWORK: "devnet", NEAR_RPC_URL: undefined, FAIRGROUND_CONTRACT: "Not_Valid!", MAX_GAS_TGAS: "301" });
    expect(message).toContain("NETWORK must be one of");
    expect(message).toContain("NEAR_RPC_URL is required");
    expect(message).toContain("FAIRGROUND_CONTRACT is not a valid NEAR account id");
    expect(message).toContain("MAX_GAS_TGAS must be an integer from 1 to 300");
  });

  it("never echoes the private key", () => {
    // "0", "O", "I" and "l" are not base58, so this cannot parse.
    const message = problemsOf({ RELAYER_PRIVATE_KEY: "ed25519:SECRETPART0OIl" });
    expect(message).toContain("RELAYER_PRIVATE_KEY is not a valid ed25519 secret key");
    expect(message).not.toContain("SECRETPART");
    expect(problemsOf({ RELAYER_PRIVATE_KEY: "secp256k1:abc" })).toContain("must be an ed25519");
  });

  it("validates lists and optional settings", () => {
    expect(problemsOf({ USDC_CONTRACTS: " , " })).toContain("USDC_CONTRACTS");
    expect(problemsOf({ CORS_ORIGINS: "https://app.example/path" })).toContain("CORS_ORIGINS");
    expect(problemsOf({ DAILY_BUDGET_NEAR: "-1" })).toContain("DAILY_BUDGET_NEAR");
    expect(problemsOf({ STORAGE_BUDGET_NEAR: "lots" })).toContain("STORAGE_BUDGET_NEAR");
    expect(problemsOf({ TRUSTED_PROXY_HOPS: "0" })).toContain("TRUSTED_PROXY_HOPS");
    expect(
      loadConfig(env({ CORS_ORIGINS: "https://a.example,http://localhost:3000", CLIENT_IP_HEADER: "X-Forwarded-For", TRUSTED_PROXY_HOPS: "2", STORAGE_BUDGET_NEAR: "0" })),
    ).toMatchObject({
      corsOrigins: ["https://a.example", "http://localhost:3000"],
      clientIpHeader: "x-forwarded-for",
      trustedProxyHops: 2,
      limits: { storageBudget: 0n },
    });
  });
});

describe("parseNear", () => {
  it.each([
    ["5", 5n * 10n ** 24n],
    ["0.5", 5n * 10n ** 23n],
    ["0.000000000000000000000001", 1n],
  ])("%s NEAR", (input, yocto) => {
    expect(parseNear(input)).toBe(yocto);
  });

  it.each(["", "1e3", "-1", "1.0000000000000000000000001", "1,5"])("refuses %j", (input) => {
    expect(parseNear(input)).toBeUndefined();
  });
});
