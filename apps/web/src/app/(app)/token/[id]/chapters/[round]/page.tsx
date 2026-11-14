import type { Metadata } from "next";
import Image from "next/image";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/panel";
import { chapterImagePath, chapterSharePercent, parseChapterShare } from "@/lib/chapters/chapter-share";
import { chapterLink } from "@/lib/chapters/reminders";
import { isNearMode } from "@/lib/config";
import { chapterMetadata, chapterPreview } from "@/lib/og/chapter-image";

type Props = {
  params: Promise<{ id: string; round: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

async function shareFor({ params, searchParams }: Props) {
  const { id, round } = await params;
  return parseChapterShare(id, round, await searchParams, !isNearMode());
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const query = await shareFor(props);
  const card = query && await chapterPreview(query);
  return query && card ? chapterMetadata(query, card) : { title: "Chapter unavailable" };
}

export default async function ChapterSharePage(props: Props) {
  const query = await shareFor(props);
  if (!query) notFound();
  const card = await chapterPreview(query);
  if (!card) notFound();
  const { facts, source } = card;
  return (
    <div className="mx-auto grid w-full max-w-3xl gap-6">
      <PageHeader title={facts.title}
        eyebrow={<><Badge>{source}</Badge><span className="text-muted">{facts.token} · Round {query.round}</span></>}
        description={`The winning panel received ${chapterSharePercent(facts)} of locked tokens.`}
        actions={<ButtonLink href={chapterLink(query.round, query.id)} variant="primary">View chapter</ButtonLink>} />
      <div className="panel overflow-hidden">
        <Image src={chapterImagePath(query.id, query.round, query.facts)} alt={`Winning panel preview for ${facts.title}`}
          width={1200} height={630} unoptimized className="block h-auto w-full" />
      </div>
    </div>
  );
}
