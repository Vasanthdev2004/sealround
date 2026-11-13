import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  Cpu,
  EyeOff,
  Globe,
  KeyRound,
  Layers,
  Lock,
  Play,
  Ruler,
  ShieldCheck,
  X,
} from "lucide-react";
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
      <Compare />
      <Problem />
      <Steps />
      <Unique />
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
          <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11.5px] font-[510] text-accent-bright">
            Fair mode
          </span>
          for token launches on NEAR
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
          Bots can&apos;t snipe what they can&apos;t see. Every bid stays encrypted until the sale closes, an enclave
          opens them all at once, and every winner pays the same clearing price.
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

type Mark = "yes" | "no";

const LAUNCH_TYPES: { name: string; visible: Mark; speed: Mark; onePrice: Mark; how: string; us?: boolean }[] = [
  { name: "Bonding curve", visible: "yes", speed: "yes", onePrice: "no", how: "Buy in the first block, sell to people later" },
  { name: "First come, fixed price", visible: "yes", speed: "yes", onePrice: "yes", how: "The fastest bot takes the supply" },
  { name: "Public auction", visible: "yes", speed: "no", onePrice: "yes", how: "Read every bid, then outbid at the last second" },
  {
    name: "Sealround",
    visible: "no",
    speed: "no",
    onePrice: "yes",
    how: "It can't: there is nothing to read and nothing to race",
    us: true,
  },
];

/** A yes or no cell. The answer that protects buyers is lit; the other is dim. */
function YesNo({ v, good }: { v: Mark; good: Mark }) {
  const ok = v === good;
  const Icon = v === "yes" ? Check : X;
  return (
    <span className={ok ? "inline-flex items-center gap-1.5 text-fg" : "inline-flex items-center gap-1.5 text-subtle"}>
      <Icon className={ok ? "size-4 text-accent-bright" : "size-4"} strokeWidth={2.25} aria-hidden />
      {v === "yes" ? "Yes" : "No"}
    </span>
  );
}

function Compare() {
  return (
    <section className={`${wrap} mt-28 sm:mt-36`}>
      <SectionTitle
        title="Not another launchpad. The fair mode for one."
        lead="Every common way to launch a token rewards whoever is fastest or whoever reads the other bids. Sealround removes both, and any launch can run on it."
      />
      {/* Phones: one block per launch type. The table below takes over from 768px. */}
      <Reveal className="panel mt-10 divide-y divide-line overflow-hidden md:hidden">
        {LAUNCH_TYPES.map((t) => (
          <div key={t.name} className={t.us ? "bg-accent-soft px-5 py-4" : "px-5 py-4"}>
            <h3 className={t.us ? "text-small font-[590] text-fg" : "text-small text-fg"}>{t.name}</h3>
            <dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-label">
              <dt className="text-subtle">Bids visible before close</dt>
              <dd>
                <YesNo v={t.visible} good="no" />
              </dd>
              <dt className="text-subtle">Being first pays</dt>
              <dd>
                <YesNo v={t.speed} good="no" />
              </dd>
              <dt className="text-subtle">One price for everyone</dt>
              <dd>
                <YesNo v={t.onePrice} good="yes" />
              </dd>
            </dl>
            <p className={t.us ? "mt-3 text-small font-[510] text-fg" : "mt-3 text-small text-muted"}>{t.how}</p>
          </div>
        ))}
      </Reveal>
      <Reveal className="panel mt-10 hidden overflow-x-auto md:block">
        <table className="w-full min-w-[760px] text-left">
          <thead>
            <tr className="border-b border-line text-label text-subtle">
              <th scope="col" className="px-5 py-3 font-normal">
                Launch type
              </th>
              <th scope="col" className="px-5 py-3 font-normal">
                Bids visible before close
              </th>
              <th scope="col" className="px-5 py-3 font-normal">
                Being first pays
              </th>
              <th scope="col" className="px-5 py-3 font-normal">
                One price for everyone
              </th>
              <th scope="col" className="px-5 py-3 font-normal">
                How bots win
              </th>
            </tr>
          </thead>
          <tbody className="text-small">
            {LAUNCH_TYPES.map((t) => (
              <tr key={t.name} className={t.us ? "bg-accent-soft" : "border-b border-line"}>
                <th scope="row" className={t.us ? "px-5 py-4 font-[590] text-fg" : "px-5 py-4 font-normal text-muted"}>
                  {t.name}
                </th>
                <td className="px-5 py-4">
                  <YesNo v={t.visible} good="no" />
                </td>
                <td className="px-5 py-4">
                  <YesNo v={t.speed} good="no" />
                </td>
                <td className="px-5 py-4">
                  <YesNo v={t.onePrice} good="yes" />
                </td>
                <td className={t.us ? "px-5 py-4 font-[510] text-fg" : "px-5 py-4 text-muted"}>{t.how}</td>
              </tr>
            ))}
          </tbody>
        </table>
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
        title="We aimed sniper bots at three kinds of launch."
        lead={`The same crowd of 200 people and 5 sniper bots went through each one, ${arena.runs} times. On a sealed, single-price sale, being first is worth nothing.`}
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
      <Reveal className="mt-6 flex flex-col gap-1 border-l-2 border-accent pl-4 sm:flex-row sm:items-baseline sm:gap-3">
        <span className="num shrink-0 text-num-sm text-fg">0.8 s</span>
        <p className="max-w-[72ch] text-small text-muted">
          We also ran a real sniper bot against a sale on a local NEAR chain. It bid 0.8 seconds after the window
          opened and paid exactly the clearing price, the same as everyone else.
        </p>
      </Reveal>
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

function Unique() {
  const items = [
    {
      icon: EyeOff,
      title: "Sealed even from us",
      body: "Bids are encrypted in your browser to the enclave's key. Not the creator, not the relayer, not Sealround can read one before the sale closes.",
    },
    {
      icon: Ruler,
      title: "Nothing leaks from a sealed bid",
      body: "Every sealed bid has the same length, so its size says nothing. A copied bid is refused or penalised, and an invalid bid loses 1%.",
    },
    {
      icon: KeyRound,
      title: "No admin key, refunds built in",
      body: "The rules lock when the sale is created. If clearing fails or the enclave times out, every deposit can be taken back.",
    },
    {
      icon: Layers,
      title: "A stack only NEAR has",
      body: "A contract that calls a TEE and pins its code hash, USDC from other chains through NEAR Intents, and bids with no gas through a relayer.",
    },
  ];
  return (
    <section className={`${wrap} mt-28 sm:mt-36`}>
      <SectionTitle title="What a normal launchpad can't do" />
      <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {items.map(({ icon: Icon, title, body }, i) => (
          <Reveal key={title} index={i} className="panel spotlight p-6">
            <span className="flex size-9 items-center justify-center rounded-[10px] bg-accent-soft text-accent-bright">
              <Icon className="size-[18px]" strokeWidth={1.75} aria-hidden />
            </span>
            <h3 className="mt-5 text-h3 text-fg">{title}</h3>
            <p className="mt-2 text-small text-muted">{body}</p>
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
            On NEAR, the result page checks OutLayer&apos;s Intel TDX attestation in your browser: the enclave build, its
            measurements, the input and output hashes, and the bid set the contract froze. The same checks run from the
            command line with <span className="font-mono text-fg">verify-sale</span>.
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
    ["Total supply", "1,000,000 NIGHT, minted once"],
    ["For sale", "600,000 NIGHT"],
    ["Floor price", "0.001 USDC"],
    ["Minimum raise", "50 USDC"],
    ["Bid window", "30 minutes"],
    ["Unsold tokens", "Burned"],
    ["Admin key", "None"],
  ];
  return (
    <section className={`${wrap} mt-28 sm:mt-36`}>
      <div className="grid gap-4 lg:grid-cols-2">
        <Reveal className="panel spotlight flex flex-col p-6 sm:p-8">
          <Lock className="size-5 text-muted" strokeWidth={1.6} aria-hidden />
          <h2 className="mt-4 text-h2 text-fg">Launch a sale in two minutes</h2>
          <p className="mt-2 max-w-[46ch] text-small text-muted">
            Run a sale on its own, or offer it as the fair mode on a launchpad. The token is minted once with a fixed
            supply, unsold tokens are burned, and every rule locks at launch.
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
          <h2 className="mx-auto max-w-[18ch] text-h1 text-fg">Bots can&apos;t snipe what they can&apos;t see.</h2>
          <p className="mx-auto mt-4 max-w-[46ch] text-lead text-muted">
            Run a full sale on the simulated chain in your browser. Nothing to install, no wallet needed.
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
