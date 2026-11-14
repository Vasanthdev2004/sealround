import Link from "next/link";

const STEPS = [
  {
    n: "1",
    title: "The rules lock",
    body: "Supply, prices, window and caps are fixed at launch. Inspect the contract's code and keys before bidding.",
    href: "/verify",
  },
  {
    n: "2",
    title: "You seal a bid",
    body: "In a sealed sale, your limits are encrypted in your browser. Your account, deposit and bid time remain public.",
    href: "/how#visibility",
  },
  {
    n: "3",
    title: "The enclave clears",
    body: "At close a TEE opens every bid and finds one clearing price. The contract checks the result.",
    href: "/how#rule",
  },
  {
    n: "4",
    title: "Everyone claims",
    body: "Winners claim tokens and unspent USDC. Valid bids that did not win get their deposits back.",
    href: "/how#failures",
  },
];

/** Four steps, the same for every sale. Each links into /how. */
export function HowStrip() {
  return (
    <section aria-labelledby="how-strip-heading" className="flex flex-col gap-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="how-strip-heading" className="text-h2 text-fg">
          How a sale works
        </h2>
        <Link
          href="/how"
          className="inline-flex min-h-8 items-center rounded-sm text-small text-muted underline decoration-line-strong underline-offset-4 transition-colors hover:text-fg"
        >
          Read the full rules
        </Link>
      </div>
      <ol className="grid border-t border-line sm:grid-cols-2 lg:grid-cols-4">
        {STEPS.map((s) => (
          <li
            key={s.n}
            className="min-w-0 border-b border-line sm:max-lg:odd:border-r sm:max-lg:odd:pr-6 sm:max-lg:even:pl-6 lg:border-b-0 lg:px-6 lg:first:pl-0 lg:last:pr-0 lg:[&:not(:last-child)]:border-r"
          >
            <Link
              href={s.href}
              className="group flex h-full flex-col py-5 lg:py-6"
            >
              <span className="num text-label text-subtle">{s.n}</span>
              <h3 className="mt-3 text-h3 text-fg transition-colors group-hover:text-accent-bright">{s.title}</h3>
              <p className="mt-1.5 text-small text-muted">{s.body}</p>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
