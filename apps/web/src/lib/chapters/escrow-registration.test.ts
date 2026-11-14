import { expect, it, vi } from "vitest";
import type { ActionSigner } from "@fairground/relayer-client";
import { U128_MAX } from "@fairground/clearing";
import type { NearRpc } from "../near/rpc";
import type { Sale } from "../types";
import {
  chapterEscrowRegistration, chapterSetupQuote, enableSandboxChapters, registerChapterEscrow,
  type ChapterFactory, type ChapterSandbox,
} from "./sandbox";

const FACTORY = "chapters.test.near";
const ESCROW = `escrow.${FACTORY}`;
const VOTING = "fairt.fairground.test.near";
const PAYOUT = "usdc.test.near";
const sale = { id: "fairt", creator: "sponsor.test.near", tokenAccount: VOTING, config: { quoteToken: PAYOUT } } as Sale;
const story = { title: "The Fair Test", brief: "Draw the opening scene" };

function fixture() {
  const setup = "30000000000000000000000";
  const minimum: Record<string, string> = { [VOTING]: "1250", [PAYOUT]: "1600" };
  const balances = new Map<string, unknown>();
  const read = vi.fn((...args: Parameters<NearRpc["view"]>) => {
    const [token, method] = args;
    if (token === FACTORY && method === "enable_cost") return setup;
    if (token === FACTORY && method === "get_chapters") return null;
    if (method === "storage_balance_bounds") return { min: minimum[token] };
    if (method === "storage_balance_of") return balances.get(token) ?? null;
    throw new Error(`Unexpected view ${token}.${method}`);
  });
  const rpc: NearRpc = { view: async <T,>(...args: Parameters<NearRpc["view"]>) => read(...args) as T, headTimeMs: async () => 0 };
  const rpcUrl = "http://127.0.0.1:3030";
  const factory: ChapterFactory = { account: FACTORY, network: "sandbox", rpc, rpcUrl, rpcUrls: [rpcUrl] };
  const escrow: ChapterSandbox = { contract: ESCROW, token: VOTING, quote: PAYOUT, rpc, network: "sandbox" };
  const signer = { signsDelegates: false, signDelegate: vi.fn(), sendTransaction: vi.fn<ActionSigner["sendTransaction"]>() };
  const activeSigner = vi.fn(() => signer);
  return { factory, escrow, setup, minimum, balances, signer, activeSigner, read };
}

it("quotes setup and both token deposits before signing and rechecks each reviewed price", async () => {
  const { factory, setup, minimum, activeSigner } = fixture();
  const reviewed = await chapterSetupQuote(factory, sale);
  expect(reviewed).toEqual({ setup, registrations: [{ token: VOTING, deposit: "1250" }, { token: PAYOUT, deposit: "1600" }] });
  minimum[PAYOUT] = "3200";
  await expect(enableSandboxChapters(factory, sale, story, reviewed, activeSigner)).rejects.toThrow(/deposits changed/);
  expect(activeSigner).not.toHaveBeenCalled();
});

it("refuses malformed and out-of-range FT storage amounts", async () => {
  const { factory, escrow, minimum, balances } = fixture();
  minimum[VOTING] = (U128_MAX + 1n).toString();
  await expect(chapterSetupQuote(factory, sale)).rejects.toThrow(VOTING);
  balances.set(VOTING, { total: "1250", available: "1251" });
  await expect(chapterEscrowRegistration(escrow)).rejects.toThrow(VOTING);
});

it("pays token contracts directly and retries just the missing registration after a partial failure", async () => {
  const { escrow, balances, signer, activeSigner } = fixture();
  const [voting, payout] = await chapterEscrowRegistration(escrow);
  signer.sendTransaction.mockImplementationOnce(async () => { balances.set(VOTING, { total: "1250", available: "0" }); });
  await registerChapterEscrow(escrow, voting, activeSigner);
  signer.sendTransaction.mockRejectedValueOnce(new Error("Wallet declined the registration"));
  await expect(registerChapterEscrow(escrow, payout, activeSigner)).rejects.toThrow("Wallet declined the registration");
  expect(await chapterEscrowRegistration(escrow)).toEqual([payout]);
  await registerChapterEscrow(escrow, voting, activeSigner);
  expect(signer.sendTransaction).toHaveBeenCalledTimes(2);
  signer.sendTransaction.mockImplementationOnce(async () => { balances.set(PAYOUT, { total: "1600", available: "0" }); });
  await registerChapterEscrow(escrow, payout, activeSigner);
  expect(signer.sendTransaction.mock.calls.map(([action]) => action)).toEqual([voting, payout, payout].map(({ token, deposit }) => ({
    receiverId: token, methodName: "storage_deposit", args: { account_id: ESCROW, registration_only: true },
    deposit: BigInt(deposit), gas: 30_000_000_000_000n,
  })));
  expect(await chapterEscrowRegistration(escrow)).toEqual([]);
});
