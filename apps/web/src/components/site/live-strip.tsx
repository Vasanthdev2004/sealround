import { Badge, Tag } from "@/components/ui/badge";
import { QuietLink } from "@/components/ui/bits";
import { Reveal } from "@/components/visual/reveal";
import {
  LIVE_CONTRACT,
  LIVE_CONTRACT_LOCKED,
  LIVE_LOCK_TX,
  LIVE_SALES,
  explorerAddress,
  explorerTx,
  modeLabel,
  tokenAccount,
  verifyCommand,
} from "./live-evidence";
import { LiveCommand } from "./live-command";

/**
 * "Live on NEAR testnet": the sale contract, whether its account is locked,
 * and each live sale with its explorer links and the read-only command that
 * checks it again. Every fact comes from `live-evidence.ts`.
 */
export function LiveStrip() {
  const sales = [...LIVE_SALES].reverse();
  return (
    <Reveal id="live" className="panel mt-14 overflow-hidden scroll-mt-20">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 border-b border-line px-5 py-4 sm:px-6">
        <div className="min-w-0 max-w-[68ch]">
          <h3 className="text-h3 text-fg">Live on NEAR testnet</h3>
          <p className="mt-1 text-small text-muted">
            Sale contract <QuietLink href={explorerAddress(LIVE_CONTRACT)}>{LIVE_CONTRACT}</QuietLink>.{" "}
            {LIVE_CONTRACT_LOCKED ? (
              <>
                Its account has no access keys left, so nobody can change its code or move what it holds
                {LIVE_LOCK_TX ? (
                  <>
                    {" "}
                    (<QuietLink href={explorerTx(LIVE_LOCK_TX)}>the transaction that deleted the last key</QuietLink>)
                  </>
                ) : null}
                .
              </>
            ) : (
              "Not locked yet: its account still has its deploy key."
            )}{" "}
            Run a command below from a clone of the repo to check that sale again: it only reads the chain and
            OutLayer, and needs no key.
          </p>
        </div>
        <Badge tone={LIVE_CONTRACT_LOCKED ? "ok" : "warn"} dot>
          {LIVE_CONTRACT_LOCKED ? "Locked, no keys" : "Not locked yet"}
        </Badge>
      </div>
      <ol className="divide-y divide-line">
        {sales.map((s) => (
          <li
            key={`${s.contract}/${s.sale}`}
            className="grid gap-3 px-5 py-4 sm:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:items-center lg:gap-8"
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                <span className="text-small font-[510] text-fg [overflow-wrap:anywhere]">{s.sale}</span>
                <Tag>{modeLabel(s.mode)}</Tag>
                {s.afterLock && <Tag tone="ok">After the lock</Tag>}
              </div>
              <p className="mt-1 text-small text-muted">{s.note}</p>
              <p className="mt-1.5 text-label text-subtle">
                On the explorer:{" "}
                <QuietLink href={explorerAddress(s.contract)}>
                  {s.contract === LIVE_CONTRACT ? "the contract" : s.contract}
                </QuietLink>
                , <QuietLink href={explorerAddress(tokenAccount(s))}>the sale&apos;s token</QuietLink>
              </p>
            </div>
            <LiveCommand command={verifyCommand(s)} what={s.sale} />
          </li>
        ))}
      </ol>
    </Reveal>
  );
}
