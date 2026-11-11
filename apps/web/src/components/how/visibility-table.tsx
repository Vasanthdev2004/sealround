import { cn } from "@/lib/cn";

type Cell = { text: string; hidden: boolean };

const ROWS: { data: string; during: Cell; after: Cell }[] = [
  {
    data: "Max price",
    during: { text: "Hidden (encrypted)", hidden: true },
    after: { text: "Never published", hidden: true },
  },
  {
    data: "Max spend",
    during: { text: "Hidden (can be lower than the deposit)", hidden: true },
    after: { text: "Never published", hidden: true },
  },
  {
    data: "Deposit amount, bidder account, bid time",
    during: { text: "Public on-chain", hidden: false },
    after: { text: "Public", hidden: false },
  },
  {
    data: "Clearing price, each fill, each refund",
    during: { text: "Not known yet", hidden: true },
    after: { text: "Public", hidden: false },
  },
  {
    data: "Anonymized demand curve",
    during: { text: "Not known yet", hidden: true },
    after: { text: "Optional, chosen at launch (planned)", hidden: true },
  },
];

/** Public facts read in the primary ink; anything hidden or not yet known is secondary. */
function VisCell({ c }: { c: Cell }) {
  return <span className={cn(c.hidden ? "text-muted" : "font-[510] text-fg")}>{c.text}</span>;
}

export function VisibilityTable() {
  return (
    <div className="flex flex-col gap-4">
      <ul className="divide-y divide-line border-y border-line sm:hidden">
        {ROWS.map((r) => (
          <li key={r.data} className="py-4">
            <h3 className="text-body font-[510] text-fg">{r.data}</h3>
            <dl className="mt-2 grid grid-cols-2 gap-3 text-small">
              <div>
                <dt className="mb-0.5 text-label text-subtle">During the sale</dt>
                <dd>
                  <VisCell c={r.during} />
                </dd>
              </div>
              <div>
                <dt className="mb-0.5 text-label text-subtle">After settlement</dt>
                <dd>
                  <VisCell c={r.after} />
                </dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>

      <div className="hidden overflow-x-auto border-y border-line sm:block">
        <table className="data-table [&_tbody_tr:hover]:bg-transparent [&_tbody_tr:last-child_th]:border-b-0">
          <thead>
            <tr>
              <th scope="col" className="w-[38%] pl-0">
                Data
              </th>
              <th scope="col">During the sale</th>
              <th scope="col" className="pr-0">
                After settlement
              </th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map((r) => (
              <tr key={r.data}>
                <th scope="row" className="h-11 pl-0 text-small whitespace-normal text-fg">
                  {r.data}
                </th>
                <td>
                  <VisCell c={r.during} />
                </td>
                <td className="pr-0">
                  <VisCell c={r.after} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="max-w-[68ch] text-prose text-muted">
        Bids are encrypted in your browser with a libsodium sealed box to the sale’s own key. No server stores bid
        contents; the gas relayer keeps only rate-limit counters. Individual max prices are not in the enclave’s
        output either.
      </p>
    </div>
  );
}
