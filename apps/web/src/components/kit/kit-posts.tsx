"use client";

import { Check, Copy } from "lucide-react";
import type { CountdownPhase } from "@/app/api/og/countdown/share";
import { xIntentUrl } from "@/components/result/share-text";
import { Button, ButtonLink } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { cn } from "@/lib/cn";
import type { Sale } from "@/lib/types";
import { CopyStatus, XMark, useCopy, useSaleUrl } from "./kit-bits";
import { X_LIMIT, kitPosts, xPostLength, type KitPost, type KitWhere } from "./kit-text";

function PostRow({ post, url }: { post: KitPost; url: string | null }) {
  const { state, text, copy } = useCopy();
  const length = xPostLength(post.text, url);
  const over = length > X_LIMIT;
  const full = url ? `${post.text} ${url}` : post.text;
  return (
    <article className="py-4 first:pt-1">
      <div className="flex items-baseline justify-between gap-4">
        <h3 className="text-h3 text-fg">{post.title}</h3>
        <span
          className={cn("num shrink-0 text-label", over ? "text-warn" : "text-subtle")}
          title="As X counts it: a link counts as 23 characters"
        >
          {length} of {X_LIMIT}
        </span>
      </div>
      <p className="mt-2 max-w-[68ch] text-body break-words text-fg">
        {post.text}
        {url && <span className="text-muted"> {url}</span>}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <ButtonLink href={xIntentUrl(post.text, url)} external size="sm" variant="tactile" icon={<XMark />} className="max-sm:h-10">
          Post on X
          <span className="sr-only"> (opens x.com in a new tab)</span>
        </ButtonLink>
        <Button
          size="sm"
          variant="outline"
          className="max-sm:h-10"
          onClick={() => void copy(full)}
          icon={state === "copied" ? <Check className="size-3.5 text-ok" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
        >
          {state === "copied" ? "Copied" : "Copy text"}
        </Button>
      </div>
      <CopyStatus state={state} text={text} done={`${post.title}: copied with the link.`} className="mt-2" />
    </article>
  );
}

/** Two or three posts for where the sale stands, each with "Post on X" (X's intent link) and Copy. */
export function KitPosts({ sale, phase, where }: { sale: Sale; phase: Exclude<CountdownPhase, "final">; where: KitWhere }) {
  const c = sale.config;
  const url = useSaleUrl(sale.id);
  const posts = kitPosts({
    ticker: c.tokenSymbol,
    bidStart: c.bidStart,
    bidEnd: c.bidEnd,
    tee: c.revealMode === "tee",
    phase,
    where,
  });
  return (
    <Panel
      title="Posts for X"
      subtitle="Each ends with the sale link. Attach the countdown image to make it stand out."
      bodyClassName="px-5 pb-1"
    >
      <div className="divide-y divide-line">
        {posts.map((p) => (
          <PostRow key={p.id} post={p} url={url} />
        ))}
      </div>
    </Panel>
  );
}
