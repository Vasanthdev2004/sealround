"use client";

import { useState } from "react";
import { parseUnits } from "@fairground/clearing";
import {
  ActionError,
  GasNote,
  PaidFallbackPrompt,
  RelayLine,
  useGasMode,
  usePaidFallback,
} from "@/components/sale-common/relay";
import { Button } from "@/components/ui/button";
import { Countdown, TxLink } from "@/components/ui/bits";
import { Field } from "@/components/ui/field";
import { KV } from "@/components/ui/stat";
import { Panel } from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { CipherChip } from "@/components/visual/cipher-chip";
import { getClient } from "@/lib/client";
import { cn } from "@/lib/cn";
import { randomHex, sealBid } from "@/lib/crypto";
import { priceStr, usdcStr } from "@/lib/format";
import { useAction, useBalances, useMyBid, useNow } from "@/lib/hooks";
import type { BidRecord, RelayInfo, Sale } from "@/lib/types";
import { useWallet } from "@/lib/wallet";

const TITLE = "Add your own sealed bid";

/**
 * The form's frame while the run's sale is still being created, sized like
 * the first thing the form shows (the connect row, or the inputs when a wallet
 * is already connected), so nothing below it moves when the sale arrives.
 */
export function JudgeBidFormFrame({ connected }: { connected: boolean }) {
  return (
    <Panel title={TITLE} bodyClassName="@container p-5">
      <div role="status" aria-busy="true">
        <span className="sr-only">Creating the sale</span>
        {connected ? <FormSkeleton /> : <ConnectRow />}
      </div>
    </Panel>
  );
}

/** Add your own sealed bid to the judge-mode sale while its window is open. */
export function JudgeBidForm({ sale }: { sale: Sale }) {
  const { account, connect, connecting } = useWallet();
  const myBid = useMyBid(sale.id, account);
  const now = useNow(500);
  const open = now < sale.config.bidEnd;
  // How this browser's bid was paid for (the chain's bid record does not say).
  const [relay, setRelay] = useState<RelayInfo | null>(null);

  return (
    <Panel
      title={TITLE}
      bodyClassName="@container p-5"
      action={
        open ? (
          <span className="text-label text-subtle">
            Closes in <Countdown to={sale.config.bidEnd} className="text-small font-[510] text-fg" />
          </span>
        ) : null
      }
    >
      {myBid.data ? (
        <PlacedBid bid={myBid.data} relay={relay} />
      ) : !open ? (
        // The hidden copy of what was here holds its height, so the cards below stay put when the window closes.
        <div className="grid">
          <div className="invisible col-start-1 row-start-1" aria-hidden>
            {account ? <FormSkeleton /> : <ConnectRow />}
          </div>
          <p className={cn("col-start-1 row-start-1 text-small text-muted", !account && "self-center")}>
            The bid window has closed.
          </p>
        </div>
      ) : !account ? (
        <ConnectRow onConnect={connect} connecting={connecting} />
      ) : myBid.loading ? (
        <FormSkeleton />
      ) : (
        <BidInputs sale={sale} account={account} onPlaced={setRelay} />
      )}
    </Panel>
  );
}

/**
 * The row a judge without a wallet sees. Without `onConnect` it is the frame
 * shown while the sale is being created: the same words, the button waiting.
 */
function ConnectRow({ onConnect, connecting }: { onConnect?: () => void; connecting?: boolean }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
      <p className="max-w-[52ch] text-small text-muted">
        The demo wallet is a simulated account with 100 test USDC. Your max price and max spend are encrypted in this
        browser.
      </p>
      <Button onClick={onConnect} loading={connecting} disabled={!onConnect} className="max-sm:h-10 max-sm:w-full">
        Connect demo wallet
      </Button>
    </div>
  );
}

/** Three fields with their hints, then the gas line and the button: the form's settled size. */
function FormSkeleton() {
  return <Skeleton className="h-[407px] @lg:h-[147px]" rounded="tile" />;
}

type Parsed = { ok: true; v: bigint } | { ok: false };

function parse(s: string): Parsed {
  try {
    return { ok: true, v: parseUnits(s.replace(/,/g, ""), 6) };
  } catch {
    return { ok: false };
  }
}

function BidInputs({
  sale,
  account,
  onPlaced,
}: {
  sale: Sale;
  account: string;
  /** Called with how the bid was paid for, once it has landed. */
  onPlaced: (relay: RelayInfo | null) => void;
}) {
  const c = sale.config;
  const gas = useGasMode();
  const fallback = usePaidFallback(gas.paidBy === "user" ? gas.reason : null);
  const { onPaidFallback } = fallback;
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
  let priceHint = `Sealed. The floor is ${priceStr(c.floorPrice)}.`;
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
    const placed = await getClient().placeBid(sale.id, account, dp.v, ciphertext, { onPaidFallback });
    onPlaced(placed.relay ?? null);
    return placed;
  });
  // The last attempt may still land: no second attempt until the chain has spoken.
  const inDoubt = !!submit.errorDetails?.maybeSubmitted;

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setShowErrors(true);
        if (valid && !submit.pending && !inDoubt) void submit.run();
      }}
    >
      <div className="grid gap-4 @lg:grid-cols-3">
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
          hint="Sealed. The most you will pay."
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
          hint="Public. The unspent part comes back."
        />
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <GasNote what="This bid" className="max-w-[52ch]" />
        <Button
          type="submit"
          variant="primary"
          className="ml-auto max-sm:h-10 max-sm:w-full"
          loading={submit.pending}
          disabled={(showErrors && !valid) || inDoubt}
        >
          {inDoubt ? "Checking the chain" : "Seal and bid"}
        </Button>
      </div>
      <PaidFallbackPrompt fallback={fallback} what="the bid" className="mt-3" />
      <ActionError info={submit.errorDetails} what="bid" className="mt-3" />
    </form>
  );
}

function PlacedBid({ bid, relay }: { bid: BidRecord; relay: RelayInfo | null }) {
  return (
    <div className="anim-fade" role="status">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <CipherChip seed={`${bid.saleId}:${bid.index}`} text={bid.ciphertext} chars={14} tone="accent" label="you" scramble size="md" />
        <span className="text-body text-fg">
          Sealed and recorded as bid <span className="num">#{bid.index + 1}</span>.
        </span>
      </div>
      <p className="mt-2 text-small text-muted">
        The chain holds only this ciphertext. The enclave opens it after the sale closes.
      </p>
      <dl className="mt-4 divide-y divide-line border-t border-line">
        <KV k="Deposit" v={`${usdcStr(bid.deposit)} USDC`} />
        <KV k="Transaction" v={<TxLink hash={bid.txHash} />} />
      </dl>
      <RelayLine relay={relay} className="mt-2" />
    </div>
  );
}
