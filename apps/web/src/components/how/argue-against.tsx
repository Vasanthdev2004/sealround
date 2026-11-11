const AGAINST: { title: string; body: string }[] = [
  {
    title: "It is not new",
    body: "Sealed-bid, single-price batch auctions have run on Ethereum for years.",
  },
  {
    title: "Money still wins share",
    body: "They remove speed and information advantages, but not capital. A whale still buys a large share at the clearing price.",
  },
  {
    title: "Privacy rests on one provider",
    body: "Sealed prices depend on OutLayer’s TEE and on how its master secret is held today.",
  },
  {
    title: "A fair launch is not a fair market",
    body: "Most memecoin launches are speculation. A fair price at launch does not stop a dump later.",
  },
  {
    title: "Token sales are regulated",
    body: "In some countries they are. Anything beyond a capped, no-value experiment needs legal advice.",
  },
];

export function ArgueAgainst() {
  return (
    <div className="flex flex-col gap-8">
      <ul className="divide-y divide-line border-y border-line">
        {AGAINST.map((a) => (
          <li key={a.title} className="grid gap-1 py-4 sm:grid-cols-[13rem_minmax(0,1fr)] sm:gap-6">
            <h3 className="text-h3 text-fg">{a.title}</h3>
            <p className="max-w-[68ch] text-body text-muted">{a.body}</p>
          </li>
        ))}
      </ul>

      <div>
        <h3 className="text-h3 text-fg">Why we build it anyway</h3>
        <p className="mt-2 max-w-[68ch] text-prose text-muted">
          The sniping problem is real at every launch. NEAR is the one stack with a TEE, cross-chain funding and chain
          signatures together. And the clearing checks live in a contract anyone can read.
        </p>
      </div>
    </div>
  );
}
