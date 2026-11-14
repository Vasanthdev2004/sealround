"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import {
  createChapter, fundChapter, nextChapterId, reviewChapter,
  type ChapterDraft, type ChapterReview,
} from "@/lib/chapters/creator";
import { readDemoView, runDemo } from "@/lib/chapters/demo";
import { readSubmittedArt } from "@/lib/chapters/art";
import { LANTERN_STORY, artistLabel, chapterAmount, isLanternPilot, latestChapterWinner, minimumChapterLock, type ChapterRound, type ChapterSeries, type ChapterState, type ChapterSubmission } from "@/lib/chapters/model";
import type { ChapterSandbox } from "@/lib/chapters/sandbox";
import { canSignChapter, chapterWalletSigner } from "@/lib/chapters/wallet";
import { dateTime } from "@/lib/format";
import type { WalletState } from "@/lib/wallet";
import { ArtistSubmissions, VerifiedArtwork } from "./artist-submissions";
import { ChapterArtists } from "./chapter-artists";

type CreatorProps = {
  series: ChapterSeries;
  state: ChapterState;
  sandbox: ChapterSandbox | null;
  wallet: WalletState;
  onUpdate: (state: ChapterState, createdRound?: number) => void;
};

export function ChapterCreator({ series, state, sandbox, wallet, onUpdate }: CreatorProps) {
  const id = nextChapterId(state);
  const round = state.rounds.at(-1);
  const canCreate = wallet.account && (!state.config ? !sandbox : state.config.curator === wallet.account)
    && (!sandbox || canSignChapter(wallet, sandbox.network ?? "sandbox"));
  if (round?.phase === "funding" && !round.funded) {
    return <FundRound key={round.round_id} round={round} wallet={wallet} sandbox={sandbox}
      balance={state.quoteBalance} series={series} onUpdate={onUpdate} />;
  }
  if (id === null) return null;
  const submissions = state.submissions?.[id] ?? [];
  const parent = latestChapterWinner(state.rounds);
  const parentSha256 = parent?.winner != null ? parent.candidates[parent.winner].content_sha256 : null;
  const artists = state.artists?.roundId === id ? state.artists.accounts : undefined;
  const storyIndex = parent ? 1 : 0;
  return <>
    {canCreate && wallet.account && sandbox && artists && <ChapterArtists key={`artists:${id}:${artists.join(",")}`}
      id={id} artists={artists} account={wallet.account} sandbox={sandbox} wallet={wallet} onUpdate={onUpdate} />}
    <ArtistSubmissions key={`artwork:${wallet.account}:${id}`} id={id} parent={parent} submissions={submissions} series={series}
      artists={artists} wallet={wallet} sandbox={sandbox} onUpdate={onUpdate} />
    {wallet.account && canCreate ? <Setup key={`setup:${wallet.account}:${id}`} id={id} account={wallet.account} series={series}
      wallet={wallet} sandbox={sandbox} quoteBalance={state.quoteBalance} onUpdate={onUpdate}
      submissions={submissions} parentSha256={parentSha256} storyIndex={storyIndex}
      requiresSubmissions={!isLanternPilot(series) || !!sandbox?.story || state.rounds.some((r) => !!r.submission_ids)} />
      : state.config && <p className="panel p-5 text-small text-muted">
        The curator <span className="break-all text-fg">{state.config.curator}</span> selects two panels for this chapter.
      </p>}
  </>;
}

function Setup({ id, account, series, wallet, sandbox, quoteBalance, submissions, parentSha256, storyIndex, requiresSubmissions, onUpdate }: Omit<CreatorProps, "state"> & {
  id: number;
  account: string;
  quoteBalance?: string | null;
  submissions: ChapterSubmission[];
  parentSha256: string | null;
  storyIndex: number;
  requiresSubmissions: boolean;
}) {
  const story = isLanternPilot(series) ? LANTERN_STORY[storyIndex] : undefined;
  const quoteSymbol = sandbox?.quoteSymbol ?? "test USDC";
  const quoteDecimals = sandbox?.quoteDecimals ?? 6;
  const [draft, setDraft] = useState<ChapterDraft>({
    title: story?.title ?? `Chapter ${id}`, sponsor: account, bounty: "10", quorum: sandbox ? "100" : "5", slots: "16",
    openIn: "5", voteFor: "5", revealFor: "5",
  });
  const [open, setOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [review, setReview] = useState<ChapterReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const selected = selectedIds.flatMap((id) => submissions.find((item) => item.submission_id === id) ?? []);
  const bundle = !!story && !requiresSubmissions && submissions.length === 0;
  const ready = bundle || selected.length === 2;

  function pick(id: number) {
    setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id)
      : current.length < 2 ? [...current, id] : current);
    setError(null);
  }

  function update(key: keyof ChapterDraft, value: string) {
    setDraft((current) => ({ ...current, [key]: value }));
    setError(null);
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      if (!review) {
        if (!ready) throw new Error("Choose two artist submissions first.");
        const picks = selected.length === 2 ? [selected[0], selected[1]] as [ChapterSubmission, ChapterSubmission] : undefined;
        const prepared = await reviewChapter(sandbox, id, draft, series.decimals, picks, parentSha256, series, storyIndex);
        if (!sandbox && quoteBalance != null && BigInt(prepared.terms.bounty) > BigInt(quoteBalance)) {
          throw new Error(`The bounty exceeds your demo balance of ${chapterAmount(quoteBalance, quoteDecimals, quoteSymbol)}.`);
        }
        setReview(prepared);
        return;
      }
      if (sandbox) {
          onUpdate(await createChapter(sandbox, account, review, () => chapterWalletSigner(wallet, sandbox.network ?? "sandbox", account)), id);
      } else {
        await runDemo({ kind: "create", terms: review.terms, account }, series);
          onUpdate(readDemoView(account, series), id);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The chapter could not be prepared.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  if (!open) {
    return <div className="panel flex flex-wrap items-center justify-between gap-3 p-5 sm:p-6">
      <p className="text-small text-muted">{bundle ? `Set the terms for chapter ${id} using the demo artwork or wait for artist entries.`
        : submissions.length < 2 ? "The curator can set up the chapter once two artists submit panels."
          : `Select two artist submissions and set the terms for chapter ${id}.`}</p>
      <Button variant="primary" size="lg" disabled={!bundle && submissions.length < 2} onClick={() => setOpen(true)}>Set up chapter</Button>
    </div>;
  }

  const bound = (key: keyof ChapterDraft) => ({
    value: draft[key],
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => update(key, event.target.value),
    disabled: busy,
    required: true,
  });
  return (
    <form className="panel grid gap-4 p-5 sm:p-6" aria-labelledby="chapter-setup-title" onSubmit={(event) => void submit(event)}>
      <div>
        <h3 id="chapter-setup-title" className="text-h3 text-fg">{review ? "Review chapter terms" : `Set up chapter ${id}`}</h3>
        <p className="mt-1 text-small text-muted">{review
          ? "Creating fixes these terms. The named sponsor funds the bounty in a separate step."
          : bundle ? "Set the bounty and quorum for the bundled Lantern panels."
            : "Choose two panels for the holders’ vote and set the artist bounty."}</p>
      </div>
      {review || bundle ? <ul className="grid gap-2 border-y border-line py-3 text-small sm:grid-cols-2">
        {(review?.terms.candidates ?? story?.candidates ?? []).map((candidate) => <li key={candidate.content_sha256} className="min-w-0 break-words">
          <span className="text-fg">{candidate.title}</span>
          <span className="break-all text-muted"> by {artistLabel(candidate.artist)}</span>
        </li>)}
      </ul> : <fieldset disabled={busy} className="min-w-0">
        <legend className="mb-2 text-label text-muted">Artist submissions · {selected.length} of 2 selected</legend>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {submissions.map((submission) => {
            const checked = selectedIds.includes(submission.submission_id);
            return <label key={submission.submission_id} className="block min-w-0 overflow-hidden rounded-[10px] border border-line has-checked:border-accent">
              <VerifiedArtwork assetKey={submission.content_sha256} load={() => readSubmittedArt(submission, sandbox, series)} />
              <span className="flex items-start gap-3 p-3">
                <input type="checkbox" aria-label={`${submission.title} by ${submission.artist}`}
                  className="mt-0.5 size-5 shrink-0 accent-accent" checked={checked}
                  disabled={!checked && selected.length >= 2} onChange={() => pick(submission.submission_id)} />
                <span className="min-w-0">
                  <span className="block break-words text-small font-[510] text-fg">{submission.title}</span>
                  <span className="block break-all text-label text-muted">{artistLabel(submission.artist)}</span>
                </span>
              </span>
            </label>;
          })}
        </div>
      </fieldset>}
      {review ? (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-small sm:grid-cols-3">
          <Term label="Title" value={review.terms.title} />
          <Term label="Sponsor" value={review.terms.sponsor} />
          <Term label="Artist bounty" value={chapterAmount(review.terms.bounty, quoteDecimals, quoteSymbol)} numeric />
          <Term label="Revealed quorum" value={chapterAmount(review.terms.quorum, series.decimals, series.symbol)} numeric />
          <Term label="Minimum vote lock" value={chapterAmount(minimumChapterLock(review.terms).toString(), series.decimals, series.symbol)} numeric />
          <Term label="Voter slots" value={review.terms.max_voters} numeric />
          {review.deposit !== null && <>
            <Term label="Storage deposit" value={chapterAmount(review.deposit, 24, "NEAR")} numeric />
            <Term label="Voting opens" value={timestamp(review.terms.starts_at)} />
            <Term label="Reveal opens" value={timestamp(review.terms.commit_end)} />
            <Term label="Reveal closes" value={timestamp(review.terms.reveal_end)} />
          </>}
        </dl>
      ) : (
        <fieldset disabled={busy} className="grid min-w-0 gap-3 sm:grid-cols-2">
          <Field label="Chapter title" maxLength={96} className={sandbox ? undefined : "sm:col-span-2"} {...bound("title")} />
          {sandbox && <Field label="Sponsor account" maxLength={64} autoCapitalize="none" autoCorrect="off" spellCheck={false} {...bound("sponsor")} />}
          <Field label="Artist bounty" suffix={quoteSymbol} inputMode="decimal" maxLength={48} {...bound("bounty")} />
          <Field label="Revealed quorum" suffix={series.symbol} inputMode="decimal" maxLength={48} {...bound("quorum")} />
          <Field label="Voter slots" inputMode="numeric" maxLength={3} {...bound("slots")} />
          {sandbox && <>
            <Field label="Minutes until voting opens" inputMode="numeric" maxLength={5} {...bound("openIn")} />
            <Field label="Voting minutes" inputMode="numeric" maxLength={5} {...bound("voteFor")} />
            <Field label="Reveal minutes" inputMode="numeric" maxLength={5} {...bound("revealFor")} />
          </>}
        </fieldset>
      )}
      {review && sandbox && <p className="text-small text-muted">{sandbox.network === "testnet" ? "NEAR testnet." : "Local sandbox."} Your wallet pays the storage deposit and transaction gas.</p>}
      {error && <p role="alert" className="text-small text-bad">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" size="lg" loading={busy} disabled={!review && !ready}>{review ? "Create chapter" : "Review chapter"}</Button>
        <Button type="button" variant="ghost" size="lg" disabled={busy} onClick={() => {
          setError(null);
          if (review) setReview(null);
          else setOpen(false);
        }}>{review ? "Edit terms" : "Cancel"}</Button>
      </div>
    </form>
  );
}

function timestamp(value: string) {
  return dateTime(Number(BigInt(value) / 1_000_000n));
}

function Term({ label, value, numeric = false }: { label: string; value: React.ReactNode; numeric?: boolean }) {
  return <div className="min-w-0">
    <dt className="text-muted">{label}</dt>
    <dd className={`${numeric ? "num " : ""}mt-1 break-words text-fg`}>{value}</dd>
  </div>;
}

function FundRound({ round, wallet, sandbox, balance, series, onUpdate }: {
  round: ChapterRound;
  wallet: WalletState;
  sandbox: ChapterSandbox | null;
  balance?: string | null;
  series: ChapterSeries;
  onUpdate: (state: ChapterState) => void;
}) {
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const account = wallet.account;
  const quoteSymbol = sandbox?.quoteSymbol ?? "test USDC";
  const quoteDecimals = sandbox?.quoteDecimals ?? 6;
  const amount = chapterAmount(round.bounty, quoteDecimals, quoteSymbol);
  const canFund = account === round.sponsor && (!sandbox || canSignChapter(wallet, sandbox.network ?? "sandbox"));
  const lowBalance = !sandbox && balance != null && BigInt(balance) < BigInt(round.bounty);

  async function fund() {
    if (!account || !canFund || lowBalance || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      if (sandbox) {
        onUpdate(await fundChapter(sandbox, account, round, () => chapterWalletSigner(wallet, sandbox.network ?? "sandbox", account)));
      } else {
        await runDemo({ kind: "fund", round: round.round_id, account }, series);
        onUpdate(readDemoView(account, series));
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The bounty funding could not be confirmed.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return (
    <section className="panel grid gap-3 p-5 sm:p-6" aria-labelledby="chapter-fund-title">
      <div>
        <h3 id="chapter-fund-title" className="text-h3 text-fg">Fund chapter {round.round_id}</h3>
        <p className="mt-1 text-small text-muted">
          <span className="break-all text-fg">{round.sponsor}</span> funds the <span className="num text-fg">{amount}</span> artist bounty
          {sandbox && <> before {timestamp(round.starts_at)}</>}.
        </p>
      </div>
      {reviewing && canFund && <p className="text-small text-muted">
        Transfer <span className="num text-fg">{amount}</span> from your {sandbox ? (sandbox.network === "testnet" ? "testnet wallet" : "sandbox wallet") : "demo balance"} to escrow.
        The sponsor can reclaim the bounty if the chapter ties or misses quorum.
      </p>}
      {canFund && lowBalance && <p role="status" className="text-small text-bad">
        Your demo balance is {chapterAmount(balance!, quoteDecimals, quoteSymbol)}. Funding requires the full {amount}.
      </p>}
      {error && <p role="alert" className="text-small text-bad">{error}</p>}
      <div className="flex flex-wrap gap-2 empty:hidden">
        {!account && <Button variant="primary" size="lg" loading={wallet.connecting} onClick={() => void wallet.connect()}>
          {sandbox ? "Connect wallet" : "Connect demo wallet"}
        </Button>}
        {canFund && !reviewing && <Button variant="primary" size="lg" disabled={lowBalance} onClick={() => setReviewing(true)}>Fund artist bounty</Button>}
        {canFund && reviewing && <>
          <Button variant="primary" size="lg" loading={busy} disabled={lowBalance} onClick={() => void fund()}>Confirm funding</Button>
          <Button variant="ghost" size="lg" disabled={busy} onClick={() => { setError(null); setReviewing(false); }}>Cancel</Button>
        </>}
      </div>
      {account && !canFund && <p className="text-small text-muted">Switch to the designated sponsor wallet to fund the bounty.</p>}
      {wallet.error && !account && <p role="alert" className="text-small text-bad">{wallet.error}</p>}
    </section>
  );
}
