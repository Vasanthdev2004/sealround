const LIMITS: { title: string; body: string }[] = [
  {
    title: "Money still talks",
    body: "Fairground removes the speed advantage and the information advantage. It does not remove the capital advantage: a whale can still buy a large share at the clearing price.",
  },
  {
    title: "Sybils dodge caps, not prices",
    body: "Per-account deposit caps are demo-grade. Splitting money across many wallets gets around the cap, but every wallet still pays the same clearing price, so there is nothing to gain on price.",
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
    body: "A fair price at launch does not stop a dump later. Trading after settlement is not something Fairground controls.",
  },
  {
    title: "Unaudited, on testnet",
    body: "The contract has not been audited. This app runs on NEAR testnet with test USDC.",
  },
];

export function HonestLimits() {
  return (
    <ul className="grid gap-px overflow-hidden rounded-card border border-line bg-line sm:grid-cols-2">
      {LIMITS.map((l) => (
        <li key={l.title} className="bg-elev p-4 sm:p-5">
          <h3 className="text-[13.5px] font-medium text-fg">{l.title}</h3>
          <p className="mt-1 text-[13px] leading-relaxed text-muted">{l.body}</p>
        </li>
      ))}
    </ul>
  );
}
