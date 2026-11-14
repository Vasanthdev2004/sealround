import { readFile } from "node:fs/promises";
import { cache } from "react";
import type { Metadata } from "next";
import sharp from "sharp";
import { readChapterArt } from "../chapters/art";
import {
  bundledShareImage, chapterImagePath, chapterSharePercent, parseChapterShare, winningShare, type ChapterShareFacts,
} from "../chapters/chapter-share";
import { seriesFor, type ChapterRound } from "../chapters/model";
import { chapterFactoryFor, readChapterRegistration, sandboxFor } from "../chapters/sandbox";
import { appConfig } from "../config";
import { sha256Hex } from "../crypto";
import { createRpc } from "../near/rpc";
import { saleFromView, type SaleView } from "../near/views";
import { AppCard, ChapterCardImage, OG_SIZE, renderCardBytes } from "./cards";
import { loadOgFonts } from "./fonts";
import { cardText } from "./sale-card";
import { OG_RPC_TIMEOUT_MS } from "./sale-data";

type ShareQuery = NonNullable<ReturnType<typeof parseChapterShare>>;
type Card = { facts: ChapterShareFacts; source: "Simulated" | "NEAR testnet" | "Local sandbox"; loadArt: () => Promise<string | null> };
const bundledPanels = {
  "/chapters/lantern-1-a.webp": new URL("../../../public/chapters/lantern-1-a.webp", import.meta.url),
  "/chapters/lantern-1-b.webp": new URL("../../../public/chapters/lantern-1-b.webp", import.meta.url),
  "/chapters/lantern-2-a.webp": new URL("../../../public/chapters/lantern-2-a.webp", import.meta.url),
  "/chapters/lantern-2-b.webp": new URL("../../../public/chapters/lantern-2-b.webp", import.meta.url),
};

async function localArtwork(path: string) {
  if (!Object.hasOwn(bundledPanels, path)) throw new Error("Unknown bundled chapter artwork.");
  return readFile(bundledPanels[path as keyof typeof bundledPanels]);
}

async function rasterForCard(bytes: Uint8Array) {
  // The OG renderer needs PNG/JPEG pixels. Convert verified artwork at card size.
  const png = await sharp(bytes, { limitInputPixels: 24_000_000 }).timeout({ seconds: 3 })
    .autoOrient().resize(490, 365).png().toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}

async function bundledArtwork(id: string, digest: string | null) {
  const path = bundledShareImage(id, digest);
  if (!path) return null;
  const bytes = await localArtwork(path);
  return await sha256Hex(bytes) === digest ? rasterForCard(bytes) : null;
}

const readChainCard = cache(async (id: string, roundId: number): Promise<Card | null> => {
  const app = appConfig();
  if (app.mode !== "near" || app.near.network === "mainnet") return null;
  const rpc = createRpc(app.near.rpcUrls ?? app.near.rpcUrl, { timeoutMs: OG_RPC_TIMEOUT_MS, retries: 0 });
  const view = await rpc.view<SaleView | null>(app.near.contractId, "get_sale", { sale_id: id });
  if (!view || view.sale_id !== id || view.status !== "settled") return null;
  const sale = saleFromView(view);
  const legacy = sandboxFor(sale, app);
  const factory = chapterFactoryFor(sale, app);
  let escrow = legacy;
  if (!escrow && factory) {
    const entry = await readChapterRegistration({ ...factory, rpc }, sale);
    if (entry?.phase === "enabled") escrow = { contract: entry.contract_id, token: entry.token_id, quote: entry.quote_token_id, rpc };
  }
  if (!escrow) return null;
  const round = await rpc.view<ChapterRound | null>(escrow.contract, "get_round", { round_id: roundId });
  if (!round || round.round_id !== roundId) return null;
  const winner = winningShare(round);
  if (!winner) return null;
  const series = seriesFor(sale);
  const facts = {
    token: cardText(series.tokenName, 56) || series.symbol,
    title: cardText(winner.candidate.title, 80) || "Winning panel",
    weight: winner.weight, locked: winner.locked, digest: winner.candidate.content_sha256,
  };
  const artEscrow = { ...escrow, rpc };
  const loadArt = async () => {
    if (!round.submission_ids) return bundledArtwork(id, facts.digest);
    // readChapterArt authenticates the selected submission and hashes the bytes.
    const { bytes } = await readChapterArt(round, winner.choice, artEscrow, undefined, series);
    return rasterForCard(bytes);
  };
  return { facts, loadArt, source: app.near.network === "testnet" ? "NEAR testnet" : "Local sandbox" };
});

export async function chapterPreview(q: ShareQuery): Promise<Card | null> {
  const facts = q.facts;
  if (facts) return { facts, source: "Simulated", loadArt: () => bundledArtwork(q.id, facts.digest) };
  return readChainCard(q.id, q.round).catch(() => null);
}

export function chapterMetadata(q: ShareQuery, card: Card): Metadata {
  const { facts, source } = card;
  const title = `${facts.title} · ${facts.token} · Round ${q.round}`;
  const description = `Winning panel with ${chapterSharePercent(facts)} of locked tokens. ${source}.`;
  const image = { url: chapterImagePath(q.id, q.round, q.facts), ...OG_SIZE, alt: `${title}. ${description}`, type: "image/png" };
  return {
    title, description,
    openGraph: { siteName: "Sealround", title, description, type: "website", images: [image] },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  };
}

export async function renderChapterPreview(q: ShareQuery | null) {
  const [card, fonts] = await Promise.all([q && chapterPreview(q), loadOgFonts()]);
  const render = async () => {
    if (!q || !card) return renderCardBytes(<AppCard />, fonts);
    const props = {
      token: card.facts.token, title: card.facts.title, percentage: chapterSharePercent(card.facts),
      source: card.source, round: q.round,
    };
    try {
      const art = await card.loadArt();
      return await renderCardBytes(<ChapterCardImage {...props} art={art} />, fonts);
    } catch {
      return renderCardBytes(<ChapterCardImage {...props} art={null} />, fonts);
    }
  };
  const png = await render();
  return new Response(png, { headers: {
    "Content-Type": "image/png",
    "Cache-Control": card && process.env.NODE_ENV !== "development" ? "public, max-age=60, s-maxage=300" : "no-store",
  } });
}
