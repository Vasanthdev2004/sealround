import { ArrowRight } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";

/** Small, centered hero. One pitch line, one main action. */
export function HomeHero() {
  return (
    <section className="relative flex flex-col items-center px-1 pt-4 text-center sm:pt-10">
      <div
        aria-hidden
        className="pointer-events-none absolute top-0 left-1/2 h-36 w-[min(520px,90%)] -translate-x-1/2 rounded-full opacity-[0.16] blur-3xl"
        style={{ background: "radial-gradient(closest-side, var(--accent), transparent)" }}
      />

      <span className="relative inline-flex h-7 items-center gap-2 rounded-full bg-elev-2 px-3 text-[12px] text-muted ring-1 ring-line">
        <SealGlyph />
        Sealed-bid batch auctions on NEAR testnet
      </span>

      <h1 className="relative mt-5 font-display text-[24px] leading-[1.1] font-medium tracking-[-0.03em] text-fg sm:text-[26px]">
        Sealed bids. One price.
      </h1>
      <p className="relative mt-3 max-w-[470px] text-[14px] leading-relaxed text-muted sm:text-[15px]">
        Bots and you pay the same price. Bids stay hidden in a TEE until the sale closes; pay from any chain.
      </p>

      <div className="relative mt-7 flex flex-wrap items-start justify-center gap-3">
        <div className="flex flex-col items-center gap-2">
          <ButtonLink href="/judge" variant="primary" size="lg" className="min-w-[180px]">
            Run judge mode <ArrowRight className="size-4" strokeWidth={1.75} />
          </ButtonLink>
          <span className="text-[11.5px] text-subtle">no wallet, no funds, under 2 minutes</span>
        </div>
        <ButtonLink href="/create" size="lg" className="min-w-[150px]">
          Launch a sale
        </ButtonLink>
      </div>
    </section>
  );
}

/** The seal mark: a ring with one line through it. */
function SealGlyph() {
  return (
    <svg viewBox="0 0 20 20" className="size-3.5 text-accent" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden>
      <circle cx="10" cy="10" r="6.2" />
      <path d="M6.5 10h7" strokeLinecap="round" />
    </svg>
  );
}
