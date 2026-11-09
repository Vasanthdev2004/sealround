const STEPS: { title: string; body: React.ReactNode }[] = [
  {
    title: "Bid as a commitment",
    body: (
      <>
        Instead of a sealed box, the bid carries{" "}
        <code className="num break-all text-fg">sha256(sale_id ‖ bidder ‖ max_price ‖ max_spend ‖ salt)</code> next to
        the public deposit.
      </>
    ),
  },
  {
    title: "Reveal after close",
    body: "A 10-minute reveal window follows the close. Each bidder publishes their max price, max spend and salt, and the contract checks them against the commitment.",
  },
  {
    title: "Clear on-chain",
    body: "The contract runs the same clearing rule itself. Bidders who do not reveal are refunded minus a 1% penalty, which is burned.",
  },
];

const COMPARE: { k: string; tee: string; cr: string }[] = [
  { k: "Prices during the sale", tee: "Hidden (encrypted)", cr: "Hidden (only a hash)" },
  { k: "Prices after the sale", tee: "Never published", cr: "Public at reveal" },
  { k: "Extra step for bidders", tee: "None", cr: "Reveal within 10 minutes" },
  { k: "If a bidder does nothing", tee: "Nothing changes", cr: "Refund minus 1%, burned" },
  { k: "Who clears", tee: "OutLayer enclave, checked by the contract", cr: "The contract alone" },
];

export function CommitReveal() {
  return (
    <div className="flex flex-col gap-4">
      <ol className="grid gap-3 md:grid-cols-3">
        {STEPS.map((s, i) => (
          <li key={s.title} className="rounded-card border border-dashed border-line-dashed p-4">
            <span className="num text-[12px] text-subtle">{String(i + 1).padStart(2, "0")}</span>
            <h3 className="mt-2 text-[13.5px] font-medium text-fg">{s.title}</h3>
            <p className="mt-1 text-[13px] leading-relaxed text-muted">{s.body}</p>
          </li>
        ))}
      </ol>

      <div className="overflow-x-auto rounded-card border border-line bg-elev">
        <table className="w-full min-w-[520px] border-separate border-spacing-0 text-left text-[13px]">
          <thead>
            <tr className="text-[12px] text-subtle">
              <th className="px-4 py-3 font-normal" />
              <th className="px-4 py-3 font-normal">TEE mode (default)</th>
              <th className="px-4 py-3 font-normal">Commit-reveal fallback</th>
            </tr>
          </thead>
          <tbody>
            {COMPARE.map((r) => (
              <tr key={r.k} className="[&>td]:border-t [&>td]:border-dashed [&>td]:border-line-dashed [&>td]:px-4 [&>td]:py-2.5 [&>td]:align-top">
                <td className="text-muted">{r.k}</td>
                <td className="text-fg">{r.tee}</td>
                <td className="text-fg">{r.cr}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="max-w-2xl text-[13px] leading-relaxed text-muted">
        This mode is weaker, and we say so: everyone’s max price becomes public at reveal, and a bidder who misses the
        reveal window pays a penalty. Each sale’s mode is fixed at launch and shown on its page.
      </p>
    </div>
  );
}
