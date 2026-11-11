/**
 * Prepares a running local sandbox (scripts/sandbox.ps1) for `pnpm dev:sandbox`:
 * creates a relayer account, deploys contracts/res/mock_ft.wasm as USDC and
 * contracts/res/fairground.wasm, and writes apps/relayer/.env.sandbox
 * (git-ignored) pointing the relayer at them.
 *
 *   node scripts/dev-chain.ts [rpc-url]     (default http://127.0.0.1:3040)
 *
 * The local Fairground has no OutLayer, so only commit-reveal sales work on it.
 * Anyone can mint the mock USDC: `mint({account_id, amount})` on the USDC account.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, nearToYocto, teraToGas, type KeyPairString } from "near-api-js";

const rpcUrl = process.argv[2] ?? "http://127.0.0.1:3040";
const appDir = new URL("../", import.meta.url);
const res = new URL("../../../contracts/res/", import.meta.url);
const provider = new JsonRpcProvider({ url: rpcUrl });
const validator = JSON.parse(readFileSync(new URL(".sandbox-home/validator_key.json", appDir), "utf8")) as {
  account_id: string;
  secret_key?: string;
  private_key?: string;
};
const root = new Account(validator.account_id, provider, (validator.secret_key ?? validator.private_key) as KeyPairString);
const suffix = Date.now().toString(36); // so the script can run again on the same chain

async function create(name: string, near: number) {
  const key = KeyPair.fromRandom("ed25519");
  const id = `${name}-${suffix}.${root.accountId}`;
  await root.createAccount({ newAccountId: id, publicKey: key.getPublicKey(), nearToTransfer: nearToYocto(near) });
  return { id, key, account: new Account(id, provider, new KeyPairSigner(key)) };
}

const [relayer, usdc, fairground] = await Promise.all([create("relayer", 50), create("usdc", 10), create("fairground", 30)]);

await usdc.account.deployContract(readFileSync(new URL("mock_ft.wasm", res)));
await usdc.account.callFunction({ contractId: usdc.id, methodName: "new", args: { name: "USD Coin", symbol: "USDC", decimals: 6 } });

const sealerHash = "ab".repeat(32); // a placeholder: TEE sales need OutLayer
await fairground.account.deployContract(readFileSync(new URL("fairground.wasm", res)));
await fairground.account.callFunction({
  contractId: fairground.id,
  methodName: "new",
  args: {
    outlayer: root.accountId,
    sealer_source: { WasmUrl: { url: "https://example.com/sealer.wasm", hash: sealerHash, build_target: "wasm32-wasip1" } },
    sealer_code_hash: sealerHash,
    sealer_secrets: null,
    allowed_quote_tokens: [usdc.id],
  },
  gas: teraToGas(50),
});

const env = {
  NETWORK: "sandbox",
  NEAR_RPC_URL: rpcUrl,
  RELAYER_ACCOUNT_ID: relayer.id,
  RELAYER_PRIVATE_KEY: relayer.key.toString(),
  FAIRGROUND_CONTRACT: fairground.id,
  USDC_CONTRACTS: usdc.id,
  CORS_ORIGINS: "http://localhost:3000",
};
writeFileSync(new URL(".env.sandbox", appDir), `${Object.entries(env).map(([name, value]) => `${name}=${value}`).join("\n")}\n`);
console.log(`relayer ${relayer.id}, USDC ${usdc.id}, Fairground ${fairground.id}; wrote apps/relayer/.env.sandbox`);
