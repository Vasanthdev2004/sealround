import { sha256Hex } from "../crypto";
import { decodeArt } from "./art-bytes";
import { readDemoArt, readDemoView } from "./demo";
import { isLanternPilot, LANTERN_STORY, type ChapterRound, type ChapterSeries, type ChapterSubmission, type Choice } from "./model";
import type { ChapterSandbox } from "./sandbox";

export { decodeArt, MAX_ART_BYTES, MAX_ART_SUBMISSIONS } from "./art-bytes";

export class ChapterArtMismatch extends Error {
  constructor(readonly expected: string, readonly actual: string) {
    super("The artwork bytes do not match the published SHA-256 digest.");
  }
}

async function verifyDigest(bytes: Uint8Array, expected: string) {
  const actual = await sha256Hex(bytes);
  if (actual !== expected) throw new ChapterArtMismatch(expected, actual);
}

export async function readSubmittedArt(submission: ChapterSubmission, sandbox: ChapterSandbox | null, series?: ChapterSeries) {
  const { round_id, submission_id, mime_type, content_sha256 } = submission;
  const imageBase64 = sandbox
    ? await sandbox.rpc.view<string | null>(sandbox.contract, "get_art", { round_id, submission_id })
    : readDemoArt(round_id, submission_id, series);
  if (typeof imageBase64 !== "string") throw new Error("The artist's artwork is unavailable.");
  const bytes = decodeArt(imageBase64, mime_type);
  await verifyDigest(bytes, content_sha256);
  return { image: `data:${mime_type};base64,${imageBase64}`, alt: submission.title, bytes };
}

export async function readChapterArt(
  round: Pick<ChapterRound, "round_id" | "candidates" | "submission_ids" | "parent_sha256">,
  index: Choice, sandbox: ChapterSandbox | null, fetchImpl: typeof fetch = globalThis.fetch, series?: ChapterSeries,
) {
  const candidate = round.candidates[index];
  if (round.submission_ids) {
    const submissions = sandbox
      ? await sandbox.rpc.view<ChapterSubmission[]>(sandbox.contract, "get_submissions", { round_id: round.round_id })
      : (readDemoView(null, series).submissions?.[round.round_id] ?? []);
    const submission = submissions.find((item) => item.submission_id === round.submission_ids?.[index]);
    if (!submission || submission.round_id !== round.round_id || submission.content_sha256 !== candidate.content_sha256
      || submission.artist !== candidate.artist || submission.title !== candidate.title
      || submission.parent_sha256 !== (round.parent_sha256 ?? null)) {
      throw new Error("The artist submission does not match the published chapter.");
    }
    return readSubmittedArt(submission, sandbox, series);
  }
  if (!isLanternPilot(series)) throw new Error("This chapter has no published artist submission.");
  const art = LANTERN_STORY[round.round_id - 1]?.candidates.find(({ title, artist }) => title === candidate.title && artist === candidate.artist);
  if (!art) throw new Error("The chapter artwork is unavailable.");
  const response = await fetchImpl(art.image, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("The chapter artwork could not be loaded.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  await verifyDigest(bytes, candidate.content_sha256);
  return { image: art.image, alt: art.alt, bytes };
}
