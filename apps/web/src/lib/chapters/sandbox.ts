import type { ActionSigner, FairgroundAction } from "@fairground/relayer-client";
import { summarizeOutcome } from "@fairground/relayer-client";
import { U128_MAX } from "@fairground/clearing";
import { ACCOUNT_ID, devSignerAllowed, type AppConfig } from "../config";
import { createRpc, type NearRpc } from "../near/rpc";
import { browserSigners } from "../near/signers";
import type { Sale } from "../types";
import { decodeArt } from "./art-bytes";
import { MAX_CHAPTER_ROUNDS, nextChapterId, type ChapterConfig, type ChapterRound, type ChapterState, type ChapterStory, type ChapterSubmission, type ChapterVote, type SubmitArtAction, type VoteSecret } from "./model";
import { savePayoutReceipt } from "./payout-receipt";
import { chapterTransactionHash, confirmChapterChange } from "./transaction";
import type { ChapterNetwork } from "./wallet";

export type ChapterSandbox = {
  contract: string; token: string; quote: string; rpc: NearRpc; rpcUrl?: string;
  story?: ChapterStory; curator?: string; quoteSymbol?: string; quoteDecimals?: number;
  network?: ChapterNetwork; rpcUrls?: readonly string[];
};

export type ChapterFactory = { account: string; network: ChapterNetwork; rpc: NearRpc; rpcUrl: string; rpcUrls: readonly string[] };
type ChapterRegistration = ChapterStory & {
  phase: "deploying" | "enabled";
  contract_id: string; curator: string; token_id: string; quote_token_id: string;
};

function settledChapterSale(sale: Sale, app: AppConfig) {
  return app.mode === "near" && sale.status === "settled"
    && sale.tokenAccount === `${sale.id}.${app.near.contractId}` && ACCOUNT_ID.test(sale.tokenAccount);
}

export function chapterFactoryFor(sale: Sale, app: AppConfig, account = process.env.NEXT_PUBLIC_CHAPTERS_FACTORY): ChapterFactory | null {
  if (app.mode !== "near" || !settledChapterSale(sale, app) || !account || account.length > 32 || !ACCOUNT_ID.test(account)
    || account === app.near.contractId || account === sale.tokenAccount || account === sale.config.quoteToken) return null;
  const { network, rpcUrl, rpcUrls = [rpcUrl] } = app.near;
  if (network === "mainnet"
    || (network === "sandbox" && ![rpcUrl, ...rpcUrls].every((url) => devSignerAllowed({ network, rpcUrl: url })))) return null;
  return { account, network, rpc: createRpc(rpcUrls), rpcUrl, rpcUrls };
}

/** Existing Lantern fixtures have a preconfigured escrow. */
export function sandboxFor(sale: Sale, app: AppConfig, contract = process.env.NEXT_PUBLIC_CHAPTERS_CONTRACT): ChapterSandbox | null {
  if (app.mode !== "near" || !devSignerAllowed(app.near) || !settledChapterSale(sale, app) || !contract || !ACCOUNT_ID.test(contract)
    || sale.id !== "lantern" || sale.config.tokenSymbol !== "LNTN"
    || sale.tokenAccount !== `lantern.${app.near.contractId}` || contract === app.near.contractId || contract === sale.tokenAccount) return null;
  return { network: "sandbox", contract, token: sale.tokenAccount, quote: sale.config.quoteToken,
    rpc: createRpc([app.near.rpcUrl]), rpcUrl: app.near.rpcUrl };
}

export async function readChapterRegistration(factory: ChapterFactory, sale: Sale) {
  const result = await factory.rpc.view<ChapterRegistration | null>(factory.account, "get_chapters", { sale_id: sale.id });
  if (result && (result.curator !== sale.creator || result.token_id !== sale.tokenAccount || result.quote_token_id !== sale.config.quoteToken
    || !ACCOUNT_ID.test(result.contract_id) || !result.contract_id.endsWith(`.${factory.account}`)
    || !["deploying", "enabled"].includes(result.phase) || typeof result.title !== "string" || typeof result.brief !== "string")) {
    throw new Error("The Chapters registry returned a different creator, voting token or payout asset.");
  }
  return result;
}

async function registeredSandbox(factory: ChapterFactory, registration: ChapterRegistration): Promise<ChapterSandbox> {
  const { network, rpc, rpcUrl, rpcUrls } = factory;
  const { title, brief, curator, contract_id: contract, token_id: token, quote_token_id: quote } = registration;
  const metadata = await rpc.view<{ symbol: string; decimals: number }>(quote, "ft_metadata");
  if (!Number.isInteger(metadata.decimals) || metadata.decimals < 0 || metadata.decimals > 38 || !metadata.symbol?.trim()) {
    throw new Error("The payout token returned invalid metadata.");
  }
  return { network, rpc, rpcUrl, rpcUrls, contract, token, quote, curator, story: { title, brief }, quoteSymbol: metadata.symbol, quoteDecimals: metadata.decimals };
}

export async function resolveChapterSandbox(sale: Sale, app: AppConfig): Promise<ChapterSandbox | null> {
  const legacy = sandboxFor(sale, app);
  if (legacy) return legacy;
  const factory = chapterFactoryFor(sale, app);
  if (!factory) return null;
  const entry = await readChapterRegistration(factory, sale);
  return entry?.phase === "enabled" ? registeredSandbox(factory, entry) : null;
}

const TGAS = 1_000_000_000_000n;

export type EscrowRegistration = { token: string; deposit: string };
export type ChapterSetupQuote = { setup: string; registrations: [EscrowRegistration, EscrowRegistration] };

function storageAmount(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9]\d{0,38})$/.test(value) && BigInt(value) <= U128_MAX;
}

async function registrationDeposit(rpc: NearRpc, token: string): Promise<EscrowRegistration> {
  const bounds = await rpc.view<{ min?: string } | null>(token, "storage_balance_bounds");
  if (!storageAmount(bounds?.min)) throw new Error(`Could not read a valid storage deposit from ${token}.`);
  return { token, deposit: bounds.min };
}

export async function chapterSetupQuote(factory: ChapterFactory, sale: Sale): Promise<ChapterSetupQuote> {
  const { rpc, account } = factory;
  const [setup, voting, payout] = await Promise.all([
    rpc.view<string>(account, "enable_cost"),
    registrationDeposit(rpc, sale.tokenAccount),
    registrationDeposit(rpc, sale.config.quoteToken),
  ]);
  if (!storageAmount(setup) || setup === "0") throw new Error("The factory returned an invalid setup deposit.");
  return { setup, registrations: [voting, payout] };
}

export async function enableSandboxChapters(
  factory: ChapterFactory, sale: Sale, story: ChapterStory, reviewed: ChapterSetupQuote, activeSigner: () => ActionSigner,
) {
  const entry = await readChapterRegistration(factory, sale);
  if (entry?.phase === "enabled") return registeredSandbox(factory, entry);
  if (entry) throw new Error("The creator’s escrow deployment is still confirming. Read the current status first.");
  const current = await chapterSetupQuote(factory, sale);
  if (reviewed.setup !== current.setup || current.registrations.some(({ token, deposit }, index) =>
    token !== reviewed.registrations[index].token || deposit !== reviewed.registrations[index].deposit)) {
    throw new Error("The setup or token registration deposits changed. Review the story again before signing.");
  }
  const signer = activeSigner();
  let failure: unknown;
  try {
    const result = await signer.sendTransaction({
      receiverId: factory.account, methodName: "enable_chapters", gas: 160n * TGAS,
      deposit: BigInt(current.setup), args: { sale_id: sale.id, ...story },
    });
    const outcome = summarizeOutcome(result, factory.account);
    failure = outcome.failures[0]?.error;
    if (!failure && typeof result === "object" && result && "status" in result && typeof result.status === "object"
      && result.status && "SuccessValue" in result.status && typeof result.status.SuccessValue === "string" && result.status.SuccessValue) {
      const reply = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(result.status.SuccessValue), (byte) => byte.charCodeAt(0)))) as
        { enabled?: boolean; error?: string } | null;
      if (reply?.enabled === false && reply.error) failure = new Error(reply.error);
    }
  } catch (error) { failure = error; }
  const saved = await confirmChapterChange(factory.network, async () => {
    const registration = await readChapterRegistration(factory, sale);
    return registration?.phase === "enabled" ? registration : null;
  }, failure);
  if (saved) return registeredSandbox(factory, saved);
  throw new Error("Chapters setup is awaiting confirmation. Check the current status before signing again.");
}

async function hasStorageRegistration(rpc: NearRpc, token: string, account: string) {
  const balance = await rpc.view<{ total?: string; available?: string } | null>(token, "storage_balance_of", { account_id: account });
  if (balance === null) return false;
  if (!storageAmount(balance?.total) || !storageAmount(balance.available) || BigInt(balance.available) > BigInt(balance.total)) {
    throw new Error(`Could not read a valid storage registration from ${token}.`);
  }
  return true;
}

async function pendingRegistration(rpc: NearRpc, token: string, account: string): Promise<EscrowRegistration | null> {
  return await hasStorageRegistration(rpc, token, account) ? null : registrationDeposit(rpc, token);
}

export async function chapterEscrowRegistration(sandbox: ChapterSandbox): Promise<EscrowRegistration[]> {
  const { rpc, contract } = sandbox;
  const steps = await Promise.all([sandbox.token, sandbox.quote].map((token) => pendingRegistration(rpc, token, contract)));
  return steps.filter((step) => step !== null);
}

export function chapterPayoutRegistration(sandbox: ChapterSandbox, account: string) {
  return pendingRegistration(sandbox.rpc, sandbox.quote, account);
}

export async function registerChapterEscrow(sandbox: ChapterSandbox, step: EscrowRegistration, activeSigner: () => ActionSigner) {
  if (step.token !== sandbox.token && step.token !== sandbox.quote) throw new Error("Choose a token used by this chapter escrow.");
  return registerChapterAccount(sandbox, step, sandbox.contract, activeSigner);
}

export async function registerChapterPayee(sandbox: ChapterSandbox, step: EscrowRegistration, account: string, activeSigner: () => ActionSigner) {
  if (step.token !== sandbox.quote) throw new Error("Choose the chapter’s payout token.");
  return registerChapterAccount(sandbox, step, account, activeSigner);
}

async function registerChapterAccount(sandbox: ChapterSandbox, step: EscrowRegistration, account: string, activeSigner: () => ActionSigner) {
  const { rpc, contract } = sandbox;
  const pending = await pendingRegistration(rpc, step.token, account);
  if (!pending) return;
  if (pending.deposit !== step.deposit) throw new Error("Review the updated token registration deposit before signing.");
  const signer = activeSigner();
  let detail: unknown;
  try {
    const result = await signer.sendTransaction({ receiverId: step.token, methodName: "storage_deposit",
      args: { account_id: account, registration_only: true }, gas: 30n * TGAS, deposit: BigInt(step.deposit) });
    detail = summarizeOutcome(result, contract).failures[0]?.error;
  } catch (error) { detail = error; }
  const result = await confirmChapterChange(sandbox.network ?? "sandbox", async () =>
    (await hasStorageRegistration(rpc, step.token, account)) ? true : null, detail);
  if (!result) throw new Error("Token registration did not confirm. Review the remaining registration before retrying.");
}

export async function readSandbox(sandbox: ChapterSandbox, account: string | null): Promise<ChapterState> {
  const { rpc, contract, token, quote } = sandbox;
  const [config, count, balance] = await Promise.all([
    rpc.view<ChapterConfig>(contract, "get_config"),
    rpc.view<number>(contract, "get_round_count"),
    account ? rpc.view<string>(token, "ft_balance_of", { account_id: account }) : null,
  ]);
  if (config.token_id !== token || config.quote_token_id !== quote || (sandbox.curator && config.curator !== sandbox.curator)) {
    throw new Error("This Chapters contract belongs to a different token or payout asset.");
  }
  if (!Number.isInteger(count) || count < 0 || count > MAX_CHAPTER_ROUNDS) throw new Error("The network returned an invalid chapter count.");
  const state: ChapterState = { config, story: sandbox.story, rounds: [], votes: {}, balance, submissions: {} };
  // Older rounds are still needed for claims and public proofs after a no-winner round.
  for (let start = 1; start <= count; start += 3) {
    const rows = await Promise.all(Array.from({ length: Math.min(3, count - start + 1) }, async (_, index) => {
      const round_id = start + index;
      const [round, vote] = await Promise.all([
        rpc.view<ChapterRound | null>(contract, "get_round", { round_id }),
        account ? rpc.view<ChapterVote | null>(contract, "get_vote", { round_id, account_id: account }) : null,
      ]);
      if (round?.round_id !== round_id) throw new Error("The network did not return the expected chapter.");
      return { round, vote };
    }));
    for (const { round, vote } of rows) {
      state.rounds.push(round);
      state.votes[round.round_id] = vote;
    }
  }
  const next = nextChapterId(state);
  if (next !== null) {
    const [submissions, artists] = await Promise.all([
      rpc.view<ChapterSubmission[]>(contract, "get_submissions", { round_id: next }),
      rpc.view<string[]>(contract, "get_artists", { round_id: next }).catch((error: unknown) => {
        // An older immutable escrow can be viewed using its original submission rules.
        if (error instanceof Error && /method.*not found|methodnotfound/i.test(error.message)) return undefined;
        throw error;
      }),
    ]);
    state.submissions![next] = submissions;
    if (artists) state.artists = { roundId: next, accounts: artists };
  }
  return state;
}

type ChainAction =
  | { kind: "commit"; amount: bigint; commitment: string }
  | { kind: "reveal"; secret: VoteSecret }
  | { kind: "withdraw" | "finalize" | "bounty" };

export function sandboxAction(sandbox: Pick<ChapterSandbox, "contract" | "token">, round_id: number, action: ChainAction): FairgroundAction {
  const { contract, token } = sandbox;
  if (action.kind === "commit") {
    return {
      receiverId: token, methodName: "ft_transfer_call", gas: 100n * TGAS, deposit: 1n,
      args: { receiver_id: contract, amount: action.amount.toString(), msg: JSON.stringify({ kind: "commit", round_id, commitment: action.commitment }) },
    };
  }
  if (action.kind === "reveal") {
    return {
      receiverId: contract, methodName: "reveal", gas: 30n * TGAS, deposit: 0n,
      args: { round_id, candidate_index: action.secret.choice, salt: action.secret.salt },
    };
  }
  const method = action.kind === "withdraw" ? "withdraw_vote" : action.kind === "bounty" ? "claim_bounty" : "finalize";
  const pays = action.kind !== "finalize";
  return { receiverId: contract, methodName: method, gas: (pays ? 100n : 30n) * TGAS, deposit: pays ? 1n : 0n, args: { round_id } };
}

export async function runSandbox(
  sandbox: ChapterSandbox,
  signer: ActionSigner,
  account: string,
  roundId: number,
  action: ChainAction | SubmitArtAction,
  confirmed: (state: ChapterState) => boolean,
) {
  let transaction: FairgroundAction;
  if (action.kind === "submit_art") {
    const { title, mimeType, imageBase64, parentSha256, reviewedDeposit } = action;
    if (action.roundId !== roundId) throw new Error("Choose the chapter again before submitting artwork.");
    const byte_length = decodeArt(imageBase64, mimeType).length;
    const deposit = await sandbox.rpc.view<string>(sandbox.contract, "art_storage_cost", { byte_length });
    if (reviewedDeposit !== undefined && deposit !== reviewedDeposit) throw new Error("Review the updated artwork deposit before signing.");
    transaction = {
      receiverId: sandbox.contract, methodName: "submit_art", gas: 100n * TGAS, deposit: BigInt(deposit),
      args: { round_id: roundId, title, mime_type: mimeType, image_base64: imageBase64, parent_sha256: parentSha256 },
    };
  } else {
    if (action.kind === "commit") {
      const round = await sandbox.rpc.view<ChapterRound | null>(sandbox.contract, "get_round", { round_id: roundId });
      if (!round || round.round_id !== roundId || round.phase !== "commit") throw new Error("Voting is closed for this round.");
      if (round.min_lock && action.amount < BigInt(round.min_lock)) throw new Error("The lock is below the round’s minimum.");
    }
    transaction = sandboxAction(sandbox, roundId, action);
  }
  if (action.kind === "bounty" && sandbox.network === "testnet"
    && !await sandbox.rpc.view<unknown>(sandbox.quote, "storage_balance_of", { account_id: account })) {
    throw new Error(`Register your wallet with ${sandbox.quote} to receive this bounty. Then return here to claim it.`);
  }
  if (browserSigners.signerFor(account) !== signer) throw new Error("Connect the same wallet before confirming.");
  let failure: unknown;
  try {
    const result = await signer.sendTransaction(transaction);
    const outcome = summarizeOutcome(result, sandbox.contract);
    failure = outcome.failures[0]?.error;
    if (action.kind === "bounty" && !failure) savePayoutReceipt(sandbox, roundId, chapterTransactionHash(result, outcome));
  } catch (error) {
    failure = error;
  }
  const fresh = await confirmChapterChange(sandbox.network ?? "sandbox", async () => {
    const state = await readSandbox(sandbox, account);
    return confirmed(state) ? state : null;
  }, failure);
  if (fresh) return fresh;
  throw new Error("The network has not confirmed this action. Refresh the chapter before trying again.");
}
