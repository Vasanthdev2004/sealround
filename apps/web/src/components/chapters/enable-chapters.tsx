"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { canEnableDemoChapters, runDemo } from "@/lib/chapters/demo";
import { chapterAmount, validateChapterStory, type ChapterSeries, type ChapterStory } from "@/lib/chapters/model";
import { canSignChapter, chapterWalletSigner } from "@/lib/chapters/wallet";
import {
  chapterEscrowRegistration, chapterSetupQuote, enableSandboxChapters, registerChapterEscrow,
  type ChapterFactory, type ChapterSandbox, type ChapterSetupQuote, type EscrowRegistration,
} from "@/lib/chapters/sandbox";
import type { Sale } from "@/lib/types";
import type { WalletState } from "@/lib/wallet";

export function EnableChapters({ sale, series, wallet, factory, onEnabled }: {
  sale: Sale;
  series: ChapterSeries;
  wallet: WalletState;
  factory: ChapterFactory | null;
  onEnabled: (sandbox?: ChapterSandbox) => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [review, setReview] = useState<{ story: ChapterStory; quote: ChapterSetupQuote | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const account = wallet.account;
  const canEnable = account !== null && (factory
    ? account === series.creator && canSignChapter(wallet, factory.network)
    : canEnableDemoChapters(series, account));

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!account || !canEnable || pending.current) return;
    setBusy(true);
    setError(null);
    pending.current = true;
    try {
      if (!review) {
        const story = validateChapterStory(title, brief);
        const quote = factory ? await chapterSetupQuote(factory, sale) : null;
        setReview({ story, quote });
      } else if (factory && review.quote) {
        onEnabled(await enableSandboxChapters(factory, sale, review.story, review.quote,
          () => chapterWalletSigner(wallet, factory.network, series.creator)));
      } else {
        await runDemo({ kind: "enable", account, ...review.story }, series);
        onEnabled();
      }
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Chapters setup did not confirm.");
    } finally { pending.current = false; setBusy(false); }
  }

  if (!open || !canEnable) return <div className="panel flex flex-wrap items-center justify-between gap-3 p-5 sm:p-6">
    <p className="max-w-xl text-small text-muted">{account && !canEnable
      ? `The sale creator (${series.creator}) can start this story.`
      : "Open a story for this token. Artists submit panels, holders choose the winner, and a sponsor funds each bounty."}</p>
    {canEnable && <Button variant="primary" size="lg" onClick={() => setOpen(true)}>Enable Chapters</Button>}
    {!account && <Button variant="outline" size="lg" loading={wallet.connecting} onClick={() => void wallet.connect()}>Connect creator wallet</Button>}
    {!account && wallet.error && <p className="basis-full text-small text-bad" role="alert">{wallet.error}</p>}
  </div>;

  return <form className="panel grid gap-4 p-5 sm:p-6" aria-labelledby="enable-chapters-title" onSubmit={(event) => void submit(event)}>
    <div>
      <h3 id="enable-chapters-title" className="text-h3 text-fg">{review ? "Review your story" : "Set up your story"}</h3>
      <p className="mt-1 text-small text-muted">{account !== series.creator
        ? "You’re acting as the creator of this seeded sale in the browser demo."
        : "Your wallet curates this story. Give artists a brief for their first panel."}</p>
    </div>
    {review ? <div className="grid gap-1 break-words text-small text-muted">
      <p className="font-[510] text-fg">{review.story.title}</p>
      <p className="whitespace-pre-wrap">{review.story.brief}</p>
      {review.quote && <div className="mt-2 space-y-1">
        <p>Escrow setup deposit <strong className="num text-fg">{chapterAmount(review.quote.setup, 24, "NEAR")}</strong>.</p>
        <p>After deployment, your wallet pays each storage deposit the escrow still needs.</p>
        <RegistrationDeposits steps={review.quote.registrations} />
      </div>}
    </div> : <fieldset className="grid min-w-0 gap-3" disabled={busy}>
      <Field label="Story title" value={title} maxLength={96} required onChange={(event) => setTitle(event.target.value)} />
      <label className="grid gap-1.5 text-label font-[510] text-muted">
        Story brief
        <textarea className="inset min-h-24 w-full px-3 py-2 text-small font-normal text-fg" value={brief} maxLength={512} required
          onChange={(event) => setBrief(event.target.value)} />
      </label>
    </fieldset>}
    {error && <p role="alert" className="text-small text-bad">{error}</p>}
    <div className="flex flex-wrap gap-2">
      <Button type="submit" variant="primary" size="lg" loading={busy}>{review ? "Confirm enable Chapters" : "Review story"}</Button>
      <Button type="button" variant="ghost" size="lg" disabled={busy} onClick={() => {
        setError(null);
        if (review) setReview(null);
        else setOpen(false);
      }}>{review ? "Edit story" : "Cancel"}</Button>
    </div>
  </form>;
}

function RegistrationDeposits({ steps }: { steps: readonly EscrowRegistration[] }) {
  return <ul className="space-y-1 text-small text-muted">{steps.map(({ token, deposit }) =>
    <li key={token} className="break-words">{token} · {chapterAmount(deposit, 24, "NEAR")}</li>)}</ul>;
}

export function ChapterEscrowSetup({ sandbox, wallet, ready }: { sandbox: ChapterSandbox; wallet: WalletState; ready: () => void }) {
  const [steps, setSteps] = useState<EscrowRegistration[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revision, refresh] = useState(0);
  const [confirmed, setConfirmed] = useState(false);
  const pending = useRef(false);
  const { curator } = sandbox;
  const network = sandbox.network ?? "sandbox";
  const canRegister = !!curator && wallet.account === curator && canSignChapter(wallet, network);
  useEffect(() => {
    let current = true;
    async function load() {
      try {
        const remaining = await chapterEscrowRegistration(sandbox);
        if (current) { setSteps(remaining); setError(null); }
      } catch {
        if (current) { setSteps(null); setError("Could not read the escrow’s token registrations."); }
      }
    }
    void load();
    return () => { current = false; };
  }, [sandbox, revision]);
  useEffect(() => { if (steps?.length === 0) ready(); }, [steps, ready]);

  async function register() {
    if (!curator || !canRegister || !steps?.length || pending.current) return;
    pending.current = true;
    setError(null);
    setBusy(true);
    let reason: string | null = null;
    for (const step of steps) {
      try {
        await registerChapterEscrow(sandbox, step, () => chapterWalletSigner(wallet, network, curator));
      } catch (problem) {
        reason = `${step.token} registration did not confirm. ${problem instanceof Error ? problem.message : "Check the current status before retrying."}`;
        break;
      }
    }
    const remaining = await chapterEscrowRegistration(sandbox).catch(() => null);
    setSteps(remaining);
    setError(remaining?.length === 0 ? null : reason ?? (remaining ? null : "Refresh the token registrations before retrying."));
    setConfirmed(false);
    setBusy(false);
    pending.current = false;
  }

  if (!steps && !error) return <p role="status" className="panel p-5 text-small text-muted">Reading escrow registrations…</p>;
  if (steps?.length === 0) return null;
  return <section className="panel grid gap-3 p-5 sm:p-6" aria-labelledby="chapter-escrow-title">
    <h3 id="chapter-escrow-title" className="text-h3 text-fg">Register the chapter escrow</h3>
    <p className="text-small text-muted">The escrow needs a storage registration on the voting and bounty tokens before it can hold either asset.</p>
    {steps && <RegistrationDeposits steps={steps} />}
    {confirmed && <p className="text-small text-muted">Approve each remaining registration. Token contracts return any duplicate registration deposit directly to the paying wallet.</p>}
    {error && <p role="alert" className="text-small text-bad">{error}</p>}
    <div className="flex flex-wrap gap-2">
      {canRegister && steps?.length ? <Button variant="primary" size="lg" loading={busy}
        onClick={() => { if (confirmed) void register(); else setConfirmed(true); }}>{confirmed ? "Confirm registration" : "Register escrow"}</Button> : null}
      <Button variant="outline" size="lg" disabled={busy} onClick={() => {
        setConfirmed(false);
        setError(null);
        setSteps(null);
        refresh((value) => value + 1);
      }}>Refresh registration</Button>
    </div>
  </section>;
}
