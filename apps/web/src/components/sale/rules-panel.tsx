"use client";

import { BadgeCheck, LockKeyhole } from "lucide-react";
import { Panel } from "@/components/ui/panel";
import { KV } from "@/components/ui/stat";
import { getClient } from "@/lib/client";
import { dateTime, duration, priceStr, shortHash, tokenFull, tokenStr, usdcStr } from "@/lib/format";
import type { Sale } from "@/lib/types";

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-dashed border-line-dashed py-2 first:border-t-0 first:pt-0 last:pb-0">
      <div className="pt-1.5 pb-0.5 text-[12px] text-subtle">{title}</div>
      <dl className="[&>div]:py-1.5">{children}</dl>
    </div>
  );
}

/** Every SaleConfig parameter, plus the sealer key and code hash. Locked at launch. */
export function RulesPanel({ sale }: { sale: Sale }) {
  const c = sale.config;
  const sym = c.tokenSymbol;
  const tok = (v: bigint) => <span title={tokenFull(v, c.decimals)}>{tokenStr(v, c.decimals)} {sym}</span>;
  const client = getClient();
  const codeMatches = sale.sealerCodeHash === client.expectedCodeHash();

  return (
    <Panel
      title="Rules, locked"
      subtitle="Set at launch. No admin key can change them."
      icon={<LockKeyhole strokeWidth={1.75} />}
    >
      <Group title="Token">
        <KV k="Name" v={c.tokenName} mono={false} />
        <KV k="Symbol" v={sym} />
        <KV k="Token account" v={<span className="break-all">{sale.tokenAccount}</span>} />
        <KV k="Decimals" v={c.decimals} />
        <KV k="Total supply" v={tok(c.totalSupply)} />
        <KV k="For sale" v={tok(c.saleSupply)} />
        <KV k="Creator allocation" v={tok(c.creatorAllocation)} />
        <KV k="LP reserve" v={tok(c.lpReserve)} />
      </Group>
      <Group title="Price">
        <KV k="Floor price" v={`${priceStr(c.floorPrice)} USDC`} />
        <KV k="Max price" v={c.maxPrice === null ? "None" : `${priceStr(c.maxPrice)} USDC`} />
        <KV k="Min raise" v={`${usdcStr(c.minRaise)} USDC`} />
      </Group>
      <Group title="Bid window">
        <KV k="Opens" v={<span suppressHydrationWarning>{dateTime(c.bidStart)}</span>} />
        <KV k="Closes" v={<span suppressHydrationWarning>{dateTime(c.bidEnd)}</span>} />
        <KV k="Length" v={duration(c.bidEnd - c.bidStart)} />
      </Group>
      <Group title="Deposits">
        <KV k="Min deposit" v={`${usdcStr(c.minDeposit)} USDC`} />
        <KV k="Max per account" v={`${usdcStr(c.maxDepositPerAccount)} USDC`} />
        <KV k="Deposit token" v={<span className="break-all">{c.quoteToken}</span>} />
      </Group>
      <Group title="Settlement">
        <KV k="Bid privacy" v={c.revealMode === "tee" ? "Sealed, TEE clears" : "Commit-reveal"} mono={false} />
        <KV k="Unsold tokens" v={c.unsoldRule === "burn" ? "Burned" : c.unsoldRule} mono={false} />
        <KV k="Settle timeout" v={duration(c.settleTimeoutMs)} />
        <KV k="Contract" v={client.contractId} />
      </Group>
      <Group title="Enclave">
        <KV k="Sealer public key" v={<span title={sale.sealerPubkey}>{shortHash(sale.sealerPubkey, 6)}</span>} />
        <KV
          k="Sealer code hash"
          v={
            <span className="inline-flex items-center gap-1" title={sale.sealerCodeHash}>
              {shortHash(sale.sealerCodeHash, 6)}
              {codeMatches && (
                <BadgeCheck className="size-3.5 text-ok" strokeWidth={1.75} aria-label="Matches our reproducible build" />
              )}
            </span>
          }
        />
      </Group>
    </Panel>
  );
}
