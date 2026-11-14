import { icsFold, icsText, icsTime } from "@/components/sale/ics";
import { validSaleId } from "../client/rules";
import { appConfig, devSignerAllowed, type NearConfig } from "../config";
import type { ChapterRound, ChapterSeries, ChapterState } from "./model";

const VOTE_INDEX = "sealround:chapter-vote-index:v1:";

export function chapterReminderNetwork(near: Pick<NearConfig, "network" | "rpcUrl">) {
  return near.network === "testnet" ? "testnet" : devSignerAllowed(near) ? "sandbox" : null;
}

function voteIndexPrefix(rpcUrl: string, account: string) {
  const app = appConfig();
  if (app.mode !== "near" || app.near.rpcUrl !== rpcUrl) return null;
  const network = chapterReminderNetwork(app.near);
  if (!network) return null;
  return `${VOTE_INDEX}${JSON.stringify([app.near.contractId, network === "testnet" ? network : rpcUrl, account])}:`;
}

/** A browser bookmark for finding this holder's on-chain vote again from Activity. */
export function rememberChapterVote(rpcUrl: string, account: string, saleId: string) {
  const prefix = voteIndexPrefix(rpcUrl, account);
  if (!prefix || !validSaleId(saleId)) return;
  try {
    localStorage.setItem(prefix + saleId, "1");
  } catch {
    // This bookmark has no effect on whether a vote confirms on-chain.
  }
}

export function rememberedChapterSales(rpcUrl: string, account: string): string[] {
  const prefix = voteIndexPrefix(rpcUrl, account);
  if (!prefix) return [];
  try {
    const ids = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      const saleId = key?.startsWith(prefix) ? key.slice(prefix.length) : "";
      if (validSaleId(saleId)) ids.push(saleId);
    }
    return ids;
  } catch {
    return [];
  }
}

export function pendingChapterReveals(state: ChapterState): ChapterRound[] {
  return state.rounds.filter((round) => {
    const vote = state.votes[round.round_id];
    return !!vote && vote.revealed_choice === null && (round.phase === "commit" || round.phase === "reveal");
  });
}

export function chapterLink(id: number, saleId = "lantern") {
  return `/token/${encodeURIComponent(saleId)}?chapter=${id}#meme-chapters`;
}

export function chapterRevealCalendar(
  round: ChapterRound, origin: string, contract: string, now: number,
  series: Pick<ChapterSeries, "saleId" | "tokenName"> = { saleId: "lantern", tokenName: "Lantern" },
): string | null {
  const open = Number(BigInt(round.commit_end) / 1_000_000n);
  const close = Number(BigInt(round.reveal_end) / 1_000_000n);
  const start = Math.max(open, now);
  if (open <= 0 || close <= start) return null;
  const url = new URL(chapterLink(round.round_id, series.saleId), origin);
  const description = `Reveal your ${series.tokenName} vote before ${new Date(close).toISOString()}. Use the browser where you voted or your saved reveal code. ${url.href}`;
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Sealround//Chapter reveal//EN", "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT", `UID:${icsText(`${series.saleId}-${contract}-${round.round_id}-${open}@${url.host}`)}`,
    `DTSTAMP:${icsTime(now)}`, `DTSTART:${icsTime(start)}`, `DTEND:${icsTime(close)}`,
    `SUMMARY:${icsText(`Reveal your ${series.tokenName} vote: ${round.title}`)}`,
    `DESCRIPTION:${icsText(description)}`, `URL:${url.href}`,
    "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:PT0M", `DESCRIPTION:${icsText(`Reveal your ${series.tokenName} vote`)}`, "END:VALARM",
    "END:VEVENT", "END:VCALENDAR", "",
  ].map(icsFold).join("\r\n");
}
