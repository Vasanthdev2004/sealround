const STEPS: { title: string; body: React.ReactNode }[] = [
  {
    title: "Bid as a commitment",
    body: (
      <>
        Instead of a sealed box, the bid carries{" "}
        <code className="font-mono text-label break-words text-fg">sha256(sale_id ‖ bidder ‖ max_price ‖ max_spend ‖ salt)</code> next to
        the public deposit.
      </>
    ),
  },
  {
    title: "Reveal after close",
    body: "A reveal window follows the close: 10 minutes by default, set at launch. Each bidder publishes their max price, max spend and salt, and the contract checks them against the commitment. The salt is saved in the browser the bid came from, and can be backed up as a file.",
  },
  {
    title: "Clear on-chain",
    body: "Once the window ends, anyone can have the contract run the same clearing rule itself. A bid that was not revealed is void: it is refunded less a 1 % penalty, which stays locked in the contract for good.",
  },
];

const COMPARE: { k: string; tee: string; cr: string }[] = [
  { k: "Prices during the sale", tee: "Hidden (encrypted)", cr: "Hidden (only a hash)" },
  { k: "Prices after the sale", tee: "Never published", cr: "Public at reveal" },
  { k: "Extra step for bidders", tee: "None", cr: "Reveal within the window" },
  { k: "If a bidder does nothing", tee: "Nothing changes", cr: "Void: refund less 1 %" },
  { k: "A bid that breaks a rule", tee: "Void: refund less 1 %", cr: "Void: refund less 1 %" },
  { k: "Who clears", tee: "OutLayer enclave, checked by the contract", cr: "The contract alone" },
];

const TEE = "TEE mode (default)";
const CR = "Commit-reveal fallback";

export function CommitReveal() {
  return (
    <div className="flex flex-col gap-8">
      <ol className="divide-y divide-line border-y border-line">
        {STEPS.map((s, i) => (
          <li key={s.title} className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-3 py-4 sm:grid-cols-[2rem_minmax(0,1fr)] sm:gap-4">
            <span aria-hidden className="num pt-0.5 text-label text-subtle">{i + 1}</span>
            <div className="min-w-0">
              <h3 className="text-h3 text-fg">{s.title}</h3>
              <p className="mt-1 max-w-[68ch] text-body text-muted">{s.body}</p>
            </div>
          </li>
        ))}
      </ol>

      <ul className="divide-y divide-line border-y border-line sm:hidden" aria-label="TEE mode and commit-reveal">
        {COMPARE.map((r) => (
          <li key={r.k} className="py-4">
            <h3 className="text-body font-[510] text-fg">{r.k}</h3>
            <dl className="mt-2 grid grid-cols-2 gap-3 text-small">
              <div>
                <dt className="mb-0.5 text-label text-subtle">TEE</dt>
                <dd className="text-fg">{r.tee}</dd>
              </div>
              <div>
                <dt className="mb-0.5 text-label text-subtle">Commit-reveal</dt>
                <dd className="text-fg">{r.cr}</dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>

      <div className="hidden overflow-x-auto border-y border-line sm:block">
        <table className="data-table [&_tbody_tr:hover]:bg-transparent [&_tbody_tr:last-child_th]:border-b-0">
          <thead>
            <tr>
              <th scope="col" className="w-[30%] pl-0">
                Feature
              </th>
              <th scope="col">{TEE}</th>
              <th scope="col" className="pr-0">
                {CR}
              </th>
            </tr>
          </thead>
          <tbody>
            {COMPARE.map((r) => (
              <tr key={r.k}>
                <th scope="row" className="h-11 pl-0 text-small whitespace-normal text-muted">
                  {r.k}
                </th>
                <td className="text-fg">{r.tee}</td>
                <td className="pr-0 text-fg">{r.cr}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="-mt-3 max-w-[68ch] text-prose text-muted">
        This mode is weaker, and we say so: everyone’s max price becomes public at reveal, and a bidder who misses the
        reveal window, or loses the salt, pays the 1 % penalty. Each sale’s mode is fixed at launch and shown on its
        page.
      </p>
    </div>
  );
}
