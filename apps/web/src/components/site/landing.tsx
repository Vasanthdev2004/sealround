import Link from "next/link";
import { ArrowRight, ArrowUpRight, Check, Cpu, Globe, Lock, Play, ShieldCheck } from "lucide-react";
import arena from "@/data/arena-results.json";
import { ButtonLink } from "@/components/ui/button";
import { Reveal } from "@/components/visual/reveal";
import { REPO_URL, appHref } from "@/lib/site";
import { BidField } from "./bid-field";
import { ArenaBars, ChecksDemo, SwapRoute, type ArenaMetric } from "./proof";
import { EnclaveVisual, LedgerVisual, OnePriceVisual, SealVisual } from "./step-visuals";

const wrap = "mx-auto w-full max-w-[1240px] px-4 sm:px-6 lg:px-8";

/** The landing page at `/`. Everything it claims links to the app page that shows it. */
export function Landing() {
  return (
    <>
      <Hero />
      <BuiltOn />
      <Problem />
      <Steps />
      <Verify />
      <Launch />
      <FinalCta />
    </>
  );
}

function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div className="hero-backdrop" aria-hidden />
      <div className={`${wrap} relative flex flex-col items-center pt-16 text-center sm:pt-24`}>
        <Link
          href={appHref("/how")}
          className="anim-blur group inline-flex h-8 items-center gap-2 rounded-full border border-line bg-elev/60 pr-3 pl-1.5 text-label text-muted backdrop-blur transition-colors hover:border-line-strong hover:text-fg"
        >
          <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11.5px] font-[510] text-accent-bright">New</span>
          Bids opened in a TEE on NEAR
          <ArrowRight className="size-3.5 transition-transform duration-200 group-hover:translate-x-0.5" aria-hidden />
        </Link>
        <h1 className="mt-6 text-display text-fg sm:text-[clamp(3rem,1.6rem+4.4vw,5.25rem)]">
          <span className="anim-blur block" style={{ "--i": 1 } as React.CSSProperties}>
            Sealed bids.
          </span>
          <span className="anim-blur block text-accent-bright" style={{ "--i": 2 } as React.CSSProperties}>
            One price.
          </span>
        </h1>
        <p className="anim-blur mt-6 max-w-[48ch] text-lead text-muted" style={{ "--i": 3 } as React.CSSProperties}>
          Token sales where bots and people pay the same price. Every bid stays encrypted until the sale closes, then
          an enclave sets one clearing price for every winner.
        </p>
        <div className="anim-blur mt-8 flex flex-wrap justify-center gap-3" style={{ "--i": 4 } as React.CSSProperties}>
          <ButtonLink href={appHref()} variant="primary" size="lg">
            Launch app <ArrowRight className="size-4" aria-hidden />
          </ButtonLink>
          <ButtonLink href={appHref("/judge")} size="lg" icon={<Play className="size-4" aria-hidden />}>
            Watch a sale clear
          </ButtonLink>
        </div>
      </div>
      <div className={`${wrap} relative mt-14 sm:mt-16`}>
        <div className="anim-stage stage-glow panel mx-auto max-w-[1080px] overflow-hidden rounded-stage">
          <BidField />
        </div>
      </div>
    </section>
  );
}

function BuiltOn() {
  const items = [
    { icon: Globe, label: "NEAR Protocol", note: "Contract and settlement" },
    { icon: Cpu, label: "OutLayer TEE", note: "Opens bids at close" },
    { icon: ArrowUpRight, label: "NEAR Intents", note: "Fund from other chains" },
  ];
  return (
    <section className={`${wrap} mt-20 sm:mt-24`}>
      <Reveal className="grid gap-px overflow-hidden rounded-panel border border-line bg-line sm:grid-cols-3">
        {items.map(({ icon: Icon, label, note }) => (
          <div key={label} className="flex items-center gap-3 bg-bg px-5 py-4">
            <Icon className="size-4 shrink-0 text-muted" strokeWidth={1.75} aria-hidden />
            <span className="text-small font-[510] text-fg">{label}</span>
            <span className="ml-auto text-label text-subtle">{note}</span>
          </div>
        ))}
      </Reveal>
    </section>
  );
}

function SectionTitle({ title, lead, children }: { title: React.ReactNode; lead?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <Reveal className="flex flex-wrap items-end justify-between gap-x-10 gap-y-4">
      <div className="max-w-[44rem]">
        <h2 className="text-h1 text-fg">{title}</h2>
        {lead && <p className="mt-4 text-lead text-muted">{lead}</p>}
      </div>
      {children}
    </Reveal>
  );
}

const usd = (n: number) => `${Math.round(n).toLocaleString("en-US")} USDC`;
const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
const times = (n: number) => `${n.toFixed(2)}×`;

function Problem() {
  const s = arena.summary;
  const metric = (
    title: string,
    note: string,
    key: "botProfit" | "botShare" | "premium",
    fmt: (n: number) => string,
  ): ArenaMetric => ({
    title,
    note,
    rows: [
      { label: "Bonding curve", value: s.bonding_curve[key].mean, text: fmt(s.bonding_curve[key].mean), tone: "bonding" },
      { label: "First come, fixed price", value: s.fixed_price[key].mean, text: fmt(s.fixed_price[key].mean), tone: "fixed" },
      { label: "Sealround", value: s.fairground[key].mean, text: fmt(s.fairground[key].mean), tone: "sealround" },
    ],
  });
  const metrics = [
    metric("Bot profit per launch", "USDC bots make selling to people afterwards", "botProfit", usd),
    metric("Bots' share of supply", "Tokens bots get at launch", "botShare", pct),
    metric("What people pay", "Median price people paid, per price bots paid", "premium", times),
  ];
  return (
    <section className={`${wrap} mt-28 sm:mt-36`}>
      <SectionTitle
        title="Launches are a race. Bots win races."
        lead={`We ran the same crowd of 200 people and 5 sniper bots through three kinds of launch, ${arena.runs} times. On a sealed, single-price sale, being first is worth nothing.`}
      >
        <ButtonLink href={appHref("/arena")} variant="ghost">
          Open the Bot Arena <ArrowRight className="size-4" aria-hidden />
        </ButtonLink>
      </SectionTitle>
      <div className="mt-10">
        <ArenaBars metrics={metrics} />
      </div>
      <p className="mt-4 text-label text-subtle">
        Averages over {arena.runs} seeded simulations, demand from {arena.demandMin}× to {arena.demandMax}× supply.
        Rerun them with <code className="font-mono text-[12px]">pnpm arena</code>.
      </p>
    </section>
  );
}

function Steps() {
  const steps = [
    {
      n: 1,
      title: "Seal your bid in the browser",
      body: "Your max price and max spend are encrypted on your device to the enclave's key. Nobody else can read them.",
      visual: <SealVisual />,
    },
    {
      n: 2,
      title: "Only your deposit is public",
      body: "The chain sees who bid and how much USDC they locked. There is no price column to copy or front-run.",
      visual: <LedgerVisual />,
    },
    {
      n: 3,
      title: "An enclave opens every bid at close",
      body: "When the window ends, an OutLayer TEE decrypts all bids at once and runs the clearing rule. The contract checks its work.",
      visual: <EnclaveVisual />,
    },
    {
      n: 4,
      title: "Every winner pays one price",
      body: "The clearing price is the highest price at which demand covers the supply. Bots and people pay exactly that.",
      visual: <OnePriceVisual />,
    },
  ];
  return (
    <section className={`${wrap} mt-28 sm:mt-36`} id="how">
      <SectionTitle
        title="How a sale works"
        lead="Four steps, the same for everyone. The rules are locked when the sale is created, and there is no admin key."
      />
      <div className="mt-10 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {steps.map((s, i) => (
          <Reveal key={s.n} index={i} className="panel spotlight flex flex-col p-3">
            {s.visual}
            <div className="px-2 pt-4 pb-2">
              <div className="num text-label text-subtle">0{s.n}</div>
              <h3 className="mt-1 text-h3 text-fg">{s.title}</h3>
              <p className="mt-2 text-small text-muted">{s.body}</p>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

function Verify() {
  return (
    <section className={`${wrap} mt-28 sm:mt-36`}>
      <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-16">
        <Reveal>
          <ShieldCheck className="size-6 text-accent-bright" strokeWidth={1.6} aria-hidden />
          <h2 className="mt-4 text-h1 text-fg">Don&apos;t trust the result. Check it.</h2>
          <p className="mt-4 text-lead text-muted">
            Every result page re-runs five checks in your browser: the attested enclave run, its code hash against a
            reproducible build, the sealer key, the bid-set hash and the contract&apos;s own checks.
          </p>
          <ul className="mt-6 flex flex-col gap-2.5 text-small text-muted">
            {[
              "The enclave code is built reproducibly, so anyone can match its hash",
              "The contract refuses a result that does not match the bids it stored",
              "If clearing fails or times out, every deposit can be refunded",
            ].map((t) => (
              <li key={t} className="flex gap-2.5">
                <Check className="mt-0.5 size-4 shrink-0 text-ok" strokeWidth={2.25} aria-hidden />
                {t}
              </li>
            ))}
          </ul>
        </Reveal>
        <Reveal delay={0.1}>
          <ChecksDemo />
        </Reveal>
      </div>
    </section>
  );
}

function Launch() {
  const rules = [
    ["For sale", "600,000 NIGHT"],
    ["Floor price", "0.001 USDC"],
    ["Minimum raise", "50 USDC"],
    ["Bid window", "30 minutes"],
    ["Deposit per account", "1 to 10 USDC"],
    ["Admin key", "None"],
  ];
  return (
    <section className={`${wrap} mt-28 sm:mt-36`}>
      <div className="grid gap-4 lg:grid-cols-2">
        <Reveal className="panel spotlight flex flex-col p-6 sm:p-8">
          <Lock className="size-5 text-muted" strokeWidth={1.6} aria-hidden />
          <h2 className="mt-4 text-h2 text-fg">Launch a sale in two minutes</h2>
          <p className="mt-2 max-w-[46ch] text-small text-muted">
            Pick a supply, a floor price, a minimum raise and a window. The token is minted once with a fixed supply,
            and every rule locks at launch.
          </p>
          <dl className="mt-6 divide-y divide-line border-y border-line">
            {rules.map(([k, v]) => (
              <div key={k} className="flex items-baseline justify-between gap-4 py-2.5">
                <dt className="text-small text-muted">{k}</dt>
                <dd className="num text-small text-fg">{v}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-6">
            <ButtonLink href={appHref("/create")}>
              Launch a sale <ArrowRight className="size-4" aria-hidden />
            </ButtonLink>
          </div>
        </Reveal>
        <Reveal index={1} className="panel spotlight flex flex-col p-6 sm:p-8">
          <Globe className="size-5 text-muted" strokeWidth={1.6} aria-hidden />
          <h2 className="mt-4 text-h2 text-fg">Bid with USDC from other chains</h2>
          <p className="mt-2 max-w-[46ch] text-small text-muted">
            Fund a bid through NEAR Intents 1Click. The swap lands as USDC on NEAR before the bid is sealed, and a
            failed swap refunds to the address you gave.
          </p>
          <div className="mt-6 flex flex-wrap gap-2">
            {["Ethereum", "Base", "Arbitrum", "Solana", "NEAR"].map((c) => (
              <span
                key={c}
                className="inline-flex h-8 items-center rounded-full border border-line bg-elev-2 px-3 text-label text-muted"
              >
                {c}
              </span>
            ))}
          </div>
          <div className="mt-auto pt-6">
            <SwapRoute />
            <p className="mt-2 text-label text-subtle">Live swaps run on mainnet only. The demo previews the route.</p>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section className={`${wrap} mt-28 mb-24 sm:mt-36`}>
      <Reveal className="cta-card relative overflow-hidden rounded-stage border border-line px-6 py-14 text-center sm:px-12 sm:py-20">
        <div className="hero-backdrop" aria-hidden />
        <div className="relative">
          <h2 className="mx-auto max-w-[18ch] text-h1 text-fg">Run a sale bots can&apos;t snipe.</h2>
          <p className="mx-auto mt-4 max-w-[46ch] text-lead text-muted">
            Try it on the simulated chain in your browser. Nothing to install, no wallet needed.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <ButtonLink href={appHref()} variant="primary" size="lg">
              Launch app <ArrowRight className="size-4" aria-hidden />
            </ButtonLink>
            <ButtonLink href={REPO_URL} external size="lg">
              Read the code <ArrowUpRight className="size-4" aria-hidden />
            </ButtonLink>
          </div>
        </div>
      </Reveal>
    </section>
  );
}
