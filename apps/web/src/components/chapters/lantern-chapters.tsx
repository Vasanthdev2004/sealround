"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, LockKeyhole } from "lucide-react";
import { Badge, Tag } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Segmented } from "@/components/ui/field";
import { appConfig } from "@/lib/config";
import { cn } from "@/lib/cn";
import { dateTime } from "@/lib/format";
import type { Sale } from "@/lib/types";
import { useWallet } from "@/lib/wallet";
import {
  demoChapterContract, demoChapterQuote, readDemoProof, readDemoView, resetDemo, runDemo, subscribeDemo, type DemoAction,
} from "@/lib/chapters/demo";
import { readChapterArt } from "@/lib/chapters/art";
import {
  LANTERN_STORY, artistLabel, bountyRecipient, chapterAmount, newVoteSecret, parseLockAmount,
  parseRecoveryCode, readVoteSecret, recoveryCode, saveVoteSecret, voteCommitment,
  isLanternPilot, seriesFor, type ChapterRound, type ChapterSeries, type ChapterState, type ChapterVote, type Choice,
} from "@/lib/chapters/model";
import { rememberChapterVote } from "@/lib/chapters/reminders";
import {
  chapterFactoryFor, chapterPayoutRegistration, readSandbox, registerChapterPayee, resolveChapterSandbox, runSandbox,
  sandboxFor, type ChapterSandbox, type EscrowRegistration,
} from "@/lib/chapters/sandbox";
import { canSignChapter, chapterWalletSigner } from "@/lib/chapters/wallet";
import { VerifiedArtwork } from "./artist-submissions";
import { ChapterCreator } from "./chapter-creator";
import { ChapterVerification } from "./chapter-verification";
import { ChapterRevealReminder } from "./reveal-reminders";
import { ChapterEscrowSetup, EnableChapters } from "./enable-chapters";

const PHASE_LABEL: Record<ChapterRound["phase"], string> = {
  funding: "Waiting to open",
  commit: "Voting open",
  reveal: "Reveal open",
  awaiting_finalization: "Ready to finalize",
  finalized: "Finalized",
};

export function TokenChapters({ sale }: { sale: Sale }) {
  const wallet = useWallet();
  if (sale.status !== "settled") return null;
  return <ChaptersEntry key={`${sale.tokenAccount}:${wallet.account ?? "disconnected"}`} sale={sale} wallet={wallet} />;
}

type Wallet = ReturnType<typeof useWallet>;

function ChaptersEntry({ sale, wallet }: { sale: Sale; wallet: Wallet }) {
  const series = useMemo(() => seriesFor(sale), [sale]);
  const legacy = useMemo(() => sandboxFor(sale, appConfig()), [sale]);
  const factory = useMemo(() => legacy ? null : chapterFactoryFor(sale, appConfig()), [legacy, sale]);
  const [sandbox, setSandbox] = useState<ChapterSandbox | null>(null);
  const [registered, setRegistered] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, refresh] = useState(0);

  useEffect(() => {
    if (!factory || sandbox) return;
    let alive = true;
    let reading = false;
    async function load() {
      if (reading || document.hidden) return;
      reading = true;
      try {
        const result = await resolveChapterSandbox(sale, appConfig());
        if (alive) { if (result) setSandbox(result); setError(null); }
      } catch (problem) {
        if (alive) setError(problem instanceof Error ? problem.message : "Chapters could not load.");
      } finally {
        reading = false;
        if (alive) setLoading(false);
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [factory, revision, sale, sandbox]);

  if (legacy || wallet.mode === "mock" || (sandbox && registered)) {
    return <ChapterPanel sale={sale} series={series} sandbox={legacy ?? sandbox} wallet={wallet} />;
  }
  if (!factory) return null;
  return <section id="meme-chapters" aria-labelledby="chapters-title" className="scroll-mt-20 space-y-4">
    <ChapterHeading title={sandbox?.story?.title ?? "Meme Chapters"} brief={sandbox?.story?.brief} network={factory.network} />
    {error ? <div className="panel p-5 text-small"><p role="alert" className="mb-3 text-bad">{error}</p>
      <Button onClick={() => refresh((value) => value + 1)}>Read again</Button></div>
      : sandbox ? <ChapterEscrowSetup sandbox={sandbox} wallet={wallet} ready={() => setRegistered(true)} />
        : loading ? <p role="status" className="panel p-5 text-small text-muted">Reading Chapters availability…</p>
          : <EnableChapters sale={sale} series={series} wallet={wallet} factory={factory} onEnabled={(result) => {
            if (result) setSandbox(result);
          }} />}
  </section>;
}

function ChapterHeading({ title, brief, network }: { title: string; brief?: string; network?: "sandbox" | "testnet" }) {
  return <header className="flex flex-wrap items-start justify-between gap-3">
    <div className="min-w-0">
      <h2 id="chapters-title" className="break-words text-h2 text-fg">{title}</h2>
      {brief && <p className="mt-1 max-w-prose whitespace-pre-wrap break-words text-small text-muted">{brief}</p>}
    </div>
    <Tag>{network === "testnet" ? "NEAR testnet" : network === "sandbox" ? "Local sandbox" : "Simulated"}</Tag>
  </header>;
}

function ChapterPanel({ sale, series, sandbox, wallet }: { sale: Sale; series: ChapterSeries; sandbox: ChapterSandbox | null; wallet: Wallet }) {
  const { account } = wallet;
  const [state, setState] = useState<ChapterState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [revision, refresh] = useState(0);
  const [selected, selectRound] = useState<number | null>(null);
  const requested = useSearchParams().get("chapter");
  const network = sandbox && (sandbox.network ?? "sandbox");
  const scope = sandbox
    ? network === "testnet" ? `testnet:${sandbox.contract}:${sandbox.token}` : `sandbox:${sandbox.rpcUrl}:${sandbox.contract}:${sandbox.token}`
    : `mock:${demoChapterContract(series)}`;
  const requestVersion = useRef(0);

  function update(next: ChapterState) {
    ++requestVersion.current;
    setState(next);
    setLoadError(null);
  }

  useEffect(() => {
    let active = true;
    let loading = false;
    async function load() {
      if (loading && sandbox) return;
      loading = true;
      const version = ++requestVersion.current;
      try {
        const next = await Promise.resolve().then(() => sandbox ? readSandbox(sandbox, account) : readDemoView(account, series));
        if (!active || version !== requestVersion.current) return;
        setState(next);
        setLoadError(null);
      } catch (error) {
        if (!active || version !== requestVersion.current) return;
        setLoadError(error instanceof Error ? error.message : "The chapter could not load.");
      } finally {
        loading = false;
      }
    }
    void load();
    const interval = sandbox ? window.setInterval(() => { if (!document.hidden) void load(); }, 4000) : null;
    const unsubscribe = sandbox ? null : subscribeDemo(() => void load());
    return () => {
      active = false;
      if (interval !== null) window.clearInterval(interval);
      unsubscribe?.();
    };
  }, [account, revision, sandbox, series]);

  const round = state?.rounds.find((item) => item.round_id === (selected ?? Number(requested))) ?? state?.rounds.at(-1);
  return (
    <section id="meme-chapters" aria-labelledby="chapters-title" className="scroll-mt-20 space-y-4">
      <ChapterHeading title={state?.story?.title ?? "Meme Chapters"} brief={state?.story?.brief ?? (isLanternPilot(series) ? "Lantern holders choose how the story continues." : undefined)} network={network ?? undefined} />
      {loadError ? (
        <div className="panel p-5 sm:p-6">
          <p role="alert" className="text-small text-bad">{loadError}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button onClick={() => refresh((n) => n + 1)}>Read again</Button>
            {!sandbox && <Button variant="ghost" onClick={() => {
              try { resetDemo(series); selectRound(null); } catch { setLoadError("Local storage is blocked. Enable it to use the demo."); }
            }}>Reset chapter demo</Button>}
          </div>
        </div>
      ) : !state ? (
        <p role="status" className="panel p-5 text-small text-muted">Loading chapters…</p>
      ) : !sandbox && !isLanternPilot(series) && !state.story ? (
        <EnableChapters sale={sale} series={series} wallet={wallet} factory={null} onEnabled={() => update(readDemoView(account, series))} />
      ) : (
        <div className="space-y-4">
          <ChapterCreator series={series} state={state} sandbox={sandbox} wallet={wallet} onUpdate={(next) => {
            if (next.rounds.length > state.rounds.length) selectRound(next.rounds.at(-1)!.round_id);
            update(next);
          }} />
          {state.rounds.length > 1 && (
            <div className="mb-4">
              <Segmented label={`${series.tokenName} chapter`} value={String(round?.round_id)} onChange={(id) => selectRound(Number(id))}
                options={state.rounds.map((r) => ({ value: String(r.round_id), label: `Chapter ${r.round_id}` }))} />
            </div>
          )}
          {round && <Chapter key={round.round_id} round={round} state={state} series={series} wallet={wallet}
            sandbox={sandbox} scope={scope} onUpdate={update} />}
        </div>
      )}
    </section>
  );
}

type VoteAction = Exclude<DemoAction, { kind: "enable" | "create" | "fund" | "submit_art" }>;

function Chapter({ round, state, series, wallet, sandbox, scope, onUpdate }: {
  round: ChapterRound;
  state: ChapterState;
  series: ChapterSeries;
  wallet: Wallet;
  sandbox: ChapterSandbox | null;
  scope: string;
  onUpdate: (state: ChapterState) => void;
}) {
  const [choice, setChoice] = useState<Choice | null>(null);
  const [amount, setAmount] = useState("25");
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);
  const [payoutRegistration, setPayoutRegistration] = useState<{ account: string; step: EscrowRegistration } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const { decimals, symbol } = series;
  const id = round.round_id;
  const account = wallet.account;
  const vote = state.votes[id];
  const secret = vote && account ? readVoteSecret(scope, id, account, vote.commitment) : null;
  const amountInBase = parseLockAmount(amount, decimals);
  const available = state.balance !== null ? BigInt(state.balance) : 0n;
  const owner = bountyRecipient(round);
  const script = isLanternPilot(series) ? LANTERN_STORY[id - 1] : undefined;
  const winner = round.winner !== null ? round.candidates[round.winner] : null;
  const first = id === 2 ? state.rounds.find((prior) => prior.round_id === 1) : undefined;
  const parent = first?.winner != null ? first.candidates[first.winner] : null;
  const isDemo = !sandbox;
  const canSign = !sandbox || canSignChapter(wallet, sandbox.network ?? "sandbox");
  const canChoose = round.phase === "commit" && !vote && account !== null;
  const canReveal = round.phase === "reveal" && vote && vote.revealed_choice === null;
  const canWithdraw = round.phase === "finalized" && vote?.withdrawal_state === "unclaimed";
  const canTakeBounty = owner && round.bounty_state === "unclaimed" && (isDemo || owner === account);
  const payoutStep = canTakeBounty && payoutRegistration?.account === account ? payoutRegistration?.step : null;
  const balance = (value: string) => chapterAmount(value, decimals, symbol);
  const quote = chapterAmount(round.bounty, sandbox?.quoteDecimals ?? 6, sandbox?.quoteSymbol ?? "test USDC");
  const deadline = round.phase === "commit" ? round.commit_end : round.phase === "reveal" ? round.reveal_end : null;

  async function submit(actionOrPrepare: VoteAction | (() => Promise<VoteAction>)) {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const action = typeof actionOrPrepare === "function" ? await actionOrPrepare() : actionOrPrepare;
      if (!sandbox) {
        await runDemo(action, series);
        onUpdate(readDemoView(account, series));
      } else {
        if (!account) throw new Error("Connect the wallet you used for this chapter.");
        const activeSigner = () => chapterWalletSigner(wallet, sandbox.network ?? "sandbox", account);
        if (action.kind === "end_commit" || action.kind === "end_reveal") throw new Error("This control is available in the demo.");
        if (action.kind === "bounty" && sandbox.network === "testnet") {
          if (payoutStep) {
            await registerChapterPayee(sandbox, payoutStep, account, activeSigner);
            setPayoutRegistration(null);
            return;
          }
          const step = await chapterPayoutRegistration(sandbox, account);
          if (step) {
            setPayoutRegistration({ account, step });
            return;
          }
        }
        const confirmed = (fresh: ChapterState) => {
          const current = fresh.rounds.find((r) => r.round_id === id);
          const myVote = fresh.votes[id];
          switch (action.kind) {
            case "commit": return myVote?.commitment === action.commitment;
            case "reveal": return myVote?.revealed_choice === action.secret.choice;
            case "finalize": return current?.phase === "finalized";
            case "withdraw": return myVote?.withdrawal_state === "paid";
            case "bounty": return current?.bounty_state === "paid";
            default: return false;
          }
        };
        const rpcUrl = sandbox.rpcUrl;
        // A testnet wallet can navigate away while signing. Activity checks the on-chain commitment.
        if (action.kind === "commit" && rpcUrl && sandbox.network === "testnet") rememberChapterVote(rpcUrl, account, series.saleId);
        const fresh = await runSandbox(sandbox, activeSigner(), account, id, action, confirmed);
        if (action.kind === "commit" && rpcUrl && sandbox.network !== "testnet") rememberChapterVote(rpcUrl, account, series.saleId);
        onUpdate(fresh);
      }
    } catch (e) {
      if (payoutStep) setPayoutRegistration(null);
      setError(e instanceof Error ? e.message : "The chapter action did not complete.");
    } finally {
      setBusy(false);
      submitting.current = false;
    }
  }

  async function lock(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!account || choice === null || amountInBase === null || amountInBase > available || busy) return;
    await submit(async () => {
      const voteSecret = newVoteSecret(choice);
      const commitment = await voteCommitment(sandbox?.contract ?? demoChapterContract(series), id, account, voteSecret);
      await readChapterArt(round, choice, sandbox, undefined, series);
      saveVoteSecret(scope, id, account, commitment, voteSecret);
      return { kind: "commit", round: id, account, amount: amountInBase, commitment };
    });
  }

  function reveal() {
    if (!account) return;
    const value = secret ?? parseRecoveryCode(code);
    if (!value) { setError("Enter your reveal code from the browser where you voted."); return; }
    void submit({ kind: "reveal", round: id, account, secret: value });
  }

  const phaseControl = isDemo && round.phase === "commit" ? { title: "End voting", kind: "end_commit" as const }
    : isDemo && round.phase === "reveal" ? { title: "End reveal", kind: "end_reveal" as const } : null;
  const visibleChoices: readonly Choice[] = round.winner === null ? [0, 1] : [round.winner];
  return (
    <div className="panel overflow-hidden">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line p-5 sm:p-6">
        <div className="min-w-0">
          <div className="text-label text-subtle">Chapter {id} of 2</div>
          <h3 className="mt-1 text-h2 text-fg">{round.title}</h3>
          {!round.submission_ids && script?.title === round.title && <p className="mt-1.5 text-small text-muted">{script.brief}</p>}
          {parent && round.parent_sha256 === parent.content_sha256 && <p className="mt-1.5 break-words text-small text-muted">
            Continues <span className="text-fg">{parent.title}</span>, the winner of chapter 1.
          </p>}
        </div>
        <div className="flex flex-col items-end gap-1">
          <Badge>{PHASE_LABEL[round.phase]}</Badge>
          {sandbox && deadline && <span className="text-label text-subtle">Ends {dateTime(Number(BigInt(deadline) / 1_000_000n))}</span>}
        </div>
      </header>

      <fieldset disabled={busy || !canChoose} className="min-w-0">
        <legend className="sr-only">Choose the next panel</legend>
        <div className={cn("grid divide-y divide-line", !winner && "sm:grid-cols-2 sm:divide-x sm:divide-y-0")}>
          {visibleChoices.map((index) => (
            <PanelChoice key={index} round={round} sandbox={sandbox} series={series} index={index} selected={choice === index}
              selectable={canChoose} winner={round.winner === index} change={setChoice} />
          ))}
        </div>
      </fieldset>

      <div className="border-t border-line px-5 sm:px-6">
        <dl className="grid grid-cols-2 gap-x-4 py-4 sm:grid-cols-4">
          <Measure label="Committed weight" value={balance(round.locked)} />
          <Measure label="Revealed weight" value={balance(round.revealed)} />
          <Measure label="Quorum" value={balance(round.quorum)} />
          <Measure label={round.funded ? "Funded artist bounty" : "Artist bounty"} value={quote} />
        </dl>
      </div>

      <div className="space-y-4 border-t border-line p-5 sm:p-6">
        {round.phase === "finalized" && <ChapterResult round={round} balance={balance} quote={quote} />}
        {round.phase === "funding" && <p className="text-small text-muted">Voting starts once the sponsor funds the bounty and the round opens.</p>}
        {round.phase === "reveal" && !vote && <p className="text-small text-muted">Voters are revealing their sealed choices. Check back after the result is finalized.</p>}
        {!account && (round.phase === "commit" || round.phase === "reveal" || round.phase === "finalized" || round.phase === "awaiting_finalization") && (
          <Button variant="primary" size="lg" loading={wallet.connecting} onClick={() => void wallet.connect()}>{isDemo ? "Connect demo wallet" : "Connect wallet"}</Button>
        )}
        {wallet.error && !account && <p role="alert" className="text-small text-bad">{wallet.error}</p>}

        {canChoose && account && (
          <form onSubmit={(event) => void lock(event)} className="flex flex-col gap-4 sm:flex-row sm:items-start">
            <Field label="Tokens to lock" suffix={symbol} inputMode="decimal" maxLength={64} value={amount} onChange={(event) => setAmount(event.target.value)} disabled={busy}
              error={amount && amountInBase === null ? `Enter a positive ${symbol} amount.` : amountInBase && amountInBase > available ? `This exceeds your available ${symbol}.` : undefined}
              hint={`${balance(available.toString())} available${isDemo ? " in this chapter demo" : ""}. Your lock is returned after the chapter.`} />
            <Button variant="primary" size="lg" className="sm:mt-6" type="submit" loading={busy} icon={<LockKeyhole className="size-4" aria-hidden />}
              disabled={!amountInBase || amountInBase > available || choice === null || !canSign}>
              Lock &amp; seal vote
            </Button>
          </form>
        )}
        {vote && <VoteStatus vote={vote} amount={balance(vote.amount)} />}

        {vote && vote.revealed_choice === null && (round.phase === "commit" || round.phase === "reveal") && (
          <ChapterRevealReminder key={`${id}:${round.phase}`} round={round} contract={sandbox?.contract} series={series} />
        )}
        {vote && vote.revealed_choice === null && (round.phase === "commit" || round.phase === "reveal") && (
          <details className="text-small text-muted">
            <summary className="w-fit cursor-pointer text-fg">Reveal code</summary>
            {secret ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <p className="basis-full">Keep this code private until you reveal. Save it to reveal in another browser.</p>
                <code className="font-mono text-label break-all text-fg">{recoveryCode(secret)}</code>
                <Button size="sm" onClick={async () => {
                  try { await navigator.clipboard.writeText(recoveryCode(secret)); setCopied(true); }
                  catch { setError("Copy the reveal code manually."); }
                }}>{copied ? "Copied" : "Copy code"}</Button>
              </div>
            ) : <p className="mt-2">This browser has no saved code. Use the code from the browser where you voted.</p>}
          </details>
        )}

        {canReveal && <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-end">
          {!secret && <Field label="Saved reveal code" value={code} onChange={(event) => setCode(event.target.value)} maxLength={66} autoComplete="off" />}
          <Button variant="primary" size="lg" loading={busy} disabled={!canSign || (!secret && !parseRecoveryCode(code))} onClick={reveal}>Reveal vote</Button>
        </div>}

        <div className="flex flex-wrap gap-2 empty:hidden">
          {round.phase === "awaiting_finalization" && account && (
            <Button variant="primary" size="lg" loading={busy} disabled={!canSign} onClick={() => void submit({ kind: "finalize", round: id })}>Finalize chapter</Button>
          )}
          {canWithdraw && account && (
            <Button size="lg" variant="primary" loading={busy} disabled={!canSign} onClick={() => void submit({ kind: "withdraw", round: id, account })}>Withdraw locked {symbol}</Button>
          )}
          {canTakeBounty && (
            <Button size="lg" disabled={busy || !canSign} onClick={() => void submit({ kind: "bounty", round: id })}>
              {payoutStep ? "Confirm payout token registration" : isDemo ? (winner ? "Pay artist in demo" : "Refund sponsor in demo")
                : (winner ? "Claim artist bounty" : "Claim sponsor refund")}
            </Button>
          )}
        </div>
        {payoutStep && <p role="status" className="text-small text-muted">
          Register your wallet on {payoutStep.token} for {chapterAmount(payoutStep.deposit, 24, "NEAR")}. Then claim the payout.
        </p>}
        {phaseControl && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-label text-subtle">Demo controls</span>
            <Button variant="outline" disabled={busy} onClick={() => void submit({ kind: phaseControl.kind, round: id })}>{phaseControl.title}</Button>
          </div>
        )}
        {error && <p role="alert" className="text-small text-bad">{error}</p>}
      </div>
      <ChapterVerification round={round} sandbox={sandbox} series={series}
        readMockEvidence={sandbox ? undefined : () => readDemoProof(id, series)} mockQuoteToken={demoChapterQuote(series)} />
    </div>
  );
}

function PanelChoice({ round, sandbox, series, index, selected, selectable, winner, change }: {
  round: ChapterRound; sandbox: ChapterSandbox | null; series: ChapterSeries; index: Choice; selected: boolean;
  selectable: boolean; winner: boolean; change: (index: Choice) => void;
}) {
  const candidate = round.candidates[index];
  const title = <span className="block break-words text-h3 text-fg">{candidate.title}</span>;
  const credit = <span className="block break-all text-label text-muted">By {artistLabel(candidate.artist)}</span>;
  const art = <VerifiedArtwork assetKey={`${candidate.content_sha256}:${round.submission_ids?.[index] ?? "bundle"}`}
    load={() => readChapterArt(round, index, sandbox, undefined, series)} className={winner ? "aspect-[16/7]" : "aspect-[3/2]"} />;

  if (!selectable) return <figure>{art}<figcaption className="space-y-1 p-4 sm:px-6">{title}{credit}</figcaption></figure>;
  return (
    <label className="group block cursor-pointer">
      <input type="radio" name="chapter-candidate" className="peer sr-only" checked={selected} onChange={() => change(index)} aria-label={candidate.title} />
      <span className="relative block peer-focus-visible:outline-2 peer-focus-visible:-outline-offset-2 peer-focus-visible:outline-accent">
        {art}
        <span className="flex items-center justify-between gap-4 p-4 group-hover:bg-wash sm:px-6">
          <span className="min-w-0 space-y-1">{title}{credit}</span>
          <span aria-hidden className={cn("grid size-6 shrink-0 place-items-center rounded-full border", selected ? "border-accent bg-accent-soft text-accent-bright" : "border-line-strong")}>
            {selected && <Check className="size-4" />}
          </span>
        </span>
      </span>
    </label>
  );
}

function Measure({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 py-1"><dt className="text-label text-muted">{label}</dt><dd className="num mt-1 text-small font-[510] text-fg break-words">{value}</dd></div>;
}

function VoteStatus({ vote, amount }: { vote: ChapterVote; amount: string }) {
  return <p className="text-small text-muted" role="status">
    {vote.withdrawal_state === "paid" ? `${amount} returned to your wallet.`
      : vote.withdrawal_state === "pending" ? `${amount} withdrawal pending.`
        : vote.revealed_choice !== null ? `Vote revealed · ${amount} locked.` : `Vote sealed · ${amount} locked.`}
  </p>;
}

function ChapterResult({ round, balance, quote }: { round: ChapterRound; balance: (value: string) => string; quote: string }) {
  const winner = round.winner !== null ? round.candidates[round.winner] : null;
  const reason = round.outcome === "tie" ? "The vote tied." : round.outcome === "unfunded" ? "The sponsor did not fund the bounty in time." : "Revealed votes did not reach quorum.";
  return (
    <div className="space-y-1.5">
      <p className="text-small font-[510] text-fg">{winner ? `${winner.title} became chapter ${round.round_id}.` : `No panel selected. ${reason}`}</p>
      {round.funded && <p className="text-small text-muted">
        {winner ? `${quote} artist bounty · ${artistLabel(winner.artist)}` : `${quote} sponsor refund`}{" · "}
        {round.bounty_state === "paid" ? "Paid" : round.bounty_state === "pending" ? "Transfer pending" : "Ready to claim"}
      </p>}
      <p className="num text-label text-subtle">{round.candidates.map((candidate, index) => `${artistLabel(candidate.artist)} ${balance(round.tallies[index])}`).join(" · ")}</p>
    </div>
  );
}
