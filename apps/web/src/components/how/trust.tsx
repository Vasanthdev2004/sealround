import { SimulatedNote } from "@/components/ui/bits";
import { isNearMode } from "@/lib/config";

const TRUSTED: { title: string; risk?: string; body: string }[] = [
  {
    title: "OutLayer’s TEE",
    body: "Keeps bid prices secret and runs the published job inside Intel TDX. The job’s hash is pinned in the contract at deployment and cannot change. OutLayer attests each run (the code hash, the bids that went in, the result that came out), and the contract accepts a result only for the pinned hash. The result page shows that hash next to our reproducible build.",
  },
  {
    title: "OutLayer’s master secret",
    risk: "Known privacy risk",
    body: "Each sale’s key is derived inside the enclave from one OutLayer master secret. OutLayer’s own docs say a DAO full-access key can currently obtain that master secret outside an enclave. Whoever holds that key could, in principle, derive a sale’s private key and read its sealed bids. The clearing math and payouts would still be checked by the contract, but price privacy would not hold.",
  },
  {
    title: "NEAR Intents 1Click",
    body: "Routes cross-chain funding through solvers. A failed swap refunds to the origin address.",
  },
  {
    title: "The gas relayer",
    body: "Pays the network fee for bids, reveals, claims, clearing a commit-reveal sale and refund mode, including the 1 yoctoNEAR a USDC transfer has to attach. It cannot move anyone’s funds and stores only rate-limit counters. A gasless bid needs a wallet that signs a delegate action with a full-access key. Other wallets send the same bid as a normal transaction with a small NEAR fee, and so does everyone while the relayer is down or out of budget. Creating and closing a sale attach NEAR, so they are never relayed.",
  },
];

const CHECKED = [
  "The result came from OutLayer for the pinned enclave code hash",
  "Its bid-set hash equals the hash stored at close",
  "The bids were opened with this sale’s published key",
  "The clearing price is at least the floor",
  "Tokens filled are at most the sale supply",
  "There is one fill for every bid in the frozen bid set",
  "No fill costs more than that bidder’s deposit",
  "Every charge equals tokens × clearing price",
  "No bid listed as invalid received tokens",
  "The total raise meets the minimum, or the sale refunds",
];

export function TrustAssumptions() {
  return (
    <div className="flex flex-col gap-10">
      <section aria-labelledby="trust-you-h">
        <h3 id="trust-you-h" className="text-h3 text-fg">
          What you trust
        </h3>
        <ul className="mt-3 divide-y divide-line border-y border-line">
          {TRUSTED.map((t) => (
            <li key={t.title} className="grid gap-1 py-4 sm:grid-cols-[13rem_minmax(0,1fr)] sm:gap-6">
              <div>
                <h4 className="text-body font-[510] text-fg">{t.title}</h4>
                {t.risk && (
                  <p className="mt-0.5 flex items-center gap-2 text-small text-warn">
                    <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warn" />
                    {t.risk}
                  </p>
                )}
              </div>
              <p className="max-w-[68ch] text-body text-muted">{t.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="trust-checks-h">
        <h3 id="trust-checks-h" className="text-h3 text-fg">
          What the contract checks itself
        </h3>
        <p className="mt-1 max-w-[68ch] text-body text-muted">
          Everything public is verified before settling. There is no admin key: the contract has no owner methods, and
          sale parameters cannot change after creation.
        </p>
        <ol className="mt-3 grid border-t border-line sm:grid-cols-2 sm:gap-x-10">
          {CHECKED.map((c, i) => (
            <li key={c} className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-3 border-b border-line py-2.5">
              <span aria-hidden className="num pt-0.5 text-label text-subtle">
                {i + 1}
              </span>
              <span className="text-body text-fg">{c}</span>
            </li>
          ))}
        </ol>
      </section>

      {!isNearMode() && (
        <SimulatedNote className="-mt-4">
          This demo runs on a simulated chain in your browser, including a simulated attestation and a simulated gas
          relayer. The sealed-box encryption and the clearing math are real.
        </SimulatedNote>
      )}
    </div>
  );
}
