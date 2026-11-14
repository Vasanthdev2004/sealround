import { U128_MAX } from "@fairground/clearing";
import { ACCOUNT_ID } from "../config";
import { ChapterArtMismatch, readChapterArt } from "./art";
import { demoChapterQuote } from "./demo";
import {
  type ChapterOutcome,
  type ChapterRound,
  type ChapterSeries,
  type ChapterVote,
  type Choice,
  type PaymentState,
} from "./model";
import { payoutReceiptResult, verifyPayoutReceipt } from "./payout-receipt";
import type { ChapterSandbox } from "./sandbox";

export type ChapterPublicVote = ChapterVote & { account_id: string };
export type ChapterPayout = { recipient: string; token_id: string; amount: string; state: PaymentState; paid_at: string | null; attempt: number };
export type ChapterPublicEvidence = { votes: ChapterPublicVote[]; payout: ChapterPayout | null };

export type ChapterCheck = {
  status: "passed" | "failed" | "pending" | "unavailable" | "not_applicable";
  message: string;
};

function check(status: ChapterCheck["status"], message: string): ChapterCheck {
  return { status, message };
}

const HASH = /^[a-f0-9]{64}$/;
const MAX_VOTERS = 512;
const PAGE_SIZE = 64;

function amount(value: string): bigint | null {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,38})$/.test(value)) return null;
  const units = BigInt(value);
  return units <= U128_MAX ? units : null;
}

export function chapterSnapshot(round: ChapterRound) {
  return JSON.stringify([round.round_id, round.title, round.phase, round.funded, round.committed_count,
    round.max_voters, round.locked, round.revealed, round.tallies, round.outcome, round.winner,
    round.bounty_state, round.reveal_end, round.bounty, round.quorum, round.sponsor, round.submission_ids, round.parent_sha256, round.brief,
    round.candidates.map((c) => [c.title, c.artist, c.content_sha256])]);
}

/** Public vote rows do not contain openings. Recount only the choices the contract recorded. */
export function recomputeChapterTally(round: ChapterRound, votes: readonly ChapterPublicVote[] | null) {
  if (round.phase !== "finalized") {
    return { check: check("pending", "Final tally checks are available after finalization."), computed: null };
  }
  if (votes === null) return { check: check("unavailable", "The public vote records could not be read."), computed: null };

  const { committed_count: count, max_voters: max } = round;
  const invalid = { check: check("failed", "The vote records do not match the round’s count or contain invalid rows."), computed: null };
  if (!Number.isInteger(count) || count < 0 || count > MAX_VOTERS || !Number.isInteger(max)
      || max < 1 || max > MAX_VOTERS || count > max || votes.length !== count) return invalid;

  const accounts = new Set<string>();
  let locked = 0n;
  const tallies = [0n, 0n];
  for (const vote of votes) {
    if (!vote || typeof vote !== "object") return invalid;
    const weight = amount(vote.amount);
    const choice = vote.revealed_choice;
    if (weight === null || weight === 0n || typeof vote.account_id !== "string"
        || !ACCOUNT_ID.test(vote.account_id) || accounts.has(vote.account_id)
        || !HASH.test(vote.commitment) || (choice !== null && choice !== 0 && choice !== 1)) return invalid;
    accounts.add(vote.account_id);
    locked += weight;
    if (choice !== null) tallies[choice] += weight;
  }
  const quorum = amount(round.quorum);
  if (locked > U128_MAX || quorum === null || quorum === 0n || (!round.funded && count > 0)) return invalid;
  const revealed = tallies[0] + tallies[1];
  const outcome: ChapterOutcome = !round.funded ? "unfunded" : revealed < quorum ? "no_quorum"
    : tallies[0] === tallies[1] ? "tie" : "winner";
  const winner: Choice | null = outcome === "winner" ? (tallies[1] > tallies[0] ? 1 : 0) : null;
  const computed = { locked: locked.toString(), revealed: revealed.toString(), tallies: tallies.map(String), outcome, winner };
  const agrees = round.locked === computed.locked && round.revealed === computed.revealed
    && round.tallies[0] === computed.tallies[0] && round.tallies[1] === computed.tallies[1]
    && round.outcome === outcome && round.winner === winner;
  return {
    check: agrees
      ? check("passed", `Recounted ${votes.length} public vote records. Only revealed locks count toward the tally and quorum.`)
      : check("failed", "The recomputed tally or outcome differs from the round record."),
    computed,
  };
}

export function verifyChapterPayout(
  round: ChapterRound,
  tally: ReturnType<typeof recomputeChapterTally>,
  payout: ChapterPayout | null | undefined,
  quote: string,
  simulated: boolean,
): ChapterCheck {
  if (round.phase !== "finalized") return check("pending", "A payout becomes due after finalization.");
  if (payout === undefined) return check("unavailable", "The payout record could not be read.");
  if (tally.check.status !== "passed" || !tally.computed) {
    return check("unavailable", "Confirm the final tally before checking who is owed the bounty.");
  }
  if (tally.computed.outcome === "unfunded") {
    return payout === null
      ? check("not_applicable", "The sponsor did not fund this round, so no payment is due.")
      : check("failed", "The unfunded round has a payout record.");
  }
  if (payout === null) return check("unavailable", "The funded round’s payout record is missing.");
  const winner = tally.computed.winner;
  const recipient = winner === null ? round.sponsor : round.candidates[winner].artist;
  const bounty = amount(round.bounty);
  if (payout.recipient !== recipient || payout.token_id !== quote || payout.amount !== round.bounty
      || bounty === null || bounty === 0n || payout.state !== round.bounty_state) {
    return check("failed", "The payout record differs from the expected recipient, asset, amount or state.");
  }
  if (!simulated && (!Number.isInteger(payout.attempt) || payout.attempt < 0 || payout.attempt > 0xffff_ffff
    || ((payout.state === "paid" || payout.state === "pending") && payout.attempt === 0))) {
    return check("failed", "The payout record has an invalid attempt number.");
  }
  if (payout.state === "pending" || payout.state === "unclaimed") {
    if (payout.paid_at !== null) return check("failed", "The unpaid record contains a payment timestamp.");
    return check("pending", payout.state === "pending" ? "The transfer is awaiting confirmation." : "The recipient has yet to claim this payment.");
  }
  if (payout.state !== "paid") return check("failed", "The payout record has an unknown state.");
  const paidAt = payout.paid_at === null ? null : amount(payout.paid_at);
  const revealEnd = amount(round.reveal_end);
  if (!(simulated && payout.paid_at === null) && (paidAt === null || revealEnd === null || paidAt === 0n || paidAt < revealEnd || paidAt > 2n ** 64n - 1n)) {
    return check("failed", "The paid record has an invalid confirmation timestamp.");
  }
  return check("passed", simulated ? "The simulated payment matches the expected recipient, asset and amount."
    : "The successful callback recorded the expected recipient, asset and amount.");
}

function hasPublicFields(vote: unknown): vote is ChapterPublicVote {
  if (!vote || typeof vote !== "object") return false;
  const row = vote as Partial<ChapterPublicVote>;
  return typeof row.account_id === "string" && typeof row.amount === "string" && typeof row.commitment === "string"
    && (row.revealed_choice === null || row.revealed_choice === 0 || row.revealed_choice === 1);
}

function publicVotes(votes: ChapterPublicVote[]) {
  // Keep an explicit allowlist in the download. Only the recorded choices and commitments belong here.
  return votes.filter(hasPublicFields).map(({ account_id, amount: weight, commitment, revealed_choice }) => ({
    account_id, amount: weight, commitment, revealed_choice,
  }));
}

async function matchedArtwork(round: ChapterRound, index: Choice, sandbox: ChapterSandbox | null, fetchImpl: typeof fetch, series?: ChapterSeries) {
  const candidate = round.candidates[index];
  const expected = candidate.content_sha256;
  const details = { title: candidate.title, artist: candidate.artist, expected, actual: null as string | null };
  if (!HASH.test(expected)) return { ...details, check: check("failed", "The recorded digest is invalid.") };
  try {
    await readChapterArt(round, index, sandbox, fetchImpl, series);
    return { ...details, actual: expected, check: check("passed", "The file matches the recorded SHA-256 hash.") };
  } catch (problem) {
    if (problem instanceof ChapterArtMismatch) {
      return { ...details, actual: problem.actual, check: check("failed", "The file differs from the recorded SHA-256 hash.") };
    }
    return { ...details, check: check("unavailable", "The artwork bytes could not be read.") };
  }
}

type ReadChapterEvidence = { round: ChapterRound; votes: ChapterPublicVote[] | null; payout: ChapterPayout | null | undefined };

async function readVotes(sandbox: ChapterSandbox, round: ChapterRound) {
  if (round.phase !== "finalized") return null;
  const { committed_count: count, round_id } = round;
  if (!Number.isInteger(count) || count < 0 || count > MAX_VOTERS) return [];
  const votes: ChapterPublicVote[] = [];
  for (let from_index = 0; from_index <= count; from_index += PAGE_SIZE) {
    // Verify the end of the list even when the count lands exactly on a page boundary.
    const limit = Math.min(PAGE_SIZE, count - from_index + 1);
    const page = await sandbox.rpc.view<ChapterPublicVote[]>(sandbox.contract, "get_votes", { round_id, from_index, limit });
    if (!Array.isArray(page) || page.length > limit) return null;
    votes.push(...page);
  }
  return votes;
}

async function readChainEvidence(sandbox: ChapterSandbox, round_id: number): Promise<ReadChapterEvidence> {
  const { rpc, contract } = sandbox;
  const getRound = async () => {
    const round = await rpc.view<ChapterRound | null>(contract, "get_round", { round_id });
    if (!round || round.round_id !== round_id) throw new Error("The Chapters contract did not return this chapter.");
    return round;
  };
  let round = await getRound();
  // A payout may finish while the reads are in flight. Re-read after a phase or payment change.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (round.phase !== "finalized") return { round, votes: null, payout: null };
    const [votes, payout] = await Promise.all([
      readVotes(sandbox, round).catch(() => null),
      rpc.view<ChapterPayout | null>(contract, "get_payout", { round_id }).catch(() => undefined),
    ]);
    const latest = await getRound();
    if (chapterSnapshot(latest) === chapterSnapshot(round)) return { round, votes, payout };
    round = latest;
  }
  throw new Error("The chapter changed while checking it. Run the checks again.");
}

export async function verifyChapter({ round: inputRound, sandbox, series, decimals, readMockEvidence, mockQuoteToken, payoutHash = "", fetchImpl = (...args) => globalThis.fetch(...args) }: {
  round: ChapterRound;
  sandbox: ChapterSandbox | null;
  series?: ChapterSeries;
  decimals: number;
  readMockEvidence?: () => ChapterPublicEvidence | Promise<ChapterPublicEvidence>;
  mockQuoteToken?: string;
  payoutHash?: string;
  fetchImpl?: typeof fetch;
}) {
  const observed: ReadChapterEvidence = sandbox ? await readChainEvidence(sandbox, inputRound.round_id)
    : { round: inputRound, ...(await readMockEvidence?.() ?? { votes: null, payout: undefined }) };
  const { round, votes, payout } = observed;
  const simulated = !sandbox;
  const source: "simulated" | "testnet" | "local-sandbox" = simulated ? "simulated"
    : sandbox.network === "testnet" ? "testnet" : "local-sandbox";
  const quote = sandbox?.quote ?? mockQuoteToken ?? demoChapterQuote(series);
  const tally = recomputeChapterTally(round, votes);
  const payoutCheck = verifyChapterPayout(round, tally, payout, quote, simulated);
  const [artwork, payoutReceipt] = await Promise.all([
    Promise.all(([0, 1] as const).map((index) => matchedArtwork(round, index, sandbox, fetchImpl, series))),
    !sandbox ? payoutReceiptResult("not_applicable", "Simulated payouts have no token transfer receipts.")
      : payoutCheck.status === "passed" && payout
        ? verifyPayoutReceipt(sandbox, round.round_id, payout, payoutHash, fetchImpl)
        : payoutReceiptResult(payoutCheck.status === "not_applicable" ? "not_applicable"
          : payoutCheck.status === "pending" ? "pending" : "unavailable",
        payoutCheck.status === "not_applicable" ? "No payment was due for this chapter."
          : payoutCheck.status === "pending" ? "The receipt check becomes available when the payout is confirmed."
            : "A verified payout record is required to check the receipt."),
  ]);

  return {
    schema: "sealround.chapter-evidence.v2",
    source,
    contract: sandbox?.contract ?? null,
    saleId: series?.saleId ?? "lantern",
    votingToken: sandbox?.token ?? series?.token ?? null,
    tokenSymbol: series?.symbol ?? "LNTN",
    quoteToken: quote,
    tokenDecimals: decimals,
    quoteDecimals: sandbox?.quoteDecimals ?? 6,
    recordedAt: new Date().toISOString(),
    round: {
      id: round.round_id, title: round.title, phase: round.phase, funded: round.funded, sponsor: round.sponsor,
      quorum: round.quorum, bounty: round.bounty, revealEndNs: round.reveal_end, committedCount: round.committed_count,
      locked: round.locked, revealed: round.revealed, tallies: [...round.tallies], outcome: round.outcome, winner: round.winner,
      submissions: round.submission_ids ?? null, parentSha256: round.parent_sha256 ?? null, brief: round.brief ?? null,
    },
    voteRecords: votes === null ? null : publicVotes(votes),
    tally,
    artwork,
    winningHash: round.winner === null ? null : (artwork[round.winner]?.expected ?? null),
    payout: payout ? { recipient: payout.recipient, token_id: payout.token_id, amount: payout.amount, state: payout.state, paid_at: payout.paid_at, attempt: payout.attempt } : null,
    payoutCheck,
    payoutReceipt,
    snapshot: chapterSnapshot(round),
  };
}

export type ChapterVerificationReport = Awaited<ReturnType<typeof verifyChapter>>;
