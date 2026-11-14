import type { ActionSigner, FairgroundAction } from "@fairground/relayer-client";
import { U128_MAX } from "@fairground/clearing";
import { chapterTransactionHash } from "../chapters/transaction";
import { ACCOUNT_ID, devSignerAllowed, type AppConfig } from "../config";
import { fromB64 } from "../crypto";
import type { Sale, SaleResult } from "../types";
import { jsonRpc } from "../verify/rpc";
import type { RpcAction, RpcOutcome, RpcReceipt, RpcTransaction } from "./attestation";
import { createRpc, type NearRpc } from "./rpc";
import type { RefPoolView } from "./views";

export const RHEA_TESTNET = "ref-finance-101.testnet";
export const RHEA_SANDBOX = "dex.test.near";
export const RHEA_SLIPPAGE_BPS = 100n;
const BPS = 10_000n;
const TGAS = 1_000_000_000_000n;
const QUOTE_WINDOW_MS = 60_000;

export type RheaPool = { exchange: string; poolId: number; input: string; output: string };
export type RheaChain = RheaPool & { network: "testnet" | "sandbox"; rpc: NearRpc; rpcUrls: readonly string[] };
export type RheaQuote = { amount: bigint; estimate: bigint; minimum: bigint; expires: number };
export type RheaReceipt =
  | { status: "bought"; amount: bigint; hash: string }
  | { status: "refunded" | "failed" | "unresolved" | "pending"; hash: string | null };

export function rheaPool(sale: Sale, result: SaleResult, app: AppConfig): RheaPool | null {
  const liquidity = result.liquidity;
  if (sale.status !== "settled" || result.status !== "settled" || !liquidity || liquidity.stage !== "seeded"
    || liquidity.poolId === null || !Number.isSafeInteger(liquidity.poolId) || liquidity.poolId < 0
    || sale.tokenAccount === sale.config.quoteToken || !ACCOUNT_ID.test(sale.tokenAccount) || !ACCOUNT_ID.test(sale.config.quoteToken)) return null;
  const exchange = liquidity.dex;
  const allowed = app.mode === "mock" ? liquidity.simulated && exchange === RHEA_TESTNET
    : !liquidity.simulated && (app.near.network === "testnet" ? exchange === RHEA_TESTNET
      : exchange === RHEA_SANDBOX && [app.near.rpcUrl, ...(app.near.rpcUrls ?? [])].every((rpcUrl) => devSignerAllowed({ network: app.near.network, rpcUrl })));
  return allowed ? { exchange, poolId: liquidity.poolId, input: sale.config.quoteToken, output: sale.tokenAccount } : null;
}

export function rheaChain(pool: RheaPool, app: AppConfig): RheaChain | null {
  if (app.mode === "mock" || app.near.network === "mainnet") return null;
  const rpcUrls = [...new Set([app.near.rpcUrl, ...(app.near.rpcUrls ?? [])])];
  return { ...pool, network: app.near.network, rpc: createRpc(rpcUrls), rpcUrls };
}

export type PendingRheaSwap = { account: string; quote: RheaQuote; hash: string | null };

/** Redirect data is a lookup hint. A receipt check still has to prove the swap. */
export function rheaCallbackHash(search: string): string | null {
  const hashes = new URLSearchParams(search).getAll("transactionHashes");
  return hashes.length === 1 ? chapterTransactionHash(hashes[0]) : null;
}

function pendingKey(chain: RheaChain): string {
  const network = chain.network === "testnet" ? chain.network : `${chain.network}:${chain.rpcUrls[0]}`;
  return `sealround:rhea-buy:v1:${network}:${chain.exchange}:${chain.poolId}:${chain.input}:${chain.output}`;
}

export function savePendingRheaSwap(chain: RheaChain, swap: PendingRheaSwap) {
  sessionStorage.setItem(pendingKey(chain), JSON.stringify(swap, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value));
}

export function readPendingRheaSwap(chain: RheaChain): PendingRheaSwap | null {
  try {
    const saved = record(JSON.parse(sessionStorage.getItem(pendingKey(chain)) ?? "null"));
    if (typeof saved?.account !== "string" || !ACCOUNT_ID.test(saved.account)) return null;
    const quote = record(saved.quote);
    const amount = rheaAmount(quote?.amount);
    const estimate = rheaAmount(quote?.estimate);
    const minimum = rheaAmount(quote?.minimum);
    const expires = quote?.expires;
    if (!amount || !estimate || !minimum || minimum !== estimate * (BPS - RHEA_SLIPPAGE_BPS) / BPS
      || typeof expires !== "number" || !Number.isSafeInteger(expires)) return null;
    return { account: saved.account, quote: { amount, estimate, minimum, expires }, hash: chapterTransactionHash(saved.hash) };
  } catch { return null; }
}

export function clearPendingRheaSwap(chain: RheaChain) {
  try { sessionStorage.removeItem(pendingKey(chain)); } catch { /* The transaction still has a finalized receipt. */ }
}

export function rheaAmount(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,38})$/.test(value)) return null;
  const amount = BigInt(value);
  return amount <= U128_MAX ? amount : null;
}

export function rheaQuoteFor(amount: bigint, estimate: bigint, now = Date.now()): RheaQuote {
  const minimum = estimate * (BPS - RHEA_SLIPPAGE_BPS) / BPS;
  if (amount <= 0n || amount > U128_MAX || estimate > U128_MAX || minimum <= 0n) throw new Error("This amount does not produce a usable quote.");
  return { amount, estimate, minimum, expires: now + QUOTE_WINDOW_MS };
}

export function rheaQuoteExpired(quote: RheaQuote) {
  return Date.now() >= quote.expires;
}

export function mockRheaQuote(result: SaleResult, feeBps: number, amount: bigint): RheaQuote {
  const pool = result.liquidity;
  if (!pool?.simulated || pool.usdc <= 0n || pool.tokens <= 0n || !Number.isInteger(feeBps) || feeBps < 0 || feeBps >= Number(BPS)) {
    throw new Error("A simulated Rhea pool is unavailable.");
  }
  const net = amount * (BPS - BigInt(feeBps));
  return rheaQuoteFor(amount, net * pool.tokens / (pool.usdc * BPS + net));
}

export async function quoteRhea(chain: RheaChain, amount: bigint): Promise<RheaQuote> {
  const { rpc, exchange, poolId, input, output } = chain;
  const pool = await rpc.view<RefPoolView>(exchange, "get_pool", { pool_id: poolId });
  if (pool?.pool_kind !== "SIMPLE_POOL" || pool.token_account_ids?.length !== 2
    || !pool.token_account_ids.includes(input) || !pool.token_account_ids.includes(output)) {
    throw new Error("The Rhea pool does not match this token and its sale currency.");
  }
  const value = await rpc.view<string>(exchange, "get_return", { pool_id: poolId, token_in: input, amount_in: amount.toString(), token_out: output });
  const estimate = rheaAmount(value);
  if (estimate === null) throw new Error("Rhea returned an invalid quote.");
  return rheaQuoteFor(amount, estimate);
}

export async function rheaWalletQuote(chain: RheaChain, account: string, amount: bigint) {
  const { rpc, input, output } = chain;
  const [balanceValue, storage] = await Promise.all([
    rpc.view<string>(input, "ft_balance_of", { account_id: account }),
    rpc.view<{ total?: string; available?: string } | null>(output, "storage_balance_of", { account_id: account }),
  ]);
  const balance = rheaAmount(balanceValue);
  if (balance === null || balance < amount) throw new Error("Your wallet does not have enough of the sale currency.");
  if (storage !== null) {
    const total = rheaAmount(storage?.total);
    const available = rheaAmount(storage?.available);
    if (total === null || available === null || available > total) throw new Error("The token returned invalid storage registration details.");
    return { deposit: null };
  }
  const bounds = await rpc.view<{ min?: string }>(output, "storage_balance_bounds");
  const deposit = rheaAmount(bounds?.min);
  if (deposit === null) throw new Error("The token returned an invalid storage deposit.");
  return { deposit };
}

export async function registerRheaBuyer(chain: RheaChain, account: string, quote: RheaQuote, deposit: bigint, activeSigner: () => ActionSigner) {
  const current = await rheaWalletQuote(chain, account, quote.amount);
  if (current.deposit === null) return;
  if (current.deposit !== deposit) throw new Error("The storage deposit changed. Review it again before signing.");
  const signer = activeSigner();
  let failure: unknown;
  try {
    await signer.sendTransaction({ receiverId: chain.output, methodName: "storage_deposit", gas: 30n * TGAS, deposit,
      args: { account_id: account, registration_only: true } });
  } catch (error) { failure = error; }
  if ((await rheaWalletQuote(chain, account, quote.amount)).deposit !== null) {
    throw failure instanceof Error ? failure : new Error("Token registration is awaiting confirmation. Recheck your quote before swapping.");
  }
}

export function rheaSwapAction(pool: RheaPool, quote: RheaQuote): FairgroundAction {
  return {
    receiverId: pool.input, methodName: "ft_transfer_call", gas: 300n * TGAS, deposit: 1n,
    args: {
      receiver_id: pool.exchange, amount: quote.amount.toString(),
      msg: JSON.stringify({ force: 0, actions: [{ pool_id: pool.poolId, token_in: pool.input,
        amount_in: quote.amount.toString(), token_out: pool.output, min_amount_out: quote.minimum.toString() }] }),
    },
  };
}

type Outcome = RpcOutcome & { outcome: { receipt_ids: string[] } };
type SwapTx = {
  final_execution_status?: string;
  transaction?: RpcTransaction;
  transaction_outcome?: Outcome;
  receipts_outcome?: Outcome[];
  receipts?: RpcReceipt[];
  status?: Outcome["outcome"]["status"];
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function parseValue(value: unknown): unknown {
  if (typeof value !== "string" || value.length > 16_384) return undefined;
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fromB64(value))); }
  catch { return undefined; }
}

function callArgs(actions: RpcAction[] | undefined, method: string, deposit?: string) {
  if (!Array.isArray(actions) || actions.length !== 1) return;
  const call = record(record(actions[0])?.FunctionCall);
  if (call?.method_name !== method || (deposit !== undefined && call.deposit !== deposit)) return;
  return record(parseValue(call.args));
}

function matchesSwapCall(actions: RpcAction[] | undefined, pool: RheaPool, quote: RheaQuote) {
  const args = callArgs(actions, "ft_transfer_call", "1");
  if (args?.receiver_id !== pool.exchange || args.amount !== quote.amount.toString() || typeof args.msg !== "string" || args.msg.length > 1024) return false;
  try {
    const msg = record(JSON.parse(args.msg));
    if (msg?.force !== 0 || !Array.isArray(msg.actions) || msg.actions.length !== 1) return false;
    const action = record(msg.actions[0]);
    return action?.pool_id === pool.poolId && action.token_in === pool.input && action.token_out === pool.output
      && action.amount_in === args.amount && action.min_amount_out === quote.minimum.toString();
  } catch { return false; }
}

function transferEvents(outcome: Outcome, oldOwner: string, newOwner: string): bigint[] {
  if (typeof record(outcome.outcome.status)?.SuccessValue !== "string") return [];
  return (Array.isArray(outcome.outcome.logs) ? outcome.outcome.logs : []).flatMap((log) => {
    if (typeof log !== "string" || !log.startsWith("EVENT_JSON:")) return [];
    try {
      const event = record(JSON.parse(log.slice(11)));
      if (event?.standard !== "nep141" || event.version !== "1.0.0" || event.event !== "ft_transfer" || !Array.isArray(event.data)) return [];
      return event.data.flatMap((row) => {
        const info = record(row);
        const amount = info?.old_owner_id === oldOwner && info.new_owner_id === newOwner ? rheaAmount(info.amount) : null;
        return amount === null ? [] : [amount];
      });
    } catch { return []; }
  });
}

export function readRheaReceipt(tx: SwapTx, hash: string, account: string, pool: RheaPool, quote: RheaQuote): RheaReceipt {
  if (tx?.final_execution_status !== "FINAL") return { status: "pending", hash };
  const unresolved: RheaReceipt = { status: "unresolved", hash };
  const { transaction, transaction_outcome: root } = tx;
  if (!transaction || transaction.hash !== hash || transaction.signer_id !== account || transaction.receiver_id !== pool.input
    || !matchesSwapCall(transaction.actions, pool, quote) || root?.id !== hash || root.outcome?.executor_id !== account
    || !Array.isArray(tx.receipts) || !Array.isArray(tx.receipts_outcome)) return unresolved;

  const start = record(root.outcome.status)?.SuccessReceiptId;
  if (typeof start !== "string" || !root.outcome.receipt_ids?.includes(start)) return unresolved;
  const outcomes = new Map(tx.receipts_outcome.filter((item) => item?.outcome).map((item) => [item.id, item]));
  const initial = outcomes.get(start);
  if (initial?.outcome.executor_id !== pool.input) return unresolved;
  if (Object.hasOwn(record(initial.outcome.status) ?? {}, "Failure")) return { status: "failed", hash };

  const dependents = [start];
  const reachable = new Set<string>();
  for (let i = 0; i < dependents.length; i++) {
    const id = dependents[i];
    if (reachable.has(id)) continue;
    reachable.add(id);
    const outcome = outcomes.get(id)?.outcome;
    if (Array.isArray(outcome?.receipt_ids)) dependents.push(...outcome.receipt_ids);
  }
  const resolverId = record(initial.outcome.status)?.SuccessReceiptId;
  if (typeof resolverId !== "string" || !reachable.has(resolverId)) return unresolved;
  const resolver = outcomes.get(resolverId);
  const resolverReceipt = tx.receipts.find((row) => row?.receipt_id === resolverId);
  const resolve = callArgs(resolverReceipt?.receipt?.Action?.actions, "ft_resolve_transfer", "0");
  if (!resolver || resolver.outcome.executor_id !== pool.input || resolverReceipt?.predecessor_id !== pool.input
    || resolverReceipt.receiver_id !== pool.input || resolve?.sender_id !== account || resolve.receiver_id !== pool.exchange
    || resolve.amount !== quote.amount.toString()) return unresolved;
  const used = rheaAmount(parseValue(record(resolver.outcome.status)?.SuccessValue));
  if (used === 0n && transferEvents(resolver, pool.exchange, account).includes(quote.amount)) return { status: "refunded", hash };
  if (used !== quote.amount) return unresolved;

  const outputTransfers = tx.receipts.flatMap((row) => {
    if (!reachable.has(row?.receipt_id) || row?.predecessor_id !== pool.exchange || row?.receiver_id !== pool.output) return [];
    const args = callArgs(row.receipt?.Action?.actions, "ft_transfer", "1");
    const amount = rheaAmount(args?.amount);
    const outcome = outcomes.get(row.receipt_id);
    return args?.receiver_id === account && amount !== null && amount >= quote.minimum && outcome?.outcome.executor_id === pool.output
      && transferEvents(outcome, pool.exchange, account).includes(amount) ? [amount] : [];
  });
  return outputTransfers.length === 1 ? { status: "bought", amount: outputTransfers[0], hash } : unresolved;
}

export async function checkRheaSwap(chain: RheaChain, hash: string | null, account: string, quote: RheaQuote): Promise<RheaReceipt> {
  if (!hash || !chapterTransactionHash(hash)) return { status: "pending", hash: null };
  let unresolved: RheaReceipt | null = null;
  const params = { tx_hash: hash, sender_account_id: account, wait_until: "FINAL" };
  for (const endpoint of chain.rpcUrls) {
    const rpc = jsonRpc([endpoint], { timeoutMs: 12_000, retries: 0 });
    try {
      const tx = await rpc<SwapTx>(chain.network === "sandbox" ? "EXPERIMENTAL_tx_status" : "tx_status", params)
        .catch((error: unknown) => {
          if (chain.network !== "testnet" || !(error instanceof Error) || !/method[\s_-]*not[\s_-]*found/i.test(error.message)) throw error;
          return rpc<SwapTx>("EXPERIMENTAL_tx_status", params);
        });
      const receipt = readRheaReceipt(tx, hash, account, chain, quote);
      if (receipt.status === "pending") continue;
      if (receipt.status !== "unresolved") return receipt;
      unresolved = receipt;
    } catch { /* another configured RPC may have the receipt */ }
  }
  return unresolved ?? { status: "pending", hash };
}

export async function buyOnRhea(chain: RheaChain, account: string, reviewed: RheaQuote, activeSigner: () => ActionSigner,
  onSigning: (swap: PendingRheaSwap) => void): Promise<RheaReceipt> {
  if (rheaQuoteExpired(reviewed)) throw new Error("This quote expired. Get a new quote before signing.");
  const [quote, registration] = await Promise.all([quoteRhea(chain, reviewed.amount), rheaWalletQuote(chain, account, reviewed.amount)]);
  if (quote.estimate < reviewed.minimum || rheaQuoteExpired(reviewed)) throw new Error("The reviewed quote expired or the price moved below its minimum. Get a new quote.");
  if (registration.deposit !== null) throw new Error("Register your wallet on the token before swapping.");
  const signer = activeSigner();
  onSigning({ account, quote: reviewed, hash: null });
  let hash: string | null = null;
  try { hash = chapterTransactionHash(await signer.sendTransaction(rheaSwapAction(chain, reviewed))); }
  catch (problem) {
    const code = record(problem)?.code;
    if (code === 4001 || code === "4001" || (problem instanceof Error && /^User rejected(?: the request)?[.!]?$/i.test(problem.message))) {
      return { status: "failed", hash: null };
    }
    // Transport and wallet failures can arrive after submission. Keep the intent pending.
  }
  if (hash) onSigning({ account, quote: reviewed, hash });
  return checkRheaSwap(chain, hash, account, reviewed);
}
