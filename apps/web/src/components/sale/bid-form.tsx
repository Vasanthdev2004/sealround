"use client";

import { useState } from "react";
import { Lock, LockKeyhole, Wallet } from "lucide-react";
import { formatUnits, parseUnits } from "@fairground/clearing";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Panel } from "@/components/ui/panel";
import { getClient } from "@/lib/client";
import { canonicalBid, randomHex, sealBid } from "@/lib/crypto";
import { priceStr, shortHash, usdcStr } from "@/lib/format";
import type { BidPlaintext, BidRecord, Sale } from "@/lib/types";
import { useWallet } from "@/lib/wallet";
import { BidPreview } from "./bid-preview";
import { saveLocalBid } from "./local-bid";
import { SealTransition, type SealState } from "./seal-transition";

type Parsed = { value: bigint | null; error: string | null };

/** Parse a USDC amount or price typed by a person. 6 decimals max. */
function parseUsdc(input: string): Parsed {
  const s = input.replace(/[,\s]/g, "");
  if (!s) return { value: null, error: null };
  try {
    return { value: parseUnits(s, 6), error: null };
  } catch (e) {
    const tooPrecise = e instanceof Error && e.message.includes("too many decimals");
    return { value: null, error: tooPrecise ? "Use at most 6 decimals." : "Enter a number, like 0.002." };
  }
}

/** Plain decimal string for an input value (no thousands separators). */
const plain = (v: bigint) => formatUnits(v, 6, 6).replace(/,/g, "");

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function BidForm({
  sale,
  account,
  myBid,
  myBidLoading,
  usdcBalance,
  onSend,
}: {
  sale: Sale;
  account: string | null;
  myBid: BidRecord | null | undefined;
  myBidLoading: boolean;
  usdcBalance: bigint | null;
  /** Called when a sealed bid starts on its way to the contract. */
  onSend?: () => void;
}) {
  const { connect, connecting } = useWallet();
  const [seal, setSeal] = useState<SealState | null>(null);

  let body: React.ReactNode;
  if (account) {
    const canBid = !myBidLoading && !myBid;
    body = (
      <>
        {seal && <SealTransition state={seal} pubkey={sale.sealerPubkey} />}
        {!seal && myBidLoading && <div className="shimmer h-[220px] rounded-card bg-elev-2" />}
        {!seal && !myBidLoading && myBid && <AlreadyBid bid={myBid} />}
        {/* Stays mounted (hidden) while sealing, so a rejected bid keeps its inputs and shows the error. */}
        {(canBid || (seal && seal.phase !== "done")) && (
          <div hidden={!!seal}>
            <BidInputs sale={sale} account={account} usdcBalance={usdcBalance} onSeal={setSeal} onSend={onSend} />
          </div>
        )}
      </>
    );
  } else {
    body = (
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-[14px] font-medium text-fg">Connect a wallet to bid.</div>
          <p className="mt-0.5 text-[13px] text-muted">Demo accounts start with 100 test USDC. No real funds.</p>
        </div>
        <Button
          variant="primary"
          size="lg"
          onClick={connect}
          loading={connecting}
          icon={<Wallet className="size-4" strokeWidth={1.75} />}
          className="w-full sm:w-auto"
        >
          Connect
        </Button>
      </div>
    );
  }

  return (
    <Panel
      id="bid"
      title="Place a sealed bid"
      subtitle="Encrypted in this browser to the sale's enclave key."
      icon={<LockKeyhole strokeWidth={1.75} />}
    >
      {body}
    </Panel>
  );
}

function AlreadyBid({ bid }: { bid: BidRecord }) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-soft ring-1 ring-accent/30">
        <Lock className="size-4 text-accent" strokeWidth={1.75} />
      </span>
      <div>
        <div className="text-[14px] font-medium text-fg">Your sealed bid is in.</div>
        <p className="mt-0.5 text-[13px] text-muted">
          One bid per account. Your deposit of <span className="num text-fg">{usdcStr(bid.deposit)} USDC</span> is locked
          until the sale closes. Details are under My bid.
        </p>
      </div>
    </div>
  );
}

function BidInputs({
  sale,
  account,
  usdcBalance,
  onSeal,
  onSend,
}: {
  sale: Sale;
  account: string;
  usdcBalance: bigint | null;
  onSeal: React.Dispatch<React.SetStateAction<SealState | null>>;
  onSend?: () => void;
}) {
  const c = sale.config;
  const closed = sale.status !== "open";
  const [price, setPrice] = useState("");
  const [spend, setSpend] = useState("");
  const [deposit, setDeposit] = useState("");
  const [depositTouched, setDepositTouched] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const depositInput = depositTouched ? deposit : spend;
  const p = parseUsdc(price);
  const s = parseUsdc(spend);
  const d = parseUsdc(depositInput);

  let priceErr = p.error;
  if (!priceErr && p.value !== null && p.value < c.floorPrice) {
    priceErr = `At least the floor, ${priceStr(c.floorPrice)} USDC.`;
  }
  if (!priceErr && p.value === null && attempted) priceErr = "Enter your max price.";

  let spendErr = s.error;
  if (!spendErr && s.value !== null && s.value <= 0n) spendErr = "Max spend must be above zero.";
  if (!spendErr && s.value !== null && d.value !== null && s.value > d.value) {
    spendErr = "Above your deposit. Raise the deposit or lower the spend.";
  }
  if (!spendErr && s.value === null && attempted) spendErr = "Enter your max spend.";

  let depositErr = d.error;
  if (!depositErr && d.value !== null) {
    if (d.value < c.minDeposit) depositErr = `At least ${usdcStr(c.minDeposit)} USDC.`;
    else if (d.value > c.maxDepositPerAccount) depositErr = `At most ${usdcStr(c.maxDepositPerAccount)} USDC per account.`;
    else if (usdcBalance !== null && d.value > usdcBalance) {
      depositErr = `You have ${usdcStr(usdcBalance)} USDC. Fund from any chain, or use the faucet in the account menu.`;
    }
  }
  if (!depositErr && d.value === null && attempted) depositErr = "Enter a deposit.";

  const ok =
    p.value !== null &&
    s.value !== null &&
    d.value !== null &&
    !priceErr &&
    !spendErr &&
    !depositErr;

  const capped = c.maxPrice !== null && p.value !== null && p.value > c.maxPrice;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setAttempted(true);
    setError(null);
    if (!ok || p.value === null || s.value === null || d.value === null) return;
    const dep = d.value;
    const pt: BidPlaintext = {
      sale_id: sale.id,
      bidder: account,
      max_price: p.value.toString(),
      max_spend: s.value.toString(),
      salt: randomHex(16),
    };
    setBusy(true);
    onSend?.();
    onSeal({ phase: "plain", plain: canonicalBid(pt), cipher: null, deposit: dep, txHash: null });
    let alive = true;
    try {
      const ct = await sealBid(sale.sealerPubkey, pt);
      // Send right away. The sealing animation plays alongside the
      // transaction, so a bid placed seconds before the close is not held
      // back by it, and a rejection shows at once.
      const placing = getClient().placeBid(sale.id, account, dep, ct);
      const animation = (async () => {
        await wait(700);
        if (alive) onSeal((st) => st && { ...st, phase: "cipher", cipher: ct });
        await wait(1100);
        if (alive) onSeal((st) => st && { ...st, phase: "sending" });
      })();
      const [rec] = await Promise.all([placing, animation]);
      saveLocalBid(sale.id, account, {
        max_price: pt.max_price,
        max_spend: pt.max_spend,
        salt: pt.salt,
        savedAt: Date.now(),
      });
      onSeal((st) => st && { ...st, phase: "done", txHash: rec.txHash });
    } catch (err) {
      alive = false;
      onSeal(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const chip = (label: string, mult: bigint) => (
    <button
      type="button"
      key={label}
      onClick={() => setPrice(plain(c.floorPrice * mult))}
      className="inline-flex h-6 items-center rounded-full bg-elev-2 px-2.5 text-[12px] text-muted ring-1 ring-line transition-colors hover:text-fg"
    >
      {label}
    </button>
  );

  return (
    <form onSubmit={submit} noValidate>
      <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <div>
            <Field
              label="Max price"
              suffix="USDC / token"
              inputMode="decimal"
              autoComplete="off"
              placeholder={plain(c.floorPrice * 2n)}
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              error={priceErr && (attempted || price) ? priceErr : undefined}
              hint={
                capped
                  ? `Above this sale's max price. The enclave caps it at ${priceStr(c.maxPrice!)} USDC.`
                  : `The most you would pay per token. Floor ${priceStr(c.floorPrice)} USDC.`
              }
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {chip("Floor", 1n)}
              {chip("2× floor", 2n)}
              {chip("5× floor", 5n)}
            </div>
          </div>
          <Field
            label="Max spend"
            suffix="USDC"
            inputMode="decimal"
            autoComplete="off"
            placeholder="5"
            value={spend}
            onChange={(e) => setSpend(e.target.value)}
            error={spendErr && (attempted || spend) ? spendErr : undefined}
            hint="The most USDC you will spend in total."
          />
          <Field
            label="Deposit"
            suffix="USDC"
            inputMode="decimal"
            autoComplete="off"
            placeholder={usdcStr(c.minDeposit)}
            value={depositInput}
            onChange={(e) => {
              setDeposit(e.target.value);
              setDepositTouched(e.target.value.trim() !== "");
            }}
            error={depositErr && (attempted || depositInput) ? depositErr : undefined}
            hint={
              <>
                {depositTouched
                  ? "Public. Above max spend, it hides your real spend."
                  : "Public. Defaults to max spend; set it higher to hide your real spend."}{" "}
                <span className="num">
                  {usdcStr(c.minDeposit)}–{usdcStr(c.maxDepositPerAccount)}
                </span>{" "}
                USDC.
                {usdcBalance !== null && (
                  <>
                    {" "}
                    Balance <span className="num text-muted">{usdcStr(usdcBalance)} USDC</span>.
                  </>
                )}
              </>
            }
          />
        </div>

        <BidPreview
          sale={sale}
          maxPrice={p.value !== null && !priceErr ? p.value : null}
          maxSpend={s.value !== null && !s.error && s.value > 0n ? s.value : null}
          deposit={d.value !== null && !d.error ? d.value : null}
        />
      </div>

      {error && (
        <p role="alert" className="mt-5 rounded-tile border border-bad/25 bg-bad-soft px-3.5 py-2.5 text-[13px] text-bad">
          {error}
          {closed && " Your deposit never left your account."}
        </p>
      )}
      {closed && !error && !busy && (
        <p className="mt-5 text-[13px] text-muted">The bid window has closed. No more bids can be placed.</p>
      )}

      <Button
        type="submit"
        variant="primary"
        size="lg"
        loading={busy}
        disabled={(attempted && !ok) || (closed && !busy)}
        icon={<Lock className="size-4" strokeWidth={1.75} />}
        className="mt-5 w-full"
      >
        Seal and place bid
      </Button>
      <p className="mt-2.5 text-center text-[12px] leading-snug text-subtle">
        Sealed in this browser to sale key <span className="num">{shortHash(sale.sealerPubkey, 5)}</span>. Stored only in
        this browser. No server keeps your price.
      </p>
    </form>
  );
}
