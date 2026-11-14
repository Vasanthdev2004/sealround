import type { ActionSigner } from "@fairground/relayer-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConfig, type NearNetwork } from "../config";
import { browserSigners } from "../near/signers";
import type { Sale } from "../types";
import { base58Encode } from "../verify/base58";
import {
  chapterFactoryFor, chapterPayoutRegistration, readChapterRegistration, registerChapterPayee, runSandbox, sandboxFor, type ChapterSandbox,
} from "./sandbox";
import { chapterTransactionHash, confirmChapterChange } from "./transaction";
import { canSignChapter, chapterWalletSigner } from "./wallet";

const CURATOR = "creator.testnet";
const FACTORY = "chapters.testnet";
const SALES = "sealround.testnet";
const QUOTE = "usdc.testnet";
const ESCROW = "chapter.chapters.testnet";
const RPC = "http://127.0.0.1:3030";
const sale = {
  id: "lantern", status: "settled", creator: CURATOR, tokenAccount: `lantern.${SALES}`,
  config: { quoteToken: QUOTE, tokenSymbol: "LNTN" },
} as Sale;

function config(network: NearNetwork, fallbacks = "none") {
  return parseConfig({
    NEXT_PUBLIC_NEAR_NETWORK: network, NEXT_PUBLIC_NEAR_RPC_URL: RPC, NEXT_PUBLIC_NEAR_RPC_FALLBACKS: fallbacks,
    NEXT_PUBLIC_FAIRGROUND_CONTRACT: SALES, NEXT_PUBLIC_USDC_CONTRACT: QUOTE,
  });
}

function signerFixture() {
  return { signsDelegates: false, signDelegate: vi.fn(), sendTransaction: vi.fn<ActionSigner["sendTransaction"]>() };
}

afterEach(() => {
  browserSigners.clear();
  vi.useRealTimers();
});

describe("Chapter networks and signers", () => {
  it("resolves the factory for a settled testnet sale and keeps the legacy escrow on loopback sandbox", () => {
    expect(chapterFactoryFor(sale, config("testnet"), FACTORY)).toMatchObject({ network: "testnet", rpcUrls: [RPC] });
    expect(sandboxFor(sale, config("testnet"), ESCROW)).toBeNull();
    expect(sandboxFor(sale, config("sandbox"), ESCROW)?.network).toBe("sandbox");
    expect(chapterFactoryFor(sale, config("mainnet"), FACTORY)).toBeNull();
    expect(chapterFactoryFor(sale, config("sandbox", "https://rpc.example.com"), FACTORY)).toBeNull();
    expect(chapterFactoryFor({ ...sale, status: "open" }, config("testnet"), FACTORY)).toBeNull();
    expect(chapterFactoryFor({ ...sale, tokenAccount: "foreign.testnet" }, config("testnet"), FACTORY)).toBeNull();
  });

  it("rejects registries that return another creator or escrow outside the configured factory", async () => {
    const factory = chapterFactoryFor(sale, config("testnet"), FACTORY)!;
    const entry = { phase: "enabled", curator: CURATOR, contract_id: ESCROW, token_id: sale.tokenAccount,
      quote_token_id: QUOTE, title: "Story", brief: "Continue the winning panel" };
    const view = vi.spyOn(factory.rpc, "view").mockResolvedValueOnce(entry)
      .mockResolvedValueOnce({ ...entry, curator: "another.testnet" })
      .mockResolvedValueOnce({ ...entry, contract_id: "foreign.testnet" });
    await expect(readChapterRegistration(factory, sale)).resolves.toEqual(entry);
    await expect(readChapterRegistration(factory, sale)).rejects.toThrow(/registry/);
    await expect(readChapterRegistration(factory, sale)).rejects.toThrow(/registry/);
    expect(view).toHaveBeenCalledWith(FACTORY, "get_chapters", { sale_id: sale.id });
  });

  it("accepts an ordinary testnet wallet and detects a wallet switch after review", () => {
    const signer = signerFixture();
    const wallet = { mode: "near", network: "testnet", kind: "near", account: CURATOR, signer } as const;
    browserSigners.set(CURATOR, signer);
    expect(chapterWalletSigner(wallet, "testnet", CURATOR)).toBe(signer);
    expect(canSignChapter({ ...wallet, kind: "dev" }, "testnet")).toBe(false);
    expect(canSignChapter({ ...wallet, network: "mainnet" }, "testnet")).toBe(false);
    expect(canSignChapter(wallet, "sandbox")).toBe(false);
    expect(() => chapterWalletSigner(wallet, "testnet", "artist.testnet")).toThrow(/same NEAR testnet wallet/);
    browserSigners.set(CURATOR, signerFixture());
    expect(() => chapterWalletSigner(wallet, "testnet", CURATOR)).toThrow(/same NEAR testnet wallet/);
  });

  it("reads delayed testnet confirmation without signing again", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockRejectedValueOnce(new Error("RPC busy")).mockResolvedValueOnce(null).mockResolvedValueOnce("confirmed");
    const confirmation = confirmChapterChange("testnet", read);
    await vi.runAllTimersAsync();
    await expect(confirmation).resolves.toBe("confirmed");
    expect(read).toHaveBeenCalledTimes(3);
    const decline = new Error("Wallet declined");
    await expect(confirmChapterChange("testnet", async () => null, decline)).rejects.toBe(decline);
  });

  it("retains valid wallet transaction identifiers for payout checks", () => {
    const hash = base58Encode(new Uint8Array(32).fill(42));
    expect(chapterTransactionHash({ transaction: { hash } })).toBe(hash);
    expect(chapterTransactionHash({ transactionHash: hash })).toBe(hash);
    expect(chapterTransactionHash(hash)).toBe(hash);
    expect(chapterTransactionHash("z".repeat(32))).toBeNull();
    expect(chapterTransactionHash({ transactionHash: "-".repeat(44) })).toBeNull();
  });

  it("reviews the payee's exact storage deposit before a bounty or registration can be sent", async () => {
    const artist = "artist.testnet";
    const signer = signerFixture();
    browserSigners.set(artist, signer);
    const view = vi.fn<ChapterSandbox["rpc"]["view"]>()
      .mockResolvedValueOnce(null).mockResolvedValueOnce({ min: "1250" })
      .mockResolvedValueOnce(null).mockResolvedValueOnce({ min: "1300" })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null).mockResolvedValueOnce({ min: "1250" }).mockResolvedValueOnce({ total: "1250" });
    const sandbox: ChapterSandbox = {
      network: "testnet", contract: ESCROW, token: sale.tokenAccount, quote: QUOTE,
      rpc: { view: async <T,>(...args: Parameters<ChapterSandbox["rpc"]["view"]>) => await view(...args) as T,
        headTimeMs: async () => 0 },
    };
    const review = await chapterPayoutRegistration(sandbox, artist);
    expect(review).toEqual({ token: QUOTE, deposit: "1250" });
    await expect(registerChapterPayee(sandbox, review!, artist, () => signer)).rejects.toThrow(/updated token registration/);
    await expect(runSandbox(sandbox, signer, artist, 1, { kind: "bounty" }, () => false)).rejects.toThrow(/Register your wallet/);
    expect(signer.sendTransaction).not.toHaveBeenCalled();
    await registerChapterPayee(sandbox, review!, artist, () => signer);
    expect(signer.sendTransaction).toHaveBeenCalledExactlyOnceWith({
      receiverId: QUOTE, methodName: "storage_deposit", gas: 30_000_000_000_000n, deposit: 1250n,
      args: { account_id: artist, registration_only: true },
    });
  });
});
