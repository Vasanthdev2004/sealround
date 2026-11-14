import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseChapterShare } from "../chapters/chapter-share";
import type { ChapterRound, ChapterSubmission } from "../chapters/model";
import type { SaleView } from "../near/views";
import { chapterMetadata, chapterPreview } from "./chapter-image";

const view = vi.hoisted(() => vi.fn());
vi.mock("../near/rpc", () => ({ createRpc: () => ({ view }) }));
vi.mock("../config", async (load) => {
  const config = await load<typeof import("../config")>();
  return { ...config, appConfig: () => config.parseConfig({
    NEXT_PUBLIC_FAIRGROUND_CONTRACT: "sealround.testnet", NEXT_PUBLIC_NEAR_NETWORK: "testnet",
    NEXT_PUBLIC_USDC_CONTRACT: "usdc.testnet",
  }) };
});

const artwork = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAABAAAAAQBPJcTWAAAAI0lEQVR4nGO8vCCagRTAQpJqhlENxAEWItXBwagGYgDJoQQA5gcCDJsebXUAAAAASUVORK5CYII=";
const differentArtwork = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAABAAAAAQBPJcTWAAAAI0lEQVR4nGO0CO9nIAWwkKSaYVQDcYCFSHVwMKqBGEByKAEAy3oBXDGejK4AAAAASUVORK5CYII=";
const hash = (data: string) => createHash("sha256").update(Buffer.from(data, "base64")).digest("hex");
const sale: SaleView = {
  sale_id: "fairt", status: "settled", creator: "publisher.testnet", token: "fairt.sealround.testnet",
  quote_token: "usdc.testnet", token_name: "Fair Test", token_symbol: "FAIRT", decimals: 18,
  icon: null, description: null, website: null, total_supply: "1000", sale_supply: "800", creator_allocation: "200",
  floor_price: "1000", max_price: null, min_raise: "100", bid_start: "1", bid_end: "2", min_deposit: "100",
  max_deposit_per_account: "10000", max_bids: 100, reveal_mode: "Tee", reveal_window: null, reveal_end: null,
  settle_timeout: "10", refund_mode_at: null, unsold_rule: "Burn", sealer_code_hash: "f8408a87", sealer_pubkey: null,
  token_setup: "done", sealer_key_setup: "done", created_at: "1", closed_at: "2", bid_count: 3, total_deposits: "400", bid_set_hash: "",
};
const winner: ChapterSubmission = {
  title: "Harbor at dawn", artist: "mira.testnet", content_sha256: hash(artwork),
  submission_id: 7, round_id: 3, mime_type: "image/png", parent_sha256: "a".repeat(64),
};
const round: ChapterRound = {
  round_id: 3, title: "Second chapter", candidates: [
    { title: "Harbor at night", artist: "sora.testnet", content_sha256: hash(differentArtwork) }, winner,
  ],
  sponsor: sale.creator, bounty: "10000000", quorum: "100", max_voters: 10,
  starts_at: "0", commit_end: "1", reveal_end: "2", phase: "finalized", funded: true,
  committed_count: 3, locked: "1000", revealed: "620", tallies: ["160", "460"],
  outcome: "winner", winner: 1, bounty_state: "paid", submission_ids: [6, 7], parent_sha256: winner.parent_sha256,
};

function setup(result: ChapterRound, artistBytes: string) {
  const registration = { title: "Fair Test story", brief: "Two linked rounds", phase: "enabled", curator: sale.creator,
    contract_id: "fairt.chapters.testnet", token_id: sale.token, quote_token_id: sale.quote_token };
  const results = new Map<string, unknown>([
    ["get_sale", sale], ["get_chapters", registration], ["get_round", result],
    ["get_submissions", [winner]], ["get_art", artistBytes],
  ]);
  view.mockImplementation(async (_, method: string) => {
    if (!results.has(method)) throw Error(`Unexpected read: ${method}`);
    return results.get(method);
  });
}

describe("NEAR chapter share", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_CHAPTERS_FACTORY", "chapters.testnet");
    view.mockReset();
    return () => vi.unstubAllEnvs();
  });

  it("reads final facts, ignores mock query flags and renders only the selected authenticated submission", async () => {
    setup(round, artwork);
    const query = parseChapterShare("fairt", "3", new URLSearchParams("token=Wrong&title=Wrong&weight=1&locked=1"), false)!;
    const card = await chapterPreview(query);
    expect(card?.facts).toMatchObject({ token: "Fair Test", title: "Harbor at dawn", weight: 460n, locked: 1000n });
    expect(view.mock.calls.map(([, method]) => method)).toEqual(["get_sale", "get_chapters", "get_round"]);
    const metadata = chapterMetadata(query, card!);
    expect(metadata.description).toBe("Winning panel with 46% of locked tokens. NEAR testnet.");
    expect(metadata.openGraph?.images).toEqual([expect.objectContaining({ url: "/api/og/chapter?sale=fairt&round=3" })]);
    const image = await card?.loadArt();
    expect(image).toMatch(/^data:image\/png;base64,iVBOR/);
    expect(view).toHaveBeenCalledWith("fairt.chapters.testnet", "get_art", { round_id: 3, submission_id: 7 });
  });

  it("keeps facts available when art differs from the digest and excludes a no-winner result", async () => {
    setup(round, differentArtwork);
    const query = parseChapterShare("fairt", "3", {}, false)!;
    const card = await chapterPreview(query);
    expect(card?.facts.title).toBe("Harbor at dawn");
    await expect(card?.loadArt()).rejects.toThrow("do not match the published SHA-256 digest");
    setup({ ...round, winner: null, outcome: "no_quorum" }, artwork);
    expect(await chapterPreview(query)).toBeNull();
  });
});
