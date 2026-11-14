/**
 * "Get 10 test USDC" on the bid form: when it shows (testnet, a sale paid in
 * usdc.fakes.testnet, bidding not over; never in mock mode or on mainnet),
 * its markup signed out and signed in, and the one transaction it asks the
 * wallet for: `mint` on usdc.fakes.testnet for the connected account, 30
 * TGas, no deposit, after registering the account on the token if needed.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionSigner, FairgroundAction, RelayerClient } from "@fairground/relayer-client";
import { NearClient, TESTNET_TEST_USDC, testUsdcMintAction } from "@/lib/client/near";
import { TOKEN_STORAGE_DEPOSIT } from "@/lib/client/rules";
import type { NearConfig, NearNetwork } from "@/lib/config";
import type { NearRpc } from "@/lib/near/rpc";
import { staticSigners } from "@/lib/near/signers";
import type { Sale, SaleStatus } from "@/lib/types";

/** What useWallet() and getClient() return in each render test. */
const env = vi.hoisted(() => ({
  wallet: { account: null as string | null, mode: "near" as "mock" | "near", network: "testnet" as string | null },
  usdcContract: "usdc.fakes.testnet",
}));

vi.mock("@/lib/wallet", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/wallet")>()),
  useWallet: () => env.wallet,
}));

vi.mock("@/lib/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/client")>()),
  getClient: () => ({ usdcContract: env.usdcContract }),
}));

const { GetTestUsdc, offersTestUsdc, TEST_USDC_AMOUNT, TEST_USDC_TOKEN } = await import("../get-test-usdc");

const TGAS = 1_000_000_000_000n;
const CIRCLE_TESTNET_USDC = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
const JUDGE = "judge-one.testnet";

const sale = (quoteToken: string, status: SaleStatus = "open") =>
  ({ id: "jury-11141430", status, config: { quoteToken } }) as unknown as Sale;

const render = (s: Sale) => renderToStaticMarkup(createElement(GetTestUsdc, { sale: s }));

beforeEach(() => {
  env.wallet = { account: null, mode: "near", network: "testnet" };
  env.usdcContract = TEST_USDC_TOKEN;
});

describe("offersTestUsdc", () => {
  const base = {
    mode: "near" as const,
    network: "testnet" as NearNetwork,
    usdcContract: TEST_USDC_TOKEN,
    quoteToken: TEST_USDC_TOKEN,
    status: "open" as SaleStatus,
  };

  it("offers the mint on testnet for a sale paid in usdc.fakes.testnet, before and during bidding", () => {
    expect(offersTestUsdc(base)).toBe(true);
    expect(offersTestUsdc({ ...base, status: "upcoming" })).toBe(true);
  });

  it("never offers it in mock mode, on mainnet or on a sandbox", () => {
    expect(offersTestUsdc({ ...base, mode: "mock", network: null })).toBe(false);
    expect(offersTestUsdc({ ...base, network: "mainnet" })).toBe(false);
    expect(offersTestUsdc({ ...base, network: "sandbox" })).toBe(false);
  });

  it("never offers it for another quote token, or when the app's USDC is another token", () => {
    expect(offersTestUsdc({ ...base, quoteToken: CIRCLE_TESTNET_USDC })).toBe(false);
    expect(offersTestUsdc({ ...base, usdcContract: CIRCLE_TESTNET_USDC })).toBe(false);
    expect(offersTestUsdc({ ...base, usdcContract: CIRCLE_TESTNET_USDC, quoteToken: CIRCLE_TESTNET_USDC })).toBe(false);
  });

  it("stops once bidding is over", () => {
    for (const status of ["awaiting_close", "clearing", "revealing", "settled", "failed"] as const) {
      expect(offersTestUsdc({ ...base, status })).toBe(false);
    }
  });

  it("names the same token as the NEAR client's faucet, and mints 10 USDC", () => {
    expect(TEST_USDC_TOKEN).toBe(TESTNET_TEST_USDC);
    expect(TEST_USDC_AMOUNT).toBe(10n * 1_000_000n);
  });
});

describe("GetTestUsdc markup", () => {
  it("renders nothing in mock mode", () => {
    env.wallet = { account: "guest-abc123.testnet", mode: "mock", network: null };
    expect(render(sale(TEST_USDC_TOKEN))).toBe("");
  });

  it("renders nothing on mainnet, signed in or out", () => {
    env.wallet = { account: null, mode: "near", network: "mainnet" };
    expect(render(sale(TEST_USDC_TOKEN))).toBe("");
    env.wallet = { account: JUDGE, mode: "near", network: "mainnet" };
    expect(render(sale(TEST_USDC_TOKEN))).toBe("");
  });

  it("renders nothing for a testnet sale paid in another token, or after the close", () => {
    expect(render(sale(CIRCLE_TESTNET_USDC))).toBe("");
    expect(render(sale(TEST_USDC_TOKEN, "awaiting_close"))).toBe("");
  });

  it("shows a disabled button and names testnet wallets while signed out", () => {
    const html = render(sale(TEST_USDC_TOKEN));
    expect(html).toContain("Get 10 test USDC");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>/);
    expect(html).toContain("Connect a testnet wallet first.");
    expect(html).toContain("Meteor Wallet and Intear Wallet");
  });

  it("enables the button for a connected testnet account", () => {
    env.wallet = { account: JUDGE, mode: "near", network: "testnet" };
    const html = render(sale(TEST_USDC_TOKEN));
    expect(html).toContain("Get 10 test USDC");
    expect(html).not.toMatch(/<button[^>]*disabled=""/);
    expect(html).toContain("usdc.fakes.testnet");
  });
});

// ---------- the transaction ----------

const TESTNET: NearConfig = {
  network: "testnet",
  rpcUrl: "https://rpc.testnet.fastnear.com",
  contractId: "sealround.itzbeast.testnet",
  usdcContract: TESTNET_TEST_USDC,
  relayerUrl: null,
  devAccounts: [],
  expectedCodeHash: null,
  explorerUrl: "https://testnet.nearblocks.io",
};

/** usdc.fakes.testnet as far as the faucet reads it, and a wallet whose transactions land on it. */
function testnet(opts: { config?: Partial<NearConfig>; registered?: boolean; relayer?: Partial<RelayerClient> | null } = {}) {
  const config = { ...TESTNET, ...opts.config };
  const token = { registered: new Set<string>(opts.registered ? [JUDGE] : []), usdc: new Map<string, bigint>() };
  const rpc: NearRpc = {
    async view<T>(contract: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
      const account = String(args.account_id);
      if (contract === config.usdcContract && method === "storage_balance_of") {
        return (token.registered.has(account) ? { total: "1250000000000000000000", available: "0" } : null) as T;
      }
      if (contract === config.usdcContract && method === "ft_balance_of") return (token.usdc.get(account) ?? 0n).toString() as T;
      throw new Error(`unexpected view ${contract}.${method}`);
    },
    headTimeMs: async () => Date.now(),
  };
  const sendTransaction = vi.fn(async (action: FairgroundAction): Promise<unknown> => {
    // The real token refuses to mint for an account that is not registered on it.
    if (action.methodName === "storage_deposit") token.registered.add(String(action.args.account_id));
    if (action.methodName === "mint") {
      const who = String(action.args.account_id);
      if (!token.registered.has(who)) throw new Error(`The account ${who} is not registered`);
      token.usdc.set(who, (token.usdc.get(who) ?? 0n) + BigInt(String(action.args.amount)));
    }
    const hash = `TX${sendTransaction.mock.calls.length}`;
    return {
      transaction: { hash },
      transaction_outcome: { id: hash, outcome: { executor_id: JUDGE, status: { SuccessReceiptId: "r1" }, logs: [] } },
      receipts_outcome: [{ id: "r1", outcome: { executor_id: config.usdcContract, status: { SuccessValue: "" }, logs: [] } }],
    };
  });
  const signer: ActionSigner = { signsDelegates: true, signDelegate: vi.fn(), sendTransaction };
  const client = new NearClient(config, {
    rpc,
    relayer: (opts.relayer ?? null) as RelayerClient | null,
    signers: staticSigners({ [JUDGE]: signer }),
    cacheMs: 0,
    waitMs: 200,
    pollMs: 10,
  });
  return { client, sendTransaction, token };
}

const MINT_10: FairgroundAction = {
  receiverId: "usdc.fakes.testnet",
  methodName: "mint",
  args: { account_id: JUDGE, amount: "10000000" },
  gas: 30n * TGAS,
  deposit: 0n,
};

describe("the test USDC mint", () => {
  it("builds mint on usdc.fakes.testnet for the account: 10 USDC, 30 TGas, no deposit", () => {
    expect(testUsdcMintAction(TESTNET_TEST_USDC, JUDGE, TEST_USDC_AMOUNT)).toEqual(MINT_10);
  });

  it("asks the wallet for that mint alone when the account is already registered, then reads the balance", async () => {
    const t = testnet({ registered: true });
    const balances = await t.client.faucet(JUDGE, TEST_USDC_AMOUNT);
    expect(t.sendTransaction).toHaveBeenCalledTimes(1);
    expect(t.sendTransaction.mock.calls[0][0]).toEqual(MINT_10);
    expect(balances).toMatchObject({ account: JUDGE, usdc: 10_000_000n });
  });

  it("registers a new account first, paid by the wallet when there is no relayer", async () => {
    const t = testnet();
    const balances = await t.client.faucet(JUDGE, TEST_USDC_AMOUNT);
    expect(t.sendTransaction.mock.calls.map((c) => c[0])).toEqual([
      {
        receiverId: "usdc.fakes.testnet",
        methodName: "storage_deposit",
        args: { account_id: JUDGE, registration_only: true },
        gas: 30n * TGAS,
        deposit: TOKEN_STORAGE_DEPOSIT,
      },
      MINT_10,
    ]);
    expect(balances.usdc).toBe(10_000_000n);
  });

  it("lets the relayer pay the registration, so the wallet signs only the mint", async () => {
    const registered = new Set<string>();
    const sponsorStorage = vi.fn<RelayerClient["sponsorStorage"]>(async (account) => {
      registered.add(account);
      return { status: "registered", token_id: TESTNET_TEST_USDC, tx_hash: "STORAGETX" };
    });
    const t = testnet({ relayer: { sponsorStorage } });
    // The relayer's registration lands on the same token the wallet mints on.
    t.token.registered = registered;
    await t.client.faucet(JUDGE, TEST_USDC_AMOUNT);
    expect(sponsorStorage).toHaveBeenCalledWith(JUDGE, TESTNET_TEST_USDC);
    expect(t.sendTransaction.mock.calls.map((c) => c[0])).toEqual([MINT_10]);
  });

  it("refuses on mainnet, and on testnet for a token without an open mint, before anything is signed", async () => {
    const mainnet = testnet({ config: { network: "mainnet", usdcContract: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1" } });
    await expect(mainnet.client.faucet(JUDGE, TEST_USDC_AMOUNT)).rejects.toMatchObject({ code: "not_supported" });
    expect(mainnet.sendTransaction).not.toHaveBeenCalled();

    const circle = testnet({ config: { usdcContract: CIRCLE_TESTNET_USDC } });
    await expect(circle.client.faucet(JUDGE, TEST_USDC_AMOUNT)).rejects.toMatchObject({
      code: "not_supported",
      message: expect.stringContaining("usdc.fakes.testnet"),
    });
    expect(circle.sendTransaction).not.toHaveBeenCalled();
  });
});
