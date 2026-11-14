import { Panel } from "@/components/ui/panel";

export function TrustBoundaries() {
  return (
    <Panel title="What these checks establish" bodyClassName="px-5 pt-2 pb-5">
      <dl className="grid gap-5 text-small sm:grid-cols-2 sm:gap-x-10">
        <div>
          <dt className="font-medium text-fg">Public evidence, checked in your browser</dt>
          <dd className="mt-1.5 leading-relaxed text-muted">Compare the sale, frozen bid set, recorded result and attested execution. Contract invariants check public accounting; they do not reveal every bidder’s private price or prove the full private clearing computation.</dd>
        </div>
        <div>
          <dt className="font-medium text-fg">Intel attestation is a separate boundary</dt>
          <dd className="mt-1.5 leading-relaxed text-muted">This browser checks quote bindings and approved measurements. Intel’s quote signature chain is checked separately by OutLayer’s verifier, linked in the evidence when available.</dd>
        </div>
        <div>
          <dt className="font-medium text-fg">Current keys, historical execution</dt>
          <dd className="mt-1.5 leading-relaxed text-muted">Access-key checks read the accounts now. They do not prove the accounts were keyless for the whole sale. Run timestamps show when execution happened; OutLayer takes no fresh challenge nonce.</dd>
        </div>
        <div>
          <dt className="font-medium text-fg">Missing evidence stays missing</dt>
          <dd className="mt-1.5 leading-relaxed text-muted">A failed check disagrees with the evidence. Unavailable means a check could not run. Not applicable means the sale does not use it. Simulated checks describe the browser demo.</dd>
        </div>
      </dl>
    </Panel>
  );
}
