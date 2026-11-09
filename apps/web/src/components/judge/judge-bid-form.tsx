"use client";

import { useState } from "react";
import { Lock, Wallet } from "lucide-react";
import { parseUnits } from "@fairground/clearing";
import { Button } from "@/components/ui/button";
import { Countdown, TxLink } from "@/components/ui/bits";
import { Field } from "@/components/ui/field";
import { KV } from "@/components/ui/stat";
import { Panel } from "@/components/ui/panel";
import { getClient } from "@/lib/client";
import { randomHex, sealBid } from "@/lib/crypto";
import { priceStr, usdcStr } from "@/lib/format";
import { useAction, useBalances, useMyBid, useNow } from "@/lib/hooks";
import type { BidRecord, Sale } from "@/lib/types";
import { useWallet } from "@/lib/wallet";

/** Add your own sealed bid to the judge-mode sale while its window is open. */
export function JudgeBidForm({ sale }: { sale: Sale }) {
  const { account, connect, connecting } = useWallet();
  const myBid = useMyBid(sale.id, account);
  const now = useNow(500);
  const open = now < sale.config.bidEnd;

  return (
    <Panel
      title="Add your own sealed bid"
      subtitle="Encrypted in this browser before it leaves. Then it is just another row below."
      icon={<Lock strokeWidth={1.75} />}
      action={
        open ? (
          <div className="text-right">
            <Countdown to={sale.config.bidEnd} className="text-[13px] text-fg" />
            <div className="text-[11.5px] text-subtle">left</div>
          </div>
        ) : null
      }
    >
      {myBid.data ? (
        <PlacedBid bid={myBid.data} />
      ) : !open ? (
        <p className="text-[13px] text-muted">The bid window has closed. Watch the enclave clear the sale.</p>
      ) : !account ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-sm text-[13px] text-muted">
            You need an account to bid. The demo wallet is a simulated testnet account with 100 test USDC.
          </p>
          <Button onClick={connect} loading={connecting} icon={<Wallet className="size-4" strokeWidth={1.75} />}>
            Connect demo wallet
          </Button>
        </div>
      ) : myBid.loading ? (
        <div className="shimmer h-24 rounded-tile bg-hover" aria-hidden />
      ) : (
        <BidInputs sale={sale} account={account} />
      )}
    </Panel>
  );
}

type Parsed = { ok: true; v: bigint } | { ok: false };

function parse(s: string): Parsed {
  try {
    return { ok: true, v: parseUnits(s.replace(/,/g, ""), 6) };
  } catch {
    return { ok: false };
  }
}

function BidInputs({ sale, account }: { sale: Sale; account: string }) {
  const c = sale.config;
  const [price, setPrice] = useState(() => priceStr(c.floorPrice * 3n).replace(/,/g, ""));
  const [spend, setSpend] = useState("5");
  const [deposit, setDeposit] = useState("5");
  const [depositTouched, setDepositTouched] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const bal = useBalances(account);

  const p = parse(price);
  const sp = parse(spend);
  const dp = parse(deposit);

  let priceErr: string | null = null;
  let priceHint = `Floor ${priceStr(c.floorPrice)}. Never shown to anyone.`;
  if (!p.ok) priceErr = "Enter a price like 0.003.";
  else if (p.v < c.floorPrice) priceErr = `Below the floor of ${priceStr(c.floorPrice)}. The bid would be void.`;
  else if (c.maxPrice !== null && p.v > c.maxPrice) priceHint = `Above the sale's max price; counted as ${priceStr(c.maxPrice)}.`;

  let spendErr: string | null = null;
  if (!sp.ok) spendErr = "Enter an amount like 5.";
  else if (sp.v <= 0n) spendErr = "Max spend must be above zero.";
  else if (dp.ok && sp.v > dp.v) spendErr = "Max spend cannot be more than your deposit.";

  let depositErr: string | null = null;
  if (!dp.ok) depositErr = "Enter an amount like 5.";
  else if (dp.v < c.minDeposit) depositErr = `Minimum deposit is ${usdcStr(c.minDeposit, 6)} USDC.`;
  else if (dp.v > c.maxDepositPerAccount) depositErr = `Maximum deposit is ${usdcStr(c.maxDepositPerAccount, 6)} USDC per account.`;
  else if (bal.data && dp.v > bal.data.usdc) depositErr = `Not enough test USDC. Balance ${usdcStr(bal.data.usdc)}.`;

  const valid = !priceErr && !spendErr && !depositErr;

  const submit = useAction(async () => {
    if (!p.ok || !sp.ok || !dp.ok) throw new Error("Check the amounts.");
    const ciphertext = await sealBid(sale.sealerPubkey, {
      sale_id: sale.id,
      bidder: account,
      max_price: p.v.toString(),
      max_spend: sp.v.toString(),
      salt: randomHex(16),
    });
    return getClient().placeBid(sale.id, account, dp.v, ciphertext);
  });

  return (
    <form
      className="@container"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setShowErrors(true);
        if (valid && !submit.pending) void submit.run();
      }}
    >
      <div className="grid gap-4 @xl:grid-cols-3">
        <Field
          label="Max price"
          suffix="USDC / token"
          inputMode="decimal"
          autoComplete="off"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          error={showErrors || !p.ok ? priceErr : null}
          hint={priceHint}
        />
        <Field
          label="Max spend"
          suffix="USDC"
          inputMode="decimal"
          autoComplete="off"
          value={spend}
          onChange={(e) => {
            setSpend(e.target.value);
            if (!depositTouched) setDeposit(e.target.value);
          }}
          error={showErrors || !sp.ok ? spendErr : null}
          hint="The most you will pay. Also hidden."
        />
        <Field
          label="Deposit"
          suffix="USDC"
          inputMode="decimal"
          autoComplete="off"
          value={deposit}
          onChange={(e) => {
            setDeposit(e.target.value);
            setDepositTouched(true);
          }}
          error={showErrors || !dp.ok ? depositErr : null}
          hint={`Public. ${usdcStr(c.minDeposit)} to ${usdcStr(c.maxDepositPerAccount)} USDC.`}
        />
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[12px] text-subtle">
          Deposit above max spend hides your real budget. Unspent USDC comes back at claim.
        </p>
        <Button type="submit" variant="primary" loading={submit.pending} disabled={showErrors && !valid}>
          Seal and bid
        </Button>
      </div>
      {submit.error && (
        <p className="mt-3 rounded-tile bg-bad-soft px-3 py-2 text-[12.5px] text-bad" role="alert">
          {submit.error} Your USDC did not move.
        </p>
      )}
    </form>
  );
}

function PlacedBid({ bid }: { bid: BidRecord }) {
  return (
    <div>
      <div className="flex items-center gap-2 text-[13.5px] text-fg">
        <span className="size-1.5 rounded-full bg-ok" aria-hidden />
        Your sealed bid is in, as row #{bid.index + 1}.
      </div>
      <p className="mt-1 text-[12.5px] text-muted">
        This ciphertext is all the chain holds. Only the enclave can open it, and only after close.
      </p>
      <div className="inset cipher mt-3 max-h-24 overflow-y-auto px-3 py-2.5">{bid.ciphertext}</div>
      <dl className="mt-2">
        <KV k="Deposit" v={`${usdcStr(bid.deposit)} USDC`} />
        <KV k="Transaction" v={<TxLink hash={bid.txHash} />} />
      </dl>
    </div>
  );
}
