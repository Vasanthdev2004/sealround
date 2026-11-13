"use client";

import { useState } from "react";
import { Wallet } from "lucide-react";
import { formatUnits, parseUnits } from "@fairground/clearing";
import {
  ActionError,
  GasNote,
  PaidFallbackPrompt,
  useGasMode,
  usePaidFallback,
} from "@/components/sale-common/relay";
import { ImIn } from "@/components/sale-common/im-in";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Panel } from "@/components/ui/panel";
import { errorInfo, getClient, type ErrorInfo } from "@/lib/client";
import { canonicalBid, randomHex, sealBid } from "@/lib/crypto";
import { priceStr, shortHash, usdcStr } from "@/lib/format";
import type { BidPlaintext, BidRecord, PaidReason, Sale } from "@/lib/types";
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

/**
 * The bid form: three amounts on the left, what they buy and what leaves the
 * wallet on the right, with the one button under that. While a bid is sealed
 * and sent the form gives way to the sealing moment (SealTransition).
 */
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
  const [seal, setSeal] = useState<SealState | null>(null);
  const commit = sale.config.revealMode === "commit_reveal";
  const checking = !!account && myBidLoading && !seal;
  const already = !!account && !myBidLoading && !!myBid && !seal;
  // The inputs stay mounted (hidden) while sealing, so a rejected bid keeps
  // its values and shows the error. They are also usable before connecting.
  const showInputs = !already && (!seal || seal.phase !== "done");
  // A reason the page already shows under the button needs no second question.
  const gas = useGasMode();
  const fallback = usePaidFallback(gas.paidBy === "user" ? gas.reason : null);

  return (
    <Panel
      id="bid"
      title={
        already || seal?.phase === "done"
          ? commit
            ? "Your committed bid"
            : "Your sealed bid"
          : commit
            ? "Place a committed bid"
            : "Place a sealed bid"
      }
      action={
        account && usdcBalance !== null ? (
          <span className="text-label text-subtle" title="USDC in your NEAR account">
            In your wallet <span className="num text-fg">{usdcStr(usdcBalance)} USDC</span>
          </span>
        ) : undefined
      }
    >
      {seal && <SealTransition state={seal} pubkey={sale.sealerPubkey} />}
      {/* The relayer refused after the first signature: say why before the wallet asks again. */}
      <PaidFallbackPrompt fallback={fallback} what="the bid" className="mt-5" />
      {already && myBid && <AlreadyBid bid={myBid} commit={commit} />}
      {already && myBid && sale.status === "open" && (
        <ImIn sale={sale} bid={myBid} className="mt-5 border-t border-line pt-5" />
      )}
      {showInputs && (
        <div hidden={!!seal}>
          <BidInputs
            sale={sale}
            account={account}
            checking={checking}
            usdcBalance={usdcBalance}
            onSeal={setSeal}
            onSend={onSend}
            onPaidFallback={fallback.onPaidFallback}
          />
        </div>
      )}
    </Panel>
  );
}

function AlreadyBid({ bid, commit }: { bid: BidRecord; commit: boolean }) {
  return (
    // The status panel above already says the bid is in; this card says what that means for the money.
    <div role="status">
      <p className="max-w-[62ch] text-small text-muted">
        One bid per account. Your deposit of <span className="num text-fg">{usdcStr(bid.deposit)} USDC</span> is locked
        until the sale settles.
        {commit && " Come back after the close to reveal it: a bid that is not revealed is void and loses 1\u00a0% of its deposit."}
      </p>
    </div>
  );
}

/**
 * A quick-fill chip under a field: the shared small button, filled when the
 * field holds exactly its value. `label` is the tooltip.
 */
function Preset({
  active,
  onClick,
  children,
  label,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  label: string;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={active ? "tactile" : "outline"}
      aria-pressed={active}
      title={label}
      onClick={onClick}
      className="gap-1.5 max-sm:h-10"
    >
      {children}
    </Button>
  );
}

function BidInputs({
  sale,
  account,
  checking,
  usdcBalance,
  onSeal,
  onSend,
  onPaidFallback,
}: {
  sale: Sale;
  account: string | null;
  /** Looking up whether this account already bid. */
  checking: boolean;
  usdcBalance: bigint | null;
  onSeal: React.Dispatch<React.SetStateAction<SealState | null>>;
  onSend?: () => void;
  /** Awaited by the client before a paid transaction replaces a gasless one. */
  onPaidFallback: (reason: PaidReason) => Promise<void>;
}) {
  const { connect, connecting, mode } = useWallet();
  const c = sale.config;
  const commit = c.revealMode === "commit_reveal";
  const closed = sale.status !== "open";
  const [price, setPrice] = useState("");
  const [spend, setSpend] = useState("");
  const [deposit, setDeposit] = useState("");
  const [depositTouched, setDepositTouched] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState<ErrorInfo | null>(null);
  const [busy, setBusy] = useState(false);
  // The last attempt may still land: no second attempt until the chain has spoken.
  const inDoubt = !!error?.maybeSubmitted;

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

  const ok = p.value !== null && s.value !== null && d.value !== null && !priceErr && !spendErr && !depositErr;
  const capped = c.maxPrice !== null && p.value !== null && p.value > c.maxPrice;

  // Price presets: multiples of the floor, plus the sale's max price if it has one.
  const pricePresets: { label: string; value: bigint }[] = [
    { label: "Floor", value: c.floorPrice },
    { label: "2×", value: c.floorPrice * 2n },
    { label: "5×", value: c.floorPrice * 5n },
  ];
  if (c.maxPrice !== null && c.maxPrice > c.floorPrice * 5n) pricePresets.push({ label: "Max", value: c.maxPrice });

  // Spend presets: the minimum, a quarter, a half and all of what this account may deposit.
  let cap = c.maxDepositPerAccount;
  if (usdcBalance !== null && usdcBalance >= c.minDeposit && usdcBalance < cap) cap = usdcBalance;
  const spendPresets: bigint[] = [];
  for (const v of [c.minDeposit, cap / 4n, cap / 2n, cap]) {
    const r = (v / 10_000n) * 10_000n; // whole cents
    if (r >= c.minDeposit && !spendPresets.includes(r)) spendPresets.push(r);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!account) {
      await connect();
      return;
    }
    setAttempted(true);
    setError(null);
    if (checking || inDoubt || !ok || p.value === null || s.value === null || d.value === null) return;
    const dep = d.value;
    const terms = { maxPrice: p.value, maxSpend: s.value };
    const base = { deposit: dep, txHash: null, bidder: account, relay: null, cipher: null } as const;
    setBusy(true);
    onSend?.();
    let alive = true;
    try {
      if (commit) {
        // Commit-reveal: the client makes the salt and the commitment, and
        // saves the secret in this browser before anything is sent, so a bid
        // that lands can always be revealed.
        onSeal({
          ...base,
          kind: "commitment",
          phase: "plain",
          plain: JSON.stringify({
            sale_id: sale.id,
            bidder: account,
            max_price: terms.maxPrice.toString(),
            max_spend: terms.maxSpend.toString(),
            salt: "16 random bytes, made and kept in this browser",
          }),
        });
        const [rec] = await Promise.all([
          getClient().bid(sale.id, account, dep, terms, { onPaidFallback }),
          wait(600),
        ]);
        saveLocalBid(sale.id, account, {
          max_price: terms.maxPrice.toString(),
          max_spend: terms.maxSpend.toString(),
          salt: rec.secret?.salt ?? "",
          savedAt: Date.now(),
        });
        const commitment = rec.secret?.commitment ?? "";
        onSeal((st) => st && { ...st, phase: "cipher", cipher: commitment });
        await wait(950);
        onSeal((st) => st && { ...st, phase: "done", txHash: rec.txHash, relay: rec.relay ?? null });
        return;
      }
      const pt: BidPlaintext = {
        sale_id: sale.id,
        bidder: account,
        max_price: terms.maxPrice.toString(),
        max_spend: terms.maxSpend.toString(),
        salt: randomHex(16),
      };
      onSeal({ ...base, kind: "sealed", phase: "plain", plain: canonicalBid(pt) });
      const ct = await sealBid(sale.sealerPubkey, pt);
      // Send right away. The sealing animation plays alongside the
      // transaction, so a bid placed seconds before the close is not held
      // back by it, and a rejection shows at once.
      const placing = getClient().placeBid(sale.id, account, dep, ct, { onPaidFallback });
      const animation = (async () => {
        await wait(600);
        if (alive) onSeal((st) => st && { ...st, phase: "cipher", cipher: ct });
        await wait(950);
        if (alive) onSeal((st) => st && { ...st, phase: "sending" });
      })();
      const [rec] = await Promise.all([placing, animation]);
      saveLocalBid(sale.id, account, {
        max_price: pt.max_price,
        max_spend: pt.max_spend,
        salt: pt.salt,
        savedAt: Date.now(),
      });
      onSeal((st) => st && { ...st, phase: "done", txHash: rec.txHash, relay: rec.relay ?? null });
    } catch (err) {
      alive = false;
      onSeal(null);
      setError(errorInfo(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate aria-busy={checking || undefined}>
      <div className="grid gap-x-8 gap-y-5 md:grid-cols-2">
        <div className="flex flex-col gap-5">
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
                  ? `Above this sale's max price. It counts as ${priceStr(c.maxPrice!)} USDC.`
                  : commit
                    ? "Hidden until you reveal it after the close."
                    : "Never shown to anyone, even after the sale."
              }
            />
            <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Max price presets">
              {pricePresets.map((x) => (
                <Preset
                  key={x.label}
                  active={p.value === x.value}
                  onClick={() => setPrice(plain(x.value))}
                  label={`${x.label === "Floor" ? "Floor" : x.label === "Max" ? "Sale max" : `${x.label} floor`}: ${priceStr(x.value)} USDC`}
                >
                  {x.label}
                  {x.label !== "Floor" && x.label !== "Max" && <span className="sr-only">floor,</span>}
                  <span className="num font-normal text-muted">{priceStr(x.value)}</span>
                  <span className="sr-only">USDC</span>
                </Preset>
              ))}
            </div>
          </div>

          <div>
            <Field
              label="Max spend"
              suffix="USDC"
              inputMode="decimal"
              autoComplete="off"
              placeholder={usdcStr(cap / 2n)}
              value={spend}
              onChange={(e) => setSpend(e.target.value)}
              error={spendErr && (attempted || spend) ? spendErr : undefined}
            />
            <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Max spend presets">
              {spendPresets.map((v, i) => {
                const last = i === spendPresets.length - 1 && spendPresets.length > 1;
                return (
                  <Preset
                    key={v.toString()}
                    active={s.value === v}
                    onClick={() => setSpend(plain(v))}
                    label={`${last ? "Most you can deposit" : "Spend"}: ${usdcStr(v)} USDC`}
                  >
                    {last && "Max"}
                    <span className={last ? "num font-normal text-muted" : "num"}>{usdcStr(v)}</span>
                    <span className="sr-only">USDC</span>
                  </Preset>
                );
              })}
            </div>
          </div>

          <Field
            label="Deposit"
            labelAside={
              <span className="num text-label text-subtle">
                {usdcStr(c.minDeposit)} to {usdcStr(c.maxDepositPerAccount)} USDC
              </span>
            }
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
              depositTouched ? (
                <>
                  Public. Above your max spend, it hides the spend.{" "}
                  <button
                    type="button"
                    onClick={() => {
                      setDeposit("");
                      setDepositTouched(false);
                    }}
                    className="rounded-sm text-muted underline decoration-line-strong underline-offset-2 transition-colors duration-[120ms] hover:text-fg"
                  >
                    Match max spend
                  </button>
                </>
              ) : (
                "Public. Follows your max spend. Raise it to hide the spend."
              )
            }
          />
        </div>

        <div className="border-t border-line pt-5 md:border-t-0 md:border-l md:pt-0 md:pl-8">
          <BidPreview
            sale={sale}
            maxPrice={p.value !== null && !priceErr ? p.value : null}
            maxSpend={s.value !== null && !s.error && s.value > 0n ? s.value : null}
            deposit={d.value !== null && !d.error ? d.value : null}
          />
        </div>
      </div>

      <div className="mt-5 flex flex-col gap-4 border-t border-line pt-5">
        <ActionError info={error} what="bid" />
        {closed && !error && !busy && (
          <p className="text-small text-muted">The bid window has closed. No more bids can be placed.</p>
        )}
        <div className="flex flex-col gap-x-5 gap-y-3 sm:flex-row sm:items-center">
          {account ? (
            <Button
              type="submit"
              variant="primary"
              size="lg"
              loading={busy}
              disabled={checking || inDoubt || (attempted && !ok) || (closed && !busy)}
              className="shrink-0 max-sm:w-full"
            >
              {checking
                ? "Checking your account"
                : inDoubt
                  ? "Checking the chain for your bid"
                  : commit
                    ? "Commit and place bid"
                    : "Seal and place bid"}
            </Button>
          ) : (
            <Button
              type="submit"
              variant="primary"
              size="lg"
              loading={connecting}
              disabled={closed}
              icon={<Wallet className="size-4" strokeWidth={1.75} />}
              className="shrink-0 max-sm:w-full"
            >
              Connect a wallet to bid
            </Button>
          )}
          {/* Who pays the network fee, then the one line of reassurance. */}
          <div className="flex min-w-0 flex-col gap-1">
            {account || mode === "near" ? (
              <GasNote what="This bid" />
            ) : (
              <p className="text-label text-subtle">Demo accounts start with 100 test USDC. Your inputs stay.</p>
            )}
            <p className="text-label text-subtle">
              {!account && mode === "near" && "Your inputs stay. "}
              {commit ? (
                "Only a hash of your bid goes on chain until you reveal it."
              ) : (
                <>
                  Sealed in this browser to sale key <span className="num">{shortHash(sale.sealerPubkey, 4)}</span>.
                </>
              )}{" "}
              Unspent deposit comes back in full.
            </p>
          </div>
        </div>
      </div>
    </form>
  );
}
