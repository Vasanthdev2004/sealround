"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { KV } from "@/components/ui/stat";
import { getClient } from "@/lib/client";
import { dateTime, duration, priceStr, shortHash, tokenFull, tokenStr, usdcStr } from "@/lib/format";
import type { Sale } from "@/lib/types";

/** Rows of a ledger: 41px each, divided by hairlines. */
const LEDGER = "divide-y divide-line px-5 [&>div]:py-2.5";

/** A group of the full list: a quiet 36px heading row, then its rows. */
function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-line">
      <h3 className="flex h-9 items-end px-5 pb-1.5 text-label font-normal text-subtle">{title}</h3>
      <dl className={LEDGER}>{children}</dl>
    </div>
  );
}

/**
 * Every SaleConfig parameter, plus the sealer key and code hash, as a ledger.
 * Locked at launch. The rules people check first are always visible; the
 * rest opens on request.
 */
export function RulesPanel({ sale }: { sale: Sale }) {
  const c = sale.config;
  const sym = c.tokenSymbol;
  const tok = (v: bigint) => (
    <span title={tokenFull(v, c.decimals)}>
      {tokenStr(v, c.decimals)} {sym}
    </span>
  );
  const client = getClient();
  const tee = c.revealMode === "tee";
  // "" when this deployment names no reference build: then there is nothing to compare with.
  const expected = client.expectedCodeHash();
  const codeMatches = !!expected && sale.sealerCodeHash === expected;
  const [open, setOpen] = useState(false);

  return (
    <Panel
      title="Rules"
      action={<span className="text-label text-subtle">Locked at launch</span>}
      bodyClassName="p-0"
    >
      <dl className={LEDGER}>
        <KV k="For sale" v={tok(c.saleSupply)} />
        <KV k="Floor price" v={`${priceStr(c.floorPrice)} USDC`} />
        {c.maxPrice !== null && <KV k="Max price" v={`${priceStr(c.maxPrice)} USDC`} />}
        <KV k="Min raise" v={`${usdcStr(c.minRaise)} USDC`} />
        <KV k="Deposit per account" v={`${usdcStr(c.minDeposit)} to ${usdcStr(c.maxDepositPerAccount)} USDC`} />
        <KV k="Bids per account" v="One" mono={false} />
        <KV k="Bid window" v={duration(c.bidEnd - c.bidStart)} />
        <KV k="Bid privacy" v={tee ? "Sealed, an enclave clears" : "Commit-reveal, the contract clears"} mono={false} />
        {!tee && c.revealWindowMs !== undefined && <KV k="Reveal window" v={duration(c.revealWindowMs)} />}
        {tee && (
          <>
            <KV k="Enclave code hash" v={<span title={sale.sealerCodeHash}>{shortHash(sale.sealerCodeHash, 6)}</span>} />
            <KV
              k="Against the reference build"
              v={
                <span className={codeMatches ? "font-sans text-ok" : "font-sans text-muted"}>
                  {codeMatches ? "Matches" : expected ? "Differs" : "Not checked"}
                </span>
              }
            />
          </>
        )}
      </dl>

      <div className="border-t border-line px-2 py-2">
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={open}
          aria-controls="rules-all"
          onClick={() => setOpen((v) => !v)}
          className="max-sm:h-10"
        >
          {open ? "Hide the other parameters" : "Show every other parameter"}
        </Button>
      </div>

      {open && (
        <div id="rules-all" className="anim-fade">
          <Group title="Token">
            <KV k="Name" v={c.tokenName} mono={false} />
            <KV k="Symbol" v={sym} />
            <KV k="Token account" v={<span className="break-all">{sale.tokenAccount}</span>} />
            <KV k="Decimals" v={c.decimals} />
            <KV k="Total supply" v={tok(c.totalSupply)} />
            <KV k="Creator allocation" v={tok(c.creatorAllocation)} />
            <KV k="LP reserve" v={tok(c.lpReserve)} />
          </Group>
          <Group title="Bid window">
            <KV k="Opens" v={<span suppressHydrationWarning>{dateTime(c.bidStart)}</span>} />
            <KV k="Closes" v={<span suppressHydrationWarning>{dateTime(c.bidEnd)}</span>} />
          </Group>
          <Group title="Deposits">
            <KV k="Deposit token" v={<span className="break-all">{c.quoteToken}</span>} />
            {sale.maxBids !== undefined && <KV k="Bid slots" v={sale.maxBids} />}
            <KV k="A void bid" v="Loses 1&nbsp;% of its deposit" mono={false} />
          </Group>
          <Group title="Settlement">
            <KV k="Unsold tokens" v={c.unsoldRule === "burn" ? "Burned" : c.unsoldRule} mono={false} />
            <KV k="Settle timeout" v={duration(c.settleTimeoutMs)} />
            <KV k="Contract" v={<span className="break-all">{client.contractId}</span>} />
            {tee && (
              <KV k="Sealer public key" v={<span title={sale.sealerPubkey}>{shortHash(sale.sealerPubkey, 6)}</span>} />
            )}
          </Group>
        </div>
      )}
    </Panel>
  );
}
