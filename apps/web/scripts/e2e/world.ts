/**
 * Everything a sandbox end-to-end run stands on: the chain, the accounts, the
 * deployed contracts, the OutLayer stand-in, the relayer process, and the web
 * app's NEAR client built the way the app builds it (from NEXT_PUBLIC_*
 * values, with dev signers).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { baseEncode, teraToGas, type Account } from "near-api-js";
import { NearClient, type NearClientOptions } from "../../src/lib/client/near";
import { parseConfig, type NearConfig, type PublicEnv } from "../../src/lib/config";
import { devSigners } from "../../src/lib/near/dev-signer";
import type { SignerSource } from "../../src/lib/near/signers";
import { Chain, REPO_DIR, startSandbox, type Named } from "./chain";
import { OutlayerWorker, pinnedSealerHash, runnerPath, sha256Hex } from "./outlayer";
import { RELAYER_URL, startRelayer, type RelayerProcess } from "./relayer";

const RES_DIR = path.join(REPO_DIR, "contracts", "res");
export const USDC = 1_000_000n;
/** What every bidder starts with. */
export const START_USDC = 100n * USDC;

/** The people of the run. The bidders' names are equally long on purpose: a copied sealed bid needs it. */
const PEOPLE = ["creator", "alice", "bobby", "carol", "david", "ellen", "grace", "fresh", "frank"] as const;
export type Person = (typeof PEOPLE)[number];
export const BIDDERS = ["alice", "bobby", "carol", "david", "ellen", "grace"] as const satisfies readonly Person[];

export type ClientOptions = {
  /** The relayer URL; null builds a client without a relayer. Default: the run's relayer. */
  relayerUrl?: string | null;
  /** Who signs calls anyone may push when no caller is named. Default: the first dev account. */
  active?: string;
  /** Another signer source than the dev signers. */
  signers?: (config: NearConfig) => SignerSource;
} & Pick<NearClientOptions, "cacheMs" | "waitMs" | "pollMs">;

export type World = {
  chain: Chain;
  root: Account;
  /** The sha256 of enclave/res/fairground_sealer.wasm, pinned in the contract. */
  sealerHash: string;
  wasm: { fairground: string; usdc: string; outlayer: string };
  fairground: Named;
  usdc: Named;
  outlayer: Named;
  operator: Named;
  relayerAccount: Named;
  who: Record<Person, Named>;
  worker: OutlayerWorker;
  relayer: RelayerProcess | null;
  /** The NEXT_PUBLIC_* values an app pointed at this run would be built with. */
  publicEnv(overrides?: Partial<PublicEnv>): PublicEnv;
  nearConfig(overrides?: Partial<PublicEnv>): NearConfig;
  /** The web app's NEAR client, built from the public env with dev signers. */
  client(options?: ClientOptions): NearClient;
  startRelayer(label: string, overrides?: Record<string, string>): Promise<RelayerProcess>;
  stopRelayer(): Promise<void>;
};

function wasm(name: string): Uint8Array {
  const file = path.join(RES_DIR, name);
  if (!existsSync(file)) throw new Error(`${file} is missing: build the contracts with scripts\\build-contracts.ps1`);
  return readFileSync(file);
}

/** The on-chain code hash of an account, as view_account reports it (base58 of the sha256). */
export async function codeHashOf(chain: Chain, accountId: string): Promise<string> {
  return (await chain.rpc<{ code_hash: string }>("query", { request_type: "view_account", finality: "optimistic", account_id: accountId })).code_hash;
}

export const base58OfHex = (hex: string) => baseEncode(Buffer.from(hex, "hex"));

export async function buildWorld(runDir: string, say: (line: string) => void): Promise<World> {
  // Fail before any container exists when something the run needs is missing.
  const sealerHash = pinnedSealerHash();
  const runner = runnerPath();
  const code = { fairground: wasm("fairground.wasm"), usdc: wasm("mock_ft.wasm"), outlayer: wasm("outlayer_contract.wasm") };
  say(`fairground.wasm        sha256 ${sha256Hex(code.fairground)} (${code.fairground.length} bytes)`);
  say(`fairground_sealer.wasm sha256 ${sealerHash} (the pinned enclave job)`);

  const { rpcUrl, validator } = await startSandbox();
  const chain = new Chain(rpcUrl);
  const root = chain.root(validator);
  say(`sandbox ready at ${rpcUrl}, root account ${validator.accountId}`);

  // One transaction at a time: they all come from the root account's one key.
  const make = async (name: string, near: number) => chain.createAccount(root, name, near);
  const fairground = await make("fairground", 60);
  const usdc = await make("usdc", 10);
  const outlayer = await make("outlayer", 20);
  const operator = await make("operator", 20);
  const relayerAccount = await make("relayer", 50);
  const who = {} as Record<Person, Named>;
  for (const name of PEOPLE) who[name] = await make(name, name === "creator" ? 40 : 5);

  await outlayer.account.deployContract(code.outlayer);
  await outlayer.account.callFunction({ contractId: outlayer.id, methodName: "new", args: { owner_id: operator.id, operator_id: operator.id } });
  await usdc.account.deployContract(code.usdc);
  await usdc.account.callFunction({ contractId: usdc.id, methodName: "new", args: { name: "USD Coin", symbol: "USDC", decimals: 6 } });
  await fairground.account.deployContract(code.fairground);
  await fairground.account.callFunction({
    contractId: fairground.id,
    methodName: "new",
    args: {
      outlayer: outlayer.id,
      // The URL is never fetched here: the stand-in worker runs the local file with this very hash.
      sealer_source: { WasmUrl: { url: "https://example.com/fairground_sealer.wasm", hash: sealerHash, build_target: "wasm32-wasip1" } },
      sealer_code_hash: sealerHash,
      sealer_secrets: null,
      allowed_quote_tokens: [usdc.id],
    },
    gas: teraToGas(50),
  });
  // Test USDC for the bidders. Not for "fresh" and "frank": they must start unregistered on USDC.
  for (const name of BIDDERS) {
    await root.callFunction({ contractId: usdc.id, methodName: "mint", args: { account_id: who[name].id, amount: START_USDC.toString() }, gas: teraToGas(30) });
  }
  say(`deployed ${fairground.id}, ${usdc.id} (mock USDC), ${outlayer.id} (OutLayer's contract)`);

  const worker = new OutlayerWorker(chain, outlayer.id, operator, fairground.id, runner, path.join(runDir, "outlayer"), sealerHash);
  worker.start();

  const devAccounts = PEOPLE.map((name) => `${who[name].id}=${who[name].secret}`).join(",");
  const publicEnv = (overrides: Partial<PublicEnv> = {}): PublicEnv => ({
    NEXT_PUBLIC_FAIRGROUND_CONTRACT: fairground.id,
    NEXT_PUBLIC_NEAR_NETWORK: "sandbox",
    NEXT_PUBLIC_NEAR_RPC_URL: rpcUrl,
    NEXT_PUBLIC_USDC_CONTRACT: usdc.id,
    NEXT_PUBLIC_RELAYER_URL: RELAYER_URL,
    NEXT_PUBLIC_DEV_ACCOUNTS: devAccounts,
    NEXT_PUBLIC_SEALER_CODE_HASH: sealerHash,
    ...overrides,
  });
  const nearConfig = (overrides: Partial<PublicEnv> = {}): NearConfig => {
    const config = parseConfig(publicEnv(overrides));
    if (config.mode !== "near") throw new Error("the public env does not select NEAR mode");
    return config.near;
  };

  const world: World = {
    chain,
    root,
    sealerHash,
    wasm: { fairground: sha256Hex(code.fairground), usdc: sha256Hex(code.usdc), outlayer: sha256Hex(code.outlayer) },
    fairground,
    usdc,
    outlayer,
    operator,
    relayerAccount,
    who,
    worker,
    relayer: null,
    publicEnv,
    nearConfig,
    client({ relayerUrl, active, signers, cacheMs = 0, waitMs = 30_000, pollMs = 300 }: ClientOptions = {}) {
      const config = nearConfig(relayerUrl === undefined ? {} : { NEXT_PUBLIC_RELAYER_URL: relayerUrl ?? "" });
      return new NearClient(config, { signers: signers ? signers(config) : devSigners(config, active), cacheMs, waitMs, pollMs });
    },
    async startRelayer(label, overrides = {}) {
      if (world.relayer) throw new Error("the relayer is already running");
      world.relayer = await startRelayer(
        {
          NETWORK: "sandbox",
          NEAR_RPC_URL: rpcUrl,
          RELAYER_ACCOUNT_ID: relayerAccount.id,
          RELAYER_PRIVATE_KEY: relayerAccount.secret,
          FAIRGROUND_CONTRACT: fairground.id,
          USDC_CONTRACTS: usdc.id,
          ...overrides,
        },
        runDir,
        label,
      );
      return world.relayer;
    },
    async stopRelayer() {
      const running = world.relayer;
      world.relayer = null;
      await running?.stop();
    },
  };
  return world;
}
