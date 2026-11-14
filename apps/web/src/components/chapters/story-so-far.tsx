"use client";

import Link from "next/link";
import { useState } from "react";
import { Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { readChapterArt } from "@/lib/chapters/art";
import { chapterSharePath, chapterSharePercent, winningShare } from "@/lib/chapters/chapter-share";
import { artistLabel, type ChapterRound, type ChapterSeries } from "@/lib/chapters/model";
import type { ChapterSandbox } from "@/lib/chapters/sandbox";
import { VerifiedArtwork } from "./artist-submissions";

export function StorySoFar({ rounds, series, sandbox, selectRound }: {
  rounds: ChapterRound[];
  series: ChapterSeries;
  sandbox: ChapterSandbox | null;
  selectRound: (round: number) => void;
}) {
  const [copied, setCopied] = useState<number | null>(null);
  const winners = rounds.flatMap((round) => {
    const share = winningShare(round);
    return share ? [{ round, share }] : [];
  });
  if (!winners.length) return null;

  return (
    <section aria-labelledby="story-so-far" className="panel overflow-hidden">
      <h3 id="story-so-far" className="border-b border-line px-5 py-4 text-h3 text-fg sm:px-6">Story so far</h3>
      <ol className="flex snap-x gap-4 overflow-x-auto p-5 sm:p-6">
        {winners.map(({ round, share }, index) => {
          const { candidate } = share;
          const href = chapterSharePath(series.saleId, round.round_id, sandbox ? null : {
            token: series.tokenName, title: candidate.title, weight: share.weight, locked: share.locked, digest: candidate.content_sha256,
          });
          return (
            <li key={round.round_id} className="inset w-[min(100%,22rem)] shrink-0 snap-start overflow-hidden rounded-tile">
              <VerifiedArtwork className="aspect-[16/9] rounded-t-tile border-b border-line"
                assetKey={`${sandbox?.contract ?? series.token}:${round.round_id}:${candidate.content_sha256}`}
                load={() => readChapterArt(round, share.choice, sandbox, undefined, series)} />
              <div className="space-y-2 p-4">
                <p className="text-label text-muted">Chapter {index + 1} · Round {round.round_id}</p>
                <p className="break-words text-body font-[510] text-fg">{candidate.title}</p>
                <p className="break-words text-label text-muted">
                  {artistLabel(candidate.artist)} · <strong className="num font-[510] text-fg">{chapterSharePercent(share)}</strong> of locked tokens
                </p>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <Button type="button" size="sm" variant="ghost" className="px-0" onClick={() => selectRound(round.round_id)}>
                    View round {round.round_id}
                  </Button>
                  <span aria-hidden className="text-subtle">·</span>
                  <Link href={href} prefetch={false} className="inline-flex min-h-8 items-center text-small text-accent-bright hover:underline">
                    Share card
                  </Link>
                  <Button type="button" size="sm" variant="ghost" aria-label={`Copy share link for round ${round.round_id}`}
                    icon={<Copy className="size-3.5" aria-hidden />}
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(new URL(href, window.location.origin).href);
                        setCopied(round.round_id);
                      } catch { setCopied(null); }
                    }}>
                    {copied === round.round_id ? "Copied" : "Copy link"}
                  </Button>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      <p role="status" className="sr-only">{copied !== null && `Round ${copied} share link copied.`}</p>
    </section>
  );
}
