import { formatUnits, parseUnits, U128_MAX } from "@fairground/clearing";
import { randomHex, sha256Hex } from "../crypto";
import type { Sale } from "../types";
import lantern from "../../../public/chapters/lantern.json";

export type Choice = 0 | 1;
export type ChapterPhase = "funding" | "commit" | "reveal" | "awaiting_finalization" | "finalized";
export type ChapterOutcome = "winner" | "tie" | "no_quorum" | "unfunded";
export type PaymentState = "unclaimed" | "pending" | "paid";

export type ChapterSeries = {
  saleId: string;
  token: string;
  symbol: string;
  tokenName: string;
  decimals: number;
  creator: string;
  quote: string;
};
export type ChapterStory = { title: string; brief: string };

export function seriesFor(sale: Pick<Sale, "id" | "creator" | "tokenAccount" | "config">): ChapterSeries {
  return {
    saleId: sale.id, token: sale.tokenAccount, symbol: sale.config.tokenSymbol, tokenName: sale.config.tokenName,
    decimals: sale.config.decimals, creator: sale.creator, quote: sale.config.quoteToken,
  };
}

export function isLanternPilot(series?: ChapterSeries): boolean {
  return !series || (series.saleId === "lantern" && series.symbol === "LNTN");
}

export function validateChapterStory(title: string, brief: string): ChapterStory {
  const trimmed = { title: title.trim(), brief: brief.trim() };
  const encoder = new TextEncoder();
  if (!trimmed.title || encoder.encode(trimmed.title).length > 96) {
    throw new Error("Enter a story title of at most 96 bytes.");
  }
  if (!trimmed.brief || encoder.encode(trimmed.brief).length > 512) {
    throw new Error("Enter a story brief of at most 512 bytes.");
  }
  return trimmed;
}

export type ChapterCandidate = { title: string; content_sha256: string; artist: string };
export type ChapterArtMime = "image/jpeg" | "image/png" | "image/webp";
export type ChapterSubmission = ChapterCandidate & {
  submission_id: number;
  round_id: number;
  mime_type: ChapterArtMime;
  parent_sha256: string | null;
};
export type SubmitArtAction = {
  kind: "submit_art";
  roundId: number;
  title: string;
  mimeType: ChapterArtMime;
  imageBase64: string;
  parentSha256: string | null;
  reviewedDeposit?: string;
};
export type ChapterConfig = { curator: string; token_id: string; quote_token_id: string };
export type ChapterRound = {
  round_id: number;
  title: string;
  brief?: string;
  candidates: [ChapterCandidate, ChapterCandidate];
  sponsor: string;
  bounty: string;
  quorum: string;
  max_voters: number;
  starts_at: string;
  commit_end: string;
  reveal_end: string;
  phase: ChapterPhase;
  funded: boolean;
  committed_count: number;
  locked: string;
  revealed: string;
  tallies: [string, string];
  outcome: ChapterOutcome | null;
  winner: Choice | null;
  bounty_state: PaymentState;
  submission_ids?: [number, number] | null;
  parent_sha256?: string | null;
};

export type ChapterVote = {
  amount: string;
  commitment: string;
  revealed_choice: Choice | null;
  withdrawal_state: PaymentState;
};

export type ChapterState = {
  rounds: ChapterRound[];
  votes: Record<number, ChapterVote | null>;
  balance: string | null;
  config?: ChapterConfig;
  story?: ChapterStory;
  quoteBalance?: string | null;
  submissions?: Record<number, ChapterSubmission[]>;
};

export type VoteSecret = { choice: Choice; salt: string };

type ChapterArt = ChapterCandidate & { image: string; alt: string };
type ChapterScript = { title: string; brief: string; candidates: ChapterArt[] };
export const LANTERN_STORY: readonly ChapterScript[] = lantern.rounds;

export function artistLabel(account: string): string {
  if (account === "mira.test.near" || account === "guest-mira.testnet") return "Mira";
  if (account === "sora.test.near" || account === "guest-sora.testnet") return "Sora";
  return account;
}

export function bountyRecipient(round: ChapterRound): string | null {
  if (!round.funded || round.phase !== "finalized") return null;
  return round.winner !== null ? round.candidates[round.winner].artist : round.sponsor;
}

export function parseLockAmount(text: string, decimals: number): bigint | null {
  if (text.length > 64) return null;
  try {
    const amount = parseUnits(text, decimals);
    return amount > 0n && amount <= U128_MAX ? amount : null;
  } catch {
    return null;
  }
}

export function chapterAmount(value: string, decimals: number, symbol: string) {
  return `${formatUnits(BigInt(value), decimals)} ${symbol}`;
}

export function voteCommitment(contract: string, round: number, account: string, secret: VoteSecret): Promise<string> {
  return sha256Hex(`sealround-chapter-v1|${contract}|${round}|${account}|${secret.choice}|${secret.salt}`);
}

export function newVoteSecret(choice: Choice): VoteSecret {
  return { choice, salt: randomHex(32) };
}

export function parseRecoveryCode(value: string): VoteSecret | null {
  const [choice, salt] = value.trim().split(":");
  if (!/^[01]:[0-9a-f]{64}$/.test(value.trim())) return null;
  return { choice: choice === "0" ? 0 : 1, salt };
}

export function recoveryCode(secret: VoteSecret) {
  return `${secret.choice}:${secret.salt}`;
}

function secretKey(scope: string, round: number, account: string, commitment: string) {
  return `sealround:chapter-vote:v1:${scope}:${round}:${account}:${commitment}`;
}

/** Keep each attempt so a later rejected transaction cannot overwrite a landed vote's secret. */
export function saveVoteSecret(scope: string, round: number, account: string, commitment: string, secret: VoteSecret) {
  try {
    localStorage.setItem(secretKey(scope, round, account, commitment), recoveryCode(secret));
  } catch {
    throw new Error("This browser could not save a reveal code. Enable local storage before locking tokens.");
  }
}

export function readVoteSecret(scope: string, round: number, account: string, commitment: string): VoteSecret | null {
  try {
    return parseRecoveryCode(localStorage.getItem(secretKey(scope, round, account, commitment)) ?? "");
  } catch {
    return null;
  }
}
