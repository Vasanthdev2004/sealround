/**
 * Which wallets the NEAR Connect picker offers on each network, with the
 * options lib/wallet.tsx gives it. The manifest is the one NEAR Connect
 * loaded from GitHub on 14 Nov 2026 (trimmed to the fields its filters
 * read), run through the real NearConnector, so this pins the list a judge
 * sees on the hosted testnet app.
 */
import { NearConnector, type WalletManifest } from "@hot-labs/near-connect";
import { describe, expect, it } from "vitest";
import manifest from "./fixtures/near-connect/manifest-2026-11-14.json";
import { connectorOptions, noWalletsText, TESTNET_EXCLUDED_WALLETS } from "../wallet";

const RPC = "https://rpc.testnet.fastnear.com";

async function offered(network: "testnet" | "mainnet") {
  const c = new NearConnector({
    ...connectorOptions({ network, rpcUrl: RPC }),
    // A copy each time: NearConnector filters the manifest object it is given in place.
    manifest: structuredClone(manifest) as unknown as { wallets: WalletManifest[]; version: string },
  });
  await c.whenManifestLoaded;
  return { connector: c, names: c.availableWallets.map((w) => w.manifest.name) };
}

describe("wallets per network", () => {
  it("offers on testnet only the wallets that work there", async () => {
    const { names } = await offered("testnet");
    expect(names).toEqual(["Meteor Wallet", "Intear Wallet", "Ledger", "Nightly Wallet", "NEAR CLI"]);
    // No testnet mode in their manifests.
    for (const name of ["HOT Wallet", "MyNearWallet", "OKX Wallet", "NEAR Mobile", "Hana Wallet"]) {
      expect(names).not.toContain(name);
    }
  });

  it("drops Ethereum Wallets on testnet and WalletConnect wallets everywhere (no project id)", async () => {
    expect(TESTNET_EXCLUDED_WALLETS).toEqual(["ethereum-wallets"]);
    const { names } = await offered("testnet");
    expect(names).not.toContain("Ethereum Wallets");
    expect(names).not.toContain("Wallet Connect");
    expect(names).not.toContain("Unity Wallet");
  });

  it("hands the app's RPC to testnet wallets that read it", async () => {
    const { connector } = await offered("testnet");
    expect(connector.network).toBe("testnet");
    expect(connector.providers.testnet).toEqual([RPC]);
  });

  it("leaves mainnet as it was: every manifest wallet but the WalletConnect ones", async () => {
    expect(connectorOptions({ network: "mainnet", rpcUrl: "https://rpc.mainnet.fastnear.com" })).toEqual({ network: "mainnet" });
    const { names } = await offered("mainnet");
    expect(names).toContain("HOT Wallet");
    expect(names).toContain("MyNearWallet");
    expect(names).toContain("Ethereum Wallets");
    expect(names).not.toContain("Wallet Connect");
  });

  it("says what to do when no wallet could be loaded", () => {
    expect(noWalletsText("testnet")).toBe(
      "No NEAR testnet wallet could be loaded. Reload the page and try again. Meteor Wallet and Intear Wallet work on testnet in the browser.",
    );
    expect(noWalletsText("mainnet")).toBe("No NEAR wallet could be loaded. Reload the page and try again.");
  });
});
