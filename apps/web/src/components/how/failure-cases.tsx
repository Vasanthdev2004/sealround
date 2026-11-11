import Link from "next/link";
import { isNearMode } from "@/lib/config";

const CASES: {
  title: string;
  trigger: string;
  body: React.ReactNode;
  demo?: { href: string; label: string };
}[] = [
  {
    title: "Clearing times out",
    trigger: "The enclave never answers",
    body: (
      <>
        Every sale has a settle timeout, fixed at launch (2 hours by default). Once it passes with no result, anyone can
        call <code className="font-mono text-label text-fg">trigger_refund_mode</code>. The sale moves to Failed and every bidder claims a
        full refund.
      </>
    ),
    demo: { href: "/sale/ashfall", label: "See Ashfall" },
  },
  {
    title: "Invalid or copied bids",
    trigger: "A bid the enclave cannot accept",
    body: "A bid that fails to decrypt, names a different bidder or sale (a copied ciphertext), sets a max spend above its deposit, or bids below the floor is void. It counts as zero, and its deposit is refunded less a 1 % penalty, the same as a commit-reveal bid that is not revealed. The penalty is what makes junk bids cost something. The rest of the sale clears normally.",
    demo: { href: "/sale/lantern/result", label: "See Lantern’s copycat bot" },
  },
  {
    title: "A funding swap fails",
    trigger: "1Click ends REFUNDED or FAILED",
    body: "The funds go back to the origin address on the origin chain. No bid was placed, so nothing is locked in Sealround. The funding panel shows every 1Click status in plain words.",
  },
  {
    title: "Minimum raise missed",
    trigger: "Total raise below the minimum",
    body: "The sale fails. Nobody gets tokens, and every valid bid gets its whole deposit back. A void bid still loses its 1 %.",
    demo: { href: "/sale/driftwood/result", label: "See Driftwood" },
  },
];

export function FailureCases() {
  const showExamples = !isNearMode();
  return (
    <div className="divide-y divide-line border-y border-line">
      {CASES.map((c) => (
        <article key={c.title} className="grid gap-1.5 py-4 sm:grid-cols-[13rem_minmax(0,1fr)] sm:gap-6">
          <div>
            <h3 className="text-h3 text-fg">{c.title}</h3>
            <p className="mt-0.5 text-small text-muted">{c.trigger}</p>
          </div>
          <div className="min-w-0">
            <p className="max-w-[68ch] text-body text-muted">{c.body}</p>
            {showExamples && c.demo && (
              <Link
                href={c.demo.href}
                className="mt-1 inline-flex min-h-10 items-center rounded-sm text-small text-accent-bright underline-offset-4 hover:underline sm:min-h-8"
              >
                {c.demo.label}
              </Link>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}
