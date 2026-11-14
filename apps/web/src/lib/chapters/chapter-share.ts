import { formatUnits, U128_MAX } from "@fairground/clearing";
import { validSaleId } from "../client/rules";
import { LANTERN_STORY, MAX_CHAPTER_ROUNDS, type ChapterRound } from "./model";

export type ChapterShareFacts = {
  token: string;
  title: string;
  weight: bigint;
  locked: bigint;
  digest: string | null;
};

type Search = Record<string, string | string[] | undefined>;

const DIGEST = /^[0-9a-f]{64}$/;

export function chapterRoundId(raw: string) {
  return /^[1-9]\d?$/.test(raw) && Number(raw) <= MAX_CHAPTER_ROUNDS ? Number(raw) : null;
}

function publicText(value: unknown, max: number) {
  if (typeof value !== "string" || new TextEncoder().encode(value).length > max) return "";
  return value.replace(/[\p{Cc}\p{Cf}\p{Extended_Pictographic}]/gu, "").trim();
}

function units(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,38})$/.test(value)) return null;
  const amount = BigInt(value);
  return amount <= U128_MAX ? amount : null;
}

export function winningShare(round: ChapterRound) {
  const { winner } = round;
  if (round.phase !== "finalized" || round.outcome !== "winner" || (winner !== 0 && winner !== 1)) return null;
  const candidate = round.candidates?.[winner];
  const weight = units(round.tallies?.[winner]);
  const other = units(round.tallies?.[1 - winner]);
  const locked = units(round.locked);
  if (!candidate || weight === null || other === null || locked === null || weight <= other || weight + other > locked) return null;
  return { candidate, weight, locked, choice: winner };
}

export const chapterSharePercent = ({ weight, locked }: Pick<ChapterShareFacts, "weight" | "locked">) => {
  // Round to the nearest hundredth of a percent before formatting.
  const scaled = (weight * 10_000n + locked / 2n) / locked;
  if (scaled === 0n) return "<0.01%";
  if (scaled === 10_000n && weight < locked) return ">99.99%";
  return `${formatUnits(scaled, 2)}%`;
};

export function bundledShareImage(id: string, digest: string | null) {
  if (id !== "lantern" || !digest) return null;
  return LANTERN_STORY.flatMap(({ candidates }) => candidates).find((candidate) => candidate.content_sha256 === digest)?.image ?? null;
}

export function chapterShareQuery(facts: ChapterShareFacts | null) {
  const values = new URLSearchParams();
  if (facts) {
    values.set("token", publicText(facts.token, 96));
    values.set("title", publicText(facts.title, 96));
    values.set("weight", facts.weight.toString());
    values.set("locked", facts.locked.toString());
    if (facts.digest) values.set("panel", facts.digest);
  }
  return values;
}

export function chapterSharePath(id: string, round: number, facts: ChapterShareFacts | null) {
  const query = chapterShareQuery(facts).toString();
  return `/token/${encodeURIComponent(id)}/chapters/${round}${query ? `?${query}` : ""}`;
}

export function chapterImagePath(id: string, round: number, facts: ChapterShareFacts | null) {
  return `/api/og/chapter?${new URLSearchParams({ sale: id, round: String(round), ...Object.fromEntries(chapterShareQuery(facts)) })}`;
}

export function parseChapterShare(id: string, rawRound: string, input: URLSearchParams | Search, mock: boolean) {
  const round = chapterRoundId(rawRound);
  if (!validSaleId(id) || round === null) return null;
  if (!mock) return { id, round, facts: null };
  const get = (key: string) => {
    const value = input instanceof URLSearchParams
      ? (input.getAll(key).length === 1 ? input.get(key) : null)
      : input[key];
    return typeof value === "string" ? value : "";
  };
  const token = publicText(get("token"), 96);
  const title = publicText(get("title"), 96);
  const weight = units(get("weight"));
  const locked = units(get("locked"));
  if (!token || !title || weight === null || weight <= 0n || locked === null || locked < weight) return null;
  const panel = get("panel");
  const digest = DIGEST.test(panel) && bundledShareImage(id, panel) ? panel : null;
  return { id, round, facts: { token, title, weight, locked, digest } };
}
