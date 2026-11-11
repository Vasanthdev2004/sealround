import { ButtonLink } from "@/components/ui/button";
import { isNearMode } from "@/lib/config";

/**
 * The pitch and the two actions. No illustration: the live sale right below
 * it is the picture. Server-rendered, and it enters with the CSS `anim-*`
 * classes, so it shows before hydration.
 */
export function HomeHero() {
  // Judge mode exists only on the simulated chain; against a real contract the first action is to read the rules.
  const near = isNearMode();
  return (
    <section
      aria-labelledby="home-title"
      className="grid gap-5 pt-2 sm:gap-6 sm:pt-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)] lg:items-end lg:gap-12 lg:pt-8"
    >
      <h1 id="home-title" className="anim-rise text-display text-fg">
        Sealed bids.
        <br />
        <span className="text-accent-bright">One price.</span>
      </h1>
      <div className="anim-rise flex flex-col gap-5" style={{ "--i": 1 } as React.CSSProperties}>
        <p className="max-w-[46ch] text-lead text-muted">
          Bid terms stay sealed until the sale closes. Every winner pays the same clearing price.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <ButtonLink href={near ? "/how" : "/judge"} variant="primary" size="lg">
            {near ? "How it works" : "Run the demo"}
          </ButtonLink>
          <ButtonLink href="/create" variant="ghost" size="lg" className="max-[359px]:px-2.5">
            Launch a sale
          </ButtonLink>
        </div>
      </div>
    </section>
  );
}
