/** The clearing formula, legend and allocation rules, rendered as HTML (no math library). */

function V({ children, sub }: { children: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <span className="italic">
      {children}
      {sub && <sub className="text-[0.6em] not-italic">{sub}</sub>}
    </span>
  );
}

const PSTAR = (
  <span className="italic">
    P<sup className="text-[0.6em] not-italic">*</sup>
  </span>
);

export function ClearingFormula() {
  return (
    <div className="overflow-x-auto rounded-card border border-line bg-inset shadow-[inset_0_1px_2px_rgba(0,0,0,0.5)]">
      <div
        role="math"
        aria-label="P star equals the largest price P, at least the floor F, such that the sum over all bids with max price at least P of max spend divided by P is at least the supply S."
        className="num mx-auto flex w-max items-center gap-2 px-4 py-7 text-[16px] text-fg sm:gap-3 sm:px-6 sm:text-[23px]"
      >
        {PSTAR}
        <span className="text-muted">=</span>
        <span className="not-italic">max</span>
        <span className="text-[1.5em] leading-none font-light text-subtle">{"{"}</span>
        <span className="whitespace-nowrap">
          <V>P</V> <span className="text-muted">≥</span> <V>F</V>
        </span>
        <span className="text-subtle">:</span>
        <span className="inline-flex flex-col items-center leading-none">
          <span className="text-[1.35em]">Σ</span>
          <span className="mt-1 text-[0.5em] whitespace-nowrap text-muted">
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
        <span className="text-[1.5em] leading-none font-light text-subtle">{"}"}</span>
      </div>
    </div>
  );
}

const LEGEND: { sym: React.ReactNode; text: string }[] = [
  { sym: PSTAR, text: "Clearing price. The one price every winner pays." },
  { sym: <V>F</V>, text: "Floor price, fixed at launch. Nothing fills below it." },
  { sym: <V>S</V>, text: "Tokens for sale (sale supply)." },
  { sym: <V sub="i">p</V>, text: "Max price of bid i, in USDC per token. Sealed." },
  { sym: <V sub="i">m</V>, text: "Max spend of bid i, in USDC. Sealed; can be lower than the deposit." },
];

export function FormulaLegend() {
  return (
    <dl className="mt-4 grid gap-x-6 gap-y-2 sm:grid-cols-2">
      {LEGEND.map((l, i) => (
        <div key={i} className="flex items-baseline gap-3">
          <dt className="num w-7 shrink-0 text-[14px] text-fg">{l.sym}</dt>
          <dd className="text-[13px] leading-snug text-muted">{l.text}</dd>
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
        <span className="num text-fg">
          spent = ⌈ tokens × {PSTAR} ⌉
        </span>
        , in USDC base units. It is never above your max spend. The rest of your deposit is refunded.
      </>
    ),
  },
  {
    k: "Invalid bids",
    v: "A bid that fails to decrypt, copies another bidder’s ciphertext, sets a max spend above its deposit or a max price below the floor counts as zero. Its deposit is refunded in full.",
  },
  {
    k: "Minimum raise",
    v: "If the total raise is below the minimum, the sale fails and every bidder is refunded in full.",
  },
];

export function AllocationRules() {
  return (
    <dl className="mt-6 overflow-hidden rounded-card border border-line bg-elev">
      {RULES.map((r, i) => (
        <div
          key={i}
          className="grid gap-1 border-dashed border-line-dashed px-4 py-3 sm:grid-cols-[190px_minmax(0,1fr)] sm:gap-4 [&:not(:first-child)]:border-t"
        >
          <dt className="text-[13px] font-medium text-fg">{r.k}</dt>
          <dd className="text-[13px] leading-relaxed text-muted">{r.v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ClearingRule() {
  return (
    <div>
      <ClearingFormula />
      <p className="mt-4 max-w-2xl text-[14px] leading-relaxed text-muted">
        In words: the highest price, at or above the floor, at which the bids willing to pay at least that much can
        still buy the whole supply.
      </p>
      <FormulaLegend />
      <AllocationRules />
      <p className="mt-4 max-w-2xl text-[12.5px] leading-relaxed text-subtle">
        Integer math only: USDC has 6 decimals, tokens 18. Prices step in whole USDC base units, so in rare cases the
        bids above {PSTAR} alone want more than <V>S</V>; then they are prorated the same way. The enclave runs a Rust
        port of the same TypeScript code that runs below, and the two must agree on every random bid set.
      </p>
    </div>
  );
}
