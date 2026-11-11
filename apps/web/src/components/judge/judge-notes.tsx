"use client";

import Link from "next/link";
import { useSales } from "@/lib/hooks";

const LINK =
  "inline-flex min-h-8 items-center rounded-sm text-muted underline decoration-line-strong underline-offset-4 transition-colors hover:text-fg";

/**
 * What the simulated run stands in for on NEAR, one sentence a row: who pays
 * the gas, which wallets bid gasless, where the token lives, how the enclave
 * is pinned, and what stops someone filling the bid slots with junk. A quiet
 * ledger at the foot of the page; "How it works" has the long version.
 */
const notes = (simulated: boolean): { k: string; v: React.ReactNode }[] => [
  {
    k: "Gas",
    v: "A relayer pays the network fee of every bid, reveal and claim, so a bidder needs USDC and no NEAR.",
  },
  {
    k: "Wallets",
    v: "A gasless bid is a delegate action signed with a full-access key. A wallet that cannot sign one sends the same bid and pays a small NEAR fee.",
  },
  {
    k: "Token",
    v: (
      <>
        The contract deploys each sale&apos;s token, with a fixed supply, to its own sub-account{" "}
        <span className="num text-fg">&lt;sale_id&gt;.&lt;contract&gt;</span>.
      </>
    ),
  },
  {
    k: "Enclave",
    v: "The enclave job's hash is pinned in the contract. OutLayer attests each run, and the contract accepts a result only for that hash.",
  },
  {
    k: "Bid slots",
    v: `Slots are first come, first served. A void bid${simulated ? ", like the copycat's," : ""} loses 1 % of its deposit, so filling them with junk costs money.`,
  },
];

export function JudgeNotes({ simulated = true }: { /** False when the app runs against a real contract. */ simulated?: boolean }) {
  return (
    <section aria-labelledby="judge-notes-title" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="judge-notes-title" className="text-h2 text-fg">
          {simulated ? "The same sale on NEAR" : "A sale on NEAR"}
        </h2>
        <Link href="/how#trust" className={LINK + " text-small"}>
          Trust assumptions and limits
        </Link>
      </div>
      <dl className="border-y border-line">
        {notes(simulated).map((n) => (
          <Row key={n.k} k={n.k}>
            {n.v}
          </Row>
        ))}
        {/* The run skips funding: a judge-mode sale lasts 30 seconds. */}
        {simulated && <FundingRow />}
      </dl>
    </section>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-x-6 gap-y-0.5 border-line py-3 sm:grid-cols-[132px_minmax(0,1fr)] [&:not(:first-child)]:border-t">
      <dt className="text-small font-[510] text-fg">{k}</dt>
      <dd className="max-w-[84ch] text-small text-muted">{children}</dd>
    </div>
  );
}

/**
 * Points at a live demo sale. The seeded one may be a rolling copy (fairt-2,
 * fairt-3...) once an earlier copy has closed, so link to whichever sale is
 * open now, or to the list when none is.
 */
function FundingRow() {
  const { data: sales } = useSales();
  const open = sales?.find((s) => s.status === "open" && !s.isJudgeSale);
  return (
    <Row k="Funding">
      An open sale shows live dry quotes for funding a bid from another chain.{" "}
      <Link
        href={open ? `/sale/${encodeURIComponent(open.id)}` : "/"}
        className="rounded-sm text-fg underline decoration-line-strong underline-offset-4 transition-colors hover:decoration-fg"
      >
        {open ? `Try it on ${open.config.tokenName}` : "See the sales"}
      </Link>
    </Row>
  );
}
