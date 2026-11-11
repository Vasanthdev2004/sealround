/**
 * Where the NEAR client gets signers from. In the browser the wallet provider
 * (lib/wallet.tsx) registers the connected account's signer here; in Node
 * (the e2e script) a fixed set of dev signers is passed to the client instead.
 *
 * This file only imports types, so it costs the mock-mode bundle nothing.
 */

import type { ActionSigner } from "@fairground/relayer-client";

/** Gives the client a signer for an account, and says which account is connected. */
export type SignerSource = {
  /** A signer that signs as `accountId`, or null when this source has none. */
  signerFor(accountId: string): ActionSigner | null;
  /** The connected account: who signs a call anyone may push (a claim for another bidder, clear_onchain). */
  activeAccount(): string | null;
};

/** A fixed set of signers, the first being the active one unless `active` names another. */
export function staticSigners(signers: Record<string, ActionSigner>, active?: string): SignerSource {
  const first = active ?? Object.keys(signers)[0] ?? null;
  return {
    signerFor: (accountId) => (Object.hasOwn(signers, accountId) ? signers[accountId] : null),
    activeAccount: () => first,
  };
}

let current: { accountId: string; signer: ActionSigner } | null = null;

/** The signer of the wallet connected in this browser tab. Set by the wallet provider, read by the NEAR client. */
export const browserSigners: SignerSource & {
  set(accountId: string, signer: ActionSigner): void;
  clear(): void;
} = {
  signerFor: (accountId) => (current && current.accountId === accountId ? current.signer : null),
  activeAccount: () => current?.accountId ?? null,
  set(accountId, signer) {
    current = { accountId, signer };
  },
  clear() {
    current = null;
  },
};
