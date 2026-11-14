import { U128_MAX } from "@fairground/clearing";
import { validSaleId } from "../client/rules";
import { sha256Hex } from "../crypto";
import { decodeArt, isArtMime, MAX_ART_SUBMISSIONS } from "./art-bytes";
import type { ChapterTerms } from "./creator";
import {
  bountyRecipient,
  isLanternPilot,
  latestChapterWinner,
  LANTERN_STORY,
  MAX_CHAPTER_ROUNDS,
  minimumChapterLock,
  nextChapterId,
  validateChapterStory,
  voteCommitment,
  type ChapterOutcome,
  type ChapterRound,
  type ChapterSeries,
  type ChapterState,
  type ChapterStory,
  type ChapterSubmission,
  type ChapterVote,
  type Choice,
  type SubmitArtAction,
  type VoteSecret,
} from "./model";
import type { ChapterPayout, ChapterPublicVote } from "./verification";

export const DEMO_CONTRACT = "chapters.lantern.demo";
export const DEMO_QUOTE_TOKEN = "usdc.demo";
const LEGACY_SPONSOR = "lantern-labs.testnet";
const STORAGE_KEY = "sealround:chapters:lantern:v1";
const TOKEN_KEY_PREFIX = "sealround:chapters:token:v1:";
const DEMO_CHANGE = "sealround:chapters:change";
const DEMO_QUOTE_BALANCE = 100_000_000n;
const DEMO_ACCOUNT = /^guest-[a-z0-9]+\.testnet$/;
const PHASES = ["funding", "commit", "reveal", "awaiting_finalization", "finalized"] as const;
const SEED_CREATORS = new Map([
  ["fairt", "fairground.testnet"], ["thistle", "meadow.testnet"], ["driftwood", "shoreline.testnet"],
  ["kiln", "kilnworks.testnet"], ["ashfall", "kilnworks.testnet"], ["moth", "nightshift.testnet"],
]);

type DemoRound = { terms: ChapterTerms; phase: (typeof PHASES)[number]; votes: Record<string, ChapterVote>; bountyPaid: boolean };
type DemoSubmission = { submission: ChapterSubmission; imageBase64: string };
type DemoPurchase = { amount: string; spent: string };
export type DemoState = { curator: string | null; story?: ChapterStory; rounds: DemoRound[]; uploads: DemoSubmission[];
  purchases?: Record<string, DemoPurchase> };

export type DemoAction =
  | ({ kind: "enable"; account: string } & ChapterStory)
  | { kind: "buy_demo"; account: string; amount: bigint; cost: bigint }
  | { kind: "create"; terms: ChapterTerms; account?: string }
  | (SubmitArtAction & { account: string })
  | { kind: "fund"; round: number; account: string }
  | { kind: "commit"; round: number; account: string; amount: bigint; commitment: string }
  | { kind: "reveal"; round: number; account: string; secret: VoteSecret }
  | { kind: "withdraw"; round: number; account: string }
  | { kind: "end_commit"; round: number }
  | { kind: "end_reveal"; round: number }
  | { kind: "finalize" | "bounty"; round: number };

export const emptyDemo = (): DemoState => ({ curator: null, rounds: [], uploads: [] });

export function demoChapterContract(series?: ChapterSeries): string {
  return !series || isLanternPilot(series) ? DEMO_CONTRACT : `chapters.${series.token}.demo`;
}

export function demoChapterQuote(series?: ChapterSeries): string {
  return !series || isLanternPilot(series) ? DEMO_QUOTE_TOKEN : series.quote;
}

function storageKey(series?: ChapterSeries) {
  return !series || isLanternPilot(series) ? STORAGE_KEY : `${TOKEN_KEY_PREFIX}${series.saleId}:${series.token}`;
}

function demoVotingBalance(series?: ChapterSeries) {
  return 100n * 10n ** BigInt(series?.decimals ?? 18);
}

function canActInDemo(account: string, series?: ChapterSeries) {
  return DEMO_ACCOUNT.test(account) || account === series?.creator;
}

/** The seed creators are fictional. A connected guest can play their role in their own demo. */
export function canEnableDemoChapters(series: ChapterSeries, account: string | null): boolean {
  if (!account || isLanternPilot(series)) return false;
  if (account === series.creator) return true;
  const seedId = /^fairt-\d+$/.test(series.saleId) ? "fairt" : series.saleId;
  const seedCreator = /^judge-\d+$/.test(seedId) ? "judge.testnet" : SEED_CREATORS.get(seedId);
  return DEMO_ACCOUNT.test(account) && seedCreator === series.creator
    && series.token === `${series.saleId}.fairground.testnet`;
}

function checkedObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function preservedTerms(roundIndex: number): ChapterTerms {
  const { title, candidates } = LANTERN_STORY[roundIndex];
  return {
    title, candidates: [candidates[0], candidates[1]], sponsor: LEGACY_SPONSOR,
    bounty: "10000000", quorum: "5000000000000000000", max_voters: 100,
    starts_at: "0", commit_end: "0", reveal_end: "0",
  };
}

function sameCandidate(value: unknown, candidate: ChapterRound["candidates"][number]) {
  return checkedObject(value) && value.title === candidate.title && value.artist === candidate.artist
    && value.content_sha256 === candidate.content_sha256;
}

function checkedTerms(value: unknown, roundIndex: number, uploads: DemoSubmission[], series?: ChapterSeries, storyIndex = roundIndex): ChapterTerms {
  const bundled = isLanternPilot(series) ? LANTERN_STORY[storyIndex]?.candidates : undefined;
  if (!checkedObject(value) || typeof value.title !== "string" || !value.title.trim()
      || new TextEncoder().encode(value.title).length > 96 || typeof value.sponsor !== "string"
      || !canActInDemo(value.sponsor, series) || typeof value.bounty !== "string" || !/^[1-9]\d{0,8}$/.test(value.bounty)
      || BigInt(value.bounty) > DEMO_QUOTE_BALANCE || typeof value.quorum !== "string" || !/^[1-9]\d{0,38}$/.test(value.quorum)
      || BigInt(value.quorum) > U128_MAX || typeof value.max_voters !== "number" || !Number.isInteger(value.max_voters)
      || (value.brief !== undefined && (typeof value.brief !== "string" || new TextEncoder().encode(value.brief).length > 512))
      || value.max_voters < 1 || value.max_voters > 512 || !Array.isArray(value.candidates) || value.candidates.length !== 2) {
    throw new Error("Invalid chapter terms.");
  }
  const entries = uploads.filter(({ submission }) => submission.round_id === roundIndex + 1);
  let candidates: ChapterTerms["candidates"];
  let submission_ids: ChapterTerms["submission_ids"];
  if (value.submission_ids != null) {
    const ids = value.submission_ids;
    if (!Array.isArray(ids) || ids.length !== 2 || ids[0] === ids[1]) throw new Error("Choose two different artist submissions.");
    const first = entries.find(({ submission }) => submission.submission_id === ids[0])?.submission;
    const second = entries.find(({ submission }) => submission.submission_id === ids[1])?.submission;
    if (!first || !second || first.artist === second.artist) throw new Error("Choose submissions by two different artists.");
    candidates = [
      { title: first.title, artist: first.artist, content_sha256: first.content_sha256 },
      { title: second.title, artist: second.artist, content_sha256: second.content_sha256 },
    ];
    submission_ids = [first.submission_id, second.submission_id];
  } else if (!bundled || entries.length) {
    throw new Error("Choose two submitted artworks before creating this chapter.");
  } else {
    candidates = [bundled[0], bundled[1]];
  }
  if (!value.candidates.every((candidate, index) => sameCandidate(candidate, candidates[index]))) {
    throw new Error("The selected candidates do not match the published submissions.");
  }
  return {
    title: value.title.trim(), candidates, sponsor: value.sponsor, ...(submission_ids ? { submission_ids } : {}),
    ...(typeof value.brief === "string" && value.brief.trim() ? { brief: value.brief.trim() } : {}),
    bounty: value.bounty, quorum: value.quorum, max_voters: value.max_voters,
    starts_at: "0", commit_end: "0", reveal_end: "0",
  };
}

function checkedUploads(value: unknown, series?: ChapterSeries): DemoSubmission[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ART_SUBMISSIONS * MAX_CHAPTER_ROUNDS) throw new Error("Invalid demo artwork list");
  const artists = new Set<string>();
  const counts = Array<number>(MAX_CHAPTER_ROUNDS).fill(0);
  return value.map((row: unknown) => {
    if (!checkedObject(row) || !checkedObject(row.submission) || typeof row.imageBase64 !== "string") throw new Error("Invalid demo artwork");
    const { round_id, submission_id, title, artist, mime_type, content_sha256, parent_sha256 } = row.submission;
    if (typeof round_id !== "number" || !Number.isInteger(round_id) || round_id < 1 || round_id > MAX_CHAPTER_ROUNDS
      || submission_id !== ++counts[round_id - 1] || submission_id > MAX_ART_SUBMISSIONS
      || typeof title !== "string" || !title.trim() || new TextEncoder().encode(title).length > 96
      || typeof artist !== "string" || !canActInDemo(artist, series) || !isArtMime(mime_type)
      || typeof content_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(content_sha256)
      || (parent_sha256 !== null && (typeof parent_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(parent_sha256)))) {
      throw new Error("Invalid demo artwork metadata");
    }
    const artistKey = `${round_id}:${artist}`;
    if (artists.has(artistKey)) throw new Error("Duplicate artist submission");
    artists.add(artistKey);
    return { submission: { round_id, submission_id, title, artist, mime_type, content_sha256, parent_sha256: parent_sha256 as string | null }, imageBase64: row.imageBase64 };
  });
}

/** Validate the versioned demo store before using its amounts or indexing a round. */
function parseDemo(raw: string, series?: ChapterSeries): DemoState {
  const saved: unknown = JSON.parse(raw);
  if (!checkedObject(saved) || !Array.isArray(saved.rounds) || saved.rounds.length > MAX_CHAPTER_ROUNDS) {
    throw new Error("Invalid demo rounds");
  }
  const curator = typeof saved.curator === "string" && canActInDemo(saved.curator, series) ? saved.curator : null;
  let story: ChapterStory | undefined;
  if (!isLanternPilot(series) && (saved.story !== undefined || saved.rounds.length > 0 || curator !== null)) {
    if (!series || !canEnableDemoChapters(series, curator) || !checkedObject(saved.story)
      || typeof saved.story.title !== "string" || typeof saved.story.brief !== "string") throw new Error("Invalid demo story");
    story = validateChapterStory(saved.story.title, saved.story.brief);
  }
  const uploads = checkedUploads(saved.uploads, series);
  if (!isLanternPilot(series) && !story && uploads.length) throw new Error("Invalid demo story.");
  let purchases: DemoState["purchases"];
  if (saved.purchases !== undefined) {
    if (!checkedObject(saved.purchases)) throw new Error("Invalid demo purchases.");
    const entries = Object.entries(saved.purchases).map(([account, value]): [string, DemoPurchase] => {
      if (!canActInDemo(account, series) || !checkedObject(value)
        || typeof value.amount !== "string" || !/^[1-9]\d{0,38}$/.test(value.amount) || BigInt(value.amount) > U128_MAX - demoVotingBalance(series)
        || typeof value.spent !== "string" || !/^[1-9]\d{0,38}$/.test(value.spent) || BigInt(value.spent) > U128_MAX) {
        throw new Error("Invalid demo purchase.");
      }
      return [account, { amount: value.amount, spent: value.spent }];
    });
    purchases = Object.fromEntries(entries);
  }
  const initialVotingBalance = demoVotingBalance(series);
  const rounds: DemoRound[] = [];
  let wins = 0;
  for (const [index, row] of saved.rounds.entries()) {
    if (!checkedObject(row) || !PHASES.some((phase) => phase === row.phase) || !checkedObject(row.votes) || typeof row.bountyPaid !== "boolean") {
      throw new Error("Invalid demo round");
    }
    const terms = isLanternPilot(series) && (row.terms === undefined || (checkedObject(row.terms) && row.terms.sponsor === LEGACY_SPONSOR))
      ? preservedTerms(wins) : checkedTerms(row.terms, index, uploads, series, wins);
    const entries = Object.entries(row.votes);
    if (entries.length > terms.max_voters) throw new Error("Too many demo votes");
    const votes = entries.map(([account, vote]): [string, ChapterVote] => {
      if (!canActInDemo(account, series) || !checkedObject(vote) ||
          typeof vote.amount !== "string" || !/^[1-9]\d{0,38}$/.test(vote.amount)
          || BigInt(vote.amount) > initialVotingBalance + BigInt(purchases?.[account]?.amount ?? "0") ||
          typeof vote.commitment !== "string" || !/^[a-f0-9]{64}$/.test(vote.commitment) ||
          (vote.revealed_choice !== null && vote.revealed_choice !== 0 && vote.revealed_choice !== 1) ||
          (vote.withdrawal_state !== "unclaimed" && vote.withdrawal_state !== "paid")) {
        throw new Error("Invalid demo vote");
      }
      return [account, { amount: vote.amount, commitment: vote.commitment, revealed_choice: vote.revealed_choice, withdrawal_state: vote.withdrawal_state }];
    });
    const round = { terms, phase: row.phase as DemoRound["phase"], votes: Object.fromEntries(votes), bountyPaid: row.bountyPaid };
    rounds.push(round);
    if (round.phase === "finalized" && demoWinner(round).winner !== null) wins++;
  }
  return { curator, story, rounds, uploads, purchases };
}

function readDemo(series?: ChapterSeries): DemoState {
  try {
    const raw = localStorage.getItem(storageKey(series));
    return raw === null ? emptyDemo() : parseDemo(raw, series);
  } catch {
    throw new Error("This browser could not read the chapter demo. Check local storage, or reset the demo.");
  }
}

function demoWinner(round: DemoRound) {
  const tally = [0n, 0n];
  let locked = 0n;
  for (const vote of Object.values(round.votes)) {
    locked += BigInt(vote.amount);
    if (vote.revealed_choice !== null) tally[vote.revealed_choice] += BigInt(vote.amount);
  }
  const revealed = tally[0] + tally[1];
  const outcome: ChapterOutcome | null = round.phase !== "finalized" ? null
    : revealed < BigInt(round.terms.quorum) ? "no_quorum" : tally[0] === tally[1] ? "tie" : "winner";
  const winner: Choice | null = outcome === "winner" ? (tally[0] > tally[1] ? 0 : 1) : null;
  return { tally, locked, revealed, outcome, winner };
}

export function demoView(state: DemoState, account: string | null, series?: ChapterSeries): ChapterState {
  const votes: ChapterState["votes"] = {};
  const submissions: NonNullable<ChapterState["submissions"]> = {};
  for (const { submission } of state.uploads) (submissions[submission.round_id] ??= []).push(submission);
  const purchase = account ? state.purchases?.[account] : undefined;
  let balance = demoVotingBalance(series) + BigInt(purchase?.amount ?? "0");
  let quoteBalance = DEMO_QUOTE_BALANCE - BigInt(purchase?.spent ?? "0");
  let parent_sha256: string | null = null;
  const rounds = state.rounds.map((round, index): ChapterRound => {
    const id = index + 1;
    const { tally, locked, revealed, outcome, winner } = demoWinner(round);
    const mine = account ? round.votes[account] : undefined;
    votes[id] = mine ?? null;
    if (mine && mine.withdrawal_state !== "paid") balance -= BigInt(mine.amount);
    const funded = round.phase !== "funding";
    if (funded && account === round.terms.sponsor && !(round.bountyPaid && winner === null)) {
      quoteBalance -= BigInt(round.terms.bounty);
    }
    if (round.bountyPaid && winner !== null && account === round.terms.candidates[winner].artist) quoteBalance += BigInt(round.terms.bounty);
    const parent = parent_sha256;
    if (winner !== null) parent_sha256 = round.terms.candidates[winner].content_sha256;
    return {
      round_id: id,
      ...round.terms,
      parent_sha256: parent,
      phase: round.phase,
      funded,
      committed_count: Object.keys(round.votes).length,
      min_lock: minimumChapterLock(round.terms).toString(),
      locked: locked.toString(),
      revealed: revealed.toString(),
      tallies: [tally[0].toString(), tally[1].toString()],
      outcome,
      winner,
      bounty_state: round.bountyPaid ? "paid" : "unclaimed",
    };
  });
  return {
    rounds, votes, submissions, balance: account ? balance.toString() : null,
    quoteBalance: account ? quoteBalance.toString() : null,
    ...(state.story ? { story: state.story } : {}),
    ...(state.curator ? { config: { curator: state.curator, token_id: series?.token ?? "lantern.demo", quote_token_id: demoChapterQuote(series) } } : {}),
  };
}

export async function applyDemo(state: DemoState, action: DemoAction, series?: ChapterSeries): Promise<DemoState> {
  const next = structuredClone(state);
  const pilot = isLanternPilot(series);
  if (action.kind === "enable") {
    if (next.story) throw new Error("Chapters are already enabled for this token.");
    if (!series || !canEnableDemoChapters(series, action.account)) throw new Error("Only the token creator can enable chapters.");
    next.story = validateChapterStory(action.title, action.brief);
    next.curator = action.account;
    return next;
  }
  if (action.kind === "buy_demo") {
    const { account, amount, cost } = action;
    if (!series || !canActInDemo(account, series) || amount <= 0n || cost <= 0n) throw new Error("Invalid simulated purchase.");
    const prior = next.purchases?.[account];
    const spent = BigInt(prior?.spent ?? "0") + cost;
    const purchased = BigInt(prior?.amount ?? "0") + amount;
    const available = BigInt(demoView(next, account, series).quoteBalance ?? "0");
    if (cost > available || spent > U128_MAX || purchased > U128_MAX - demoVotingBalance(series)) {
      throw new Error("This buy exceeds the simulated wallet balance.");
    }
    next.purchases = { ...next.purchases, [account]: { amount: purchased.toString(), spent: spent.toString() } };
    return next;
  }
  if (!pilot && !next.story) throw new Error("Enable chapters for this token before adding artwork or rounds.");
  if (action.kind === "submit_art") {
    const { roundId, account, title, mimeType, imageBase64, parentSha256 } = action;
    const view = demoView(next, null, series);
    const prior = latestChapterWinner(view.rounds);
    if (roundId !== nextChapterId(view)) throw new Error("Artwork submissions are closed for this chapter.");
    const parent = prior?.winner != null ? prior.candidates[prior.winner].content_sha256 : null;
    if (parentSha256 !== parent) throw new Error("Use the latest winning panel as the reference for this chapter.");
    const existing = next.uploads.filter(({ submission }) => submission.round_id === roundId);
    if (existing.length >= MAX_ART_SUBMISSIONS) throw new Error("All eight artist submission slots are filled.");
    if (existing.some(({ submission }) => submission.artist === account)) throw new Error("This artist has already submitted artwork for the chapter.");
    const name = title.trim();
    if (!canActInDemo(account, series) || !name || new TextEncoder().encode(name).length > 96) throw new Error("Enter a valid artist and artwork title.");
    const bytes = decodeArt(imageBase64, mimeType);
    const digest = await sha256Hex(bytes);
    if (digest === parent) throw new Error("Submit a new panel that continues the first winner.");
    if (existing.some(({ submission }) => submission.content_sha256 === digest)) throw new Error("This artwork has already been submitted to this chapter.");
    next.uploads.push({
      submission: { submission_id: existing.length + 1, round_id: roundId, title: name, artist: account,
        mime_type: mimeType, parent_sha256: parent, content_sha256: digest },
      imageBase64,
    });
    return next;
  }
  if (action.kind === "create") {
    if (next.rounds.length && next.rounds.at(-1)?.phase !== "finalized") throw new Error("Finalize the current chapter first.");
    const view = demoView(next, null, series);
    if (nextChapterId(view) === null) throw new Error("This story has no rounds left.");
    const terms = checkedTerms(action.terms, next.rounds.length, next.uploads, series, latestChapterWinner(view.rounds) ? 1 : 0);
    if (view.rounds.some(({ submission_ids }) => !!submission_ids) && !terms.submission_ids) {
      throw new Error("Choose two signed artist submissions for the next round.");
    }
    const curator = pilot ? action.account ?? terms.sponsor : action.account;
    if (!curator || !canActInDemo(curator, series) || (next.curator && next.curator !== curator)) {
      throw new Error("Only the demo creator can set up another chapter.");
    }
    next.curator = curator;
    next.rounds.push({ terms, phase: "funding", votes: {}, bountyPaid: false });
    return next;
  }
  const round = next.rounds[action.round - 1];
  if (!round) throw new Error("This chapter has not opened.");
  switch (action.kind) {
    case "fund": {
      if (round.phase !== "funding") throw new Error("This chapter is already funded.");
      if (action.account !== round.terms.sponsor) throw new Error("Only the sponsor can fund this chapter.");
      const { quoteBalance } = demoView(next, action.account, series);
      if (BigInt(round.terms.bounty) > BigInt(quoteBalance ?? "0")) throw new Error("The bounty exceeds your demo chapter budget.");
      round.phase = "commit";
      break;
    }
    case "commit": {
      if (round.phase !== "commit") throw new Error("Voting is closed.");
      if (Object.hasOwn(round.votes, action.account)) throw new Error("This wallet already has a sealed vote.");
      if (Object.keys(round.votes).length >= round.terms.max_voters) throw new Error("This chapter is full.");
      const { balance } = demoView(next, action.account, series);
      if (!canActInDemo(action.account, series) || action.amount < minimumChapterLock(round.terms) || action.amount > BigInt(balance ?? "0")) {
        throw new Error("Enter an amount within your demo token balance.");
      }
      round.votes[action.account] = { amount: action.amount.toString(), commitment: action.commitment, revealed_choice: null, withdrawal_state: "unclaimed" };
      break;
    }
    case "end_commit":
      if (round.phase !== "commit") throw new Error("This chapter is past voting.");
      round.phase = "reveal";
      break;
    case "reveal": {
      if (round.phase !== "reveal") throw new Error("This chapter is outside its reveal window.");
      const vote = round.votes[action.account];
      if (!vote || vote.revealed_choice !== null) throw new Error("There is no sealed vote to reveal.");
      const check = await voteCommitment(demoChapterContract(series), action.round, action.account, action.secret);
      if (check !== vote.commitment) throw new Error("This reveal code does not match your sealed vote.");
      vote.revealed_choice = action.secret.choice;
      break;
    }
    case "end_reveal":
      if (round.phase !== "reveal") throw new Error("This chapter is outside its reveal window.");
      round.phase = "awaiting_finalization";
      break;
    case "finalize":
      if (round.phase !== "awaiting_finalization") throw new Error("Wait for the reveal window to end.");
      round.phase = "finalized";
      break;
    case "withdraw": {
      const vote = round.votes[action.account];
      if (round.phase !== "finalized" || !vote || vote.withdrawal_state !== "unclaimed") throw new Error("This wallet has no locked tokens ready to withdraw.");
      vote.withdrawal_state = "paid";
      break;
    }
    case "bounty":
      if (round.phase !== "finalized" || round.bountyPaid) throw new Error("This chapter has no unpaid bounty.");
      round.bountyPaid = true;
      break;
  }
  return next;
}

export function readDemoView(account: string | null, series?: ChapterSeries) {
  return demoView(readDemo(series), account, series);
}

export function readDemoArt(roundId: number, submissionId: number, series?: ChapterSeries): string | null {
  return readDemo(series).uploads.find(({ submission }) => submission.round_id === roundId && submission.submission_id === submissionId)?.imageBase64 ?? null;
}

export function readDemoProof(roundId: number, series?: ChapterSeries): { votes: ChapterPublicVote[]; payout: ChapterPayout | null } {
  const state = readDemo(series);
  const saved = state.rounds[roundId - 1];
  const round = demoView(state, null, series).rounds[roundId - 1];
  if (!saved || !round) throw new Error("This chapter does not exist.");
  const recipient = bountyRecipient(round);
  return {
    votes: Object.entries(saved.votes).map(([account_id, vote]) => ({ account_id, ...vote })),
    payout: recipient ? {
      recipient, token_id: demoChapterQuote(series), amount: round.bounty,
      state: round.bounty_state, paid_at: null, attempt: round.bounty_state === "paid" ? 1 : 0,
    } : null,
  };
}

export async function runDemo(action: DemoAction, series?: ChapterSeries) {
  const key = storageKey(series);
  const update = async () => {
    const next = await applyDemo(readDemo(series), action, series);
    // Storage failure is surfaced before the UI reports a simulated transaction.
    localStorage.setItem(key, JSON.stringify(next));
    window.dispatchEvent(new Event(DEMO_CHANGE));
  };
  if (navigator.locks) await navigator.locks.request(key, update);
  else await update();
}

function chapterStorageKeys() {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(TOKEN_KEY_PREFIX)) keys.push(key);
  }
  return keys;
}

export function listDemoChapterSales(): string[] {
  const ids = chapterStorageKeys().map((key) => key.slice(TOKEN_KEY_PREFIX.length).split(":", 1)[0]);
  return [...new Set(["lantern", ...ids.filter(validSaleId)])];
}

export function hasDemoChapterStory(series: ChapterSeries): boolean {
  try { return readDemo(series).story !== undefined; }
  catch { return false; }
}

export function resetDemo(series?: ChapterSeries) {
  const keys = series ? [storageKey(series)] : [STORAGE_KEY, ...chapterStorageKeys()];
  for (const key of keys) localStorage.removeItem(key);
  window.dispatchEvent(new Event(DEMO_CHANGE));
}

export function subscribeDemo(listener: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === null || event.key.startsWith(TOKEN_KEY_PREFIX)) listener();
  };
  window.addEventListener(DEMO_CHANGE, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(DEMO_CHANGE, listener);
    window.removeEventListener("storage", onStorage);
  };
}

