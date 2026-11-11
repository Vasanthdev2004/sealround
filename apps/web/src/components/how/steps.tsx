const STEPS: { title: string; who: string; body: React.ReactNode }[] = [
  {
    title: "Set the sale terms",
    who: "Creator",
    body: (
      <>
        Choose the supply for sale, floor price, minimum raise, bid window and per-account caps. The contract deploys
        the token with a fixed supply to its own sub-account,{" "}
        <code className="font-mono text-label break-words text-fg">&lt;sale_id&gt;.&lt;contract&gt;</code>. Every parameter is locked
        at creation, and there is no admin key.
      </>
    ),
  },
  {
    title: "Get USDC on NEAR",
    who: "Bidder",
    body: "Use USDC you already hold on NEAR, or fund from SOL, ETH, BTC or USDC on another chain through NEAR Intents 1Click. The USDC lands in your own NEAR account.",
  },
  {
    title: "Submit a sealed bid",
    who: "Bidder",
    body: "One transfer carries a public USDC deposit plus an encrypted payload containing your max price, max spend and a random salt. The browser seals it to the sale’s enclave key. When the gas relayer covers the transaction, you need USDC and no NEAR.",
  },
  {
    title: "Close the bid window",
    who: "Anyone",
    body: "After the window ends, anyone can call close. The bid set is frozen on-chain and the contract stores its hash.",
  },
  {
    title: "Calculate the clearing price",
    who: "OutLayer TEE",
    body: "The enclave decrypts the bids, computes the clearing price and fills, and returns the result. The contract accepts a result from OutLayer for the job hash pinned at deployment. It checks the arithmetic it can see, then settles.",
  },
  {
    title: "Claim tokens and refunds",
    who: "Every bidder",
    body: "Winners get tokens at the clearing price plus any unspent USDC. Valid bids that lose get a full refund, and so does every valid bid if the minimum raise is missed. A void bid gets its deposit back less 1 %. If clearing never arrives, everyone is refunded in full.",
  },
];

export function SaleSteps() {
  return (
    <ol className="divide-y divide-line border-y border-line">
      {STEPS.map((step, index) => (
        <li key={step.title} className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-3 py-4 sm:grid-cols-[2rem_minmax(0,1fr)] sm:gap-4">
          <span aria-hidden className="num pt-0.5 text-label text-subtle">
            {index + 1}
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
              <h3 className="text-h3 text-fg">
                <span className="sr-only">Step {index + 1}. </span>
                {step.title}
              </h3>
              <span className="text-label text-subtle">{step.who}</span>
            </div>
            <p className="mt-1 max-w-[68ch] text-body text-muted">{step.body}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
