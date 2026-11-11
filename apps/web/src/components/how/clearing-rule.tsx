/**
 * The clearing formula, its symbols and the allocation rules, rendered as HTML
 * (no math library). Typeset, not coded: variables are italic <var>s in a math
 * or serif face (`.math`), sub- and superscripts in the same italic at 0.7em,
 * "max" upright in the sans. Sizes inside the formula are relative (em), so
 * the whole expression scales from one token on its container.
 */

function V({ children, sub }: { children: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <span className="math">
      <var>{children}</var>
      {sub && (
        <sub className="ml-[0.04em] text-[0.7em]">
          <var>{sub}</var>
        </sub>
      )}
    </span>
  );
}

const PSTAR = (
  <span className="math">
    <var>P</var>
    <sup className="ml-[0.1em] text-[0.7em]">*</sup>
  </span>
);

export function ClearingFormula() {
  return (
    <div className="overflow-x-auto rounded-panel border border-line bg-inset">
      <div
        role="math"
        aria-label="P star equals the largest price P, at least the floor F, such that the sum over all bids with max price at least P of max spend divided by P is at least the supply S."
        className="math mx-auto flex w-max items-center gap-1.5 px-4 py-7 text-num-md font-normal tracking-normal text-fg sm:gap-3 sm:px-8 sm:py-9 sm:text-num-lg"
      >
        {PSTAR}
        <span className="text-muted">=</span>
        <span className="font-sans text-[0.8em] font-[510]">max</span>
        <span className="text-[1.4em] leading-none font-light text-subtle">{"{"}</span>
        <span className="whitespace-nowrap">
          <V>P</V> <span className="text-muted">≥</span> <V>F</V>
        </span>
        <span className="text-subtle">:</span>
        <span className="inline-flex flex-col items-center leading-none">
          <span className="text-[1.3em]">Σ</span>
          {/* The index under the sum, from sm up; phones get it as a sentence below. */}
          <span className="mt-1 text-[0.5em] whitespace-nowrap text-muted max-sm:hidden">
            <V>i</V> : <V sub="i">p</V> ≥ <V>P</V>
          </span>
        </span>
        <span className="inline-flex flex-col items-center text-[0.9em] leading-tight">
          <span className="px-1">
            <V sub="i">m</V>
          </span>
          <span className="w-full border-t border-fg/60 px-1 text-center">
            <V>P</V>
          </span>
        </span>
        <span className="text-muted">≥</span>
        <V>S</V>
        <span className="text-[1.4em] leading-none font-light text-subtle">{"}"}</span>
      </div>
      <p className="px-4 pb-5 text-center text-small text-muted sm:hidden">
        The sum runs over every bid with <V sub="i">p</V> ≥ <V>P</V>.
      </p>
    </div>
  );
}

const LEGEND: { sym: React.ReactNode; name: string; text: string }[] = [
  { sym: PSTAR, name: "Clearing price", text: "The one price every winner pays." },
  { sym: <V>F</V>, name: "Floor price", text: "Fixed at launch. Nothing fills below it." },
  { sym: <V>S</V>, name: "Sale supply", text: "The tokens for sale." },
  { sym: <V sub="i">p</V>, name: "Max price of bid i", text: "In USDC per token. Sealed." },
  { sym: <V sub="i">m</V>, name: "Max spend of bid i", text: "In USDC. Sealed, and can be lower than the deposit." },
];

export function FormulaLegend() {
  return (
    <dl className="mt-4 divide-y divide-line border-y border-line">
      {LEGEND.map((l) => (
        <div key={l.name} className="grid grid-cols-[2rem_minmax(0,1fr)] items-baseline gap-x-3 py-2.5 sm:grid-cols-[2rem_11rem_minmax(0,1fr)] sm:gap-x-4">
          <dt className="text-lead text-fg">{l.sym}</dt>
          <dd className="text-body text-fg">{l.name}</dd>
          <dd className="text-body text-muted max-sm:col-start-2">{l.text}</dd>
        </div>
      ))}
    </dl>
  );
}

const RULES: { k: React.ReactNode; v: React.ReactNode }[] = [
  {
    k: <>Max price above {PSTAR}</>,
    v: <>Filled in full at {PSTAR}.</>,
  },
  {
    k: <>Max price exactly {PSTAR}</>,
    v: "Ties share what is left, pro rata to how many tokens each bid could buy at that price.",
  },
  {
    k: <>Max price below {PSTAR}</>,
    v: "Not filled. The whole deposit comes back.",
  },
  {
    k: "Rounding",
    v: "Every share is rounded down to the smallest token unit. Leftover units go out one at a time, in bid order.",
  },
  {
    k: "Undersubscribed",
    v: (
      <>
        If demand at the floor is below <V>S</V>, then {PSTAR} is the floor, every valid bid fills in full, and the
        unsold tokens are burned. That rule is fixed at launch.
      </>
    ),
  },
  {
    k: "What you pay",
    v: (
      <>
        <span className="math text-[1.08em] whitespace-nowrap text-fg">
          <var>spent</var> = ⌈ <var>tokens</var> × {PSTAR} ⌉
        </span>
        , in USDC base units. It is never above your max spend. The rest of your deposit is refunded.
      </>
    ),
  },
  {
    k: "Invalid bids",
    v: "A bid that fails to decrypt, copies another bidder’s ciphertext, sets a zero max spend or one above its deposit, or a max price below the floor counts as zero. Its deposit is refunded less a 1 % penalty, rounded up, the same as a commit-reveal bid that is not revealed. The app refuses to send such a bid, so an honest bidder never pays it.",
  },
  {
    k: "Minimum raise",
    v: "If the total raise is below the minimum, the sale fails and every valid bid is refunded in full.",
  },
];

export function AllocationRules() {
  return (
    <div className="mt-10">
      <h3 className="text-h3 text-fg">Who gets what</h3>
      <dl className="mt-3 divide-y divide-line border-y border-line">
        {RULES.map((r, i) => (
          <div key={i} className="grid gap-1 py-3.5 sm:grid-cols-[13rem_minmax(0,1fr)] sm:gap-6">
            <dt className="text-body font-[510] text-fg">{r.k}</dt>
            <dd className="max-w-[68ch] text-body text-muted">{r.v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function ClearingRule() {
  return (
    <div>
      <ClearingFormula />
      <FormulaLegend />
      <AllocationRules />
      <p className="mt-5 max-w-[68ch] text-small text-muted">
        Integer math only: USDC has 6 decimals, tokens 18. Prices step in whole USDC base units, so in rare cases the
        bids above {PSTAR} alone want more than <V>S</V>; then they are prorated the same way. The enclave runs a Rust
        port of the same TypeScript code that runs below, and the two must agree on every random bid set.
      </p>
    </div>
  );
}
