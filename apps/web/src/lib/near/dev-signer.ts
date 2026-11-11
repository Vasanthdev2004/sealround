/**
 * Dev signers: accounts whose full-access secret keys sit in
 * NEXT_PUBLIC_DEV_ACCOUNTS, for a local sandbox chain only (the e2e script
 * and manual testing without a wallet). Such a key is readable by anyone who
 * can load the page, so it must never exist for testnet or mainnet:
 *
 * - parseConfig (config.ts) drops the accounts unless the network is
 *   "sandbox" and the RPC URL is on localhost or 127.0.0.1;
 * - assertDevSignerAllowed below checks the same thing again, on the values
 *   actually used to build the signer, and throws otherwise.
 *
 * near-api-js is imported here and nowhere else in the app, and this module
 * is only reached through import(), so it is not in the mock-mode bundle or
 * in a wallet user's first load.
 */

import { keyPairSigner, type ActionSigner } from "@fairground/relayer-client";
import { JsonRpcProvider, KeyPair, type KeyPairString } from "near-api-js";
import { ConfigError, devSignerAllowed, type DevAccount } from "../config";
import { staticSigners, type SignerSource } from "./signers";

/** What a dev signer is built from: the same fields of NearConfig. */
export type DevSignerConfig = { network: string; rpcUrl: string; devAccounts: readonly DevAccount[] };

/** Throws a ConfigError unless this is a sandbox network on a local RPC URL. */
export function assertDevSignerAllowed(config: { network: string; rpcUrl: string }): void {
  if (!devSignerAllowed(config)) {
    throw new ConfigError(
      `dev signers are refused: they need NEXT_PUBLIC_NEAR_NETWORK=sandbox and an RPC URL on localhost or 127.0.0.1 (got network "${config.network}")`,
    );
  }
}

/** One dev account's signer. Throws on anything but a local sandbox. */
export function createDevSigner(config: { network: string; rpcUrl: string }, account: DevAccount): ActionSigner {
  assertDevSignerAllowed(config);
  return keyPairSigner({
    accountId: account.accountId,
    keyPair: KeyPair.fromString(account.secretKey as KeyPairString),
    provider: new JsonRpcProvider({ url: config.rpcUrl }),
  });
}

/**
 * A signer source over every dev account of the config, for the NEAR client
 * outside the browser: `new NearClient(config, { signers: devSigners(config) })`.
 * `active` names the account that signs calls anyone may push (default: the first).
 */
export function devSigners(config: DevSignerConfig, active?: string): SignerSource {
  assertDevSignerAllowed(config);
  const signers: Record<string, ActionSigner> = {};
  for (const account of config.devAccounts) signers[account.accountId] = createDevSigner(config, account);
  return staticSigners(signers, active);
}
