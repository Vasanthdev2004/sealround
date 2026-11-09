import Link from "next/link";
import { ArrowRight } from "lucide-react";

const STEPS = [
  {
    n: "01",
    title: "Set the rules",
    body: "Supply, floor price, minimum raise, window and caps. Locked at launch. No admin key.",
    href: "/how#steps",
  },
  {
    n: "02",
    title: "Seal your bid",
    body: "Your max price and max spend are encrypted in the browser. Only the deposit is public.",
    href: "/how#visibility",
  },
  {
    n: "03",
    title: "The enclave clears",
    body: "At close, the TEE opens every bid and finds one clearing price. The contract checks the math.",
    href: "/how#rule",
  },
  {
    n: "04",
    title: "Everyone claims",
    body: "Winners get tokens at that one price plus unspent USDC. Everyone else gets a full refund.",
    href: "/how#failures",
  },
];

/** Compact four-step explainer that links into /how. */
export function HowStrip() {
  return (
    <section aria-labelledby="how-strip-heading" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <h2 id="how-strip-heading" className="font-display text-[18px] font-medium tracking-[-0.015em] text-fg">
          How a sale works
        </h2>
        <Link href="/how" className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-fg">
          Read the rules <ArrowRight className="size-3.5" strokeWidth={1.75} />
        </Link>
      </div>
      <ol className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {STEPS.map((s) => (
          <li key={s.n}>
            <Link
              href={s.href}
              className="group flex h-full flex-col rounded-card border border-dashed border-line-dashed p-4 transition-colors hover:border-line-strong hover:bg-hover"
            >
              <span className="num text-[12px] text-subtle transition-colors group-hover:text-accent">{s.n}</span>
              <span className="mt-3 text-[14px] font-medium tracking-[-0.01em] text-fg">{s.title}</span>
              <span className="mt-1 text-[13px] leading-relaxed text-muted">{s.body}</span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
