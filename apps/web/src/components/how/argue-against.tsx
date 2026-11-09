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
    <div className="flex flex-col gap-4">
      <ol className="rounded-card border border-line bg-elev">
        {AGAINST.map((a, i) => (
          <li
            key={a.title}
            className="flex gap-4 border-dashed border-line-dashed px-4 py-3.5 sm:px-5 [&:not(:first-child)]:border-t"
          >
            <span className="num pt-px text-[12px] text-subtle">{String(i + 1).padStart(2, "0")}</span>
            <div className="min-w-0">
              <h3 className="text-[13.5px] font-medium text-fg">{a.title}</h3>
              <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{a.body}</p>
            </div>
          </li>
        ))}
      </ol>

      <div className="rounded-card border border-accent/25 bg-accent-soft p-5">
        <h3 className="text-[13.5px] font-medium text-fg">Why we build it anyway</h3>
        <p className="mt-1.5 max-w-2xl text-[13.5px] leading-relaxed text-muted">
          The sniping problem is real at every launch. NEAR is the one stack with a TEE, cross-chain funding and chain
          signatures together. And the clearing checks live in a contract anyone can read.
        </p>
      </div>
    </div>
  );
}
