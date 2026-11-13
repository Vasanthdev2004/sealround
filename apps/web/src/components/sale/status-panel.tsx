"use client";

import { useEffect, useRef } from "react";
import { Wallet } from "lucide-react";
import { BurnMoment, useBurnCapture } from "@/components/burn/burn-moment";
import {
  ActionError,
  GasNote,
  PaidFallbackPrompt,
  nearStr,
  useGasMode,
  usePaidFallback,
} from "@/components/sale-common/relay";
import { Button, ButtonLink } from "@/components/ui/button";
import { Countdown, SimulatedNote, TxLink } from "@/components/ui/bits";
import { Price } from "@/components/ui/price";
import { Skeleton } from "@/components/ui/skeleton";
import { KV, Progress } from "@/components/ui/stat";
import { getClient } from "@/lib/client";
import { OUTLAYER_COMPUTE_DEPOSIT, invalidBidPenalty } from "@/lib/client/rules";
import { cn } from "@/lib/cn";
import { ago, dateTime, duration, priceStr, shortHash, usdcStr } from "@/lib/format";
import { useAction, useBidSecret, useCloseDeposit, useNow, useResult } from "@/lib/hooks";
import { locksTokens } from "@/lib/liquidity";
import { focusEl, scrollToEl } from "@/lib/scroll";
import type { BidRecord, Sale, SaleStatus, StepState, WriteOptions } from "@/lib/types";
import { useWallet } from "@/lib/wallet";
import { ImportSecrets } from "./bid-secret";
import { ClearingSteps, resultHref, useClock, useRevealHandoff } from "./clearing-moment";
import { HeroCountdown } from "./hero-countdown";
import { PhaseTimeline } from "./phase-timeline";
import { PublicStats } from "./public-stats";
import { RevealReminder } from "./reveal-reminder";

/**
 * The page's main block, set like the home page's featured sale. Every phase
 * fills the same frame: the phase row, a label over one large number (the
 * countdown, or the clearing price), one line that says what state the sale is
 * in, at most one primary action, and four public numbers.
 *
 * Every action says how it is paid for before it is pressed: bids, reveals,
 * clearing on chain, refund mode and payouts are gasless (the relayer pays),
 * closing a sale is a wallet transaction that may attach NEAR.
 */
/** What the polite live region says when the sale moves to a new phase. */
const PHASE_SAID: Record<SaleStatus, string> = {
  upcoming: "The bid window has not opened yet.",
  open: "The bid window is open.",
  awaiting_close: "The bid window has ended. Anyone can close the sale.",
  clearing: "Sale closed. The enclave is clearing.",
  revealing: "Sale closed. The reveal window is open.",
  settled: "The sale has settled. Everyone who won paid the same price.",
  failed: "The sale is refunding. Every bidder can claim their deposit back.",
};

export function StatusPanel({
  sale,
  account,
  hasBid = false,
  myBid = null,
  bids,
}: {
  sale: Sale;
  account: string | null;
  /** The connected account already has a bid in this sale. */
  hasBid?: boolean;
  /** That bid, for the reveal step of a commit-reveal sale. */
  myBid?: BidRecord | null;
  /** The page's bid list (sale-page.tsx polls it once), for the reveal count. */
  bids?: BidRecord[];
}) {
  const now = useNow(5000);
  const commit = sale.config.revealMode === "commit_reveal";
  const stalled =
    sale.status === "clearing" && now > (sale.closedAt ?? sale.config.bidEnd) + sale.config.settleTimeoutMs;
  // Watched the enclave clear it: take the viewer to the reveal on the result page.
  const handoff = useRevealHandoff(sale);

  // A phase change unmounts the button that caused it (Close sale, Switch to
  // refunds). If focus fell to the page body, put it on the new statement.
  const titleRef = useRef<HTMLHeadingElement>(null);
  const prev = useRef(sale.status);
  useEffect(() => {
    if (prev.current === sale.status) return;
    prev.current = sale.status;
    const a = document.activeElement;
    if (a && a !== document.body) return;
    focusEl(document.getElementById(STATEMENT_ID) ?? titleRef.current);
  }, [sale.status]);

  return (
    <section className="panel overflow-hidden" aria-labelledby="sale-status-title">
      <h2 id="sale-status-title" ref={titleRef} tabIndex={-1} className="sr-only">
        Sale status
      </h2>
      <p className="sr-only" aria-live="polite">
        {PHASE_SAID[sale.status]}
      </p>
      <div className="p-5 sm:p-8">
        <PhaseTimeline status={sale.status} stalled={stalled} commit={commit} />
        <div className="mt-6 sm:mt-8">
          {sale.status === "upcoming" && <Upcoming sale={sale} account={account} />}
          {sale.status === "open" && <Open sale={sale} hasBid={hasBid} />}
          {sale.status === "awaiting_close" && <AwaitingClose sale={sale} account={account} />}
          {sale.status === "clearing" && <Clearing sale={sale} account={account} />}
          {sale.status === "revealing" && <Revealing sale={sale} account={account} myBid={myBid} bids={bids} />}
          {handoff ? (
            <ResultIsIn sale={sale} />
          ) : (
            (sale.status === "settled" || sale.status === "failed") && <Done sale={sale} account={account} />
          )}
        </div>
      </div>
      {/* The page's one "simulated" disclosure. */}
      {getClient().mode === "mock" && (
        <SimulatedNote className="border-t border-line px-5 py-3 sm:px-8">
          Simulated chain, accounts and enclave, in your browser. Bid encryption and the clearing math are real.
        </SimulatedNote>
      )}
    </section>
  );
}

// ---------- the frame every phase fills ----------

const HERO = "num text-num-hero text-fg max-[359px]:text-num-xl";

/** A label over the one large number of the phase. Everything else goes below it as children. */
function Frame({ label, hero, children }: { label: React.ReactNode; hero: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-label text-subtle">{label}</div>
      <div className={cn(HERO, "mt-2")}>{hero}</div>
      {children}
    </div>
  );
}

const STATEMENT_ID = "sale-status-headline";

const TONE = { neutral: "text-fg", warn: "text-warn", bad: "text-bad" } as const;

/** The one line that says what state the sale is in. Focus lands here after a phase change. */
function Statement({ tone = "neutral", children }: { tone?: keyof typeof TONE; children: React.ReactNode }) {
  return (
    <h3 id={STATEMENT_ID} tabIndex={-1} className={cn("mt-4 text-small font-[510] outline-none", TONE[tone])}>
      {children}
    </h3>
  );
}

/** One sentence of consequence under the statement. */
function Detail({ children }: { children: React.ReactNode }) {
  return <p className="mt-1 max-w-[62ch] text-small text-muted">{children}</p>;
}

const Fg = ({ children }: { children: React.ReactNode }) => <span className="num text-fg">{children}</span>;

/** The frozen bid set's hash, for anyone checking the clearing against it. */
function BidSetHash({ sale }: { sale: Sale }) {
  return (
    <p className="mt-2 text-label text-subtle">
      Bid set hash{" "}
      <span className="num text-muted" title={sale.bidSetHash ?? undefined}>
        {sale.bidSetHash ? shortHash(sale.bidSetHash, 8) : "pending"}
      </span>
    </p>
  );
}

// ---------- actions anyone may send ----------

function Signer({ account }: { account: string | null }) {
  const { mode } = useWallet();
  return (
    <p className="text-label text-subtle">
      {account ? (
        <>
          Signed by <span className="num text-muted">{account}</span>
        </>
      ) : mode === "mock" ? (
        <>No wallet needed. Sent as anyone.testnet.</>
      ) : (
        <>Anyone can send this. It needs a connected wallet to sign.</>
      )}
    </p>
  );
}

/**
 * One button for a call anyone may push (close, clear on chain, refund mode,
 * creator payout). It signs as the connected account; on the simulated chain a
 * stand-in account does when none is connected, and on a real chain the button
 * asks for a wallet first.
 *
 * `gasless` calls go through the relayer: the line under the button says who
 * pays, a refusal after signing asks before the wallet is asked again, and a
 * call that may still land blocks a second send. A wallet-only call shows
 * `note` there instead (what it attaches).
 */
function PushAction({
  account,
  label,
  connectLabel,
  variant = "primary",
  size = "lg",
  subject,
  gasless = true,
  note,
  run,
  className,
}: {
  account: string | null;
  label: string;
  /** The button's words while no wallet is connected on a real chain. */
  connectLabel: string;
  /** `danger` for a call that cannot be undone. */
  variant?: "primary" | "tactile" | "danger";
  size?: "md" | "lg";
  /** The call as a noun, for "the … may still land" and "send … myself": "close", "clearing". */
  subject: string;
  gasless?: boolean;
  note?: React.ReactNode;
  run: (caller: string, opts: WriteOptions) => Promise<unknown>;
  className?: string;
}) {
  const { mode, connect, connecting } = useWallet();
  const caller = account ?? (mode === "mock" ? "anyone.testnet" : null);
  const gas = useGasMode();
  const fallback = usePaidFallback(gasless && gas.paidBy === "user" ? gas.reason : null);
  const { onPaidFallback } = fallback;
  const action = useAction(async () => {
    if (!caller) throw new Error("Connect a wallet to sign this.");
    return run(caller, { onPaidFallback });
  });
  // The last attempt may still land: no second attempt until the chain has spoken.
  const inDoubt = !!action.errorDetails?.maybeSubmitted;

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div className="flex flex-col gap-x-4 gap-y-2.5 sm:flex-row sm:items-center">
        {caller ? (
          <Button
            variant={variant}
            size={size}
            onClick={() => void action.run()}
            loading={action.pending}
            disabled={inDoubt}
            className="max-sm:h-11 max-sm:w-full"
          >
            {inDoubt ? "Checking the chain" : label}
          </Button>
        ) : (
          <Button
            variant={variant}
            size={size}
            onClick={() => void connect()}
            loading={connecting}
            icon={<Wallet className="size-4" strokeWidth={1.75} />}
            className="max-sm:h-11 max-sm:w-full"
          >
            {connectLabel}
          </Button>
        )}
        <Signer account={account} />
      </div>
      {gasless ? <GasNote what={`The ${subject}`} /> : note}
      <PaidFallbackPrompt fallback={fallback} what={`the ${subject}`} />
      <ActionError info={action.errorDetails} what={subject} />
    </div>
  );
}

// ---------- upcoming ----------

function Upcoming({ sale, account }: { sale: Sale; account: string | null }) {
  const c = sale.config;
  const toFund = () => {
    const el = document.getElementById("fund");
    scrollToEl(el);
    focusEl(el?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]'));
  };
  return (
    <>
      <Frame label="Opens in" hero={<HeroCountdown to={c.bidStart} />}>
        <p className="mt-4 text-small text-muted">
          Opens{" "}
          <span className="num text-fg" suppressHydrationWarning>
            {dateTime(c.bidStart)}
          </span>{" "}
          and runs for <Fg>{duration(c.bidEnd - c.bidStart)}</Fg>.
        </p>
        <RevealReminder sale={sale} className="mt-3" />
        <div className="mt-4 sm:mt-5">
          <Button size="lg" onClick={toFund} className="max-sm:w-full">
            Fund your account
          </Button>
        </div>
      </Frame>
      {sale.chainStatus === "setup" && <Setup sale={sale} account={account} />}
      <PublicStats sale={sale} className="mt-6 sm:mt-8" />
    </>
  );
}

const STEP_WORD: Record<StepState, { word: string; tone: string }> = {
  pending: { word: "In progress", tone: "text-warn" },
  done: { word: "Done", tone: "text-ok" },
  failed: { word: "Failed", tone: "text-bad" },
};

/**
 * A real contract finishes creating a sale in follow-up steps: it deploys the
 * token and, for a TEE sale, asks the enclave for the sale's key. Until both
 * are done nobody can bid. A failed step can be retried by anyone.
 */
function Setup({ sale, account }: { sale: Sale; account: string | null }) {
  const token = sale.tokenSetup ?? "pending";
  const key = sale.sealerKeySetup ?? "pending";
  const tee = sale.config.revealMode === "tee";
  const failed = token === "failed" || (tee && key === "failed");
  const step = (s: StepState) => <span className={cn("font-sans", STEP_WORD[s].tone)}>{STEP_WORD[s].word}</span>;
  return (
    <div className="mt-6 border-t border-line pt-5">
      <div className={cn("text-small font-[510]", failed ? "text-bad" : "text-fg")}>
        {failed ? "Setting up this sale failed part way" : "This sale is still being set up"}
      </div>
      <p className="mt-1 text-small text-muted">
        Bidding opens only once {tee ? "both steps are" : "the token is"} done.
      </p>
      <dl className="mt-2 max-w-[440px] divide-y divide-line">
        <KV
          k={
            <>
              Token contract <span className="num text-subtle [overflow-wrap:anywhere]">{sale.tokenAccount}</span>
            </>
          }
          v={step(token)}
        />
        {tee && <KV k="Sale key from the enclave" v={step(key)} />}
      </dl>
      {failed && (
        <PushAction
          className="mt-4"
          account={account}
          label="Retry setup"
          connectLabel="Connect a wallet to retry"
          subject="retry"
          gasless={false}
          note={
            <p className="text-label text-subtle">
              A wallet transaction, never relayed.
              {tee && key === "failed" && (
                <>
                  {" "}
                  It attaches <span className="num text-muted">{nearStr(OUTLAYER_COMPUTE_DEPOSIT)} NEAR</span> for the
                  key request; OutLayer returns what it does not use.
                </>
              )}
            </p>
          }
          run={(caller) => getClient().retrySetup(sale.id, caller)}
        />
      )}
    </div>
  );
}

// ---------- open ----------

function Open({ sale, hasBid }: { sale: Sale; hasBid: boolean }) {
  const now = useNow(1000);
  const c = sale.config;
  const commit = c.revealMode === "commit_reveal";
  // The page's main action, on the first screen: jump to the form and put the
  // cursor in Max price (or show the bid already placed).
  const toBid = () => {
    const el = document.getElementById("bid");
    scrollToEl(el);
    if (!hasBid) focusEl(el?.querySelector<HTMLInputElement>("input:not([type=hidden])"));
  };
  return (
    <>
      <Frame label="Closes in" hero={<HeroCountdown to={c.bidEnd} />}>
        <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2">
          <Progress
            value={now - c.bidStart}
            max={c.bidEnd - c.bidStart}
            label="Share of the bid window passed"
            className="max-w-[280px] min-w-[96px] flex-1"
          />
          <span className="text-label text-subtle">
            Closes{" "}
            <span className="num" suppressHydrationWarning>
              {dateTime(c.bidEnd)}
            </span>
          </span>
        </div>
        <RevealReminder sale={sale} className="mt-3" />
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2.5 sm:mt-5">
          <Button variant={hasBid ? "tactile" : "primary"} size="lg" onClick={toBid} className="max-sm:w-full">
            {hasBid ? "See your bid" : commit ? "Place a committed bid" : "Place a sealed bid"}
          </Button>
          {hasBid ? (
            <span className="text-small text-ok">{commit ? "Your committed bid is in." : "Your sealed bid is in."}</span>
          ) : (
            <span className="text-small text-muted">Bidding early gives no edge. Everyone pays one price.</span>
          )}
        </div>
      </Frame>
      <PublicStats sale={sale} className="mt-6 sm:mt-8" />
    </>
  );
}

// ---------- close ----------

/**
 * What close_sale costs, before the wallet asks. It is a wallet transaction
 * (never relayed) and, for a TEE sale with bids, attaches the deposit that
 * pays OutLayer for the enclave run (get_close_deposit); the closer gets back
 * what the run does not use. A commit-reveal sale attaches nothing.
 */
function CloseCost({ sale }: { sale: Sale }) {
  const { mode } = useWallet();
  const deposit = useCloseDeposit(sale.id);
  const tee = sale.config.revealMode === "tee";
  if (mode === "mock") {
    return (
      <p className="max-w-[62ch] text-label text-subtle">
        {tee ? (
          <>
            On NEAR the closer&apos;s wallet attaches a deposit for the enclave run, from{" "}
            <span className="num text-muted">{nearStr(OUTLAYER_COMPUTE_DEPOSIT)} NEAR</span>, and gets back what the run
            does not use. The simulated chain charges nothing.
          </>
        ) : (
          <>On NEAR the closer&apos;s wallet signs this and attaches no deposit. The simulated chain charges nothing.</>
        )}
      </p>
    );
  }
  if (deposit.data === undefined) {
    return (
      <p className="text-label text-subtle">
        {deposit.error ? `Could not read the deposit: ${deposit.error.message}` : "Reading what closing attaches…"}
      </p>
    );
  }
  return (
    <p className="max-w-[62ch] text-label text-subtle">
      A wallet transaction, never relayed: you pay the network fee.{" "}
      {deposit.data > 0n ? (
        <>
          It attaches <span className="num text-fg">{nearStr(deposit.data)} NEAR</span> for the enclave run. OutLayer
          returns what the run does not use.
        </>
      ) : (
        <>It attaches no deposit.</>
      )}
    </p>
  );
}

function AwaitingClose({ sale, account }: { sale: Sale; account: string | null }) {
  const now = useNow(1000);
  const commit = sale.config.revealMode === "commit_reveal";
  return (
    <>
      <Frame label="Bid window ended" hero={<span suppressHydrationWarning>{ago(sale.config.bidEnd, now)}</span>}>
        <Statement>Anyone can close this sale now.</Statement>
        <Detail>
          Closing freezes the <Fg>{sale.bidCount}</Fg> {commit ? "committed" : "sealed"} bids on chain, stores their
          hash and {commit ? "opens the reveal window" : "sends them to the enclave to clear"}. One transaction.
        </Detail>
        <PushAction
          className="mt-5 sm:mt-6"
          account={account}
          label="Close sale"
          connectLabel="Connect a wallet to close"
          subject="close"
          gasless={false}
          note={<CloseCost sale={sale} />}
          run={(caller) => getClient().closeSale(sale.id, caller)}
        />
      </Frame>
      <PublicStats sale={sale} className="mt-6 sm:mt-8" />
    </>
  );
}

// ---------- refund mode ----------

/**
 * After the settle timeout: the way out that needs nobody's cooperation. It
 * cannot be undone, so the button is a danger action.
 */
function Refund({ sale, account }: { sale: Sale; account: string | null }) {
  return (
    <div className="mt-6 border-t border-line pt-5">
      <div className="text-small font-[510] text-fg">Switch this sale to refunds</div>
      <p className="mt-1 max-w-[62ch] text-small text-muted">
        Every bidder can then claim their full deposit back, with no penalty. No tokens are sold
        {sale.config.revealMode === "tee" ? ", and no prices are ever opened" : ""}. Anyone can trigger it, and it
        cannot be undone.
      </p>
      <PushAction
        className="mt-4"
        account={account}
        label="Switch to refunds"
        connectLabel="Connect a wallet to switch"
        variant="danger"
        subject="switch to refunds"
        run={(caller, opts) => getClient().triggerRefundMode(sale.id, caller, opts)}
      />
    </div>
  );
}

// ---------- clearing (TEE) ----------

/**
 * The close of a sealed sale as the moment it is: how many bids the enclave
 * is opening, how long since the close (a plain text timer, right after a
 * hidden tab comes back too), and the three steps of the close. A watcher is
 * taken to the result's reveal when it settles (useRevealHandoff). A failed
 * run can be retried; past the settle timeout, refunds are next.
 */
function Clearing({ sale, account }: { sale: Sale; account: string | null }) {
  const now = useClock(1000);
  const closedAt = sale.closedAt ?? sale.config.bidEnd;
  const due = sale.refundModeFrom ?? closedAt + sale.config.settleTimeoutMs;
  const timedOut = now > due;
  // A real contract's "closed": the last clearing attempt ended without a
  // result (the run failed or timed out), and close_sale asks again.
  const retry = sale.chainStatus === "closed";
  const n = sale.bidCount;
  const dueAt = (
    <span className="num text-fg" suppressHydrationWarning>
      {dateTime(due)}
    </span>
  );

  return (
    <>
      <Frame
        label={
          timedOut ? (
            "Settle timeout passed"
          ) : (
            <>
              {retry ? "Clearing" : "Opening"} <span className="num">{n.toLocaleString("en-US")}</span> sealed{" "}
              {n === 1 ? "bid" : "bids"} in the enclave
            </>
          )
        }
        hero={
          <>
            <span suppressHydrationWarning>{timedOut ? duration(now - due) : duration(now - closedAt)}</span>
            <span className="ml-2 text-label font-normal tracking-normal text-subtle">
              {timedOut ? "ago" : "since the close"}
            </span>
          </>
        }
      >
        <Statement tone={timedOut ? "bad" : retry ? "warn" : "neutral"}>
          {retry
            ? "The last clearing attempt gave no result."
            : timedOut
              ? "The enclave has not answered, so refunds are next."
              : "The contract sent the frozen bid set to the attested enclave job."}
        </Statement>
        <Detail>
          {retry ? (
            <>
              Nothing is lost: the bid set stays frozen, and anyone can ask the enclave again.
              {!timedOut && <> With no result by {dueAt}, anyone can switch the sale to full refunds.</>}
            </>
          ) : timedOut ? (
            <>
              It has been silent for <Fg>{duration(now - closedAt)}</Fg>, past the{" "}
              <Fg>{duration(sale.config.settleTimeoutMs)}</Fg> timeout. Anyone can switch the sale to full refunds
              below; every bidder then claims their deposit on the result page.
            </>
          ) : (
            <>
              The enclave opens every bid and computes one price. The result comes back on chain, and the contract
              checks it before it settles. With no result by {dueAt} (in <Countdown to={due} className="text-fg" />
              ), anyone can switch the sale to full refunds.
            </>
          )}
        </Detail>
        <ClearingSteps
          sale={sale}
          state={timedOut ? "timed_out" : retry ? "failed" : "running"}
          className="mt-5 sm:mt-6"
        />
        {retry && (
          <PushAction
            className="mt-5 sm:mt-6"
            account={account}
            label="Ask the enclave again"
            connectLabel="Connect a wallet to retry"
            variant={timedOut ? "tactile" : "primary"}
            subject="retry"
            gasless={false}
            note={<CloseCost sale={sale} />}
            run={(caller) => getClient().closeSale(sale.id, caller)}
          />
        )}
      </Frame>
      {timedOut && <Refund sale={sale} account={account} />}
      <PublicStats sale={sale} className="mt-6 sm:mt-8" />
    </>
  );
}

// ---------- reveal, then clear on chain (commit-reveal) ----------

/**
 * A commit-reveal sale after its close. While the reveal window is open each
 * bidder publishes the terms they committed to; once it has ended anyone can
 * have the contract clear the sale itself. A bid that was not revealed is void
 * and loses 1 % of its deposit, so the bidder's own step comes first here.
 */
function Revealing({
  sale,
  account,
  myBid,
  bids,
}: {
  sale: Sale;
  account: string | null;
  myBid: BidRecord | null;
  bids: BidRecord[] | undefined;
}) {
  const now = useNow(1000);
  const revealed = bids ? bids.filter((b) => b.revealed).length : null;
  const closedAt = sale.closedAt ?? sale.config.bidEnd;
  const revealEnd = sale.revealEnd ?? closedAt + (sale.config.revealWindowMs ?? 10 * 60_000);
  const open = now < revealEnd;
  const due = sale.refundModeFrom ?? revealEnd + sale.config.settleTimeoutMs;
  const timedOut = now > due;

  return (
    <>
      <Frame
        label={open ? "Reveal window closes in" : "Reveal window ended"}
        hero={open ? <HeroCountdown to={revealEnd} /> : <span suppressHydrationWarning>{ago(revealEnd, now)}</span>}
      >
        <Statement>
          {open ? "Bidders are revealing their bids." : "Anyone can clear this sale now."}
        </Statement>
        <Detail>
          {open ? (
            <>
              A bid not revealed by{" "}
              <span className="num text-fg" suppressHydrationWarning>
                {dateTime(revealEnd)}
              </span>{" "}
              is void and loses 1&nbsp;% of its deposit.
            </>
          ) : (
            "The contract runs the clearing rule on the revealed bids and finds one price. Bids that were not revealed are void and lose 1\u00a0% of their deposit."
          )}
        </Detail>
        <BidSetHash sale={sale} />
        {!open && (
          <PushAction
            className="mt-5 sm:mt-6"
            account={account}
            label="Clear on chain"
            connectLabel="Connect a wallet to clear"
            subject="clearing"
            run={(caller, opts) => getClient().clearOnchain(sale.id, caller, opts)}
          />
        )}
        {open && account && myBid && <MyReveal sale={sale} account={account} bid={myBid} />}
        {open && !(account && myBid) && (
          <p className="mt-5 text-small text-subtle sm:mt-6">
            {account
              ? "This account has no bid in this sale, so there is nothing for you to reveal."
              : "Did you bid? Connect the wallet you bid with to reveal it."}
          </p>
        )}
      </Frame>
      {timedOut && <Refund sale={sale} account={account} />}
      <PublicStats sale={sale} revealed={revealed} className="mt-6 sm:mt-8" />
    </>
  );
}

/** The connected bidder's reveal: the one thing they must do in a commit-reveal sale. */
function MyReveal({ sale, account, bid }: { sale: Sale; account: string; bid: BidRecord }) {
  const secret = useBidSecret(sale.id, account);
  const gas = useGasMode();
  const fallback = usePaidFallback(gas.paidBy === "user" ? gas.reason : null);
  const { onPaidFallback } = fallback;
  const reveal = useAction(() => getClient().revealBid(sale.id, account, undefined, { onPaidFallback }));
  const inDoubt = !!reveal.errorDetails?.maybeSubmitted;
  const penalty = invalidBidPenalty(bid.deposit);

  if (bid.revealed) {
    return (
      <p className="mt-5 text-small text-muted sm:mt-6" role="status">
        <span className="font-[510] text-ok">Your bid is revealed.</span> Nothing more to do until the window ends.
      </p>
    );
  }

  if (!secret) {
    return (
      <div className="mt-6 border-t border-line pt-5">
        <div className="text-small font-[510] text-warn">This browser cannot reveal your bid</div>
        <p className="mt-1 max-w-[62ch] text-small text-muted">
          The max price, max spend and salt you committed to were saved only in the browser you bid from. If the bid is
          not revealed before the window ends it is void, and <Fg>{usdcStr(penalty, 6)} USDC</Fg> (1&nbsp;%) of your{" "}
          <Fg>{usdcStr(bid.deposit, 6)} USDC</Fg> deposit is kept.
        </p>
        <p className="mt-2 max-w-[62ch] text-small text-muted">
          Reveal from that browser, or press &quot;Back up reveal secret&quot; under My bid there and import the file
          here.
        </p>
        <ImportSecrets className="mt-4" variant="primary" size="lg" />
      </div>
    );
  }

  return (
    <div className="mt-5 sm:mt-6">
      <dl className="max-w-[340px] divide-y divide-line border-y border-line">
        <KV k="Your max price" v={`${priceStr(BigInt(secret.maxPrice))} USDC`} />
        <KV k="Your max spend" v={`${usdcStr(BigInt(secret.maxSpend), 6)} USDC`} />
      </dl>
      <p className="mt-3 max-w-[62ch] text-small text-muted">
        Revealing publishes both. Without a reveal your bid is void and loses <Fg>{usdcStr(penalty, 6)} USDC</Fg> (1&nbsp;%
        of its deposit).
      </p>
      <div className="mt-4 flex flex-col gap-3">
        <Button
          variant="primary"
          size="lg"
          onClick={() => void reveal.run()}
          loading={reveal.pending}
          disabled={inDoubt}
          className="self-start max-sm:w-full"
        >
          {inDoubt ? "Checking the chain" : "Reveal my bid"}
        </Button>
        <GasNote what="Revealing" />
        <PaidFallbackPrompt fallback={fallback} what="the reveal" />
        <ActionError info={reveal.errorDetails} what="reveal" />
      </div>
    </div>
  );
}

// ---------- settled or refunding ----------

/**
 * The sale settled while this page watched it clear. The viewer is on the way
 * to the result's reveal (useRevealHandoff), so the price is not shown here
 * first; the button covers a tab that was hidden or a move that did not happen.
 */
function ResultIsIn({ sale }: { sale: Sale }) {
  return (
    <>
      <Frame label="The enclave has answered" hero="Result is in">
        <Statement>Opening the reveal on the result page.</Statement>
        <Detail>Every winner pays one clearing price. The contract checked the result before it settled.</Detail>
        <div className="mt-5 sm:mt-6">
          <ButtonLink href={resultHref(sale.id)} variant="primary" size="lg" className="max-sm:w-full">
            See the result
          </ButtonLink>
        </div>
      </Frame>
      <PublicStats sale={sale} className="mt-6 sm:mt-8" />
    </>
  );
}

const FAIL_TEXT: Record<string, string> = {
  below_min_raise: "The minimum raise was not met.",
  no_valid_bids: "There were no valid bids.",
  settle_timeout: "No clearing result arrived before the settle timeout.",
};

function Done({ sale, account }: { sale: Sale; account: string | null }) {
  const { data: result, loading } = useResult(sale.id);
  const failed = sale.status === "failed";
  const href = `/sale/${encodeURIComponent(sale.id)}/result`;
  const now = useNow(5000);
  // A real contract does not record when the sale settled.
  const at = sale.settledAt;
  const when = at !== null && <span suppressHydrationWarning>{ago(at, Math.max(now, at))}</span>;
  const penalties = result?.totalPenalties ?? 0n;
  const tokensLocked = locksTokens(result?.liquidity);
  const proceeds = result?.proceeds;
  const tokenSetupPending = sale.tokenSetup === "pending";
  const unpaid =
    !!proceeds && (!proceeds.raisePaid ||
      (!tokenSetupPending && !(proceeds.allocationPaid && proceeds.unsoldBurned && proceeds.reserveReturned)));
  // The number waits for the result, so a refund total never shows before its penalties are known.
  const waiting = loading && !result;
  const pending = <Skeleton className="inline-block h-[0.8em] w-[4.5em] align-baseline" />;
  // After a payout that burned the unsold tokens: the burn moment, once the views confirm it.
  const burn = useBurnCapture(sale, result);

  return (
    <>
      {failed ? (
        <Frame
          label={penalties > 0n ? "Refundable, after penalties" : "Refundable in full"}
          hero={waiting ? pending : <Price value={usdcStr(sale.totalDeposits - penalties)} unit="USDC" />}
        >
          <Statement tone="bad">
            {result
              ? (result.failReason && FAIL_TEXT[result.failReason]) || "A contract check failed."
              : "This sale is refunding."}
          </Statement>
          <Detail>
            Every bidder can claim their deposit back on the result page.
            {penalties > 0n && (
              <>
                {" "}
                Void bids come back less the 1&nbsp;% penalty, <Fg>{usdcStr(penalties, 6)} USDC</Fg> in all.
              </>
            )}
            {when && <> Refunds opened {when}.</>}
          </Detail>
          {result?.settleTx && <TxLink hash={result.settleTx} prefix="settle tx" className="mt-2" />}
          <div className="mt-5 sm:mt-6">
            <ButtonLink href={href} variant="primary" size="lg" className="max-sm:w-full">
              See the refunds
            </ButtonLink>
          </div>
        </Frame>
      ) : (
        <Frame
          label="Clearing price"
          hero={waiting ? pending : result ? <Price value={priceStr(result.clearingPrice)} unit="USDC" /> : "–"}
        >
          <Statement>Every winner paid this price.</Statement>
          <Detail>
            {tokensLocked
              ? "Claim any unspent USDC now. Sale tokens unlock when the launch pool is seeded or abandoned."
              : "Claim your tokens and any unspent USDC on the result page."}
            {when && <> Settled {when}.</>}
          </Detail>
          <div className="mt-5 sm:mt-6">
            <ButtonLink href={href} variant="primary" size="lg" className="max-sm:w-full">
              See the result
            </ButtonLink>
          </div>
        </Frame>
      )}

      {(unpaid || proceeds?.allocationLocked) && (
        <div className="mt-6 border-t border-line pt-5">
          <div className="text-small font-[510] text-fg">{unpaid ? "Creator payout available" : "Creator tokens locked"}</div>
          <p className="mt-1 max-w-[62ch] text-small text-muted">
            {unpaid && proceeds && (
              <>
                Anyone can send the available payout to <Fg>{sale.creator}</Fg>.
                {!proceeds.raisePaid && " The payout includes the creator’s share of the raise."}
                {!tokenSetupPending && !proceeds.allocationPaid && !proceeds.allocationLocked && " It includes the creator’s token allocation."}
                {!tokenSetupPending && !proceeds.reserveReturned && " Any unused NEAR reserve is returned."}
                {!tokenSetupPending && !proceeds.unsoldBurned && " Unsold tokens are burned."}
              </>
            )}
            {proceeds?.allocationLocked && " The creator’s token allocation unlocks when the launch pool is seeded or abandoned."}
          </p>
          {unpaid && <PushAction
            className="mt-4"
            account={account}
            label="Pay out the creator"
            connectLabel="Connect a wallet to pay out"
            variant="tactile"
            size="md"
            subject="payout"
            run={(caller, opts) => burn.capture(() => getClient().claimProceeds(sale.id, caller, opts))}
          />}
        </div>
      )}
      {burn.moment && <BurnMoment sale={sale} moment={burn.moment} />}
      <PublicStats sale={sale} result={result} className="mt-6 sm:mt-8" />
    </>
  );
}
