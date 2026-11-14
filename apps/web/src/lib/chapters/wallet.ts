import type { ActionSigner } from "@fairground/relayer-client";
import { browserSigners } from "../near/signers";
import type { WalletState } from "../wallet";

export type ChapterNetwork = "sandbox" | "testnet";
type ChapterWallet = Pick<WalletState, "account" | "kind" | "mode" | "network" | "signer">;

export function canSignChapter(wallet: ChapterWallet, network: ChapterNetwork): boolean {
  return wallet.mode === "near" && wallet.network === network && !!wallet.account && !!wallet.signer
    && wallet.kind === (network === "sandbox" ? "dev" : "near");
}

export function chapterWalletSigner(wallet: ChapterWallet, network: ChapterNetwork, expectedAccount: string): ActionSigner {
  const { account, signer } = wallet;
  if (!canSignChapter(wallet, network) || account !== expectedAccount || !signer || browserSigners.signerFor(expectedAccount) !== signer) {
    throw new Error(`Connect the same ${network === "testnet" ? "NEAR testnet" : "local sandbox"} wallet before confirming.`);
  }
  return signer;
}
