"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { readDemoView, runDemo } from "@/lib/chapters/demo";
import { chapterAmount, parseLockAmount, seriesFor } from "@/lib/chapters/model";
import { chapterFactoryFor, sandboxFor } from "@/lib/chapters/sandbox";
import { canSignChapter, chapterWalletSigner } from "@/lib/chapters/wallet";
import { appConfig } from "@/lib/config";
import {
  buyOnRhea, checkRheaSwap, clearPendingRheaSwap, mockRheaQuote, quoteRhea, readPendingRheaSwap, registerRheaBuyer,
  rheaCallbackHash, rheaChain, rheaPool, rheaQuoteExpired, rheaWalletQuote, savePendingRheaSwap,
  type RheaChain, type RheaPool, type RheaQuote, type RheaReceipt,
} from "@/lib/near/rhea-swap";
import type { Sale, SaleResult } from "@/lib/types";
import { useWallet } from "@/lib/wallet";

export function RheaBuy({ sale, result, onBought }: { sale: Sale; result: SaleResult; onBought: () => void }) {
  const config = appConfig();
  const eligible = rheaPool(sale, result, config);
  const exchange = eligible?.exchange;
  const poolId = eligible?.poolId;
  const input = eligible?.input;
  const output = eligible?.output;
  const pool = useMemo(() => exchange && poolId !== undefined && input && output ? { exchange, poolId, input, output } : null,
    [exchange, poolId, input, output]);
  const chain = useMemo(() => pool ? rheaChain(pool, config) : null, [pool, config]);
  if (!pool) return null;
  const chapters = config.mode === "mock" || !!process.env.NEXT_PUBLIC_CHAPTERS_FACTORY && !!chapterFactoryFor(sale, config)
    || !!process.env.NEXT_PUBLIC_CHAPTERS_CONTRACT && !!sandboxFor(sale, config);
  return <BuyPanel key={`${pool.exchange}:${pool.poolId}:${pool.input}:${pool.output}`}
    sale={sale} result={result} pool={pool} chain={chain} offersChapters={chapters} onBought={onBought} />;
}

type Review = {
  quote: RheaQuote;
  account: string;
  deposit: bigint | null;
  currency: { symbol: string; decimals: number } | null;
};

function BuyPanel({ sale, result, pool, chain, offersChapters, onBought }: {
  sale: Sale; result: SaleResult; pool: RheaPool; chain: RheaChain | null; offersChapters: boolean; onBought: () => void;
}) {
  const wallet = useWallet();
  const series = seriesFor(sale);
  const symbol = sale.config.tokenSymbol;
  const [input, setInput] = useState("1");
  const [review, setReview] = useState<Review | null>(null);
  const [receipt, setReceipt] = useState<RheaReceipt | null>(null);
  const [hashInput, setHashInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(!chain);
  const pending = useRef(false);
  const walletReady = wallet.account !== null && (!chain || canSignChapter(wallet, chain.network));
  const awaiting = receipt?.status === "pending" || receipt?.status === "unresolved";

  useEffect(() => {
    if (!chain) return;
    let alive = true;
    void Promise.resolve().then(() => {
      const saved = readPendingRheaSwap(chain);
      if (!alive) return;
      if (saved) {
        setReview({ account: saved.account, quote: saved.quote, currency: null, deposit: null });
        setReceipt({ status: "pending", hash: saved.hash });
        if (!saved.hash) setHashInput(rheaCallbackHash(window.location.search) ?? "");
      }
      setReady(true);
    });
    return () => { alive = false; };
  }, [chain]);

  async function quote() {
    const account = wallet.account;
    if (!account || !walletReady) throw new Error("Connect the wallet that will pay for this swap.");
    const currency = chain ? await chain.rpc.view<{ symbol: string; decimals: number }>(pool.input, "ft_metadata") : { symbol: "test USDC", decimals: 6 };
    if (typeof currency?.symbol !== "string" || !currency.symbol.trim() || currency.symbol.length > 24
      || !Number.isInteger(currency.decimals) || currency.decimals < 0 || currency.decimals > 38) {
      throw new Error("The sale currency returned invalid token metadata.");
    }
    const amount = parseLockAmount(input, currency.decimals);
    if (amount === null) throw new Error("Enter a positive amount in the sale currency.");
    if (!chain) {
      if (BigInt(readDemoView(account, series).quoteBalance ?? "0") < amount) throw new Error("You do not have enough simulated USDC in this story.");
      return { quote: mockRheaQuote(result, sale.config.liquidity?.feeBps ?? 0, amount), account, deposit: null, currency };
    }
    const [price, registration] = await Promise.all([quoteRhea(chain, amount), rheaWalletQuote(chain, account, amount)]);
    return { quote: price, account, deposit: registration.deposit, currency };
  }

  function publish(next: RheaReceipt) {
    setReceipt(next);
    if (chain && (next.status === "bought" || next.status === "failed" || next.status === "refunded")) clearPendingRheaSwap(chain);
    if (next.status === "bought") onBought();
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current || !ready) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      if (!review) {
        setReview(await quote());
      } else if (awaiting && chain) {
        const hash = receipt?.hash ?? hashInput.trim();
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(hash)) throw new Error("Enter the transaction hash reported by your wallet.");
        const checked = await checkRheaSwap(chain, hash, review.account, review.quote);
        if (checked.hash && (checked.status === "pending" || checked.status === "unresolved")) {
          savePendingRheaSwap(chain, { account: review.account, quote: review.quote, hash: receipt?.hash ?? null });
        }
        publish(!receipt?.hash && (checked.status === "pending" || checked.status === "unresolved") ? { ...checked, hash: null } : checked);
      } else if (receipt) {
        return;
      } else if (!chain) {
        if (!wallet.account || wallet.account !== review.account) throw new Error("Connect the wallet that reviewed this quote.");
        if (rheaQuoteExpired(review.quote)) throw new Error("This quote expired. Get a new quote.");
        await runDemo({ kind: "buy_demo", account: review.account, amount: review.quote.estimate, cost: review.quote.amount }, series);
        publish({ status: "bought", amount: review.quote.estimate, hash: "" });
      } else {
        const activeSigner = () => chapterWalletSigner(wallet, chain.network, review.account);
        if (review.deposit !== null) {
          await registerRheaBuyer(chain, review.account, review.quote, review.deposit, activeSigner);
          setReview(await quote());
        } else {
          publish(await buyOnRhea(chain, review.account, review.quote, activeSigner, (swap) => {
            savePendingRheaSwap(chain, swap);
            setReceipt({ status: "pending", hash: swap.hash });
          }));
        }
      }
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Could not read the swap. Check before retrying.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  function clearReview() {
    setReview(null);
    setReceipt(null);
    setHashInput("");
    setError(null);
  }

  const labels = {
    pending: "The swap is awaiting receipt confirmation. Check the original transaction in your wallet before trying again.",
    unresolved: "The receipt does not confirm delivery to your wallet or a full refund. Check this swap on Rhea.",
    failed: "The request was declined or the input transfer failed. No tokens were bought.",
    refunded: "The input token contract returned the full amount to your wallet. No tokens were bought.",
  };

  return <section className="panel space-y-4 p-5 sm:p-6" aria-labelledby="buy-on-rhea-title">
    <div>
      <h2 id="buy-on-rhea-title" className="text-h3 text-fg">{chain ? `Buy ${symbol} on Rhea` : `Simulate buying ${symbol}`}</h2>
      <p className="mt-1 text-small text-muted">{chain ? `Uses Rhea pool #${pool.poolId}.${offersChapters ? " After the swap, you can lock the tokens to vote below." : ""}`
        : "This browser-only quote uses the simulated Rhea pool. Purchased demo tokens can vote in Chapters."}</p>
    </div>
    {!walletReady && !review && <Button variant="outline" onClick={() => void wallet.connect()} loading={wallet.connecting}>Connect wallet</Button>}
    {ready && (walletReady || review) && <form className="grid max-w-xl gap-3" onSubmit={(event) => void submit(event)}>
      {!review && <Field label="Amount to spend" value={input} inputMode="decimal" maxLength={64} required disabled={busy}
        hint={chain ? `Sale currency ${pool.input}` : "Simulated USDC"} onChange={(event) => { setInput(event.target.value); setError(null); }} />}
      {review && <dl className="grid grid-cols-2 gap-x-2 gap-y-3 border-y border-line py-3 text-small sm:grid-cols-3">
        <div><dt className="text-muted">You spend</dt><dd className="num break-words text-fg">{review.currency
          ? chapterAmount(review.quote.amount.toString(), review.currency.decimals, review.currency.symbol)
          : `${review.quote.amount} base units`}</dd></div>
        <div><dt className="text-muted">Quoted output</dt><dd className="num break-words text-fg">{chapterAmount(review.quote.estimate.toString(), series.decimals, symbol)}</dd></div>
        <div><dt className="text-muted">Minimum output (1% slippage)</dt><dd className="num break-words text-fg">{chapterAmount(review.quote.minimum.toString(), series.decimals, symbol)}</dd></div>
      </dl>}
      {review?.deposit !== null && review?.deposit !== undefined && <p className="text-small text-muted">
        Register your wallet on {symbol} for {chapterAmount(review.deposit.toString(), 24, "NEAR")} before signing the swap.
      </p>}
      {receipt && <p className="text-small text-fg" role="status">{receipt.status === "bought"
        ? `${chapterAmount(receipt.amount.toString(), series.decimals, symbol)} ${chain ? "delivered to your wallet." : "added to your demo voting balance."}`
        : labels[receipt.status]}</p>}
      {review && awaiting && chain && !receipt?.hash && <Field label="Swap transaction hash" value={hashInput} maxLength={44} disabled={busy}
        onChange={(event) => setHashInput(event.target.value)} />}
      {receipt?.hash && <p className="break-all font-mono text-label text-muted">{receipt.hash}</p>}
      {error && <p role="alert" className="text-small text-bad">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {(!receipt || awaiting) && <Button size="lg" variant="primary" type="submit" loading={busy}
          disabled={!awaiting && review?.account !== undefined && review.account !== wallet.account}>
          {awaiting ? "Check swap receipt" : !review ? "Get quote" : review.deposit !== null ? "Register wallet" : chain ? "Confirm Rhea swap" : "Simulate swap"}
        </Button>}
        {review && !awaiting && <Button variant="ghost" type="button" disabled={busy} onClick={clearReview}>
          {receipt ? "Get a new quote" : "Edit amount"}
        </Button>}
        {receipt?.status === "bought" && offersChapters && <a href="#meme-chapters" className="text-small text-fg underline underline-offset-4">Go to Chapters</a>}
      </div>
    </form>}
    {!walletReady && wallet.error && <p className="text-small text-bad" role="alert">{wallet.error}</p>}
  </section>;
}
