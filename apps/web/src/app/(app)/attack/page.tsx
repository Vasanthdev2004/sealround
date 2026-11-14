import type { Metadata } from "next";
import { ArrowUpRight } from "lucide-react";
import { QuietLink } from "@/components/ui/bits";
import { PageHeader } from "@/components/ui/panel";
import attackEvidence from "../../../../../../evidence/attacks.json";

export const metadata: Metadata = {
  title: "Try to beat it",
  description: "See how Sealround sales and Meme Chapters handle eight challenges, with transaction receipts and test references.",
};

type AttackEvidence = {
  id: string;
  title: string;
  attempt: string;
  outcome: string;
  tx?: { hash: string; network: string };
  test: string;
};

const attacks: readonly AttackEvidence[] = attackEvidence;
const columns = "md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.9fr)]";

export default function AttackPage() {
  return (
    <div className="w-full">
      <PageHeader
        title="Try to beat it"
        description="See what each attempt tries to change, how the contract responds, and where to check the result."
      />
      <p className="mt-4 max-w-[68ch] text-small text-muted">
        On Nearblocks, inspect the receipts for failed calls, rejection events and refunds. The sniper and copycat links show their bid submissions for nosnipe-11140458 on sealround.itzbeast.testnet.
      </p>

      <ol className="mt-8 grid gap-4" aria-label="Attack evidence">
        {attacks.map(({ id, title, attempt, outcome, tx, test }) => (
          <li key={id}>
            <article id={id} aria-labelledby={`${id}-title`} className="panel scroll-mt-20 px-5 py-4 sm:px-6 sm:py-5">
              <h2 id={`${id}-title`} className="text-h3 text-fg">{title}</h2>
              <dl className={`mt-4 grid gap-4 border-t border-line pt-4 md:gap-6 ${columns}`}>
                <div className="min-w-0">
                  <dt className="text-label font-[510] text-fg">Attempt</dt>
                  <dd className="mt-1 text-small text-muted">{attempt}</dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-label font-[510] text-fg">Contract response</dt>
                  <dd className="mt-1 text-small text-muted">{outcome}</dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-label font-[510] text-fg">Proof</dt>
                  <dd className="mt-1 flex flex-col items-start gap-1.5 text-small text-muted">
                    {tx ? (
                      <QuietLink href={`https://${tx.network === "testnet" ? "testnet." : ""}nearblocks.io/txns/${encodeURIComponent(tx.hash)}`}>
                        {id === "sniper" || id === "copycat" ? "Bid transaction" : "Transaction"} on Nearblocks
                        <ArrowUpRight aria-hidden className="ml-1 inline size-3" />
                      </QuietLink>
                    ) : <span className="text-subtle">tx pending</span>}
                    <code className="font-mono text-label [overflow-wrap:anywhere]">{test}</code>
                  </dd>
                </div>
              </dl>
            </article>
          </li>
        ))}
      </ol>
    </div>
  );
}
