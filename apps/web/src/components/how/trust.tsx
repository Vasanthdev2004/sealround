import { Check, TriangleAlert } from "lucide-react";
import { SimulatedNote } from "@/components/ui/bits";

const TRUSTED: { title: string; body: string }[] = [
  {
    title: "OutLayer’s TEE",
    body: "Keeps bid prices secret and runs the published code inside Intel TDX. The app fetches its attestation with a fresh random nonce and checks the code hash and the sale’s public key.",
  },
  {
    title: "NEAR Intents 1Click",
    body: "Routes cross-chain funding through solvers. A failed swap refunds to the origin address.",
  },
  {
    title: "The gas relayer",
    body: "Only pays gas for calls into the Fairground contract. It cannot move anyone’s funds and stores only rate-limit counters.",
  },
];

const CHECKED = [
  "The result came from OutLayer for the registered enclave code hash",
  "Its bid-set hash equals the hash stored at close",
  "The clearing price is at least the floor",
  "Tokens filled are at most the sale supply",
  "Every fill belongs to a bidder in the frozen bid set",
  "No fill costs more than that bidder’s deposit",
  "Every charge equals tokens × clearing price",
  "The total raise meets the minimum, or everyone is refunded",
];

export function TrustAssumptions() {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-card border border-line bg-elev p-5">
          <h3 className="text-[14px] font-medium text-fg">What you trust</h3>
          <ul className="mt-3 flex flex-col gap-3.5">
            {TRUSTED.map((t) => (
              <li key={t.title}>
                <div className="text-[13px] font-medium text-fg">{t.title}</div>
                <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{t.body}</p>
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-card border border-line bg-elev p-5">
          <h3 className="text-[14px] font-medium text-fg">What the contract checks itself</h3>
          <p className="mt-1 text-[13px] leading-relaxed text-muted">
            It trusts the enclave only for the hidden prices. Everything public it verifies before settling.
          </p>
          <ul className="mt-3 flex flex-col gap-2">
            {CHECKED.map((c) => (
              <li key={c} className="flex items-start gap-2.5 text-[13px] leading-snug text-muted">
                <span className="mt-px flex size-4 shrink-0 items-center justify-center rounded-full bg-ok-soft ring-1 ring-ok/25">
                  <Check className="size-2.5 text-ok" strokeWidth={3} aria-hidden />
                </span>
                {c}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="flex gap-3 rounded-card border border-warn/30 bg-warn-soft p-4">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" strokeWidth={1.75} aria-hidden />
        <div>
          <div className="text-[13.5px] font-medium text-fg">The weakest link today: OutLayer’s master secret</div>
          <p className="mt-1 text-[13px] leading-relaxed text-muted">
            Each sale’s key is derived inside the enclave from one OutLayer master secret. OutLayer’s own docs say a DAO
            full-access key can currently obtain that master secret outside an enclave. Whoever holds that key could,
            in principle, derive a sale’s private key and read its sealed bids. The clearing math and payouts would still
            be checked by the contract, but price privacy would not hold.
          </p>
        </div>
      </div>

      <p className="text-[13px] leading-relaxed text-muted">
        No admin key: the contract has no owner methods, and sale parameters cannot change after creation.
      </p>
      <SimulatedNote>
        This demo runs on a simulated chain in your browser, including a simulated attestation. The sealed-box
        encryption and the clearing math are real.
      </SimulatedNote>
    </div>
  );
}
