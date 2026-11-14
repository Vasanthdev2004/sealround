/**
 * Config parsing and the dev-signer guard: plain secret keys from
 * NEXT_PUBLIC_DEV_ACCOUNTS must be unusable anywhere but a local sandbox.
 */
import { KeyPair } from "near-api-js";
import { describe, expect, it } from "vitest";
import { ConfigError, devSignerAllowed, parseConfig, parseDevAccounts, type PublicEnv } from "../config";
import { assertDevSignerAllowed, createDevSigner, devSigners } from "../near/dev-signer";

// A key made for this run; it is an account's key nowhere.
const SECRET = KeyPair.fromRandom("ed25519").toString();
const DEV = `alice.test.near=${SECRET},bob.test.near=${SECRET}`;

const base: PublicEnv = {
  NEXT_PUBLIC_FAIRGROUND_CONTRACT: "fairground.test.near",
  NEXT_PUBLIC_USDC_CONTRACT: "usdc.test.near",
};

function near(env: PublicEnv) {
  const c = parseConfig(env);
  if (c.mode !== "near") throw new Error("expected NEAR mode");
  return c.near;
}

describe("parseConfig", () => {
  it("is mock mode unless the contract is set", () => {
    expect(parseConfig({})).toEqual({ mode: "mock" });
    expect(parseConfig({ NEXT_PUBLIC_FAIRGROUND_CONTRACT: "  " })).toEqual({ mode: "mock" });
    // Nothing else switches it on, not even dev accounts.
    expect(parseConfig({ NEXT_PUBLIC_NEAR_NETWORK: "sandbox", NEXT_PUBLIC_DEV_ACCOUNTS: DEV })).toEqual({ mode: "mock" });
  });

  it("fills testnet defaults", () => {
    const c = near({ NEXT_PUBLIC_FAIRGROUND_CONTRACT: "fairground.testnet" });
    expect(c).toMatchObject({
      network: "testnet",
      rpcUrl: "https://rpc.testnet.fastnear.com",
      contractId: "fairground.testnet",
      usdcContract: "usdc.fakes.testnet",
      relayerUrl: null,
      devAccounts: [],
      expectedCodeHash: null,
      explorerUrl: "https://testnet.nearblocks.io",
    });
  });

  it("reads every variable", () => {
    const c = near({
      ...base,
      NEXT_PUBLIC_NEAR_NETWORK: "sandbox",
      NEXT_PUBLIC_NEAR_RPC_URL: "http://127.0.0.1:3050",
      NEXT_PUBLIC_RELAYER_URL: "http://127.0.0.1:8790",
      NEXT_PUBLIC_DEV_ACCOUNTS: DEV,
      NEXT_PUBLIC_SEALER_CODE_HASH: "F8408A875EC685394D00937CFC320C8B5E8C2A1E8398CFDF34987AA91001D8CB",
    });
    expect(c.network).toBe("sandbox");
    expect(c.rpcUrl).toBe("http://127.0.0.1:3050");
    expect(c.relayerUrl).toBe("http://127.0.0.1:8790");
    expect(c.devAccounts.map((a) => a.accountId)).toEqual(["alice.test.near", "bob.test.near"]);
    expect(c.expectedCodeHash).toBe("f8408a875ec685394d00937cfc320c8b5e8c2a1e8398cfdf34987aa91001d8cb");
    expect(c.explorerUrl).toBeNull();
  });

  it("refuses unusable values and names the variable", () => {
    const bad: [PublicEnv, RegExp][] = [
      [{ NEXT_PUBLIC_FAIRGROUND_CONTRACT: "Not An Account" }, /NEXT_PUBLIC_FAIRGROUND_CONTRACT/],
      [{ ...base, NEXT_PUBLIC_NEAR_NETWORK: "localnet" }, /NEXT_PUBLIC_NEAR_NETWORK/],
      [{ ...base, NEXT_PUBLIC_NEAR_RPC_URL: "ftp://rpc" }, /NEXT_PUBLIC_NEAR_RPC_URL/],
      [{ NEXT_PUBLIC_FAIRGROUND_CONTRACT: "f.test.near", NEXT_PUBLIC_NEAR_NETWORK: "sandbox" }, /NEXT_PUBLIC_USDC_CONTRACT/],
      [{ ...base, NEXT_PUBLIC_RELAYER_URL: "relayer.example" }, /NEXT_PUBLIC_RELAYER_URL/],
      [{ ...base, NEXT_PUBLIC_SEALER_CODE_HASH: "abc" }, /NEXT_PUBLIC_SEALER_CODE_HASH/],
      [{ ...base, NEXT_PUBLIC_DEV_ACCOUNTS: "alice.test.near" }, /NEXT_PUBLIC_DEV_ACCOUNTS/],
    ];
    for (const [env, pattern] of bad) {
      expect(() => parseConfig(env)).toThrow(ConfigError);
      expect(() => parseConfig(env)).toThrow(pattern);
    }
  });
});

describe("dev accounts", () => {
  it("parses entries separated by commas, semicolons or whitespace", () => {
    expect(parseDevAccounts(undefined)).toEqual([]);
    expect(parseDevAccounts("  ")).toEqual([]);
    const three = parseDevAccounts(`a.test.near=${SECRET}; b.test.near=${SECRET}\n c.test.near=${SECRET}`);
    expect(three.map((a) => a.accountId)).toEqual(["a.test.near", "b.test.near", "c.test.near"]);
    expect(three[0].secretKey).toBe(SECRET);
  });

  it("never echoes a key in an error", () => {
    const body = SECRET.slice("ed25519:".length);
    for (const raw of [
      `=${SECRET}`,
      `UPPER.near=${SECRET}`,
      `a.test.near=${SECRET},a.test.near=${SECRET}`,
      `a.test.near=ed25519:short`,
      `a.test.near=${body}`,
    ]) {
      let text = "";
      try {
        parseDevAccounts(raw);
      } catch (e) {
        text = e instanceof Error ? e.message : String(e);
      }
      expect(text).toMatch(/NEXT_PUBLIC_DEV_ACCOUNTS/);
      expect(text).not.toContain(body.slice(0, 24));
    }
  });

  it("are allowed only on a sandbox whose RPC is on this machine", () => {
    const allowed: [string, string][] = [
      ["sandbox", "http://127.0.0.1:3030"],
      ["sandbox", "http://localhost:3050/"],
      ["sandbox", "https://localhost"],
    ];
    const refused: [string, string][] = [
      ["testnet", "http://127.0.0.1:3030"],
      ["mainnet", "http://localhost:3030"],
      ["testnet", "https://rpc.testnet.near.org"],
      ["mainnet", "https://rpc.mainnet.near.org"],
      ["sandbox", "https://rpc.testnet.near.org"],
      ["sandbox", "http://127.0.0.1.evil.example:3030"],
      ["sandbox", "http://localhost.evil.example"],
      ["sandbox", "http://evil.example/?localhost"],
      ["sandbox", "http://localhost@evil.example:3030/127.0.0.1"],
      ["sandbox", "http://192.168.1.10:3030"],
      ["sandbox", "not a url"],
      ["sandbox", "file:///localhost"],
      ["Sandbox", "http://127.0.0.1:3030"],
      ["", "http://127.0.0.1:3030"],
    ];
    for (const [network, rpcUrl] of allowed) expect(devSignerAllowed({ network, rpcUrl }), rpcUrl).toBe(true);
    for (const [network, rpcUrl] of refused) {
      expect(devSignerAllowed({ network, rpcUrl }), `${network} ${rpcUrl}`).toBe(false);
    }
  });

  it("are dropped from the config on testnet, mainnet and a remote sandbox", () => {
    const withDev = (env: PublicEnv) => near({ ...base, NEXT_PUBLIC_DEV_ACCOUNTS: DEV, ...env }).devAccounts;
    expect(withDev({ NEXT_PUBLIC_NEAR_NETWORK: "testnet" })).toEqual([]);
    expect(withDev({ NEXT_PUBLIC_NEAR_NETWORK: "mainnet" })).toEqual([]);
    expect(withDev({ NEXT_PUBLIC_NEAR_NETWORK: "testnet", NEXT_PUBLIC_NEAR_RPC_URL: "http://127.0.0.1:3030" })).toEqual([]);
    expect(withDev({ NEXT_PUBLIC_NEAR_NETWORK: "sandbox", NEXT_PUBLIC_NEAR_RPC_URL: "https://sandbox.example" })).toEqual([]);
    expect(withDev({ NEXT_PUBLIC_NEAR_NETWORK: "sandbox" })).toHaveLength(2); // default RPC 127.0.0.1:3030
  });
});

describe("dev signer guard", () => {
  const account = { accountId: "alice.test.near", secretKey: SECRET };
  const refused = [
    { network: "testnet", rpcUrl: "https://rpc.testnet.near.org" },
    { network: "mainnet", rpcUrl: "https://rpc.mainnet.near.org" },
    // Even with a local RPC URL: the network name alone must stop it.
    { network: "testnet", rpcUrl: "http://127.0.0.1:3030" },
    { network: "mainnet", rpcUrl: "http://localhost:3030" },
    { network: "sandbox", rpcUrl: "https://rpc.testnet.near.org" },
  ];

  it("refuses to build a signer for testnet or mainnet, whatever the config holds", () => {
    for (const where of refused) {
      expect(() => assertDevSignerAllowed(where)).toThrow(ConfigError);
      expect(() => createDevSigner(where, account)).toThrow(/dev signers are refused/);
      // A hand-built config that kept its dev accounts is refused too.
      expect(() => devSigners({ ...where, devAccounts: [account] })).toThrow(ConfigError);
      expect(() => devSigners({ ...where, devAccounts: [] })).toThrow(ConfigError);
    }
  });

  it("builds signers on a local sandbox", () => {
    const where = { network: "sandbox", rpcUrl: "http://127.0.0.1:3050" };
    const signer = createDevSigner(where, account);
    expect(signer.signsDelegates).toBe(true);
    const source = devSigners({ ...where, devAccounts: [account, { ...account, accountId: "bob.test.near" }] }, "bob.test.near");
    expect(source.activeAccount()).toBe("bob.test.near");
    expect(source.signerFor("alice.test.near")).not.toBeNull();
    expect(source.signerFor("carol.test.near")).toBeNull();
    expect(devSigners({ ...where, devAccounts: [account] }).activeAccount()).toBe("alice.test.near");
  });
});
