import Link from "next/link";
import { ArrowRight, ShieldCheck } from "lucide-react";

const CASES: { title: string; trigger: string; body: React.ReactNode; demo?: { href: string; label: string } }[] = [
  {
    title: "Clearing times out",
    trigger: "The enclave never answers",
    body: (
      <>
        Every sale has a settle timeout, fixed at launch (2 hours by default). Once it passes with no result, anyone can
        call <code className="num text-fg">trigger_refund_mode</code>. The sale moves to Failed and every bidder claims a
        full refund.
      </>
    ),
    demo: { href: "/sale/ashfall", label: "See Ashfall" },
  },
  {
    title: "Invalid or copied bids",
    trigger: "A bid the enclave cannot accept",
    body: "A bid that fails to decrypt, names a different bidder or sale (a copied ciphertext), sets a max spend above its deposit, or bids below the floor is void. It counts as zero, and its deposit is refunded in full. The rest of the sale clears normally.",
    demo: { href: "/sale/lantern/result", label: "See Lantern’s copycat bot" },
  },
  {
    title: "A funding swap fails",
    trigger: "1Click ends REFUNDED or FAILED",
    body: "The funds go back to the origin address on the origin chain. No bid was placed, so nothing is locked in Fairground. The funding panel shows every 1Click status in plain words.",
  },
  {
    title: "Minimum raise missed",
    trigger: "Total raise below the minimum",
    body: "The sale fails. Nobody gets tokens, and every bidder gets their whole deposit back.",
    demo: { href: "/sale/driftwood/result", label: "See Driftwood" },
  },
];

export function FailureCases() {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {CASES.map((c) => (
        <article key={c.title} className="flex flex-col rounded-card border border-line bg-elev p-5">
          <div className="text-[12px] text-subtle">{c.trigger}</div>
          <h3 className="mt-1 text-[14px] font-medium tracking-[-0.01em] text-fg">{c.title}</h3>
          <p className="mt-2 mb-4 text-[13px] leading-relaxed text-muted">{c.body}</p>
          <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-dashed border-line-dashed pt-3">
            <span className="inline-flex items-center gap-1.5 text-[12.5px] text-ok">
              <ShieldCheck className="size-4" strokeWidth={1.75} aria-hidden />
              No path leaves funds stuck.
            </span>
            {c.demo && (
              <Link href={c.demo.href} className="inline-flex items-center gap-1 text-[12.5px] text-muted hover:text-fg">
                {c.demo.label} <ArrowRight className="size-3.5" strokeWidth={1.75} />
              </Link>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}
