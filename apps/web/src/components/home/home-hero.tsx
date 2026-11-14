import { Plus } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { isNearMode } from "@/lib/config";

/**
 * The app's page header: what this board is and the two actions. The pitch
 * lives on the landing page, so this stays compact and puts the live sale
 * near the top. Server-rendered and entered with the CSS `anim-*` classes.
 */
export function HomeHero() {
  // Judge mode exists only on the simulated chain; against a real contract the first action is to read the rules.
  const near = isNearMode();
  return (
    <section
      aria-labelledby="home-title"
      className="flex flex-col gap-4 pt-2 sm:flex-row sm:items-end sm:justify-between sm:gap-8 sm:pt-4"
    >
      <div className="anim-rise">
        <h1 id="home-title" className="text-h1 text-fg">
          Sales
        </h1>
        <p className="mt-2 max-w-[52ch] text-small text-muted">
          Find a launch, set your limits and follow your bid through to the result.
        </p>
      </div>
      <div className="anim-rise flex shrink-0 flex-wrap items-center gap-2" style={{ "--i": 1 } as React.CSSProperties}>
        <ButtonLink href={near ? "/how" : "/judge"}>{near ? "How it works" : "Run the demo"}</ButtonLink>
        <ButtonLink href="/create" variant="primary" icon={<Plus className="size-4" aria-hidden />}>
          Launch a sale
        </ButtonLink>
      </div>
    </section>
  );
}
