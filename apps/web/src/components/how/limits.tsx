const LIMITS = [
  {
    title: "Money still talks",
    body: "Sealround removes the speed advantage and the information advantage. It does not remove the capital advantage: a whale can still buy a large share at the clearing price.",
  },
  {
    title: "Sybils dodge caps, not prices",
    body: "Per-account deposit caps are demo-grade. Splitting money across many wallets gets around the cap, but every wallet still pays the same clearing price, so there is nothing to gain on price.",
  },
  {
    title: "Bid slots can be squatted",
    body: "A sale takes a fixed number of bids, first come, first served, and the contract cannot read a sealed bid. Someone can fill the slots with junk and block real bidders. A void bid loses 1 % of its deposit, at least 0.01 USDC, so it costs them, but not much. The creator’s lever is a higher minimum deposit.",
  },
  {
    title: "Privacy depends on the TEE",
    body: "If the enclave or the way its master secret is held is broken, sealed prices can be read. See the trust assumptions above.",
  },
  {
    title: "Deposits are public",
    body: "Anyone can add up deposits during the window, so total demand in USDC is visible. Individual max prices and max spends are not.",
  },
  {
    title: "After the sale is out of scope",
    body: "A fair price at launch does not stop a dump later. Trading after settlement is not something Sealround controls.",
  },
  {
    title: "The contract is unaudited",
    body: "The Sealround contract has not been audited. The demo uses simulated USDC.",
  },
];

export function HonestLimits() {
  return (
    <ul className="divide-y divide-line border-y border-line">
      {LIMITS.map((l) => (
        <li key={l.title} className="grid gap-1 py-4 sm:grid-cols-[13rem_minmax(0,1fr)] sm:gap-6">
          <h3 className="text-h3 text-fg">{l.title}</h3>
          <p className="max-w-[68ch] text-body text-muted">{l.body}</p>
        </li>
      ))}
    </ul>
  );
}
